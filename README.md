# Zoho Inventory Connector for Agent Studio

A private connector that lets an AI agent **read a merchant's Zoho Inventory**: products and stock, sales orders, customers and locations. Agents reach it over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

The merchant connects their Zoho account once with OAuth. They then create an API key for each agent, and the agent calls 12 read-only tools at a single MCP endpoint. Every call is rate-limited against Zoho's quota and logged to a usage dashboard.

**Assignment option chosen:** *3. Build a private connector for a merchant tool* (Zoho Inventory).

| | |
|---|---|
| **Live app** | https://zoho-inventory-connector.vercel.app |
| **MCP endpoint** | `https://zoho-inventory-connector.vercel.app/api/mcp` (Streamable HTTP, bearer API key) |
| **Tool spec** | [`docs/mcp-tools.json`](docs/mcp-tools.json) (generated from the server) · [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md) (reference) |
| **What the agent can / can't do** | [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) |
| **Step-by-step testing (local + deployed)** | [`docs/TESTING.md`](docs/TESTING.md) |
| **Design decisions and load-test findings** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

---

## The merchant problem

A D2C brand running on Zoho Inventory gets the same questions all day, from customers and from its own team:

- *"Where is my order SO-00042? Has it shipped?"*
- *"Is the indigo kurta in size M in stock? Can I order 2?"*
- *"Which products do we need to reorder?"*
- *"What does Priya Sharma still owe us?"*

Today someone opens Zoho, searches and copies the answer back. This connector lets an Agent Studio support or ops agent answer these directly, with read-only access scoped to one organization.

**A finding that changed the design:** in a real Zoho org, *stock on hand* includes units already promised to open orders. An agent reading only that number will promise stock that's already sold (live example: 3 on hand, 2 committed, **1** sellable). The `get_item` tool returns `available_for_sale` separately, and the tool descriptions tell the agent to check it before promising anything. See [CAPABILITIES.md](docs/CAPABILITIES.md#stock-numbers-and-what-they-mean).

---

## What's included (mapped to the assignment)

