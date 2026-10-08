# Architecture and design decisions

## Why a hosted connector, not a local script

An Agent Studio agent runs on a platform, not on the merchant's laptop. The connector therefore has to be a **network service**: the merchant authorizes once, and any number of agents call it by URL. That requirement drives the design:

- OAuth tokens must live in a **shared, durable store** (Postgres), not in a local file.
- Many **serverless instances** serve the same merchant at once, so the rate limit and the token refresh must be coordinated across instances, not in memory.
- The merchant needs a **self-serve UI** to connect, issue and revoke agent keys, and see whether the connector is used and healthy.

## Components

| Component | Tech | Responsibility |
|---|---|---|
| Merchant UI | Next.js App Router, Server Components + Server Actions | Sign in, connect Zoho, create/revoke keys, usage stats |
| OAuth routes | Route Handlers `/api/oauth/zoho/{start,callback}` | Zoho authorization-code flow |
| MCP endpoint | `mcp-handler` + MCP SDK v2, `/api/mcp` | API-key auth, tool dispatch, usage logging |
| Zoho core (`src/lib/zoho`) | Plain TypeScript, no framework or DB imports | HTTP client, OAuth, token provider, rate limiter, inventory mappers; fully unit-tested |
| Persistence | Supabase Postgres + Auth, RLS | Connections, encrypted tokens, hashed keys, buckets, usage |
| Hosting | Vercel Fluid compute, region `bom1` | Same metro as Zoho's India DC and the Supabase database (`ap-south-1`) |

The Zoho core depends on small interfaces (`TokenRepository`, `TakeTokenFn`, `AccessTokenSource`, `RateLimiter`) that `src/lib/connector` implements over Supabase. Tests swap in in-memory versions, which is how the refresh race and rate-limit behaviour are tested deterministically.

## Data model

```
auth.users ─┬─< connections (one per user × Zoho org; status: active | needs_reauth | revoked)
            │      ├── oauth_tokens   1:1  access/refresh AES-256-GCM, expires_at, refresh_lock_until
            │      ├─< api_keys            sha256(key), prefix, last_used_at, revoked_at
            │      └─< tool_calls          tool, status, error_code, latency_ms, zoho_requests
            └─< oauth_states               one-time CSRF state, 10 min expiry
rate_limit_buckets  (bucket_key = "zoho-org:<org_id>", tokens, updated_at)
```

**RLS:** merchants can `SELECT` their own `connections`, `api_keys` (without `key_hash`, enforced by a column-level grant) and `tool_calls`. `oauth_tokens`, `oauth_states` and `rate_limit_buckets` have RLS enabled with no policies, so only the server's secret key can reach them. All writes go through the server, which first re-checks ownership through the merchant's RLS-bound client.

## Flow 1: connecting Zoho (OAuth 2.0 authorization code)

```
Merchant          App (/api/oauth/zoho/start)        Zoho Accounts            App (/callback)                 Postgres
   │ Connect (dc=in) ─▶│ require session                                                                       
   │                   │ insert oauth_states(state, user_id, accounts_server) ─────────────────────────────────▶│
   │◀── 302 ───────────│ authorize?scope=*.READ&access_type=offline&prompt=consent&state
   │ consent ─────────────────────────────────────────▶│
   │◀──────────────── 302 ?code&state&accounts-server ─│
   │ ──────────────────────────────────────────────────────────────────▶│ require session
   │                                                                    │ DELETE state WHERE user=me AND not expired ─▶│ (one-time)
   │                                                                    │ accounts-server ∈ allowlist?   
   │                                                                    │ POST /oauth/v2/token (code) ─▶ Zoho
   │                                                                    │ api_domain ∈ allowlist?
   │                                                                    │ GET /organizations → pick default org
   │                                                                    │ upsert connection; encrypt + store tokens ──▶│
   │◀──────────────────────────────────── 302 /dashboard/connections/:id│
```

Decisions:
- **`prompt=consent` + `access_type=offline`:** Zoho only returns a refresh token on explicit consent.
- **State bound to the user and deleted on read:** stops CSRF and replay. The delete-returning query makes it single-use atomically.
- **Data-center allowlist:** the callback's `accounts-server` decides where the **client secret** is sent, so it must be a known Zoho host. The same check applies to the returned `api_domain`.
- **Read-only scopes:** `ZohoInventory.{items,salesorders,contacts,settings}.READ`. Least privilege also limits the damage from a connector bug.

