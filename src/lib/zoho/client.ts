import { ConnectorError } from "./errors";
import type { RateLimiter } from "./rate-limiter";

export interface AccessTokenSource {
  getAccessToken(connectionId: string, rejectedToken?: string): Promise<string>;
}

export interface ZohoClientConfig {
  connectionId: string;
  organizationId: string;
  apiDomain: string;
  tokens: AccessTokenSource;
  rateLimiter: RateLimiter;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  /** Longest server-requested Retry-After we'll honor inline before handing the wait to the agent. */
  maxInlineRetryAfterMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

/** Every Zoho Inventory response carries `code` (0 = success) and `message`. */
interface ZohoEnvelope {
  code?: number;
  message?: string;
}

/**
 * Minimal Zoho Inventory REST client.
 *
 * Per request: take a token from the shared per-org bucket, attach a valid
 * OAuth token, and send. Then:
 *   401       -> refresh the token once and retry
 *   429       -> honor Retry-After if short, otherwise return RATE_LIMITED
 *   5xx/network/timeout -> exponential backoff with full jitter
 *   code != 0 -> map to a typed ConnectorError
 */
export class ZohoInventoryClient {
  /** Number of HTTP requests sent to Zoho, including retries. Logged per tool call. */
  requestCount = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxInlineRetryAfterMs: number;

  constructor(private readonly cfg: ZohoClientConfig) {
    this.fetchImpl = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = cfg.maxRetries ?? 3;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.maxInlineRetryAfterMs = cfg.maxInlineRetryAfterMs ?? 10_000;
  }

  async get<T extends object>(path: string, query: Record<string, QueryValue> = {}): Promise<T & ZohoEnvelope> {
    const url = new URL(`/inventory/v1${path}`, this.cfg.apiDomain);
    // Empty only during OAuth, when listing organizations to pick one.
    if (this.cfg.organizationId) url.searchParams.set("organization_id", this.cfg.organizationId);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    let rejectedToken: string | undefined;
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      await this.cfg.rateLimiter.acquire(`zoho-org:${this.cfg.organizationId}`);
      const token = await this.cfg.tokens.getAccessToken(this.cfg.connectionId, rejectedToken);

      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Zoho did not respond in time", { cause });
      }

      const body = (await res.json().catch(() => ({}))) as T & ZohoEnvelope;

      if (res.status === 401) {
        if (!refreshedAfter401) {
          refreshedAfter401 = true;
          rejectedToken = token;
          continue;
        }
        // A fresh token still refused with code 57 means the grant lacks the scope, not that it expired.
        if (body.code === 57) throw new ConnectorError("FORBIDDEN_SCOPE", body.message ?? "Not authorized", { zohoCode: 57 });
        throw new ConnectorError("REAUTH_REQUIRED", "Zoho rejected the access token after a refresh", {
          zohoCode: body.code,
        });
      }

      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after")) ?? backoffMs(attempt);
        if (attempt < this.maxRetries && retryAfter <= this.maxInlineRetryAfterMs) {
          await this.sleep(retryAfter);
          continue;
        }
        throw new ConnectorError("RATE_LIMITED", body.message ?? "Zoho API rate limit exceeded", {
          retryAfterMs: retryAfter,
          zohoCode: body.code,
        });
      }

      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new ConnectorError("UPSTREAM_UNAVAILABLE", `Zoho returned HTTP ${res.status}`, { zohoCode: body.code });
      }

      if (!res.ok || (body.code !== undefined && body.code !== 0)) {
        throw mapZohoError(res.status, body);
      }
      return body;
    }
  }
}

function mapZohoError(status: number, body: ZohoEnvelope): ConnectorError {
  const message = body.message ?? `Zoho returned HTTP ${status}`;
  const opts = { zohoCode: body.code };
  if (status === 404 || /does not exist|not found|invalid .*id/i.test(message)) {
    return new ConnectorError("NOT_FOUND", message, opts);
  }
  if (status === 403 || body.code === 57) {
    return new ConnectorError("FORBIDDEN_SCOPE", message, opts);
  }
  if (status === 400) {
    return new ConnectorError("INVALID_INPUT", message, opts);
  }
  return new ConnectorError("UPSTREAM_ERROR", message, opts);
}

/** Full-jitter exponential backoff: random in [0, min(8s, 500ms * 2^attempt)]. */
export function backoffMs(attempt: number): number {
  return Math.floor(Math.random() * Math.min(8_000, 500 * 2 ** attempt));
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
