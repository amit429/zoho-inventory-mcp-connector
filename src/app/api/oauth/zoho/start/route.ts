import { NextResponse, type NextRequest } from "next/server";
import { randomState } from "@/lib/crypto";
import { zohoOAuthConfig } from "@/lib/connector/runtime";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser } from "@/lib/supabase/server";
import { isZohoDataCenter, ZOHO_DATA_CENTERS } from "@/lib/zoho/datacenters";
import { buildAuthorizeUrl } from "@/lib/zoho/oauth";

/** Step 1 of connecting: bind a one-time state to the signed-in merchant, then send them to Zoho consent. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const dc = request.nextUrl.searchParams.get("dc") ?? "in";
  if (!isZohoDataCenter(dc)) {
    return NextResponse.redirect(new URL("/dashboard?error=Unknown+Zoho+data+center", request.url));
  }
  const { accountsServer } = ZOHO_DATA_CENTERS[dc];

  const state = randomState();
  const { error } = await supabaseAdmin()
    .from("oauth_states")
    .insert({ state, user_id: user.id, accounts_server: accountsServer });
  if (error) {
    console.error("failed to store oauth state", error);
    return NextResponse.redirect(new URL("/dashboard?error=Could+not+start+the+Zoho+connection", request.url));
  }

  return NextResponse.redirect(buildAuthorizeUrl(zohoOAuthConfig(), accountsServer, state));
}
