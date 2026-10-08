import "server-only";
import { API_KEY_PREFIX, generateApiKey, hashApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface VerifiedKey {
  apiKeyId: string;
  connectionId: string;
}

/** Resolves a bearer key to its connection. Returns null for unknown, revoked or malformed keys. */
export async function verifyApiKey(key: string | undefined): Promise<VerifiedKey | null> {
  if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("api_keys")
    .select("id, connection_id, revoked_at, connections!inner(status)")
    .eq("key_hash", hashApiKey(key))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  // A connection that needs re-auth still authenticates, so tools can tell the agent why they fail.
  const connection = data.connections as unknown as { status: string };
  if (connection.status === "revoked") return null;

  // Fire and forget: usage tracking must not slow down or fail the request.
  void db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then();

  return { apiKeyId: data.id, connectionId: data.connection_id };
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
