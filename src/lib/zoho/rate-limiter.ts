import { ConnectorError } from "./errors";

export interface RateLimiter {
  /** Resolves when a request may be sent; throws RATE_LIMITED if the wait would be too long. */
  acquire(bucketKey: string): Promise<void>;
}

export type TakeTokenFn = (
  bucketKey: string,
  capacity: number,
  refillPerSec: number,
  /** Aborted when the caller's wait budget runs out; implementations should cancel the round trip. */
  signal: AbortSignal,
) => Promise<{ allowed: boolean; retryAfterMs: number }>;

export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  /** Longest we'll hold an agent's tool call waiting for capacity before failing fast (wall clock). */
  maxWaitMs: number;
  /**
   * Floor between polls. Under contention the bucket reports tiny waits
   * (a fraction of a token is already there); polling that often only adds
   * database load. Jitter is added on top.
   */
  minPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onBackendError?: (err: unknown) => void;
}

/**
 * Zoho Inventory allows 100 requests/minute per organization. A bucket of 10
 * refilling at 1.5/s can never exceed 10 + 90 = 100 requests in any 60s window.
 * Daily quotas depend on the merchant's Zoho plan and are handled reactively
 * (Zoho's 429 surfaces to the agent as RATE_LIMITED).
 */
export const ZOHO_ORG_LIMIT: Omit<TokenBucketOptions, "sleep" | "now" | "onBackendError"> = {
  capacity: 10,
  refillPerSec: 1.5,
  // Short on purpose. A waiting request still occupies a server slot, and in
  // production load tests a burst of held requests delayed the requests queued
  // behind them. Agents handle a fast RATE_LIMITED + retry_after_ms better
  // than a silent 10s+ wait.
  maxWaitMs: 4_000,
  minPollMs: 200,
};

/**
 * Token bucket whose state lives in Postgres, so every serverless instance
 * shares one budget per Zoho organization. An in-memory limiter would give
 * each instance its own budget and overshoot Zoho's limit under load.
 *
 * Within one instance, callers for the same bucket queue in memory and only
 * the head of the queue talks to Postgres. Load testing showed why: 40
 * concurrent callers each polling the bucket turned an ~80ms RPC into ~3s,
 * because every poll is a small write transaction. With the local queue, an
 * instance makes one bucket call at a time per organization, in FIFO order.
 */
export class SharedTokenBucket implements RateLimiter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Tail of the in-process FIFO queue per bucket key. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly takeToken: TakeTokenFn,
    private readonly opts: TokenBucketOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async acquire(bucketKey: string): Promise<void> {
    // Measured on the wall clock: queueing and database round trips count
    // against the budget, not just the sleeps between polls.
    const deadline = this.now() + this.opts.maxWaitMs;

    const ahead = this.queues.get(bucketKey) ?? Promise.resolve();
    let leave!: () => void;
    const mine = new Promise<void>((resolve) => (leave = resolve));
    const tail = ahead.then(() => mine);
    this.queues.set(bucketKey, tail);

    try {
      await this.waitForTurn(ahead, deadline);
      await this.takeShared(bucketKey, deadline);
    } finally {
      leave();
      if (this.queues.get(bucketKey) === tail) this.queues.delete(bucketKey);
    }
  }

  private async waitForTurn(ahead: Promise<void>, deadline: number) {
    if (!Number.isFinite(deadline)) return ahead;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - this.now()));
    });
    const result = await Promise.race([ahead.then(() => "turn" as const), timedOut]);
    clearTimeout(timer);
    if (result === "timeout") throw rateLimited(2_000);
  }

  private async takeShared(bucketKey: string, deadline: number) {
    while (true) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw rateLimited(2_000);

      const signal = Number.isFinite(remaining) ? AbortSignal.timeout(remaining) : new AbortController().signal;
      let result: { allowed: boolean; retryAfterMs: number };
      try {
        result = await this.takeToken(bucketKey, this.opts.capacity, this.opts.refillPerSec, signal);
      } catch (err) {
        if (signal.aborted) throw rateLimited(2_000);
        // Fail open: if the limiter's database is unavailable, still serve the
        // request. Zoho's own 429s remain the backstop and are retried by the client.
        this.opts.onBackendError?.(err);
        return;
      }
      if (result.allowed) return;

      const minPoll = this.opts.minPollMs ?? 0;
      const wait = Math.max(result.retryAfterMs, minPoll) + Math.floor(Math.random() * (minPoll + 100));
      if (this.now() + wait > deadline) throw rateLimited(Math.max(result.retryAfterMs, 2_000));
      await this.sleep(wait);
    }
  }
}

function rateLimited(retryAfterMs: number) {
  // Others are queued too, so the real wait is longer than one token's refill.
  return new ConnectorError("RATE_LIMITED", "Connector is at Zoho's per-minute request limit", { retryAfterMs });
}
