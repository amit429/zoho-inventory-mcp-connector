import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { StoredTokens, TokenRepository } from "@/lib/zoho/token-provider";

/** Zoho tokens in Postgres, encrypted with AES-256-GCM before they leave the app. */
export class SupabaseTokenRepository implements TokenRepository {
  constructor(
    private readonly db: SupabaseClient,
    private readonly encryptionKey: string,
  ) {}

  async load(connectionId: string): Promise<StoredTokens | null> {
    const { data, error } = await this.db
      .from("oauth_tokens")
      .select("access_token_enc, refresh_token_enc, expires_at")
      .eq("connection_id", connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      accessToken: decryptSecret(data.access_token_enc, this.encryptionKey),
      refreshToken: decryptSecret(data.refresh_token_enc, this.encryptionKey),
      expiresAt: new Date(data.expires_at),
    };
  }

  async tryAcquireRefreshLock(connectionId: string, leaseSeconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc("acquire_refresh_lock", {
      p_connection_id: connectionId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw error;
    return data === true;
  }

  async saveRefreshed(connectionId: string, accessToken: string, expiresAt: Date): Promise<void> {
    const { error } = await this.db
      .from("oauth_tokens")
      .update({
        access_token_enc: encryptSecret(accessToken, this.encryptionKey),
        expires_at: expiresAt.toISOString(),
        refreshed_at: new Date().toISOString(),
        refresh_lock_until: null,
      })
      .eq("connection_id", connectionId);
    if (error) throw error;
  }

  async releaseRefreshLock(connectionId: string): Promise<void> {
    await this.db.from("oauth_tokens").update({ refresh_lock_until: null }).eq("connection_id", connectionId);
  }

  async markNeedsReauth(connectionId: string, reason: string): Promise<void> {
    await this.db
      .from("connections")
      .update({ status: "needs_reauth", last_error: reason, updated_at: new Date().toISOString() })
      .eq("id", connectionId);
  }

  /** Initial save after the OAuth callback (insert or replace on reconnect). */
  async saveGrant(connectionId: string, tokens: StoredTokens): Promise<void> {
    const { error } = await this.db.from("oauth_tokens").upsert({
      connection_id: connectionId,
      access_token_enc: encryptSecret(tokens.accessToken, this.encryptionKey),
      refresh_token_enc: encryptSecret(tokens.refreshToken, this.encryptionKey),
      expires_at: tokens.expiresAt.toISOString(),
      refreshed_at: new Date().toISOString(),
      refresh_lock_until: null,
    });
    if (error) throw error;
  }
}
