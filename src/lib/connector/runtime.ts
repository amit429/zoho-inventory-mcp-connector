import "server-only";
import { serverEnv, zohoRedirectUri } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ZohoInventoryClient } from "@/lib/zoho/client";
import { refreshAccessToken, type ZohoOAuthConfig } from "@/lib/zoho/oauth";
import { SharedTokenBucket, ZOHO_ORG_LIMIT } from "@/lib/zoho/rate-limiter";
import { TokenProvider, type CachedToken } from "@/lib/zoho/token-provider";
import { SupabaseTokenRepository } from "./token-repo";

export interface ConnectionRow {
  id: string;
  user_id: string;
  zoho_org_id: string;
  zoho_org_name: string | null;
  currency_code: string | null;
  time_zone: string | null;
  accounts_server: string;
  api_domain: string;
  scopes: string[];
  status: "active" | "needs_reauth" | "revoked";
  last_error: string | null;
  created_at: string;
}

export function zohoOAuthConfig(): ZohoOAuthConfig {
  const env = serverEnv();
  return { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, redirectUri: zohoRedirectUri() };
}

export function tokenRepository() {
  return new SupabaseTokenRepository(supabaseAdmin(), serverEnv().TOKEN_ENCRYPTION_KEY);
}

const rateLimiter = new SharedTokenBucket(
  async (bucketKey, capacity, refillPerSec, signal) => {
    const { data, error } = await supabaseAdmin()
      .rpc("take_rate_limit_token", {
        p_bucket_key: bucketKey,
        p_capacity: capacity,
        p_refill_per_sec: refillPerSec,
      })
      .abortSignal(signal);
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; retry_after_ms: number };
    return { allowed: row.allowed, retryAfterMs: row.retry_after_ms };
  },
  { ...ZOHO_ORG_LIMIT, onBackendError: (err) => console.error("rate limiter backend error, failing open", err) },
);

/** Decrypted access tokens for this server instance; see TokenProviderOptions.cache. */
const accessTokenCache = new Map<string, CachedToken>();

export async function loadConnection(connectionId: string): Promise<ConnectionRow | null> {
  const { data, error } = await supabaseAdmin().from("connections").select("*").eq("id", connectionId).maybeSingle();
  if (error) throw error;
  return data as ConnectionRow | null;
}

/** A fresh client per tool call, so requestCount reflects just that call. */
export function zohoClientFor(connection: Pick<ConnectionRow, "id" | "accounts_server" | "zoho_org_id" | "api_domain">) {
  const oauth = zohoOAuthConfig();
  const tokens = new TokenProvider(
    tokenRepository(),
    (refreshToken) => refreshAccessToken(oauth, connection.accounts_server, refreshToken),
    { cache: accessTokenCache },
  );
  return new ZohoInventoryClient({
    connectionId: connection.id,
    organizationId: connection.zoho_org_id,
    apiDomain: connection.api_domain,
    tokens,
    rateLimiter,
  });
}
