/**
 * End-to-end check of a deployed connector, speaking MCP over HTTP exactly
 * like an agent platform would.
 *
 *   MCP_URL=https://<app>.vercel.app/api/mcp MCP_API_KEY=zic_... npm run test:connector
 *   ... npm run test:connector -- --burst   # also fire 40 parallel calls at the rate limiter
 *
 * Exits non-zero if any check fails.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const url = process.env.MCP_URL;
const key = process.env.MCP_API_KEY;
if (!url || !key) {
  console.error("Set MCP_URL and MCP_API_KEY");
  process.exit(1);
}

let id = 0;
async function rpc(method: string, params?: unknown, bearer: string | null = key!) {
  const res = await fetch(url!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(bearer && { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let body: { result?: Record<string, unknown>; error?: unknown } | null = null;
  try {
    body = JSON.parse(data ? data.slice(6) : text);
  } catch {
    // non-JSON (e.g. 401 challenge)
  }
  return { status: res.status, headers: res.headers, body };
}

type ToolResult = { isError?: boolean; data: Record<string, unknown> & { error?: { code: string } } };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body?.result as { isError?: boolean; content: { text: string }[] } | undefined;
  if (!result) throw new Error(`No result: ${JSON.stringify(body)}`);
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: performance.now() - started });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), ms: performance.now() - started });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
type Rows = { results: Record<string, unknown>[]; pagination?: { has_more: boolean } };

async function main() {
  console.log(`Testing ${url}\n`);

  await check("auth: missing key is rejected with 401", async () => {
    const { status, headers } = await rpc("tools/list", undefined, null);
    assert(status === 401, `expected 401, got ${status}`);
    return `401, WWW-Authenticate: ${headers.get("www-authenticate")?.slice(0, 40)}…`;
  });

  await check("auth: unknown key is rejected with 401", async () => {
    const { status } = await rpc("tools/list", undefined, "zic_not_a_real_key");
    assert(status === 401, `expected 401, got ${status}`);
    return "401";
  });

  await check("tools/list", async () => {
    const { body } = await rpc("tools/list");
    const tools = (body?.result?.tools ?? []) as { name: string }[];
    assert(tools.length === 12, `expected 12 tools, got ${tools.length}`);
    return tools.map((t) => t.name).join(", ");
  });

  await check("get_connection_info", async () => {
    const { data, isError } = await call("get_connection_info");
    assert(!isError, JSON.stringify(data));
    return `${data.organization_name} · ${data.currency_code} · ${data.time_zone}`;
  });

  let item: Record<string, unknown> | undefined;
  await check("list_items", async () => {
    const { data, isError } = await call("list_items", { per_page: 5 });
    assert(!isError, JSON.stringify(data));
    const rows = (data as unknown as Rows).results;
    item = rows[0];
    return `${rows.length} items, has_more=${(data as unknown as Rows).pagination?.has_more}`;
  });

  await check("search_items by SKU", async () => {
    assert(item?.sku, "no item with a SKU to search for");
    const { data, isError } = await call("search_items", { sku: item.sku });
    assert(!isError, JSON.stringify(data));
    const rows = (data as unknown as Rows).results;
    assert(rows.some((r) => r.sku === item!.sku), `SKU ${item.sku} not found`);
    return `${item.sku} → stock on hand ${rows[0].stock_on_hand}`;
  });

  await check("get_item: committed vs available for sale", async () => {
    assert(item, "no item");
    const { data, isError } = await call("get_item", { item_id: item.item_id });
    assert(!isError, JSON.stringify(data));
    assert(typeof data.available_for_sale === "number", "available_for_sale missing");
    return `${data.sku}: on hand ${data.stock_on_hand}, committed ${data.committed_stock}, sellable ${data.available_for_sale}, ${(data.locations as unknown[]).length} location(s)`;
  });

  await check("get_low_stock_items", async () => {
    const { data, isError } = await call("get_low_stock_items", { max_pages: 1 });
    assert(!isError, JSON.stringify(data));
    const rows = (data as unknown as Rows).results;
    return `${rows.length} below reorder level: ${rows.map((r) => r.sku).join(", ")}`;
  });

  let order: Record<string, unknown> | undefined;
  await check("list_sales_orders", async () => {
    const { data, isError } = await call("list_sales_orders", { per_page: 5 });
    assert(!isError, JSON.stringify(data));
    order = (data as unknown as Rows).results[0];
    return `${(data as unknown as Rows).results.length} orders, newest ${order?.salesorder_number}`;
  });

  await check("get_sales_order by number", async () => {
    assert(order, "no order");
    const { data, isError } = await call("get_sales_order", { salesorder_number: order.salesorder_number });
    assert(!isError, JSON.stringify(data));
    return `${data.salesorder_number}: ${data.status}, paid=${data.paid_status}, ${(data.line_items as unknown[]).length} line(s)`;
  });

  await check("search_sales_orders", async () => {
    assert(order?.customer_name, "no order with a customer");
    const { data, isError } = await call("search_sales_orders", { query: String(order.customer_name).split(" ")[0] });
    assert(!isError, JSON.stringify(data));
    return `${(data as unknown as Rows).results.length} match(es) for "${String(order.customer_name).split(" ")[0]}"`;
  });

  await check("search_customers → get_customer", async () => {
    assert(order?.customer_name, "no order with a customer");
    const { data, isError } = await call("search_customers", { query: String(order.customer_name) });
    assert(!isError, JSON.stringify(data));
    const c = (data as unknown as Rows).results[0];
    assert(c, "customer not found");
    const detail = await call("get_customer", { customer_id: c.customer_id });
    assert(!detail.isError, JSON.stringify(detail.data));
    return `${detail.data.name}, outstanding ${detail.data.outstanding_receivable}`;
  });

  await check("list_locations", async () => {
    const { data, isError } = await call("list_locations");
    assert(!isError, JSON.stringify(data));
    const rows = (data as unknown as Rows).results;
    assert(rows.length > 0, "no locations");
    return rows.map((r) => `${r.name}${r.is_primary ? " (primary)" : ""}`).join(", ");
  });

  await check("error: unknown item → NOT_FOUND with hint", async () => {
    const { data, isError } = await call("get_item", { item_id: "999999999999" });
    assert(isError && data.error?.code === "NOT_FOUND", JSON.stringify(data));
    return "NOT_FOUND";
  });

  await check("error: invalid arguments rejected before Zoho", async () => {
    const { body } = await rpc("tools/call", { name: "get_item", arguments: { item_id: "abc" } });
    assert(JSON.stringify(body).includes("numeric Zoho ID"), JSON.stringify(body));
    return "validation error";
  });

  if (process.argv.includes("--burst")) {
    await check("rate limit: 40 parallel calls are paced or shed, never hung", async () => {
      // Expected: ~10 succeed at once (bucket capacity), a few more as tokens
      // refill at 1.5/s, and the rest fail fast as RATE_LIMITED once their 4s
      // wait budget runs out. Zoho itself should never answer 429.
      //
      // End-to-end time also includes anything in front of the connector. In
      // production, a burst landing on one warm instance was observed to queue
      // part of it until earlier requests finished, so this checks for a hang
      // (30s) rather than for the 4s in-tool budget, and reports the numbers.
      const timed = await Promise.all(
        Array.from({ length: 40 }, async () => {
          const started = performance.now();
          const r = await call("list_items", { per_page: 1 });
          return { code: r.isError ? r.data.error?.code ?? "?" : "ok", ms: performance.now() - started };
        }),
      );
      const tally = timed.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.code]: (acc[t.code] ?? 0) + 1 }), {});
      const sorted = timed.map((t) => t.ms).sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const slowest = sorted.at(-1)!;
      assert(Object.keys(tally).every((c) => c === "ok" || c === "RATE_LIMITED"), JSON.stringify(tally));
      assert(slowest < 30_000, `slowest call took ${Math.round(slowest)}ms`);
      return `${JSON.stringify(tally)}, p50 ${(p50 / 1000).toFixed(1)}s, slowest ${(slowest / 1000).toFixed(1)}s`;
    });
  }

  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(48)} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
