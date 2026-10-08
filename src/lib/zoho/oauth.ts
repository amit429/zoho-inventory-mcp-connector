import { ConnectorError } from "./errors";
import { isAllowedAccountsServer } from "./datacenters";

/**
 * Least privilege: read-only scopes for exactly the modules the tools expose.
 * settings.READ covers the organization profile and warehouses.
 */
export const ZOHO_SCOPES = [
  "ZohoInventory.items.READ",
  "ZohoInventory.salesorders.READ",
  "ZohoInventory.contacts.READ",
  "ZohoInventory.settings.READ",
] as const;

export interface ZohoOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface ZohoTokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  apiDomain?: string;
}

export function buildAuthorizeUrl(cfg: ZohoOAuthConfig, accountsServer: string, state: string): string {
  assertAccountsServer(accountsServer);
  const url = new URL("/oauth/v2/auth", accountsServer);
  url.search = new URLSearchParams({
    scope: ZOHO_SCOPES.join(","),
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    state,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", //      Zoho only issues a refresh token on an explicit consent
  }).toString();
  return url.toString();
}

export function exchangeCode(cfg: ZohoOAuthConfig, accountsServer: string, code: string) {
  return tokenRequest(cfg, accountsServer, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
}

export function refreshAccessToken(cfg: ZohoOAuthConfig, accountsServer: string, refreshToken: string) {
  return tokenRequest(cfg, accountsServer, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Revokes a refresh token at Zoho. Best effort: disconnecting must work even if Zoho is down. */
export async function revokeToken(cfg: ZohoOAuthConfig, accountsServer: string, refreshToken: string) {
  assertAccountsServer(accountsServer);
  const url = new URL("/oauth/v2/token/revoke", accountsServer);
  url.searchParams.set("token", refreshToken);
  try {
    await (cfg.fetch ?? fetch)(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
  } catch {
    // Ignore; the encrypted copy is deleted locally regardless.
  }
}

async function tokenRequest(
  cfg: ZohoOAuthConfig,
  accountsServer: string,
  params: Record<string, string>,
): Promise<ZohoTokenGrant> {
  assertAccountsServer(accountsServer);
  const body = new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret });

  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(new URL("/oauth/v2/token", accountsServer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Could not reach Zoho Accounts", { cause });
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // Zoho reports OAuth errors with HTTP 200 and an `error` field.
  if (typeof json.error === "string" || !res.ok || typeof json.access_token !== "string") {
    const error = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    if (error === "invalid_code" || error === "invalid_client" || error === "invalid_grant") {
      throw new ConnectorError("REAUTH_REQUIRED", `Zoho rejected the grant (${error})`);
    }
    // Zoho throttles token generation per refresh token ("Access Denied" / too many requests).
    if (res.status === 429 || /too many requests|access denied/i.test(error)) {
      throw new ConnectorError("RATE_LIMITED", "Zoho is throttling token refreshes", { retryAfterMs: 60_000 });
    }
    throw new ConnectorError("UPSTREAM_ERROR", `Zoho token endpoint error: ${error}`);
  }

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresInSec: typeof json.expires_in === "number" ? json.expires_in : 3600,
    apiDomain: typeof json.api_domain === "string" ? json.api_domain : undefined,
  };
}

function assertAccountsServer(accountsServer: string) {
  if (!isAllowedAccountsServer(accountsServer)) {
    throw new ConnectorError("INVALID_INPUT", `Unknown Zoho accounts server: ${accountsServer}`);
  }
}
