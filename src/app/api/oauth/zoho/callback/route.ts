import { NextResponse, type NextRequest } from "next/server";
import { tokenRepository, zohoOAuthConfig } from "@/lib/connector/runtime";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser } from "@/lib/supabase/server";
import { ZohoInventoryClient } from "@/lib/zoho/client";
import { isAllowedAccountsServer, isAllowedApiDomain } from "@/lib/zoho/datacenters";
import { ConnectorError } from "@/lib/zoho/errors";
import { listOrganizations } from "@/lib/zoho/inventory";
import { exchangeCode, revokeToken, ZOHO_SCOPES } from "@/lib/zoho/oauth";

/**
 * Step 2 of connecting: Zoho redirects here with ?code&state&accounts-server.
 * Verify the state belongs to this merchant, exchange the code, pick the
 * Zoho organization, and store the encrypted tokens.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/dashboard?error=${encodeURIComponent(message)}`, request.url));

  if (params.get("error")) return fail(`Zoho did not grant access (${params.get("error")})`);

  const user = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return fail("Missing code or state from Zoho");

  // One-time state: delete it as we read it, and only if it belongs to this user.
  const db = supabaseAdmin();
  const { data: stateRow } = await db
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("user_id", user.id)
    .gt("expires_at", new Date().toISOString())
    .select("accounts_server")
    .maybeSingle();
  if (!stateRow) return fail("This connection link expired or was already used. Please try again.");

  // Zoho reports the account's real data center; only trust known Zoho hosts,
  // since we're about to send our client secret there.
  const reported = params.get("accounts-server");
  const accountsServer = reported && isAllowedAccountsServer(reported) ? reported : stateRow.accounts_server;

  const oauth = zohoOAuthConfig();
  try {
    const grant = await exchangeCode(oauth, accountsServer, code);
    if (!grant.refreshToken) return fail("Zoho did not return a refresh token. Please reconnect and approve access.");

    const apiDomain = grant.apiDomain ?? "";
    if (!isAllowedApiDomain(apiDomain)) {
      await revokeToken(oauth, accountsServer, grant.refreshToken);
      return fail("Zoho returned an unexpected API domain");
    }

    const bootstrap = new ZohoInventoryClient({
      connectionId: "bootstrap",
      organizationId: "",
      apiDomain,
      tokens: { getAccessToken: async () => grant.accessToken },
      rateLimiter: { acquire: async () => {} },
    });
    const orgs = await listOrganizations(bootstrap);
    const org = orgs.find((o) => o.is_default) ?? orgs[0];
    if (!org) {
      await revokeToken(oauth, accountsServer, grant.refreshToken);
      return fail("This Zoho account has no Zoho Inventory organization");
    }

    const { data: connection, error } = await db
      .from("connections")
      .upsert(
        {
          user_id: user.id,
          zoho_org_id: org.organization_id,
          zoho_org_name: org.name,
          currency_code: org.currency_code,
          time_zone: org.time_zone,
          accounts_server: accountsServer,
          api_domain: apiDomain,
          scopes: [...ZOHO_SCOPES],
          status: "active",
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,zoho_org_id" },
      )
      .select("id")
      .single();
    if (error) throw error;

    await tokenRepository().saveGrant(connection.id, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: new Date(Date.now() + grant.expiresInSec * 1000),
    });

    return NextResponse.redirect(new URL(`/dashboard/connections/${connection.id}?connected=1`, request.url));
  } catch (err) {
    console.error("zoho oauth callback failed", err);
    return fail(err instanceof ConnectorError ? err.message : "Could not complete the Zoho connection");
  }
}
