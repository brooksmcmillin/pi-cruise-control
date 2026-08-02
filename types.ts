/** Shared vocabulary for the classifier, the gate, the cache, and the audit log. */

/** Three-point scale used for both `risk` and `intent`. */
export type Level = "low" | "medium" | "high";

export const LEVELS = ["low", "medium", "high"] as const;

/** Numeric weight used only for averaging in `cruise-control stats`. */
export const LEVEL_SCORE: Record<Level, number> = { low: 1, medium: 2, high: 3 };

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** Raw model verdict for a single tool call. */
export interface Classification {
  /** Potential impact of executing the tool call. */
  risk: Level;
  /** How clearly the user asked for this action, judged from recent prompts. */
  intent: Level;
  /** One sentence, under 20 words, fed back to the agent when the call is denied. */
  reason: string;
}

/**
 * Where a decision came from. `fallback` means classification never produced a
 * verdict (no model, timeout, bad JSON) and `onError` decided the outcome.
 */
export type DecisionSource = "cache" | "model" | "fallback" | "skipped";

export interface Decision extends Classification {
  approved: boolean;
  source: DecisionSource;
  /** Wall-clock time from gate entry to verdict, including queue wait and retries. */
  durationMs: number;
  /** Classification attempts made. 0 for cache hits and skips, 1 when no retry was needed. */
  attempts: number;
  /** Time spent waiting for a concurrency slot, in milliseconds. */
  queueMs: number;
}

/** Everything the classifier is allowed to see about a pending tool call. */
export interface ClassificationRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  cwd: string;
  /** Most recent user prompts, oldest first, used to judge intent. */
  recentPrompts: string[];
}
