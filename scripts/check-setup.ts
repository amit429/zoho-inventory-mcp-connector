/**
 * Verifies a fresh setup before you try the browser flow:
 *   - every required env var is present and well-formed
 *   - the Supabase secret key works and the migration is applied
 *   - the Zoho client ID/secret are accepted by Zoho
 *
 *   npm run check:setup
 *
 * Prints only whether each value is set, never the values themselves.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const ACCOUNTS_SERVER = process.env.ZOHO_ACCOUNTS_SERVER ?? "https://accounts.zoho.in";

async function main() {
  let failed = false;
  const report = (ok: boolean, label: string, detail = "") => {
    if (!ok) failed = true;
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // Validates with the same schema the app uses at runtime.
  const { serverEnv, zohoRedirectUri } = await import("../src/lib/env");
  let env: ReturnType<typeof serverEnv>;
  try {
    env = serverEnv();
    report(true, "environment variables");
  } catch (err) {
    report(false, "environment variables", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  const { error: tableError } = await db.from("connections").select("id", { head: true, count: "exact" });
  report(!tableError, "Supabase secret key + schema", tableError?.message ?? "connections table reachable");

  const { error: rpcError } = await db.rpc("take_rate_limit_token", {
    p_bucket_key: "setup-check",
    p_capacity: 1,
    p_refill_per_sec: 1,
  });
  await db.from("rate_limit_buckets").delete().eq("bucket_key", "setup-check");
  report(!rpcError, "Supabase rate-limit function", rpcError?.message ?? "callable by the server");

  // A fake code tells us whether Zoho recognizes the client without completing a login:
  // "invalid_code" means the client ID/secret are fine; "invalid_client" means they're not.
  const res = await fetch(new URL("/oauth/v2/token", ACCOUNTS_SERVER), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "1000.setup-check.invalid",
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      redirect_uri: zohoRedirectUri(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  report(
    body.error === "invalid_code",
    `Zoho client credentials (${new URL(ACCOUNTS_SERVER).hostname})`,
    body.error === "invalid_code" ? "client recognized" : `Zoho said: ${body.error ?? res.status}`,
  );

  console.log(`\nZoho redirect URI this app will use: ${zohoRedirectUri()}`);
  console.log("It must be listed exactly under Authorized Redirect URIs in the Zoho API console.");
  process.exit(failed ? 1 : 0);
}

main();
