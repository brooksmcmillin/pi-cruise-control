import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./classifier";
import { isReasoning, REASONING_LEVELS, saveGlobalField } from "./config";
import type { Gate } from "./gate";
import { notifyIfInstructionsWritten } from "./instructions-notice";
import { canPrompt, readAvailable, selectModel, selectReasoning } from "./selectors";
import type { SessionStats } from "./stats";
import { LEVELS, type Level } from "./types";

const SUBCOMMANDS = [
  { value: "on", label: "on - classify tool calls" },
  { value: "off", label: "off - let every tool call through unclassified" },
  { value: "stats", label: "stats - session classification counters" },
  { value: "model", label: "model [provider/id] - pick or set the classifier model" },
  { value: "reasoning", label: "reasoning [level] - pick or set the classifier reasoning level" },
];

/**
 * `/cruise-control` with no argument reports the effective configuration; `on`, `off`,
 * `stats`, `model`, and `reasoning` are the documented subcommands. Everything except
 * `stats` writes to the global settings file and takes effect immediately.
 */
export function registerCommands(pi: ExtensionAPI, gate: Gate, getContext: () => ExtensionContext | undefined): void {
  pi.registerCommand("cruise-control", {
    description: "Inspect and configure the cruise-control tool-use classifier",
    getArgumentCompletions: (prefix) => completions(prefix, getContext()),
    handler: async (args, ctx) => {
      const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const value = rest.join(" ");

      switch (subcommand) {
        case "":
          ctx.ui.notify(formatConfig(gate, ctx), "info");
          return;

        case "stats":
          ctx.ui.notify(formatStats(gate.stats.snapshot()), "info");
          return;

        case "on":
        case "off": {
          const enable = subcommand === "on";
          // Turning it on when no section exists writes one, which is what makes the
          // extension active at all — so say which rules the user just opted into.
          const bootstrapped = enable && !gate.getConfig().configured;
          saveGlobalField("enabled", enable);
          const config = gate.reloadConfig(ctx.cwd);

          // The write lands in the global file, which a project file outranks. Say so
          // rather than reporting a state change that did not happen.
          if (config.enabled !== enable) {
            ctx.ui.notify(
              `Wrote enabled=${enable} globally, but this project's .pi/settings.json overrides it. Still ${config.enabled ? "on" : "off"} here.`,
              "warning",
            );
            return;
          }

          if (!enable) {
            ctx.ui.notify("cruise-control off - tool calls run unclassified", "info");
            return;
          }
          if (bootstrapped) {
            ctx.ui.notify("cruise-control on - classifying with the built-in default rules", "info");
            return;
          }
          if (!resolveModel(config, ctx)) {
            ctx.ui.notify("cruise-control on, but no classifier model is available yet", "warning");
            return;
          }
          ctx.ui.notify("cruise-control on - classifying tool calls", "info");

          // Enabling can be the step that completes setup.
          notifyIfInstructionsWritten(gate, ctx);
          return;
        }

        case "model": {
          const chosen = value || (await pickModel(gate, ctx));
          if (!chosen) return;

          saveGlobalField("model", chosen);
          const config = gate.reloadConfig(ctx.cwd);
          const resolved = resolveModel(config, ctx);
          if (resolved) ctx.ui.notify(`cruise-control model set to ${chosen}`, "info");
          else ctx.ui.notify(`cruise-control model set to ${chosen}, but it is not available yet`, "warning");

          // Choosing a model can be the step that completes setup.
          notifyIfInstructionsWritten(gate, ctx);
          return;
        }

        case "reasoning": {
          let level = value;
          if (!level) {
            if (!canPrompt(ctx)) {
              ctx.ui.notify(`Usage: /cruise-control reasoning <${REASONING_LEVELS.join("|")}>`, "warning");
              return;
            }
            const picked = await selectReasoning(ctx, gate.getConfig().reasoning);
            if (!picked) return;
            level = picked;
          }
          if (!isReasoning(level)) {
            ctx.ui.notify(`Usage: /cruise-control reasoning <${REASONING_LEVELS.join("|")}>`, "warning");
            return;
          }

          saveGlobalField("reasoning", level);
          gate.reloadConfig(ctx.cwd);
          ctx.ui.notify(`cruise-control reasoning set to ${level}`, "info");
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand "${subcommand}". Try on, off, stats, model, or reasoning.`,
            "warning",
          );
      }
    },
  });
}

/**
 * Offer the models whose providers have resolved auth — the same set pi treats as
 * usable — so `/cruise-control model` is a pick list rather than a name to remember.
 * Returns undefined when the user cancels or there is nothing to pick from.
 */
async function pickModel(gate: Gate, ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (readAvailable(ctx).length === 0) {
    ctx.ui.notify(
      "No models available - log in to a provider, or name one directly: /cruise-control model <provider/model-id>",
      "warning",
    );
    return undefined;
  }

  if (!canPrompt(ctx)) {
    ctx.ui.notify("Usage: /cruise-control model <provider/model-id>", "warning");
    return undefined;
  }

  return selectModel(ctx, gate.getConfig().model);
}

function completions(prefix: string, ctx: ExtensionContext | undefined): AutocompleteItem[] | null {
  const [subcommand = "", ...rest] = prefix.split(/\s+/);
  const started = /\s/.test(prefix);

  if (!started) {
    const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(subcommand));
    return matches.length > 0 ? matches : null;
  }

  const argument = rest.join(" ");

  if (subcommand === "reasoning") {
    const matches = REASONING_LEVELS.filter((level) => level.startsWith(argument)).map((level) => ({
      value: `reasoning ${level}`,
      label: level,
    }));
    return matches.length > 0 ? matches : null;
  }

  if (subcommand === "model" && ctx) {
    try {
      const matches = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
        .filter((name) => name.startsWith(argument))
        .slice(0, 50)
        .map((name) => ({ value: `model ${name}`, label: name }));
      return matches.length > 0 ? matches : null;
    } catch {
      // The captured context goes stale across session replacement or /reload.
      // Completions are a convenience; never let a stale read break the prompt.
      return null;
    }
  }

  return null;
}

function formatConfig(gate: Gate, ctx: ExtensionContext): string {
  const config = gate.getConfig();
  const resolved = resolveModel(config, ctx);
  const status = !config.configured
    ? "inactive - not configured (/cruise-control on to start with default rules)"
    : config.enabled
      ? "on"
      : "off (/cruise-control on to enable)";

  const model = config.model
    ? `${config.model}${resolved ? "" : " (unavailable)"}`
    : `session model${resolved ? ` (${resolved.provider}/${resolved.id})` : " (none selected)"}`;

  const rules = config.instructions;
  const lines = [
    "cruise-control - configuration",
    `  status     ${status}`,
    `  model      ${model}`,
    `  reasoning  ${config.reasoning}`,
    `  timeout    ${config.timeoutMs}ms per attempt, on failure: ${config.onError}`,
    `  retry      ${config.retry.attempts > 0 ? `up to ${config.retry.attempts} retries, backoff ${config.retry.initialDelayMs}-${config.retry.maxDelayMs}ms` : "off"}`,
    `  parallel   ${config.maxConcurrent === 0 ? "unlimited" : config.maxConcurrent === 1 ? "off (one at a time)" : `max ${config.maxConcurrent} in flight`}`,
    `  cache      ${config.cache.enabled ? `on, ttl ${formatDuration(config.cache.ttlMs)}, ${gate.cacheSize}/${config.cache.maxEntries} entries` : "off"}`,
    `  log        ${config.log.enabled ? `on, ${config.log.retentionDays}d retention, ${config.log.dir}` : "off"}`,
    `  rules      background ${rules.background.length}, allow ${rules.allow.length}, conditional ${rules.conditional.length}, deny ${rules.deny.length}`,
  ];

  if (config.skipTools.length > 0) lines.push(`  skipped    ${config.skipTools.join(", ")}`);
  return lines.join("\n");
}

function formatStats(stats: SessionStats): string {
  if (stats.total === 0) return "cruise-control - no tool calls classified in this session yet";

  const lines = [
    "cruise-control - session stats",
    `  classified ${stats.total} (approved ${stats.approved}, rejected ${stats.rejected})`,
    `  sources    cache ${stats.cacheHits}, fallback ${stats.fallbacks}, skipped ${stats.skipped}`,
    `  avg risk   ${formatAverage(stats.averageRisk)}`,
    `  avg intent ${formatAverage(stats.averageIntent)}`,
    `  risk       ${formatCounts(stats.riskCounts)}`,
    `  intent     ${formatCounts(stats.intentCounts)}`,
    `  latency    avg ${formatMs(stats.averageLatencyMs)} over ${formatMs(stats.totalLatencyMs)} total`,
  ];

  if (stats.retries > 0) {
    lines.push(`  retries    ${stats.retries} across ${stats.retriedDecisions} decisions`);
  }
  if (stats.totalQueueMs > 0) {
    lines.push(`  queued     ${formatMs(stats.totalQueueMs)} waiting for a slot`);
  }

  if (stats.byTool.length > 0) {
    const tools = stats.byTool
      .slice(0, 8)
      .map((tool) => `${tool.toolName} ${tool.approved}/${tool.approved + tool.rejected}`)
      .join(", ");
    lines.push(`  by tool    ${tools}`);
  }

  return lines.join("\n");
}

function formatAverage(average: number | null): string {
  if (average === null) return "n/a";
  // Round to the nearest level so the number has a label next to it.
  const nearest = LEVELS[Math.min(LEVELS.length - 1, Math.max(0, Math.round(average) - 1))] as Level;
  return `${average.toFixed(2)} (${nearest})`;
}

function formatCounts(counts: Record<Level, number>): string {
  return LEVELS.map((level) => `${level} ${counts[level]}`).join(", ");
}

function formatMs(value: number | null): string {
  if (value === null) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function formatDuration(ms: number): string {
  if (ms >= 3600_000) return `${(ms / 3600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}