## Flow 2: a tool call

```
Agent ─POST /api/mcp (Bearer zic_…)─▶ withMcpAuth
   verifyApiKey: 1 query → api_keys ⋈ connections (reject unknown/revoked)
   └─ last_used_at write: at most 1/min/key, fire-and-forget
 ─▶ MCP SDK: validate args with the tool's Zod schema (bad input never reaches Zoho)
 ─▶ resolveContext: connection.status needs_reauth → REAUTH_REQUIRED immediately (no Zoho call)
 ─▶ ZohoInventoryClient.get()
       1. rateLimiter.acquire("zoho-org:<id>")      ≤ 4 s, else RATE_LIMITED
       2. tokens.getAccessToken()                   memory cache → DB → refresh under lock
       3. fetch Zoho (15 s timeout)
          401 → refresh once (pass the rejected token) and retry
          429 → honor Retry-After if ≤ 10 s, else RATE_LIMITED(retry_after_ms)
          5xx / network → full-jitter backoff, max 3 retries
          code ≠ 0 → typed ConnectorError (NOT_FOUND, FORBIDDEN_SCOPE, …)
 ─▶ map to a compact record → content[0].text + structuredContent
 ─▶ after(response): insert tool_calls row (tool, status, latency, zoho_requests)
```

## Rate limiting

**Goal:** never let Zoho return 429. Zoho Inventory enforces **100 requests/minute per organization**, and that budget is shared by every agent, key and serverless instance using the org.

**Shared token bucket in Postgres** (`take_rate_limit_token`): capacity **10**, refill **1.5 tokens/s**. In any 60 s window that allows at most 10 + 60×1.5 = **100** requests. A unit test runs the client against a simulated clock and asserts ≤ 100 per window.

**Per-instance FIFO queue per org:** callers in the same instance wait in memory and only the head of the queue talks to Postgres (see the findings below for why).

**Wait budget: 4 s, on the wall clock.** If a token isn't available in time, the tool returns `RATE_LIMITED` with `retry_after_ms`. A pending bucket RPC is **aborted** at the deadline. A timeout counts as `RATE_LIMITED`, not as a backend failure.

**Fail-open on database errors:** if the bucket RPC errors (not times out), the request proceeds. Zoho's own 429 handling in the client is the backstop. This trades strict quota protection for availability when Supabase is unavailable.

**Reactive layer:** a Zoho 429 with a short `Retry-After` is retried inline; a long one (e.g. the daily quota) becomes `RATE_LIMITED` immediately so the agent isn't held.

## Token refresh across instances

Zoho limits how many access tokens a refresh token can mint in a short window. If every instance that sees an expired token refreshes it, a burst of traffic can get the merchant's connection throttled.

`TokenProvider.getAccessToken()`:

1. **In-memory cache** per instance: return the cached token if it's more than 2 minutes from expiry and isn't the one Zoho just rejected.
2. Load from Postgres; return it if valid.
3. Otherwise take a **lease** (`acquire_refresh_lock`: `UPDATE … WHERE refresh_lock_until < now()`, a 20 s lease).
4. **Re-read under the lock** (double-checked locking). Another instance may have refreshed and released the lock between steps 2 and 3. Without this re-check, a unit test caught a second, redundant refresh intermittently.
5. Refresh, save, release. Instances that didn't get the lock poll until the new token appears (10 s max).
6. If Zoho rejects the refresh token (`invalid_code`), mark the connection `needs_reauth`. Later calls fail fast with `REAUTH_REQUIRED` without contacting Zoho, and the dashboard shows "Reconnect needed".

A 401 passes the rejected token in, so the refresh is forced, unless another instance has already replaced that token.

## Load-test findings

Every finding below came from running `npm run test:connector -- --burst` (40 simultaneous `list_items` calls) against the real Zoho org, measuring, and fixing. Each fix has a regression test.

