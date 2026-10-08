# What the agent can and cannot do

This is the contract between the connector and an Agent Studio agent. Each API key gives an agent **read-only** access to **one merchant's Zoho Inventory organization**.

## At a glance

| The agent **can** | The agent **cannot** |
|---|---|
| Look up products by name, description or exact SKU | Create, edit or delete products |
| See stock on hand, stock committed to orders, and stock **available to sell** | Adjust stock, transfer between locations, or reserve stock |
| See per-location stock (multi-location orgs) and list locations | Read bin/storage-level stock within a location |
| Find products at or below their reorder level | Create purchase orders or trigger reorders |
| Find and read sales orders by number, reference, customer, status or date | Create, confirm, edit, cancel or void orders |
| See an order's line items, packed/shipped/invoiced quantities, packages, carrier and tracking number | Create packages or shipments, or change tracking info |
| See an order's invoices, totals and balance due, and its payment status | Record payments, issue refunds, send invoices or payment links |
| Find customers by name, company, email or phone; see contact details and outstanding receivables | Edit customers, or read their full street address |
| Read the org's name, currency, time zone and granted scopes | Access other Zoho organizations, other Zoho apps (Books, CRM, Desk) or other merchants' data |

**Why read-only:** the first job of a support or ops agent is answering questions. Writes such as cancelling an order or adjusting stock need human approval, idempotency and an audit trail to be safe; see [the long-term plan](#limitations-and-the-long-term-fix). The OAuth grant itself is read-only (`*.READ` scopes), so even a bug in the connector can't modify the merchant's Zoho data.

## Questions it answers well

| Merchant or customer question | Tools the agent uses |
|---|---|
| "Where is my order SO-00042? Has it shipped? Tracking number?" | `get_sales_order(salesorder_number)` |
| "Where's my order?" (customer gives name/email only) | `search_customers` → `list_sales_orders(customer_id)` → `get_sales_order` |
| "Is the indigo kurta in M in stock? Can I order 2?" | `search_items` → `get_item` → read `available_for_sale` |
| "Which products should we reorder?" | `get_low_stock_items` |
| "Where is SKU X stocked?" | `get_item` (per-location stock) + `list_locations` |
| "How much does customer Y owe us?" | `search_customers` → `get_customer` (`outstanding_receivable`) |
| "What did we sell this week? Any drafts pending?" | `list_sales_orders(date_from, date_to, status)` |
| "Is order SO-00010 paid and invoiced?" | `get_sales_order` (`paid_status`, `invoiced_status`, `invoices[].balance`) |

## Stock numbers and what they mean

This matters for support agents, and it came out of testing against a live organization:

| Field | Tools | Meaning |
|---|---|---|
| `stock_on_hand` | list, search, get, low-stock | Physical units, **including units already promised to open sales orders** |
| `committed_stock` | `get_item` only | Units reserved by confirmed orders that haven't shipped |
| `available_for_sale` | `get_item` only | `stock_on_hand − committed_stock`: what can be promised to a new customer |
| `reorder_level`, `below_reorder_level` | all item tools | `below_reorder_level` = `stock_on_hand ≤ reorder_level`, the same rule Zoho uses for reorder alerts |

Zoho's list endpoint doesn't return committed or sellable stock, so list and search results can't include them. Live example from the seeded org: *Indigo Kurta M* shows `stock_on_hand: 3`, but `committed_stock: 2` and `available_for_sale: 1`. An agent that answered "yes, we have 3" would oversell. The server instructions and tool descriptions tell the agent to call `get_item` before promising stock.

## How results are shaped for agents

- **Compact records.** A raw Zoho item has 80+ fields; the tools return the ~10–20 a support or ops agent uses. That means fewer tokens per call and less for the model to misread.
- **Pagination** is uniform: `pagination: { page, per_page, has_more, next_page }`. The server instructions tell the agent to narrow filters rather than page through everything, since every page costs the merchant's Zoho quota.
- **Both forms:** each result is in `content[0].text` (JSON) and in `structuredContent`.
- **Validated input:** Zod schemas reject bad arguments (e.g. a non-numeric ID, a malformed date) **before** any Zoho call, with a message that tells the agent how to fix it.
- **Annotations:** every tool is marked `readOnlyHint: true, destructiveHint: false, idempotentHint: true`, so agent platforms can auto-approve them.

## Errors the agent will see

Every failure returns `isError: true` and a JSON body:

```json
{ "error": { "code": "NOT_FOUND", "message": "Item does not exist.", "retryable": false,
             "hint": "The record was not found. Use a list_ or search_ tool to find the correct ID." } }
```

| `code` | When | `retryable` | What the agent should do (in `hint`) |
|---|---|---|---|
| `INVALID_INPUT` | Zoho rejected an argument | no | Fix the arguments |
| `NOT_FOUND` | No such record in this org | no | Use a list/search tool to find the ID |
| `RATE_LIMITED` | Org at Zoho's per-minute limit, or Zoho's daily quota reached | **yes** | Wait `retry_after_ms`, avoid parallel calls |
| `REAUTH_REQUIRED` | Merchant revoked access or the refresh token expired | no | Tell the user; the merchant must reconnect |
| `FORBIDDEN_SCOPE` | The grant lacks the scope for this data | no | Tell the user |
| `UPSTREAM_UNAVAILABLE` | Zoho timed out or returned 5xx after 3 retries | **yes** | Retry once later |
| `UPSTREAM_ERROR` | Any other Zoho error | no | Report the message |

## Data handling

- **Customer PII exposed:** name, company, email, phone and outstanding balance (needed to identify the customer in a support conversation). Shipping is limited to **city, state, country**; street addresses are deliberately not returned.
- **Nothing is cached or stored** except, per call: tool name, status, error code, latency and the number of Zoho requests (for the usage dashboard). **Arguments and results are never stored.**
- Access tokens are cached **in memory** per server instance until shortly before expiry; at rest they are AES-256-GCM encrypted.

## Limits

| Limit | Value | Why |
|---|---|---|
| Zoho requests per org | ≤ 100 per minute (bucket of 10, refills 1.5/s) | Zoho Inventory's per-organization limit; shared by every agent and instance using that org |
| Max wait inside a tool for rate-limit capacity | 4 s, then `RATE_LIMITED` | A fast error with `retry_after_ms` is more useful to an agent than a long silent wait |
| Zoho daily quota | Plan-dependent | Not tracked proactively; surfaced as `RATE_LIMITED` when Zoho reports it |
| Results per page | 1–200 (default 25) | Zoho's maximum |
| Low-stock scan | ≤ 5 pages × 200 = 1,000 items per call | Each page uses quota; `complete: false` tells the agent the scan was partial |
| Zoho request timeout | 15 s, 3 retries on 5xx/network errors | Full-jitter exponential backoff, capped at 8 s per retry |

## Limitations and the long-term fix

| Limitation | Impact | Long-term fix |
|---|---|---|
| **Read-only** | The agent can't act (cancel, refund, adjust stock) | Add write tools behind explicit human approval (MCP elicitation or an Agent Studio approval step), with idempotency keys and an audit log; request write scopes only for those tools |
| **Static API keys for agent auth** | Keys must be copied into the agent platform; no per-user delegation or expiry | Implement MCP's OAuth 2.1 authorization (serve RFC 9728 protected-resource metadata and an authorization server; the 401 challenge already uses the standard `WWW-Authenticate: Bearer` format), so Agent Studio can obtain short-lived, scoped tokens |
| **One org per connection; default org chosen** | Accounts with several Zoho orgs connect only the default | Let the merchant pick an org after consent, or create one connection per org |
| **Low stock = catalog scan** | Slow and quota-hungry on large catalogs (>1,000 items) | Mirror item stock into Postgres via Zoho webhooks/periodic sync and query locally |
| **Daily quota handled reactively** | The agent discovers exhaustion by failing | Track daily usage per org in the same bucket table and warn early (e.g. degrade to cached data near the limit) |
| **List results lack committed stock** | Agents need a second call (`get_item`) before promising stock | The synced mirror above, keeping committed/sellable stock per item |
| **Search is Zoho's `search_text`** | No fuzzy, typo-tolerant or semantic matching | Search over the mirrored catalog (Postgres full-text or embeddings) |
| **Sales-order status filters map to Zoho's `filter_by` values** | Some org-specific custom statuses aren't filterable | Expose custom statuses from Zoho's settings and map them dynamically |
| **Burst traffic** | Under 40 simultaneous calls, part of the burst was observed waiting in front of the function in production (end-to-end up to ~25 s, while in-tool time stayed within budget) | Smooth at the source (agent-side concurrency limits; `retry_after_ms`), or move rate-limit waiting out of request handlers into a queue (e.g. Vercel Queues) and return quickly |
| **Shared encryption key** | Rotating `TOKEN_ENCRYPTION_KEY` invalidates stored tokens | The ciphertext is versioned (`v1.`); add key IDs and dual-key decryption for rotation |
