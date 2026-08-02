import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Config lives under the `cruise_control` key of pi's settings files, global first
 * then project, so a project can tighten or loosen the rules it inherits:
 *
 *   ~/.pi/agent/settings.json   -> global
 *   <cwd>/.pi/settings.json     -> project (wins on conflicts)
 *
 * pi's own SettingsManager re-reads the file and merges only the fields it
 * modified, so an unknown top-level key survives pi's writes and vice versa.
 */

export interface Instructions {
  background: string[];
  allow: string[];
  conditional: string[];
  deny: string[];
}

export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

export interface RetryConfig {
  /** Extra attempts after the first. 0 disables retrying. */
  attempts: number;
  /** Base backoff before the first retry; doubles per attempt, with full jitter. */
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface LogConfig {
  enabled: boolean;
  /** Absolute directory for audit logs. Defaults to `<agentDir>/cruise-control`. */
  dir: string;
  /** Daily log files older than this are pruned at session start. 0 disables pruning. */
  retentionDays: number;
}

export interface CruiseControlConfig {
  /** False leaves every tool call untouched. */
  enabled: boolean;
  /** `provider/modelId`. Falls back to the session model when unset or unresolvable. */
  model?: string;
  reasoning: ThinkingLevel;
  /** Budget for a single classification attempt; retries each get a fresh budget. */
  timeoutMs: number;
  /** What to do when classification cannot produce a verdict. */
  onError: "allow" | "deny";
  /** Tool names that bypass classification entirely. */
  skipTools: string[];
  retry: RetryConfig;
  /** Classifications allowed in flight at once. 0 means unlimited. */
  maxConcurrent: number;
  cache: CacheConfig;
  log: LogConfig;
  instructions: Instructions;
  /** True when a `cruise_control` key was found in at least one settings file. */
  configured: boolean;
  /**
   * True when a settings file supplied at least one instruction list. False means
   * `instructions` holds the built-in defaults, which nothing has written down yet.
   */
  instructionsConfigured: boolean;
}

export const SETTINGS_KEY = "cruise_control";
export const REASONING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const INSTRUCTION_LISTS = ["background", "allow", "conditional", "deny"] as const;

export const DEFAULT_INSTRUCTIONS: Instructions = {
  background: [
    "The user is doing software engineering work in a local project workspace.",
    "Read, search, and list operations inside the project workspace are normal exploratory work.",
    "Harmless, reversible shell commands such as echo, pwd, ls, and true are routine and low risk.",
    "When impact is unclear or irreversible, prefer deny so the host can escalate for human review.",
  ],
  allow: [
    "Allow read, grep, find, and ls tools for files inside the project workspace.",
    "Allow harmless shell commands that only inspect state or print output without modifying the system.",
    "Allow routine edits and writes that are clearly scoped to the current project task.",
  ],
  conditional: [
    "Allow git commands that inspect or commit locally, but treat push and history rewrite as higher risk.",
    "Allow package installs only when they target the current project and do not elevate privileges.",
    "Deny when a command mixes a mostly safe operation with a clearly destructive flag or target.",
  ],
  deny: [
    "Deny recursive force deletes such as rm -rf or equivalent recursive wipe commands.",
    "Deny DROP DATABASE, DROP SCHEMA CASCADE, and TRUNCATE TABLE against real data stores.",
    "Deny force-push to main or master.",
    "Deny filesystem format commands such as mkfs and dd writes to device paths.",
    "Deny commands that exfiltrate secrets or modify production infrastructure.",
  ],
};

function defaults(): CruiseControlConfig {
  return {
    enabled: true,
    model: undefined,
    // Gate decisions are cheap relative to the tool calls they guard, and a shallow
    // read of a mixed safe/destructive command is exactly how a bad approval happens.
    reasoning: "high",
    timeoutMs: 20_000,
    onError: "deny",
    skipTools: [],
    retry: { attempts: 2, initialDelayMs: 500, maxDelayMs: 4000 },
    maxConcurrent: 0,
    cache: { enabled: true, ttlMs: 30 * 60_000, maxEntries: 500 },
    log: { enabled: true, dir: join(getAgentDir(), "cruise-control"), retentionDays: 30 },
    // Copied, not shared: applySection() replaces lists in place, and a mutated
    // module-level default would leak across every later load.
    instructions: structuredClone(DEFAULT_INSTRUCTIONS),
    configured: false,
    instructionsConfigured: false,
  };
}

type RawRecord = Record<string, unknown>;

export function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

/**
 * Read and merge the `cruise_control` section from the global and project settings
 * files. Unreadable or malformed files are ignored so a bad edit degrades to
 * defaults instead of breaking every tool call.
 */
export function loadConfig(cwd: string): CruiseControlConfig {
  const config = defaults();
  const scopes = [readSection(globalSettingsPath()), readSection(projectSettingsPath(cwd))];

  for (const raw of scopes) {
    if (!raw) continue;
    config.configured = true;
    applySection(config, raw);
  }

  return config;
}

/**
 * Persist a single scalar field to the global settings file, preserving everything else.
 *
 * Writing the `cruise_control` section is safe alongside pi's own settings writes: pi
 * re-reads the file and merges only the fields it modified, so neither side clobbers
 * the other.
 */
export function saveGlobalField(field: "model" | "reasoning" | "enabled", value: string | boolean): void {
  writeGlobalSection((section) => {
    section[field] = value;
  });
}

/**
 * Write the built-in rules into the global settings file so they stop being invisible
 * defaults and become text the user can read and edit.
 *
 * Only ever called when no settings file supplied instructions, so this cannot
 * overwrite hand-written rules.
 */
export function saveGlobalInstructions(instructions: Instructions = DEFAULT_INSTRUCTIONS): void {
  writeGlobalSection((section) => {
    section.instructions = structuredClone(instructions);
  });
}

function writeGlobalSection(mutate: (section: RawRecord) => void): void {
  const path = globalSettingsPath();
  const settings = readJson(path) ?? {};
  const existing = settings[SETTINGS_KEY];
  const section: RawRecord =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as RawRecord) } : {};

  mutate(section);
  settings[SETTINGS_KEY] = section;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Fingerprint of everything that changes a verdict. Cache entries carry it so a
 * settings edit invalidates previously cached approvals instead of outliving them.
 */