| # | Observed | Root cause | Fix |
|---|---|---|---|
| 1 | Burst calls took up to **24 s** inside the tool, with an 8 s budget | The limiter added up its sleeps (~70 ms each, because the bucket reported fractional waits) but not the 200–400 ms database round trips | Budget enforced on the **wall clock**; a minimum poll interval of 200 ms + jitter |
| 2 | Each limiter RPC took **~3 s** under 40-way concurrency (81 ms alone) | `INSERT … ON CONFLICT DO NOTHING` on an existing row waits for any in-progress transaction that updated it, so every caller serialized | SQL v2: `SELECT … FOR UPDATE SKIP LOCKED` first; insert only if the bucket doesn't exist (non-blocking check); a busy row → "retry in 250 ms" |
| 3 | Still ~3 s per RPC; plain reads at the same concurrency took 330 ms | Every waiting caller polled with a write transaction; the database could only run a few at once | **In-process FIFO queue per org**, so one instance makes one bucket call at a time; RPC aborted at the deadline |
| 4 | Stale-read double refresh (intermittent unit-test failure) | Read → another instance refreshes and releases → acquire lock → refresh again | Re-read after acquiring the lock |
| 5 | ~5 Supabase round trips per tool call | Key lookup, connection lookup, `last_used_at` write, token read on every call | Key and connection in one query; `last_used_at` at most once a minute; in-memory token cache. Single calls ~2× faster (e.g. `get_low_stock_items` 802 → 252 ms locally) |
| 6 | **Production only:** after warm-up traffic, a 40-request burst reached the tool in two waves ~10 s apart; end-to-end up to 20–25 s while in-tool latency stayed within budget | Requests queued in front of the function (not in connector code; the tool-call log shows each call stayed within its budget, and no fail-open was logged) | Wait budget lowered from 8 s to **4 s** so held requests free their slots sooner; the burst check now asserts what the connector controls (every call ends `ok` or `RATE_LIMITED`, none hangs) and reports end-to-end numbers |

**Final results:**
- **Local:** 40-call burst → 15 ok, 25 `RATE_LIMITED`, slowest 9 s.
- **Production:** all checks pass. Zoho never returned a 429 in any run.

Finding #6 is listed as a known limitation. The long-term fix is to smooth bursts at the source (agent-side concurrency plus `retry_after_ms`), or to move rate-limit waiting out of request handlers into a queue.

## Other findings from the live org

- **Committed vs sellable stock:** see [CAPABILITIES.md](CAPABILITIES.md#stock-numbers-and-what-they-mean). The list endpoint omits committed stock, so `get_item` is the source of truth.
- **Warehouses → locations:** `GET /settings/warehouses` returns code 57 ("not authorized") on a current org even with `settings.READ`; `GET /locations` works. Item detail maps per-location stock from either the `locations` or the older `warehouses` shape.
- **Zoho reports OAuth errors with HTTP 200** and an `error` field; the token client checks the body, not just the status.

## Next.js 16 notes

- **Cache Components** is on (scaffold default). Session-dependent UI sits inside `<Suspense>`, and `supabaseServer()` calls `await connection()`: Supabase's session check reads the clock, which Cache Components rejects during prerender/prefetch validation.
- **`proxy.ts`** (formerly `middleware.ts`) refreshes the Supabase session cookie on page navigations and is excluded from `/api/mcp`.
- **`after()`** writes the usage row after the response, so logging adds no latency.

## Testing strategy

| Layer | How | Count |
|---|---|---|
| Zoho HTTP client | Fake `fetch` responses: 429 + Retry-After, 401 → refresh, 5xx backoff, network errors, error mapping | 14 |
| Token provider | In-memory repo with the same lease semantics; 10 concurrent "instances"; cache; rejected token; re-auth | 8 |
| Rate limiter | Simulated clock (≤100/min), wall-clock budget with slow RPCs, poll floor, in-process FIFO, per-org isolation, abort at deadline, fail-open | 9 |
| MCP protocol | The real `createMcpHandler` driven over JSON-RPC with Zoho stubbed: tool list and annotations, output shapes, validation, typed errors, re-auth short-circuit | 8 |
| End-to-end | `scripts/test-connector.ts` against local or deployed, real Zoho | 16 |
