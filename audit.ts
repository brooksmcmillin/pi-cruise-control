import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LogConfig } from "./config";
import type { Decision } from "./types";

const FILE_PREFIX = "cruise-control-";
const FILE_SUFFIX = ".jsonl";
const DAY_MS = 24 * 60 * 60_000;
/** Tool input is recorded for auditing, but a large write payload should not bloat the log. */
const MAX_LOGGED_INPUT_CHARS = 2000;

export interface AuditRecord {
  timestamp: string;
  toolName: string;
  toolCallId: string;
  cwd: string;
  input: string;
  approved: boolean;
  risk: string;
  intent: string;
  reason: string;
  source: string;
  durationMs: number;
  model?: string;
  error?: string;
}

/**
 * Append-only JSONL audit trail, one file per UTC day under `log.dir`.
 *
 * Writes are chained onto a single promise so concurrent tool calls cannot interleave
 * partial lines, and every failure is swallowed: an unwritable log directory must not
 * be able to stall or fail a tool call.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private directoryReady = false;

  constructor(private config: LogConfig) {}

  setConfig(config: LogConfig): void {
    if (config.dir !== this.config.dir) this.directoryReady = false;
    this.config = config;
  }

  record(decision: Decision, details: Omit<AuditRecord, keyof Decision | "timestamp">): void {
    if (!this.config.enabled) return;

    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      ...details,
      input: truncate(details.input, MAX_LOGGED_INPUT_CHARS),
      approved: decision.approved,
      risk: decision.risk,
      intent: decision.intent,
      reason: decision.reason,
      source: decision.source,
      durationMs: decision.durationMs,
    };

    this.queue = this.queue
      .then(async () => {
        await this.ensureDirectory();
        await appendFile(this.filePath(new Date()), `${JSON.stringify(record)}\n`, "utf8");
      })
      .catch(() => undefined);
  }

  /** Wait for queued appends to land. Used by `session_shutdown` so no record is lost. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Delete daily files older than `retentionDays`. Called at session start rather than
   * on a timer so the extension never holds a background resource.
   */
  async prune(): Promise<number> {
    if (this.config.retentionDays <= 0) return 0;

    const cutoff = Date.now() - this.config.retentionDays * DAY_MS;
    let removed = 0;

    try {
      const files = await readdir(this.config.dir);
      for (const name of files) {
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
        const path = join(this.config.dir, name);
        const info = await stat(path).catch(() => undefined);
        if (!info || info.mtimeMs >= cutoff) continue;
        await unlink(path).catch(() => undefined);
        removed += 1;
      }
    } catch {
      // Missing directory just means nothing has been logged yet.
      return removed;
    }

    return removed;
  }

  filePath(date: Date): string {
    return join(this.config.dir, `${FILE_PREFIX}${date.toISOString().slice(0, 10)}${FILE_SUFFIX}`);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    await mkdir(this.config.dir, { recursive: true });
    this.directoryReady = true;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`;
}
