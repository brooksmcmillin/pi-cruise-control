import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./classifier";
import { registerCommands } from "./commands";
import { markIntentToolsPrompted, saveGlobalField, saveGlobalIntentTools } from "./config";
import { blockReason, Gate } from "./gate";
import { registerHealthTool } from "./health";
import { notifyIfInstructionsWritten } from "./instructions-notice";
import { canPrompt, readAvailable, selectModel } from "./selectors";
import { HEALTH_TOOL_NAME } from "./types";

/** Name tokens that suggest a tool collects user answers. */
const ASK_TOKENS = new Set([
  "ask",
  "question",
  "questionnaire",
  "clarif",
  "clarify",
  "clarifying",
  "poll",
]);
/**
 * Description phrases. Kept tighter than the name match so a tool that merely
 * mentions "ask" in passing (e.g. "ask the database") is not surfaced.
 */
const ASK_DESC_PHRASES = [
  "ask the user",
  "ask user",
  "user question",
  "clarifying question",
  "questionnaire",
];

/** True if a tool's name or description looks like it collects user answers. */
function looksLikeAskTool(name: string, description: string | undefined): boolean {
  if (name.toLowerCase().split(/[^a-z]+/).some((tok) => ASK_TOKENS.has(tok))) return true;
  if (typeof description !== "string") return false;
  const desc = description.toLowerCase();
  return ASK_DESC_PHRASES.some((phrase) => desc.includes(phrase));
}

/**
 * Auto-classifies every tool call and blocks the ones that fail the policy.
 *
 * Each pending call is rated on two axes by a configurable model: `risk` (impact of
 * running it) and `intent` (how clearly the user asked for it). A call is approved
 * when risk is low, intent is high, or both are medium. Denials return a one-sentence
 * reason to the agent so it can narrow the request or escalate to a human.
 *
 * Configure under the `cruise_control` key of `~/.pi/agent/settings.json` (global) or
 * `.pi/settings.json` (project). Without that key the extension stays inactive.
 *
 *   /cruise-control                    show effective configuration
 *   /cruise-control stats              session counters and averages
 *   /cruise-control model <provider/id>
 *   /cruise-control reasoning <level>
 */
export default function (pi: ExtensionAPI) {
  const gate = new Gate(process.cwd());
  let lastContext: ExtensionContext | undefined;
  let askedForModel = false;

  registerCommands(pi, gate, () => lastContext);
  registerHealthTool(pi, gate);

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    const config = gate.reloadConfig(ctx.cwd);
    gate.stats.reset();

    if (!config.configured || !config.enabled) return;

    // Log pruning is deferred to session start so the extension holds no timers.
    void gate.pruneLogs().catch(() => undefined);

    // Offer to pick a classifier model when none is configured. Not awaited: a modal
    // must not sit in front of session startup, and the gate works meanwhile by
    // falling back to the session model.
    if (!config.model && canPrompt(ctx) && readAvailable(ctx).length > 0) {
      void promptForModel(ctx).catch(() => undefined);
      return;
    }

    notifyIfInstructionsWritten(gate, ctx);

    // First-run nudge: if an ask/question tool is installed but not in intent_tools,
    // the intent classifier would miss the user's answers. Ask once, then stop.
    if (config.model && canPrompt(ctx)) {
      void promptForIntentTools(ctx, pi).catch(() => undefined);
    }

    if (!resolveModel(config, ctx)) {
      const detail = config.model ? `"${config.model}" is unavailable` : "no model is selected";
      ctx.ui.notify(
        `cruise-control: ${detail}; tool calls will be ${config.onError === "allow" ? "allowed" : "denied"} until it resolves.`,
        "warning",
      );
    }
  });

  /** Ask once per session, and only when there is something to choose from. */
  async function promptForModel(ctx: ExtensionContext): Promise<void> {
    if (askedForModel) return;
    askedForModel = true;

    const wanted = await ctx.ui.confirm(
      "cruise-control has no classifier model",
      "It will classify tool calls with the session model. Pick a dedicated one now?",
    );
    if (!wanted) {
      ctx.ui.notify("cruise-control will use the session model (/cruise-control model to change)", "info");
      return;
    }

    const picked = await selectModel(ctx, undefined);
    if (!picked) return;

    saveGlobalField("model", picked);
    gate.reloadConfig(ctx.cwd);
    ctx.ui.notify(`cruise-control model set to ${picked}`, "info");

    // A model now exists, so the rules are worth writing down.
    notifyIfInstructionsWritten(gate, ctx);
  }

  /**
   * One-time nudge to add installed ask/question tools to `intent_tools`.
   *
   * The intent classifier only sees user-authored content. An ask tool's answer is
   * user input but arrives as a `toolResult`, so unless the tool is listed in
   * `intent_tools` the classifier misses it and a call the user just authorized can
   * still be denied.
   *
   * Detection by name/description only *surfaces candidates* — it never adds
   * anything automatically. Each candidate is confirmed individually so the user,
   * not a heuristic, decides whether a tool's results are genuinely user-authored.
   * A deceptive name can be declined. If detection finds nothing, nothing happens
   * (no flag is set), so a tool installed later still triggers the nudge.
   */
  async function promptForIntentTools(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
    const config = gate.getConfig();
    if (config.intentToolsPrompted) return;

    const known = new Set(config.intentTools);
    let tools: { name: string; description?: string }[] = [];
    try {
      tools = (pi.getAllTools?.() ?? []).map((t) => ({ name: t.name, description: t.description }));
    } catch {
      return;
    }

    const candidates = tools.filter(
      (t) => t.name !== HEALTH_TOOL_NAME && !known.has(t.name) && looksLikeAskTool(t.name, t.description),
    );
    if (candidates.length === 0) return;

    const toAdd: string[] = [];
    for (const tool of candidates) {
      const ok = await ctx.ui.confirm(
        "cruise-control: ask/question tool detected",
        `Is "${tool.name}" a tool that collects your answers? Add it to intent_tools so the intent classifier sees your replies.${tool.description ? `\n${tool.description.slice(0, 160)}` : ""}`,
      );
      if (ok) toAdd.push(tool.name);
    }

    if (toAdd.length > 0) {
      const merged = [...new Set([...config.intentTools, ...toAdd])];
      saveGlobalIntentTools(merged);
      gate.reloadConfig(ctx.cwd);
      ctx.ui.notify(`cruise-control intent_tools: ${merged.join(", ")}`, "info");
    }
    markIntentToolsPrompted();
  }

  pi.on("tool_call", async (event, ctx) => {
    lastContext = ctx;
    const config = gate.getConfig();
    if (!config.configured || !config.enabled) return;

    const decision = await gate.evaluate(event, ctx);
    if (decision.approved) return;

    return { block: true, reason: blockReason(decision) };
  });

  pi.on("session_shutdown", async () => {
    // Audit appends are queued, so drain them before the process goes away.
    await gate.flushLogs();
  });
}
