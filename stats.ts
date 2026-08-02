import { type Decision, LEVEL_SCORE, type Level } from "./types";

export interface SessionStats {
  total: number;
  approved: number;
  rejected: number;
  cacheHits: number;
  fallbacks: number;
  skipped: number;
  /** Averages over classified calls only (cache hits included, skips excluded). */
  averageRisk: number | null;
  averageIntent: number | null;
  riskCounts: Record<Level, number>;
  intentCounts: Record<Level, number>;
  byTool: { toolName: string; approved: number; rejected: number }[];
  totalLatencyMs: number;
  averageLatencyMs: number | null;
}

/**
 * Per-session counters behind `cruise-control stats`. Reset on `session_start` so
 * the numbers always describe the session in front of the user, not the process.
 */
export class StatsTracker {
  private total = 0;
  private approved = 0;
  private cacheHits = 0;
  private fallbacks = 0;
  private skipped = 0;
  private scored = 0;
  private riskSum = 0;
  private intentSum = 0;
  private latencySum = 0;
  private readonly riskCounts: Record<Level, number> = { low: 0, medium: 0, high: 0 };
  private readonly intentCounts: Record<Level, number> = { low: 0, medium: 0, high: 0 };
  private readonly tools = new Map<string, { approved: number; rejected: number }>();

  reset(): void {
    this.total = 0;
    this.approved = 0;
    this.cacheHits = 0;
    this.fallbacks = 0;
    this.skipped = 0;
    this.scored = 0;
    this.riskSum = 0;
    this.intentSum = 0;
    this.latencySum = 0;
    for (const level of ["low", "medium", "high"] as const) {
      this.riskCounts[level] = 0;
      this.intentCounts[level] = 0;
    }
    this.tools.clear();
  }

  record(toolName: string, decision: Decision): void {
    this.total += 1;
    if (decision.approved) this.approved += 1;
    if (decision.source === "cache") this.cacheHits += 1;
    if (decision.source === "fallback") this.fallbacks += 1;
    if (decision.source === "skipped") this.skipped += 1;
    this.latencySum += decision.durationMs;

    // A fallback verdict carries no model judgement, so it must not move the averages.
    if (decision.source === "model" || decision.source === "cache") {
      this.scored += 1;
      this.riskSum += LEVEL_SCORE[decision.risk];
      this.intentSum += LEVEL_SCORE[decision.intent];
      this.riskCounts[decision.risk] += 1;
      this.intentCounts[decision.intent] += 1;
    }

    const tool = this.tools.get(toolName) ?? { approved: 0, rejected: 0 };
    if (decision.approved) tool.approved += 1;
    else tool.rejected += 1;
    this.tools.set(toolName, tool);
  }

  snapshot(): SessionStats {
    return {
      total: this.total,
      approved: this.approved,
      rejected: this.total - this.approved,
      cacheHits: this.cacheHits,
      fallbacks: this.fallbacks,
      skipped: this.skipped,
      averageRisk: this.scored > 0 ? this.riskSum / this.scored : null,
      averageIntent: this.scored > 0 ? this.intentSum / this.scored : null,
      riskCounts: { ...this.riskCounts },
      intentCounts: { ...this.intentCounts },
      byTool: [...this.tools.entries()]
        .map(([toolName, counts]) => ({ toolName, ...counts }))
        .sort((a, b) => b.approved + b.rejected - (a.approved + a.rejected)),
      totalLatencyMs: this.latencySum,
      averageLatencyMs: this.total > 0 ? this.latencySum / this.total : null,
    };
  }
}
