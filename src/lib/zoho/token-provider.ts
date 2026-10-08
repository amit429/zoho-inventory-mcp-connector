import { ConnectorError } from "./errors";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** Persistence for one connection's tokens. Implemented over Supabase in production, in memory in tests. */
export interface TokenRepository {
  load(connectionId: string): Promise<StoredTokens | null>;
  /** Atomically take a lease on refreshing. Returns false if another instance holds it. */
  tryAcquireRefreshLock(connectionId: string, leaseSeconds: number): Promise<boolean>;
  /** Persist a refreshed access token and release the lease. */
  saveRefreshed(connectionId: string, accessToken: string, expiresAt: Date): Promise<void>;
  releaseRefreshLock(connectionId: string): Promise<void>;
  markNeedsReauth(connectionId: string, reason: string): Promise<void>;
}

export type RefreshFn = (refreshToken: string) => Promise<{ accessToken: string; expiresInSec: number }>;

export interface TokenProviderOptions {
  /** Refresh this long before expiry so a token never dies mid-request. */
  expirySkewMs?: number;
  leaseSeconds?: number;
  /** How long to wait for another instance's refresh before giving up. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * In-process cache of decrypted access tokens, shared across calls in one
   * server instance, so a warm instance skips the database read + decrypt on
   * every tool call. The database stays the source of truth: a 401 from Zoho
   * bypasses the cache and goes through the refresh path.
   */
  cache?: Map<string, CachedToken>;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * Hands out a valid Zoho access token for a connection.
 *
 * On serverless, many instances can see the same expired token at once. Zoho
 * caps how many access tokens one refresh token may mint in a short window,
 * so a naive "everyone refreshes" approach can lock the merchant out. Instead
 * one instance takes a lease in Postgres and refreshes; the rest poll until
 * the new token appears.
 */
export class TokenProvider {
  private readonly opts: Required<Omit<TokenProviderOptions, "cache">>;
  private readonly cache?: Map<string, CachedToken>;

  constructor(
    private readonly repo: TokenRepository,
    private readonly refresh: RefreshFn,
    opts: TokenProviderOptions = {},
  ) {
    this.opts = {
      expirySkewMs: opts.expirySkewMs ?? 120_000,
      leaseSeconds: opts.leaseSeconds ?? 20,
      maxWaitMs: opts.maxWaitMs ?? 10_000,
      pollIntervalMs: opts.pollIntervalMs ?? 300,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
    this.cache = opts.cache;
  }

  /**
   * @param rejectedToken a token Zoho just answered 401 for. Forces a refresh,
   *   unless another instance has already replaced it.
   */
  async getAccessToken(connectionId: string, rejectedToken?: string): Promise<string> {
    const { now, sleep, expirySkewMs, leaseSeconds, maxWaitMs, pollIntervalMs } = this.opts;
    const deadline = now() + maxWaitMs;
    const usable = (t: CachedToken) =>
      t.expiresAt.getTime() - now() > expirySkewMs && !(rejectedToken !== undefined && t.accessToken === rejectedToken);

    const cached = this.cache?.get(connectionId);
    if (cached && usable(cached)) return cached.accessToken;

    while (true) {
      const tokens = await this.repo.load(connectionId);
      if (!tokens) throw new ConnectorError("REAUTH_REQUIRED", "This connection has no Zoho tokens");

      if (usable(tokens)) return this.remember(connectionId, tokens);

      if (await this.repo.tryAcquireRefreshLock(connectionId, leaseSeconds)) {
        // Double-check under the lock: another instance may have refreshed and
        // released it between our read and our acquire.
        const latest = await this.repo.load(connectionId);
        if (latest && usable(latest)) {
          await this.repo.releaseRefreshLock(connectionId);
          return this.remember(connectionId, latest);
        }
        return this.refreshHoldingLock(connectionId, (latest ?? tokens).refreshToken);
      }

      if (now() >= deadline) {
        throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Timed out waiting for a concurrent token refresh");
      }
      await sleep(pollIntervalMs);
    }
  }

  private remember(connectionId: string, token: CachedToken): string {
    this.cache?.set(connectionId, { accessToken: token.accessToken, expiresAt: token.expiresAt });
    return token.accessToken;
  }

  private async refreshHoldingLock(connectionId: string, refreshToken: string): Promise<string> {
    try {
      const grant = await this.refresh(refreshToken);
      const expiresAt = new Date(this.opts.now() + grant.expiresInSec * 1000);
      await this.repo.saveRefreshed(connectionId, grant.accessToken, expiresAt);
      return this.remember(connectionId, { accessToken: grant.accessToken, expiresAt });
    } catch (err) {
      await this.repo.releaseRefreshLock(connectionId);
      if (err instanceof ConnectorError && err.code === "REAUTH_REQUIRED") {
        await this.repo.markNeedsReauth(connectionId, err.message);
      }
      throw err;
    }
  }
}
