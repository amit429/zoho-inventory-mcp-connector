import { describe, expect, it, vi } from "vitest";
import { SharedTokenBucket, ZOHO_ORG_LIMIT, type TakeTokenFn } from "@/lib/zoho/rate-limiter";

/** Same math as the take_rate_limit_token SQL function, against a controllable clock. */
function memoryBucket(clock: { now: number }): TakeTokenFn {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  return async (key, capacity, refillPerSec) => {
    const b = buckets.get(key) ?? { tokens: capacity, updated: clock.now };
    b.tokens = Math.min(capacity, b.tokens + ((clock.now - b.updated) / 1000) * refillPerSec);
    b.updated = clock.now;
    buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil(((1 - b.tokens) / refillPerSec) * 1000) };
  };
}

describe("SharedTokenBucket", () => {
  it("never allows more than 100 requests in a 60s window with the Zoho settings", async () => {
    const clock = { now: 0 };
    const limiter = new SharedTokenBucket(memoryBucket(clock), {
      ...ZOHO_ORG_LIMIT,
      maxWaitMs: Number.POSITIVE_INFINITY,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });

    const sentAt: number[] = [];
    while (clock.now < 60_000) {
      await limiter.acquire("zoho-org:1");
      if (clock.now < 60_000) sentAt.push(clock.now);
    }
    expect(sentAt.length).toBeLessThanOrEqual(100);
    expect(sentAt.length).toBeGreaterThan(90);
  });

  it("waits for capacity when the wait is short", async () => {
    const take = vi
      .fn<TakeTokenFn>()
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 400 })
      .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 });
    const sleep = vi.fn(async () => {});
    await new SharedTokenBucket(take, { ...ZOHO_ORG_LIMIT, sleep }).acquire("k");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(2);
  });

  it("fails fast with RATE_LIMITED rather than holding the agent beyond maxWaitMs", async () => {
    const take = vi.fn<TakeTokenFn>().mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const limiter = new SharedTokenBucket(take, { ...ZOHO_ORG_LIMIT, sleep: async () => {} });

    await expect(limiter.acquire("k")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 30_000 });
  });

  it("fails open if the limiter's database is unavailable", async () => {
    const onBackendError = vi.fn();
    const take = vi.fn<TakeTokenFn>().mockRejectedValue(new Error("connection refused"));
    await new SharedTokenBucket(take, { ...ZOHO_ORG_LIMIT, onBackendError }).acquire("k");
    expect(onBackendError).toHaveBeenCalled();
  });
});
