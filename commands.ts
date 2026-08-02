import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./classifier";
import { isReasoning, REASONING_LEVELS, saveGlobalField } from "./config";
import type { Gate } from "./gate";
import type { SessionStats } from "./stats";
import { LEVELS, type Level } from "./types";

const SUBCOMMANDS = [
  { value: "stats", label: "stats - session classification counters" },
  { value: "model", label: "model <provider/id> - set the classifier model" },
  { value: "reasoning", label: "reasoning <level> - set the classifier reasoning level" },
];

/**
 * `/cruise-control` with no argument reports the effective configuration;
 * `stats`, `model`, and `reasoning` are the documented subcommands. `model` and
 * `reasoning` write to the global settings file and take effect immediately.
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

        case "model": {
          if (!value) {
            ctx.ui.notify("Usage: /cruise-control model <provider/model-id>", "warning");
            return;
          }
          saveGlobalField("model", value);
          const config = gate.reloadConfig(ctx.cwd);
          const resolved = resolveModel(config, ctx);
          if (resolved) ctx.ui.notify(`cruise-control model set to ${value}`, "info");
          else ctx.ui.notify(`cruise-control model set to ${value}, but it is not available yet`, "warning");
          return;
        }

        case "reasoning": {
          if (!isReasoning(value)) {
            ctx.ui.notify(`Usage: /cruise-control reasoning <${REASONING_LEVELS.join("|")}>`, "warning");
            return;
          }
          saveGlobalField("reasoning", value);
          gate.reloadConfig(ctx.cwd);
          ctx.ui.notify(`cruise-control reasoning set to ${value}`, "info");
          return;
        }

        default:
          ctx.ui.notify(`Unknown subcommand "${subcommand}". Try stats, model, or reasoning.`, "warning");
      }
    },
  });
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
    ? "inactive - no cruise_control section in settings.json"
    : config.enabled
      ? "active"
      : "disabled by config";

  const model = config.model
    ? `${config.model}${resolved ? "" : " (unavailable)"}`
    : `session model${resolved ? ` (${resolved.provider}/${resolved.id})` : " (none selected)"}`;

  const rules = config.instructions;
  const lines = [
    "cruise-control - configuration",
    `  status     ${status}`,
    `  model      ${model}`,
    `  reasoning  ${config.reasoning}`,
    `  timeout    ${config.timeoutMs}ms, on failure: ${config.onError}`,
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
