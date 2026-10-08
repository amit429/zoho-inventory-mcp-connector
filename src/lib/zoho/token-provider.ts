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
  private readonly opts: Required<TokenProviderOptions>;

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
  }

  /**
   * @param rejectedToken a token Zoho just answered 401 for. Forces a refresh,
   *   unless another instance has already replaced it.
   */
  async getAccessToken(connectionId: string, rejectedToken?: string): Promise<string> {
    const { now, sleep, expirySkewMs, leaseSeconds, maxWaitMs, pollIntervalMs } = this.opts;
    const deadline = now() + maxWaitMs;

    while (true) {
      const tokens = await this.repo.load(connectionId);
      if (!tokens) throw new ConnectorError("REAUTH_REQUIRED", "This connection has no Zoho tokens");

      const stillValid = tokens.expiresAt.getTime() - now() > expirySkewMs;
      const wasRejected = rejectedToken !== undefined && tokens.accessToken === rejectedToken;
      if (stillValid && !wasRejected) return tokens.accessToken;

      if (await this.repo.tryAcquireRefreshLock(connectionId, leaseSeconds)) {
        return this.refreshHoldingLock(connectionId, tokens.refreshToken);
      }

      if (now() >= deadline) {
        throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Timed out waiting for a concurrent token refresh");
      }
      await sleep(pollIntervalMs);
    }
  }

  private async refreshHoldingLock(connectionId: string, refreshToken: string): Promise<string> {
    try {
      const grant = await this.refresh(refreshToken);
      const expiresAt = new Date(this.opts.now() + grant.expiresInSec * 1000);
      await this.repo.saveRefreshed(connectionId, grant.accessToken, expiresAt);
      return grant.accessToken;
    } catch (err) {
      await this.repo.releaseRefreshLock(connectionId);
      if (err instanceof ConnectorError && err.code === "REAUTH_REQUIRED") {
        await this.repo.markNeedsReauth(connectionId, err.message);
      }
      throw err;
    }
  }
}
