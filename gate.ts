import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { AuditLog } from "./audit";
import { cacheKey, ClassificationCache } from "./cache";
import { classify, ClassifierError, resolveModel } from "./classifier";
import { configFingerprint, type CruiseControlConfig, loadConfig } from "./config";
import { StatsTracker } from "./stats";
import type { Classification, ClassificationRequest, Decision } from "./types";

/** How many recent user prompts the classifier sees when judging intent. */
const RECENT_PROMPT_COUNT = 3;

/**
 * Approve when risk is low, or intent is high, or risk and intent are both medium.
 * Everything else is denied and the reason is fed back to the agent.
 */
export function isApproved(classification: Classification): boolean {
  if (classification.risk === "low") return true;
  if (classification.intent === "high") return true;
  return classification.risk === "medium" && classification.intent === "medium";
}

/** Owns the config snapshot, cache, audit log, and stats for the current session. */
export class Gate {
  readonly stats = new StatsTracker();
  private config: CruiseControlConfig;
  private fingerprint: string;
  private readonly cache: ClassificationCache;
  private readonly audit: AuditLog;

  constructor(cwd: string) {
    this.config = loadConfig(cwd);
    this.fingerprint = configFingerprint(this.config);
    this.cache = new ClassificationCache(this.config.cache);
    this.audit = new AuditLog(this.config.log);
  }

  getConfig(): CruiseControlConfig {
    return this.config;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  /** Re-read settings after a session start or a config command. */
  reloadConfig(cwd: string): CruiseControlConfig {
    this.config = loadConfig(cwd);
    const fingerprint = configFingerprint(this.config);
    if (fingerprint !== this.fingerprint) {
      // Instructions or model changed: prior verdicts no longer reflect the rules.
      this.cache.clear();
      this.fingerprint = fingerprint;
    }
    this.cache.setConfig(this.config.cache);
    this.audit.setConfig(this.config.log);
    return this.config;
  }

  async pruneLogs(): Promise<number> {
    return this.audit.prune();
  }

  async flushLogs(): Promise<void> {
    await this.audit.flush();
  }

  /** Classify one tool call and record it. Never throws. */
  async evaluate(event: ToolCallEvent, ctx: ExtensionContext): Promise<Decision> {
    const started = Date.now();
    const request: ClassificationRequest = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      cwd: ctx.cwd,
      recentPrompts: recentPrompts(ctx),
    };

    const decision = await this.decide(request, ctx, started);
    this.stats.record(event.toolName, decision);
    this.audit.record(decision, {
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      cwd: request.cwd,
      input: safeJson(request.input),
      model: resolveModel(this.config, ctx)?.id,
    });

    return decision;
  }

  private async decide(
    request: ClassificationRequest,
    ctx: ExtensionContext,
    started: number,
  ): Promise<Decision> {
    if (this.config.skipTools.includes(request.toolName)) {
      return {
        risk: "low",
        intent: "high",
        reason: "Tool is exempt from classification by configuration.",
        approved: true,
        source: "skipped",
        durationMs: Date.now() - started,
      };
    }

    const key = cacheKey(this.fingerprint, request.toolName, request.input);
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, approved: isApproved(cached), source: "cache", durationMs: Date.now() - started };
    }

    try {
      const classification = await classify(request, this.config, ctx, this.buildSignal(ctx));
      this.cache.set(key, classification);
      return {
        ...classification,
        approved: isApproved(classification),
        source: "model",
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof ClassifierError ? error.message : String(error);
      const allow = this.config.onError === "allow";
      return {
        // A failed classification carries no judgement; the fallback drives the outcome.
        risk: allow ? "low" : "high",
        intent: "low",
        reason: `Classification unavailable (${message}); ${allow ? "allowed" : "denied"} by fallback policy.`,
        approved: allow,
        source: "fallback",
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Abort the classifier when the turn is cancelled or the budget runs out, so a
   * stalled classifier cannot hold a tool call open indefinitely.
   */
  private buildSignal(ctx: ExtensionContext): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  }
}

/** Feedback handed back to the agent so it can narrow the request or escalate. */
export function blockReason(decision: Decision): string {
  return [
    `cruise-control denied this tool call (risk=${decision.risk}, intent=${decision.intent}): ${decision.reason}`,
    "Retry with a safer, narrower tool call, or use the ask tool to request human review.",
  ].join("\n");
}

function recentPrompts(ctx: ExtensionContext): string[] {
  const prompts: string[] = [];

  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0 && prompts.length < RECENT_PROMPT_COUNT; index--) {
    const entry = branch[index];
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!("role" in message) || message.role !== "user") continue;

    // User content is either a plain string or a list of text/image parts.
    const text =
      typeof message.content === "string"
        ? message.content.trim()
        : message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
    if (text) prompts.push(text);
  }

  return prompts.reverse();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
