# Testing guide

There are three levels of testing:

| Level | Command | Needs | What it proves |
|---|---|---|---|
| **1. Unit + protocol** | `npm test` | nothing (no network) | Retry and backoff rules, 401 → refresh, error mapping, the token-refresh race, rate-limiter math and queueing, and all 12 tools over real MCP JSON-RPC |
| **2. Local end-to-end** | `npm run test:connector` against `localhost` | Supabase + Zoho credentials | The whole stack against a real Zoho org: auth, every tool, error cases, burst |
| **3. Deployed end-to-end** | same script against the Vercel URL | an API key for the deployed app | The production deployment |

- [Part A: Run and test locally](#part-a--run-and-test-locally)
- [Part B: Test the deployed app](#part-b--test-the-deployed-app)
- [Part C: Test with a real agent](#part-c--test-with-a-real-agent)
- [Troubleshooting](#troubleshooting)

---

## Part A: Run and test locally

### A1. Prerequisites

- Node.js **22 or newer** (`node -v`)
- A **Supabase** project (free tier is fine)
- A **Zoho Inventory** organization: sign up at [inventory.zoho.in](https://inventory.zoho.in) (Free plan) and finish the org setup wizard
- A **Zoho API Console** client: see A3

### A2. Install

```bash
git clone https://github.com/amit429/zoho-inventory-mcp-connector.git
cd zoho-inventory-mcp-connector
npm install
cp .env.example .env.local
```

### A3. Create the Zoho OAuth client

1. Go to [api-console.zoho.in](https://api-console.zoho.in) → **Add Client** → **Server-based Applications**.
2. Fill in:
   - **Client Name:** `Zoho Inventory Connector`
   - **Homepage URL:** `http://localhost:3000`
   - **Authorized Redirect URIs:** `http://localhost:3000/api/oauth/zoho/callback`. If you'll also test a deployment, click **+** and add `https://<your-app>/api/oauth/zoho/callback`.
3. **Create**, then copy the **Client ID** and **Client Secret** into `.env.local`:

```bash
ZOHO_CLIENT_ID="1000.XXXXXXXX"
ZOHO_CLIENT_SECRET="..."
```

> If your Zoho account is in another region (US, EU, …), use that region's console (e.g. api-console.zoho.com) and pick the matching data center when connecting.

### A4. Set up Supabase

1. **Apply the schema.** In the Supabase dashboard → **SQL Editor**, run these two files in order:
   - `supabase/migrations/20261009000000_connector_schema.sql`
   - `supabase/migrations/20261009010000_rate_limit_skip_locked.sql`

   (Or with the Supabase CLI: `supabase link --project-ref <ref> && supabase db push`.)
2. **Copy the keys** from Project Settings → **API Keys** into `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
SUPABASE_SECRET_KEY="sb_secret_..."
```

3. **Auth settings** (Authentication → URL Configuration / Providers → Email):
   - **Site URL:** `http://localhost:3000` (or your deployed URL)
   - Optional for demos: switch off **Confirm email**, so sign-up logs you in immediately. Supabase's built-in mailer only sends a few emails per hour.

### A5. Generate the encryption key and finish `.env.local`

```bash
echo "TOKEN_ENCRYPTION_KEY=\"$(openssl rand -base64 32)\"" >> .env.local
echo 'APP_URL="http://localhost:3000"' >> .env.local
```

> **The same key must be used by every deployment that shares the database.** Tokens encrypted by one key can't be decrypted by another.

### A6. Verify the setup

```bash
npm run check:setup
```

Expected:

```
✓ environment variables
✓ Supabase secret key + schema — connections table reachable
✓ Supabase rate-limit function — callable by the server
✓ Zoho client credentials (accounts.zoho.in) — client recognized

Zoho redirect URI this app will use: http://localhost:3000/api/oauth/zoho/callback
```

The Zoho check sends a deliberately invalid code. Zoho answers `invalid_code` when the client ID and secret are correct and `invalid_client` when they aren't, so no login is needed.

### A7. Run the unit and protocol tests

```bash
npm test          # 39 tests, ~1s, no network
npm run typecheck
npm run lint
```

### A8. Start the app

```bash
npm run dev
```

Open http://localhost:3000.

### A9. Connect Zoho (browser)

1. **Connect Zoho Inventory** → **Create account** (email + password, min 8 chars).
2. On **Connections**: data center **India** → **Connect with Zoho**.
3. Zoho shows a consent screen listing **read** access to Items, Sales Orders, Contacts and Settings → **Accept**.
4. You land on the connection page showing your organization name, currency and time zone, with status **Active**.

### A10. Load demo data into Zoho (optional, recommended)

A new Zoho org is empty. `npm run seed` creates fictional data for a D2C apparel brand: 12 items (5 deliberately below their reorder level), 8 customers (`@example.com`) and 10 sales orders (8 confirmed, 2 draft).

The connector itself is read-only, so seeding uses a **separate one-off write grant**:

1. [api-console.zoho.in](https://api-console.zoho.in) → **Add Client** → **Self Client** → **Create**.
2. **Client Secret** tab: copy the client ID and secret.
3. **Generate Code** tab:
   - Scope: `ZohoInventory.items.CREATE,ZohoInventory.contacts.CREATE,ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE,ZohoInventory.settings.READ`
   - Time duration: **10 minutes**, any description → **Create** → choose your organization → copy the code.
4. Add to `.env.local` **and run within 10 minutes** (the code is single-use):

```bash
ZOHO_SELF_CLIENT_ID="1000...."
ZOHO_SELF_CLIENT_SECRET="..."
ZOHO_SELF_CLIENT_CODE="1000.xxxx.yyyy"
```

```bash
npm run seed       # optional: ZOHO_ORG_ID=<id> to target a specific org
```

Expected output ends with:

```
  sales order SO-00010 for Arjun Mehta (confirmed)

Done. Low-stock items: KUR-IND-M, KUR-IND-L, DUP-TEA, PAL-WHT-M, JWL-JHU.
```

### A11. Create an API key

On the connection page → **API keys** → name it (e.g. `Local test`) → **Create API key**. Copy the key (it's shown **once**) and add it to `.env.local`:

```bash
MCP_URL="http://localhost:3000/api/mcp"
MCP_API_KEY="zic_..."
```

The page also shows a ready-to-paste MCP client config.

### A12. Run the end-to-end test

```bash
npm run test:connector              # 15 checks
npm run test:connector -- --burst   # + 40 parallel calls against the rate limiter
```

Expected (timings vary):

```
Testing http://localhost:3000/api/mcp

✓ auth: missing key is rejected with 401          401, WWW-Authenticate: Bearer error="invalid_token", …
✓ auth: unknown key is rejected with 401          401
✓ tools/list                                      get_connection_info, list_items, search_items, get_item, …
✓ get_connection_info                             Amit test org · INR · Asia/Calcutta
✓ list_items                                      5 items, has_more=true
✓ search_items by SKU                             GFT-WRP → stock on hand 200
✓ get_item: committed vs available for sale       GFT-WRP: on hand 200, committed 2, sellable 198, 0 location(s)
✓ get_low_stock_items                             5 below reorder level: PAL-WHT-M, KUR-IND-L, KUR-IND-M, DUP-TEA, JWL-JHU
✓ list_sales_orders                               5 orders, newest SO-00004
✓ get_sales_order by number                       SO-00004: draft, paid=null, 1 line(s)
✓ search_sales_orders                             1 match(es) for "Ananya"
✓ search_customers → get_customer                 Ananya Iyer, outstanding 0
✓ list_locations                                  Head Office (primary)
✓ error: unknown item → NOT_FOUND with hint       NOT_FOUND
✓ error: invalid arguments rejected before Zoho   validation error
✓ rate limit: 40 parallel calls are paced or shed, never hung   {"ok":15,"RATE_LIMITED":25}, p50 …, slowest …

16/16 checks passed
```

**What each check proves**

| Check | Proves |
|---|---|
| auth 401 ×2 | No key or a wrong key never reaches a tool. The 401 carries a standard `WWW-Authenticate` challenge |
| tools/list | All 12 tools are exposed with schemas over MCP |
| get_connection_info | The key resolves to the right organization |
| list / search / get | Every primitive works against live Zoho, with pagination |
| committed vs available | The stock-accuracy fix: `available_for_sale` is present |
| low stock | The catalog scan finds exactly the seeded low-stock items, most urgent first |
| sales order by number | Number → ID resolution, then detail with line items |
| NOT_FOUND | Zoho errors become typed errors with a `hint` for the agent |
| invalid arguments | Zod rejects bad input **before** any Zoho call (no quota used) |
| burst | The rate limiter lets ~10 through at once, paces the next few at 1.5/s, and returns `RATE_LIMITED` with `retry_after_ms` instead of letting Zoho 429 |

### A13. Check the usage dashboard

Reload the connection page. **Usage · last 7 days** shows the tool calls you just made, the error rate (the deliberate NOT_FOUND and RATE_LIMITED calls), p95 latency, Zoho requests used, the most-used tools and recent calls.

### A14. Try the failure paths by hand (optional)

| Try | Expected |
|---|---|
| **Revoke** the key in the dashboard, rerun `npm run test:connector` | Every call → 401 |
| Call `get_item` with `{"item_id":"abc"}` | Validation error mentioning "numeric Zoho ID", and no Zoho call in the usage log |
| Revoke the connector's access in your Zoho account's connected-apps settings, then call tools | Once the current access token is rejected (at the latest when it expires, ≤1 h), the refresh fails, the call returns `REAUTH_REQUIRED`, the connection shows **Reconnect needed**, and later calls fail fast without contacting Zoho |
| **Disconnect** in the dashboard | Refresh token revoked at Zoho; connection, keys and logs deleted |

---

## Part B: Test the deployed app

Live deployment: **https://zoho-inventory-connector.vercel.app**

### B1. Option 1: use your own account (full flow)

1. Open https://zoho-inventory-connector.vercel.app → **Connect Zoho Inventory** → create an account.
2. **Connect with Zoho** (data center India) → approve. You need a Zoho Inventory org; a free one takes 2 minutes to create at [inventory.zoho.in](https://inventory.zoho.in).
3. Create an API key on the connection page.
4. Your org is probably empty. Seeding works from your machine against any org (A10), or you can test against whatever data you have.

### B2. Option 2: use the demo key (fastest)

The author can share a read-only demo key for a seeded organization (sent separately, not in the repo). With it:

```bash
export MCP_URL="https://zoho-inventory-connector.vercel.app/api/mcp"
export MCP_API_KEY="zic_..."     # demo key
```

### B3. Run the end-to-end test against production

From a clone of the repo (`npm install` only; no `.env.local` needed):

```bash
MCP_URL="https://zoho-inventory-connector.vercel.app/api/mcp" MCP_API_KEY="zic_..." \
  npm run test:connector -- --burst
```

Expect 16/16. Production runs in `bom1` (Mumbai), next to Zoho's India data center and the Supabase database, so single calls usually take 150–600 ms.

### B4. Test with plain curl (no repo needed)

```bash
URL=https://zoho-inventory-connector.vercel.app/api/mcp
KEY=zic_...
H=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
   -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18")

# 1. No key → 401
curl -si -X POST $URL -H "Content-Type: application/json" -d '{}' | head -1

# 2. List tools
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 3. Low-stock report
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
  "params":{"name":"get_low_stock_items","arguments":{}}}'

# 4. Can we sell 2 more indigo kurtas (M)? → search, then get_item for available_for_sale
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
  "params":{"name":"search_items","arguments":{"sku":"KUR-IND-M"}}}'

# 5. Order status by number
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":4,"method":"tools/call",
  "params":{"name":"get_sales_order","arguments":{"salesorder_number":"SO-00001"}}}'

# 6. A typed error
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":5,"method":"tools/call",
  "params":{"name":"get_item","arguments":{"item_id":"999999999999"}}}'
```

Responses arrive as Server-Sent Events: the JSON-RPC message is on the `data:` line. Tool results are in `result.content[0].text` (JSON) and also in `result.structuredContent`.

### B5. Test with MCP Inspector (visual)

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. **Transport:** Streamable HTTP
2. **URL:** `https://zoho-inventory-connector.vercel.app/api/mcp`
3. Add a request header `Authorization` with value `Bearer zic_...` (in the Inspector's authentication/headers section)
4. **Connect** → **Tools** → **List Tools**, then run any tool with its form.

---

## Part C: Test with a real agent

This is the most convincing demo: an agent answering merchant questions by choosing tools on its own.

### Claude Code

```bash
claude mcp add --transport http zoho-inventory https://zoho-inventory-connector.vercel.app/api/mcp \
  --header "Authorization: Bearer zic_..."
claude
```

### Other MCP clients (Cursor, Windsurf, …)

Clients that support remote Streamable HTTP servers with custom headers:

```json
{
  "mcpServers": {
    "zoho-inventory": {
      "url": "https://zoho-inventory-connector.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer zic_..." }
    }
  }
}
```

For clients that only support local (stdio) servers, bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "zoho-inventory": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://zoho-inventory-connector.vercel.app/api/mcp",
               "--header", "Authorization: Bearer zic_..."]
    }
  }
}
```

### Questions to ask (with the seeded data)

| Ask | What a good answer looks like |
|---|---|
| "Which products do we need to reorder? Most urgent first." | `get_low_stock_items` → PAL-WHT-M, KUR-IND-L, KUR-IND-M, DUP-TEA, JWL-JHU |
| "Can a customer order 2 Indigo Block-Print Kurtas in M right now?" | `search_items` → `get_item` → **No**: 3 on hand but 2 committed, so only 1 is sellable |
| "What's the status of Priya Sharma's latest order?" | `search_customers` → `list_sales_orders(customer_id)` → `get_sales_order`: confirmed, unpaid, not shipped |
| "Show me draft orders from this week." | `list_sales_orders(status=draft, date_from=…)` |
| "Cancel order SO-00004." | The agent explains it **can't**: the connector is read-only |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Zoho shows **Invalid Redirect URI** | The callback URL isn't registered on the Zoho client. Add `<APP_URL>/api/oauth/zoho/callback` exactly (no trailing slash). `npm run check:setup` prints the exact value |
| `check:setup` → Zoho said `invalid_client` | Wrong client ID or secret, or a client from another region's console |
| "This Zoho account has no Zoho Inventory organization" | Finish the org setup at inventory.zoho.in first |
| "Zoho did not return a refresh token" | Zoho only issues one on explicit consent. Click Connect again and approve |
| Dashboard error "Invalid server environment" | A variable in `.env.local` is missing or malformed. The message lists which one |
| Every tool returns `REAUTH_REQUIRED` | Zoho access was revoked or expired. Click **reconnect** on the connection page |
| `list_locations` or a tool returns `FORBIDDEN_SCOPE` | The Zoho grant lacks that scope. Reconnect so the current scopes are requested |
| `npm run seed` → `invalid_code` | Self Client codes are single-use and expire within 10 minutes. Generate a new one |
| Seeding fails on a second run with a duplicate SKU | Items already exist. Delete them in Zoho or change the SKUs in `scripts/seed-zoho.ts` |
| Tokens can't be decrypted after deploying | Local and deployed use different `TOKEN_ENCRYPTION_KEY`s against the same database. Use one key everywhere, then reconnect |
