import { ConnectorError } from "./errors";

export interface RateLimiter {
  /** Resolves when a request may be sent; throws RATE_LIMITED if the wait would be too long. */
  acquire(bucketKey: string): Promise<void>;
}

export type TakeTokenFn = (
  bucketKey: string,
  capacity: number,
  refillPerSec: number,
) => Promise<{ allowed: boolean; retryAfterMs: number }>;

export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  /** Longest we'll hold an agent's tool call waiting for capacity before failing fast. */
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<void>;
  onBackendError?: (err: unknown) => void;
}

/**
 * Zoho Inventory allows 100 requests/minute per organization. A bucket of 10
 * refilling at 1.5/s can never exceed 10 + 90 = 100 requests in any 60s window.
 * Daily quotas depend on the merchant's Zoho plan and are handled reactively
 * (Zoho's 429 surfaces to the agent as RATE_LIMITED).
 */
export const ZOHO_ORG_LIMIT: Omit<TokenBucketOptions, "sleep" | "onBackendError"> = {
  capacity: 10,
  refillPerSec: 1.5,
  maxWaitMs: 8_000,
};

/**
 * Token bucket whose state lives in Postgres, so every serverless instance
 * shares one budget per Zoho organization. An in-memory limiter would give
 * each instance its own budget and overshoot Zoho's limit under load.
 */
export class SharedTokenBucket implements RateLimiter {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly takeToken: TakeTokenFn,
    private readonly opts: TokenBucketOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async acquire(bucketKey: string): Promise<void> {
    let waited = 0;
    while (true) {
      let result: { allowed: boolean; retryAfterMs: number };
      try {
        result = await this.takeToken(bucketKey, this.opts.capacity, this.opts.refillPerSec);
      } catch (err) {
        // Fail open: if the limiter's database is unavailable, still serve the
        // request. Zoho's own 429s remain the backstop and are retried below.
        this.opts.onBackendError?.(err);
        return;
      }
      if (result.allowed) return;

      const wait = result.retryAfterMs + Math.floor(Math.random() * 100);
      if (waited + wait > this.opts.maxWaitMs) {
        throw new ConnectorError("RATE_LIMITED", "Connector is at Zoho's per-minute request limit", {
          retryAfterMs: result.retryAfterMs,
        });
      }
      await this.sleep(wait);
      waited += wait;
    }
  }
}