export function configFingerprint(config: CruiseControlConfig): string {
  const material = JSON.stringify([config.model, config.reasoning, config.instructions]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function applySection(config: CruiseControlConfig, raw: RawRecord): void {
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
  if (isReasoning(raw.reasoning)) config.reasoning = raw.reasoning;
  if (isPositiveNumber(raw.timeout_ms)) config.timeoutMs = raw.timeout_ms;
  if (raw.on_error === "allow" || raw.on_error === "deny") config.onError = raw.on_error;
  if (Array.isArray(raw.skip_tools)) config.skipTools = stringArray(raw.skip_tools);

  // `parallel` is the coarse switch (false means one at a time); `max_concurrent` is the
  // precise value and is applied second so it wins whenever both appear in one scope.
  if (raw.parallel === false) config.maxConcurrent = 1;
  else if (raw.parallel === true) config.maxConcurrent = 0;
  if (typeof raw.max_concurrent === "number" && raw.max_concurrent >= 0) {
    config.maxConcurrent = Math.floor(raw.max_concurrent);
  }

  const retry = section(raw.retry);
  if (retry) {
    if (typeof retry.attempts === "number" && retry.attempts >= 0) {
      config.retry.attempts = Math.floor(retry.attempts);
    }
    if (isPositiveNumber(retry.initial_delay_ms)) config.retry.initialDelayMs = retry.initial_delay_ms;
    if (isPositiveNumber(retry.max_delay_ms)) config.retry.maxDelayMs = retry.max_delay_ms;
  }

  const cache = section(raw.cache);
  if (cache) {
    if (typeof cache.enabled === "boolean") config.cache.enabled = cache.enabled;
    if (isPositiveNumber(cache.ttl_ms)) config.cache.ttlMs = cache.ttl_ms;
    if (isPositiveNumber(cache.max_entries)) config.cache.maxEntries = Math.floor(cache.max_entries);
  }

  const log = section(raw.log);
  if (log) {
    if (typeof log.enabled === "boolean") config.log.enabled = log.enabled;
    if (typeof log.dir === "string" && log.dir.trim()) config.log.dir = log.dir.trim();
    if (typeof log.retention_days === "number" && log.retention_days >= 0) {
      config.log.retentionDays = Math.floor(log.retention_days);
    }
  }

  const instructions = section(raw.instructions);
  if (instructions) {
    // Each list is replaced wholesale rather than concatenated: a project that
    // overrides `deny` means "these are the deny rules", not "also these".
    for (const key of INSTRUCTION_LISTS) {
      const list = instructions[key];
      if (!Array.isArray(list)) continue;
      config.instructions[key] = stringArray(list);
      config.instructionsConfigured = true;
    }
  }
}

function readSection(path: string): RawRecord | undefined {
  const settings = readJson(path);
  return settings ? section(settings[SETTINGS_KEY]) : undefined;
}

function readJson(path: string): RawRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return section(parsed);
  } catch {
    return undefined;
  }
}

function section(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : undefined;
}

function stringArray(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isReasoning(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}
