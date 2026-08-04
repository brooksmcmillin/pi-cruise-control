import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classify, ClassifierError, resolveModel } from "./classifier";
import type { Gate } from "./gate";
import type { SessionStats } from "./stats";
import { HEALTH_TOOL_NAME } from "./types";
import type { Classification, ClassificationRequest } from "./types";

/**
 * The agent calls `cruise_control_health` to find out whether the classifier is
 * working. It checks configuration, model resolution, and cache state, then runs a
 * live probe: one real classification of a benign `read` call against the configured
 * model. A healthy classifier approves that call; anything else is a concrete fault
 * the report surfaces with a reason.
 *
 * The tool is exempt from the gate itself (see `Gate.decide`), so a classifier that
 * is down, unconfigured, or missing credentials still gets reported instead of
 * blocking the diagnostic with its own fallback denial.
 */
export function registerHealthTool(pi: ExtensionAPI, gate: Gate): void {
  pi.registerTool({
    name: HEALTH_TOOL_NAME,
    label: "Cruise Control Health",
    description:
      "Run a health check on the cruise-control tool-use classifier: configuration state, model resolution, cache status, and a live probe classification with latency. Read-only; always runs even when classification is failing.",
    promptSnippet: "Check whether the cruise-control classifier is healthy",
    promptGuidelines: [
      "Use cruise_control_health to verify the cruise-control classifier is configured, its model resolves, and a live probe classification succeeds.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const config = gate.getConfig();
      const started = Date.now();
      const model = resolveModel(config, ctx);

      const report: HealthReport = {
        tool: HEALTH_TOOL_NAME,
        active: config.configured && config.enabled,
        configured: config.configured,
        enabled: config.enabled,
        model: model ? { source: config.model ? "configured" : "session", id: `${model.provider}/${model.id}` } : undefined,
        modelConfigured: config.model,
        reasoning: config.reasoning,
        onError: config.onError,
        probe: undefined,
        error: undefined,
        cache: { enabled: config.cache.enabled, size: gate.cacheSize, maxEntries: config.cache.maxEntries },
        stats: gate.stats.snapshot(),
        durationMs: 0,
      };

      // The probe only makes sense once there is a model to classify with. An
      // inactive or model-less setup is a configuration state, not an endpoint fault.
      if (!model) {
        report.error = config.model
          ? `configured model "${config.model}" does not resolve in the model registry`
          : "no classifier model selected (configure one with /cruise-control model)";
        return toolResult(report);
      }

      // Time the probe against the same per-attempt budget a real call gets, and
      // stop early if the turn is cancelled.
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const classification = await classify(probeRequest(ctx), config, ctx, probeSignal);
        report.probe = {
          ok: true,
          durationMs: Date.now() - started,
          classification,
          expected: "approved (low risk)",
        };
      } catch (error) {
        report.probe = {
          ok: false,
          durationMs: Date.now() - started,
          error: {
            message: error instanceof Error ? error.message : String(error),
            retryable: error instanceof ClassifierError && error.retryable,
          },
        };
      }

      report.durationMs = Date.now() - started;
      return toolResult(report);
    },
  });
}

interface HealthReport {
  tool: string;
  /** True when the gate is actually classifying calls right now. */
  active: boolean;
  configured: boolean;
  enabled: boolean;
  model?: { source: "configured" | "session"; id: string };
  modelConfigured?: string;
  reasoning: string;
  onError: "allow" | "deny";
  probe?: {
    ok: boolean;
    durationMs: number;
    classification?: Classification;
    expected?: string;
    error?: { message: string; retryable: boolean };
  };
  error?: string;
  cache: { enabled: boolean; size: number; maxEntries: number };
  stats: SessionStats;
  durationMs: number;
}

/** A benign `read` inside the workspace: any functioning classifier approves it. */
function probeRequest(ctx: ExtensionContext): ClassificationRequest {
  return {
    toolName: "read",
    toolCallId: `cruise-control-health-probe`,
    input: { path: join(ctx.cwd, "README.md") },
    cwd: ctx.cwd,
    recentPrompts: ["Run a health check on the cruise-control classifier."],
  };
}

function toolResult(report: HealthReport) {
  return {
    content: [{ type: "text" as const, text: formatReport(report) }],
    details: report,
  };
}

function formatReport(report: HealthReport): string {
  const lines = [`cruise-control health: ${healthLabel(report)}`];

  lines.push(
    report.model
      ? `  model      ${report.model.id} (${report.model.source})`
      : "  model      none",
    `  reasoning  ${report.reasoning}`,
    `  fallback   on classification failure: ${report.onError}`,
  );

  const cache = report.cache;
  lines.push(`  cache      ${cache.enabled ? `${cache.size}/${cache.maxEntries} entries` : "off"}`);

  const stats = report.stats;
  if (stats.total > 0) {
    lines.push(
      `  session    ${stats.total} classified (${stats.approved} approved, ${stats.rejected} rejected), ${stats.cacheHits} cache hits, ${stats.fallbacks} fallbacks`,
    );
  } else {
    lines.push("  session    nothing classified yet");
  }

  const probe = report.probe;
  if (probe) {
    if (probe.ok && probe.classification) {
      const verdict = probe.classification;
      lines.push(
        `  probe      read → ${verdict.risk} risk, ${verdict.intent} intent (${formatMs(probe.durationMs)}): ${verdict.reason}`,
      );
    } else if (probe.error) {
      lines.push(
        `  probe      FAILED in ${formatMs(probe.durationMs)}: ${probe.error.message}${probe.error.retryable ? " (retryable)" : ""}`,
      );
    }
  }

  if (report.error) lines.push(`  fault      ${report.error}`);

  return lines.join("\n");
}

function healthLabel(report: HealthReport): string {
  if (!report.configured) return "INACTIVE - not configured (/cruise-control on to start with default rules)";
  if (!report.enabled) return "DISABLED - off, tool calls run unclassified (/cruise-control on to enable)";

  if (report.error) return `UNHEALTHY - ${report.error}`;

  const probe = report.probe;
  if (!probe) return "UNKNOWN - no probe result";
  if (!probe.ok) {
    return `UNHEALTHY - probe ${probe.error?.retryable ? "failed (transient)" : "failed (configuration)"}: ${probe.error?.message}`;
  }
  return `HEALTHY - probe classified a benign read in ${formatMs(probe.durationMs)}`;
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}