| Requirement | Where |
|---|---|
| **OAuth authentication flow** | Zoho OAuth 2.0 authorization-code flow with refresh tokens: one-time CSRF state bound to the signed-in merchant, a data-center allowlist, read-only scopes, AES-256-GCM encrypted token storage, and automatic refresh with a cross-instance lock. `src/app/api/oauth/zoho/*`, `src/lib/zoho/oauth.ts`, `src/lib/zoho/token-provider.ts` |
| **API-key auth for agents** | Per-agent keys (`zic_…`), stored only as SHA-256 hashes, revocable, with last-used tracking. `src/lib/connector/api-keys.ts` |
| **list / get / search primitives** | 12 tools over items, sales orders, customers and locations, plus `get_low_stock_items` and `get_connection_info`. `src/lib/mcp/tools.ts`, `src/lib/zoho/inventory.ts` |
| **Rate-limit handling** | A Postgres token bucket shared across serverless instances (≤100 req/min per Zoho org), in-process queueing per org, a 4 s wait budget, `Retry-After`-aware retries, and full-jitter backoff on 5xx. `src/lib/zoho/rate-limiter.ts`, `src/lib/zoho/client.ts` |
| **MCP tool specification** | Generated [`docs/mcp-tools.json`](docs/mcp-tools.json) plus a human reference in [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md) |
| **What the agent can / cannot do** | [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) |
| **Working test script** | `npm run test:connector` runs 16 end-to-end checks against local or deployed. `npm test` runs 39 unit and MCP-protocol tests |
| **Setup, run, assumptions, limitations** | This README, [`docs/TESTING.md`](docs/TESTING.md), [Limitations](#assumptions-and-limitations) |

---

## Architecture

```
 Merchant (browser)                                     Agent (Agent Studio, Claude, any MCP client)
       │                                                        │
       │ sign in, connect Zoho, create keys                     │ POST /api/mcp
       ▼                                                        │ Authorization: Bearer zic_…
 ┌──────────────────────────── Next.js on Vercel (bom1, Mumbai) ▼───────────────────────────┐
 │  /login, /dashboard          /api/oauth/zoho/start → Zoho consent → /callback            │
 │  (Supabase Auth, RLS)        (state check, code exchange, org pick, encrypt + store)     │
 │                                                                                          │
 │  /api/mcp  ── verify API key + load connection (1 query)                                 │
 │            ── tool (zod-validated) ── rate limiter ── token provider ── Zoho client ──┐  │
 │            ── usage row written after the response (next/server `after`)              │  │
 └───────────────────────────────────────────────────────────────────────────────────────┼──┘
          │                                                                               │
          ▼                                                                               ▼
 Supabase Postgres (ap-south-1)                                         Zoho Inventory API
  connections · oauth_tokens (encrypted) · api_keys (hashed)            www.zohoapis.in/inventory/v1
  oauth_states · rate_limit_buckets · tool_calls                        (read-only scopes)
```

**Stack:** Next.js 16 (App Router, Cache Components) · TypeScript · `mcp-handler` 2 + MCP TypeScript SDK v2 · Zod 4 · Supabase (Auth + Postgres with RLS) · Vercel (Fluid compute, `bom1`) · Vitest.

Design decisions, the rate limiter, the token-refresh lock and the load-test findings are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quick start: try the deployed connector

These steps need no local setup. The full walkthrough is in [docs/TESTING.md → Part B](docs/TESTING.md#part-b--test-the-deployed-app).

1. Open https://zoho-inventory-connector.vercel.app → **Connect Zoho Inventory** → create an account.
2. Choose data center **India** → **Connect with Zoho** → approve read-only access.
   *Or skip both steps and ask the author for the demo API key (shared outside the repo).*
3. On the connection page, create an API key and copy it.
4. Call the endpoint:

```bash
curl -s https://zoho-inventory-connector.vercel.app/api/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_low_stock_items","arguments":{}}}'
```

5. Or connect a real agent, for example Claude Code:

```bash
claude mcp add --transport http zoho-inventory https://zoho-inventory-connector.vercel.app/api/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

---

## Local setup

The full step-by-step guide is in [docs/TESTING.md → Part A](docs/TESTING.md#part-a--run-and-test-locally). In short:

**Prerequisites:** Node.js ≥ 22, a Supabase project, a Zoho Inventory organization, and a Zoho API Console client.

```bash
git clone https://github.com/amit429/zoho-inventory-mcp-connector.git
cd zoho-inventory-mcp-connector
npm install
cp .env.example .env.local        # fill in the values (see the table below)
# apply supabase/migrations/*.sql to your Supabase project (SQL editor or `supabase db push`)
npm run check:setup               # validates env, database and Zoho credentials, prints no secrets
npm run dev                       # http://localhost:3000
```

### Environment variables

| Variable | Where it comes from | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API | no |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → API Keys → Publishable (`sb_publishable_…`) | no |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → Secret (`sb_secret_…`) | **yes**, server-only |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | [api-console.zoho.in](https://api-console.zoho.in) → Server-based Application | **yes** |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` | **yes**. Must be identical wherever the same database is used |
| `APP_URL` | `http://localhost:3000` locally; the production URL on Vercel | no |
| `MCP_URL`, `MCP_API_KEY` | Only for `npm run test:connector` | key is a secret |
| `ZOHO_SELF_CLIENT_ID/SECRET/CODE` | Only for `npm run seed` (one-off write grant) | **yes** |

**Zoho client settings:** add both redirect URIs: `http://localhost:3000/api/oauth/zoho/callback` and `https://<your-app>/api/oauth/zoho/callback`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm test` | 39 unit and MCP-protocol tests (no network) |
| `npm run typecheck` / `npm run lint` | Type checking (after `next typegen`) / ESLint |
| `npm run check:setup` | Verifies env vars, the Supabase key and schema, and Zoho client credentials, without printing secrets |
| `npm run seed` | Fills a Zoho org with fictional demo data (12 items, 8 customers, 10 orders) |
| `npm run test:connector [-- --burst]` | 16 end-to-end checks against `MCP_URL`; `--burst` adds a 40-call rate-limit test |
| `npm run export:tools` | Regenerates `docs/mcp-tools.json` from the server |

---

## Project layout

```
src/
  app/
    api/mcp/route.ts                MCP endpoint: API-key auth → tools
    api/oauth/zoho/{start,callback} Zoho OAuth connect flow
    dashboard/                      Merchant UI: connections, API keys, usage
    login/                          Supabase email + password auth
  lib/
    zoho/        Zoho-specific, framework-free, unit-tested
      client.ts           HTTP client: retries, Retry-After, 401 → refresh, error mapping
      oauth.ts            authorize URL, code exchange, refresh, revoke
      token-provider.ts   valid-token source with cross-instance refresh lock + cache
      rate-limiter.ts     shared token bucket + in-process queue
      inventory.ts        typed list/get/search + compact mappers
      datacenters.ts      Zoho DC allowlist
      errors.ts           typed errors with agent hints
    mcp/tools.ts          the 12 MCP tools (zod schemas, annotations, logging)
    connector/            wiring to Supabase: token repo, API keys, usage log
    supabase/             server (RLS) and admin (secret key) clients
    crypto.ts             AES-256-GCM, API key generation/hashing
supabase/migrations/      schema, RLS, rate-limit + refresh-lock SQL functions
scripts/                  seed, end-to-end test, setup check, tool-spec export
tests/                    Vitest: client, token provider, rate limiter, MCP wire tests
docs/                     capabilities, tool spec, testing guide, architecture
```

---

## Security

- **Least privilege:** the connector asks Zoho only for `items.READ`, `salesorders.READ`, `contacts.READ` and `settings.READ`. It cannot write. Seeding uses a separate, short-lived Self Client grant.
- **Secrets at rest:** Zoho tokens are AES-256-GCM encrypted before they reach the database. API keys are stored as SHA-256 hashes and shown once.
- **Isolation:** each API key resolves to exactly one connection, which means one Zoho organization. Merchants can only read their own rows (RLS). Token, key-hash, OAuth-state and rate-limit tables have RLS enabled with no policies, so only the server can reach them.
- **OAuth hardening:** one-time state bound to the signed-in user with a 10-minute expiry. The `accounts-server` reported by Zoho is checked against an allowlist before the client secret is sent there.
- **PII minimization:** order tools return the shipping city, state and country but not the street address. The usage log stores the tool name, status and latency, never arguments.
- **Disconnect** revokes the refresh token at Zoho and deletes the tokens, keys and logs.
- **No secrets in the repo:** `.env*` is gitignored. Production secrets are Vercel "sensitive" variables.

---

## Assumptions and limitations

The full list, including the long-term fixes, is in [CAPABILITIES.md](docs/CAPABILITIES.md#limitations-and-the-long-term-fix). The main points:

- **Read-only by design.** The agent can't create, edit, cancel or refund anything.
- **One Zoho organization per connection.** If an account has several, the default one is connected.
- **Agent auth uses static API keys**, not the MCP OAuth 2.1 authorization flow. That's practical for a private connector; OAuth 2.1 is the long-term fix.
- **Quotas:** the connector enforces Zoho's 100 requests/minute per org. Daily quotas depend on the merchant's Zoho plan and are only handled when Zoho reports them (`RATE_LIMITED`).
- **Low stock is computed by scanning the catalog** (Zoho has no low-stock endpoint), up to 1,000 items per call.
- **Search uses Zoho's own `search_text` matching**, so there's no fuzzy or semantic search.
- **Under a burst** (40 simultaneous calls), part of the burst was observed waiting in front of the function in production. In-tool latency stays within the 4 s budget. Details in [ARCHITECTURE.md](docs/ARCHITECTURE.md#load-test-findings).
- **Assumptions:** Zoho India data center by default (others selectable); merchants sign in with email and password through Supabase Auth.
