/**
 * Caps how many classifications may be in flight against the inference endpoint.
 *
 * pi already preflights sibling tool calls sequentially, so under the stock host this
 * limiter rarely engages. It exists so the ceiling is a property of this extension
 * rather than an inherited scheduling detail, and so retries — which multiply request
 * volume — cannot stack up behind a slow endpoint.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /** `limit` of 0 or less means unlimited. */
  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = limit;
    this.drain();
  }

  get queueDepth(): number {
    return this.waiting.length;
  }

  /**
   * Run `task` once a slot is free. Resolves with the queue wait so callers can
   * separate endpoint latency from time spent waiting for a turn.
   */
  async run<T>(task: () => Promise<T>): Promise<{ value: T; queueMs: number }> {
    const started = Date.now();
    await this.acquire();
    const queueMs = Date.now() - started;

    try {
      return { value: await task(), queueMs };
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.limit <= 0 || this.active < this.limit) {
      this.active += 1;
      return;
    }
    // No slot free: drain() hands one over and accounts for it before resuming us.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  /** Hand slots to waiters. Raising the limit can release several at once. */
  private drain(): void {
    while (this.waiting.length > 0 && (this.limit <= 0 || this.active < this.limit)) {
      const next = this.waiting.shift();
      if (!next) return;
      // Claim the slot synchronously on the waiter's behalf. Incrementing only after
      // the waiter resumes would let this loop hand the same slot out twice.
      this.active += 1;
      next();
    }
  }
}
