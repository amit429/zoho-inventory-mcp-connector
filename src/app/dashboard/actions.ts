"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createApiKey } from "@/lib/connector/api-keys";
import { loadConnection, tokenRepository, zohoOAuthConfig } from "@/lib/connector/runtime";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireUser, supabaseServer } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/zoho/oauth";

/**
 * Every action re-checks ownership through the merchant's own RLS-bound client
 * before using the admin client. Never trust the IDs a form posts.
 */
async function assertOwnsConnection(connectionId: string) {
  await requireUser();
  const supabase = await supabaseServer();
  const { data } = await supabase.from("connections").select("id").eq("id", connectionId).maybeSingle();
  if (!data) throw new Error("Connection not found");
}

export interface CreateKeyState {
  key?: string;
  error?: string;
}

export async function createKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const parsed = z
    .object({ connectionId: z.uuid(), name: z.string().trim().min(1, "Give the key a name").max(60) })
    .safeParse({ connectionId: formData.get("connectionId"), name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  await assertOwnsConnection(parsed.data.connectionId);
  const { key } = await createApiKey(parsed.data.connectionId, parsed.data.name);
  revalidatePath(`/dashboard/connections/${parsed.data.connectionId}`);
  return { key };
}

export async function revokeKeyAction(formData: FormData) {
  const connectionId = z.uuid().parse(formData.get("connectionId"));
  const keyId = z.uuid().parse(formData.get("keyId"));
  await assertOwnsConnection(connectionId);
  await supabaseAdmin()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("connection_id", connectionId);
  revalidatePath(`/dashboard/connections/${connectionId}`);
}

/** Revokes the refresh token at Zoho, then deletes the connection (cascading tokens, keys and logs). */
export async function disconnectAction(formData: FormData) {
  const connectionId = z.uuid().parse(formData.get("connectionId"));
  await assertOwnsConnection(connectionId);

  const connection = await loadConnection(connectionId);
  const tokens = await tokenRepository()
    .load(connectionId)
    .catch(() => null);
  if (connection && tokens) await revokeToken(zohoOAuthConfig(), connection.accounts_server, tokens.refreshToken);

  await supabaseAdmin().from("connections").delete().eq("id", connectionId);
  revalidatePath("/dashboard");
  redirect("/dashboard?disconnected=1");
}
