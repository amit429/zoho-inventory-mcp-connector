import "server-only";
import { API_KEY_PREFIX, generateApiKey, hashApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ConnectionRow } from "./runtime";

export interface VerifiedKey {
  apiKeyId: string;
  connection: ConnectionRow;
}

/** last_used_at is for humans ("used 2 minutes ago"), so per-minute precision is plenty. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Resolves a bearer key to its connection in one query. Returns null for
 * unknown, revoked or malformed keys, or a deleted/revoked connection.
 */
export async function verifyApiKey(key: string | undefined): Promise<VerifiedKey | null> {
  if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("api_keys")
    .select("id, revoked_at, last_used_at, connections!inner(*)")
    .eq("key_hash", hashApiKey(key))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  // A connection that needs re-auth still authenticates, so tools can tell the agent why they fail.
  const connection = data.connections as unknown as ConnectionRow;
  if (connection.status === "revoked") return null;

  // Fire and forget, and at most once a minute per key: usage tracking must not
  // slow down or fail the request, or turn every call into a write.
  const lastUsed = data.last_used_at ? Date.parse(data.last_used_at) : 0;
  if (Date.now() - lastUsed > LAST_USED_RESOLUTION_MS) {
    void db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then();
  }

  return { apiKeyId: data.id, connection };
}

/** Creates a key for a connection. The plaintext is returned once and never stored. */
export async function createApiKey(connectionId: string, name: string) {
  const { key, hash, displayPrefix } = generateApiKey();
  const { data, error } = await supabaseAdmin()
    .from("api_keys")
    .insert({ connection_id: connectionId, name, key_prefix: displayPrefix, key_hash: hash })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id as string, key };
}
