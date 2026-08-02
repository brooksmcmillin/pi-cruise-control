import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./classifier";
import { registerCommands } from "./commands";
import { blockReason, Gate } from "./gate";

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

  registerCommands(pi, gate, () => lastContext);

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    const config = gate.reloadConfig(ctx.cwd);
    gate.stats.reset();

    if (!config.configured || !config.enabled) return;

    // Log pruning is deferred to session start so the extension holds no timers.
    void gate.pruneLogs().catch(() => undefined);

    if (!resolveModel(config, ctx)) {
      const detail = config.model ? `"${config.model}" is unavailable` : "no model is selected";
      ctx.ui.notify(
        `cruise-control: ${detail}; tool calls will be ${config.onError === "allow" ? "allowed" : "denied"} until it resolves.`,
        "warning",
      );
    }
  });

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
