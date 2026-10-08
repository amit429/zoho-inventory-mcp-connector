import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@/lib/zoho/errors";
import { TokenProvider, type StoredTokens, type TokenRepository } from "@/lib/zoho/token-provider";

/** In-memory stand-in for the Postgres repository, with the same lease semantics. */
class MemoryRepo implements TokenRepository {
  lockUntil = 0;
  needsReauth: string | null = null;
  constructor(public tokens: StoredTokens | null) {}

  async load() {
    await tick();
    return this.tokens && { ...this.tokens };
  }
  async tryAcquireRefreshLock(_id: string, leaseSeconds: number) {
    await tick();
    if (this.lockUntil > Date.now()) return false;
    this.lockUntil = Date.now() + leaseSeconds * 1000;
    return true;
  }
  async saveRefreshed(_id: string, accessToken: string, expiresAt: Date) {
    await tick();
    this.tokens = { ...this.tokens!, accessToken, expiresAt };
    this.lockUntil = 0;
  }
  async releaseRefreshLock() {
    this.lockUntil = 0;
  }
  async markNeedsReauth(_id: string, reason: string) {
    this.needsReauth = reason;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 1));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
const fastPolling = { pollIntervalMs: 2, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

describe("TokenProvider", () => {
  it("returns the stored token while it is comfortably valid", async () => {
    const repo = new MemoryRepo({ accessToken: "a1", refreshToken: "r", expiresAt: inMinutes(30) });
    const refresh = vi.fn();
    const provider = new TokenProvider(repo, refresh);

    await expect(provider.getAccessToken("c")).resolves.toBe("a1");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes ahead of expiry and persists the new token", async () => {
    const repo = new MemoryRepo({ accessToken: "a1", refreshToken: "r", expiresAt: inMinutes(1) });
    const refresh = vi.fn().mockResolvedValue({ accessToken: "a2", expiresInSec: 3600 });
    const provider = new TokenProvider(repo, refresh);

    await expect(provider.getAccessToken("c")).resolves.toBe("a2");
    expect(refresh).toHaveBeenCalledWith("r");
    expect(repo.tokens?.accessToken).toBe("a2");
    expect(repo.lockUntil).toBe(0);
  });

  it("refreshes exactly once when many instances see an expired token at the same time", async () => {
    const repo = new MemoryRepo({ accessToken: "old", refreshToken: "r", expiresAt: inMinutes(-1) });
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20)); // Zoho round trip
      return { accessToken: "new", expiresInSec: 3600 };
    });

    // Separate providers model separate serverless instances sharing one database.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => new TokenProvider(repo, refresh, fastPolling).getAccessToken("c")),
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set(["new"]));
  });

  it("forces a refresh for a token Zoho rejected, unless someone already replaced it", async () => {
    const repo = new MemoryRepo({ accessToken: "a1", refreshToken: "r", expiresAt: inMinutes(30) });
    const refresh = vi.fn().mockResolvedValue({ accessToken: "a2", expiresInSec: 3600 });
    const provider = new TokenProvider(repo, refresh);

    await expect(provider.getAccessToken("c", "a1")).resolves.toBe("a2");
    // A second caller still holding the old rejected token gets the new one without another refresh.
    await expect(provider.getAccessToken("c", "a1")).resolves.toBe("a2");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("marks the connection for re-auth and releases the lock when Zoho rejects the refresh token", async () => {
    const repo = new MemoryRepo({ accessToken: "a1", refreshToken: "r", expiresAt: inMinutes(-1) });
    const refresh = vi.fn().mockRejectedValue(new ConnectorError("REAUTH_REQUIRED", "Zoho rejected the grant (invalid_code)"));
    const provider = new TokenProvider(repo, refresh);

    await expect(provider.getAccessToken("c")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(repo.needsReauth).toContain("invalid_code");
    expect(repo.lockUntil).toBe(0);
  });

  it("times out instead of hanging if another instance holds the lock and never finishes", async () => {
    const repo = new MemoryRepo({ accessToken: "a1", refreshToken: "r", expiresAt: inMinutes(-1) });
    repo.lockUntil = Date.now() + 60_000;
    const provider = new TokenProvider(repo, vi.fn(), { ...fastPolling, maxWaitMs: 30 });

    await expect(provider.getAccessToken("c")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("requires re-auth when the connection has no tokens", async () => {
    const provider = new TokenProvider(new MemoryRepo(null), vi.fn());
    await expect(provider.getAccessToken("c")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  });
});
