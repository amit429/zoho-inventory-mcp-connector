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
      now: () => clock.now,
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

  it("counts slow database round trips against the wait budget", async () => {
    // Regression: under contention the bucket reports tiny waits; when only the
    // sleeps were summed, 300ms round trips let a call wait 24s instead of its budget.
    const clock = { now: 0 };
    const take = vi.fn<TakeTokenFn>(async () => {
      clock.now += 300;
      return { allowed: false, retryAfterMs: 50 };
    });
    const limiter = new SharedTokenBucket(take, {
      ...ZOHO_ORG_LIMIT,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });

    await expect(limiter.acquire("k")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // An in-flight round trip can't be interrupted, so allow overshoot of at most one.
    expect(clock.now).toBeLessThanOrEqual(ZOHO_ORG_LIMIT.maxWaitMs + 300);
  });

  it("polls no faster than minPollMs even when told a token is almost ready", async () => {
    const sleeps: number[] = [];
    const take = vi
      .fn<TakeTokenFn>()
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 5 })
      .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 });
    await new SharedTokenBucket(take, {
      ...ZOHO_ORG_LIMIT,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).acquire("k");
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
  });

  it("queues callers in-process so only one polls the shared bucket at a time, in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const served: string[] = [];
    const take = vi.fn<TakeTokenFn>(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { allowed: true, retryAfterMs: 0 };
    });
    const limiter = new SharedTokenBucket(take, ZOHO_ORG_LIMIT);

    await Promise.all(["a", "b", "c", "d", "e"].map(async (id) => {
      await limiter.acquire("zoho-org:1");
      served.push(id);
    }));

    expect(maxInFlight).toBe(1);
    expect(served).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not serialize different organizations", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const take = vi.fn<TakeTokenFn>(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { allowed: true, retryAfterMs: 0 };
    });
    const limiter = new SharedTokenBucket(take, ZOHO_ORG_LIMIT);
    await Promise.all([limiter.acquire("zoho-org:1"), limiter.acquire("zoho-org:2")]);
    expect(maxInFlight).toBe(2);
  });

  it("times out callers stuck behind the queue head, and cancels a hung bucket call, as RATE_LIMITED", async () => {
    // The bucket call hangs until it's aborted.
    const take = vi.fn<TakeTokenFn>(
      (_k, _c, _r, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const onBackendError = vi.fn();
    const limiter = new SharedTokenBucket(take, { ...ZOHO_ORG_LIMIT, maxWaitMs: 50, onBackendError });

    const results = await Promise.allSettled([limiter.acquire("k"), limiter.acquire("k"), limiter.acquire("k")]);

    for (const r of results) {
      expect(r).toMatchObject({ status: "rejected", reason: { code: "RATE_LIMITED" } });
    }
    expect(take).toHaveBeenCalledTimes(1); // only the head ever reached the database
    expect(onBackendError).not.toHaveBeenCalled(); // a deadline is not a backend failure: no fail-open
  });

  it("fails open if the limiter's database is unavailable", async () => {
    const onBackendError = vi.fn();
    const take = vi.fn<TakeTokenFn>().mockRejectedValue(new Error("connection refused"));
    await new SharedTokenBucket(take, { ...ZOHO_ORG_LIMIT, onBackendError }).acquire("k");
    expect(onBackendError).toHaveBeenCalled();
  });
});
