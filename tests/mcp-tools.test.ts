import { createMcpHandler } from "mcp-handler";
import { describe, expect, it } from "vitest";
import { registerInventoryTools, type ToolCallRecord, type ToolContext } from "@/lib/mcp/tools";
import { ConnectorError } from "@/lib/zoho/errors";
import { fakeFetch, json, ok, testClient } from "./helpers";

/**
 * Drives the real MCP handler over HTTP JSON-RPC, the same way an agent
 * platform would, with Zoho stubbed at the fetch layer.
 */
function setup(responders: Parameters<typeof fakeFetch>, opts: { status?: string } = {}) {
  const f = fakeFetch(...responders);
  const { client } = testClient(f.impl);
  const calls: ToolCallRecord[] = [];
  const connection: ToolContext["connection"] = {
    id: "conn-1",
    zoho_org_id: "60012345",
    zoho_org_name: "Kurta Co (demo)",
    currency_code: "INR",
    time_zone: "Asia/Calcutta",
    api_domain: "https://www.zohoapis.in",
    scopes: ["ZohoInventory.items.READ"],
    status: opts.status ?? "active",
  };

  const handler = createMcpHandler((server) =>
    registerInventoryTools(server, {
      async resolveContext() {
        if (connection.status === "needs_reauth") throw new ConnectorError("REAUTH_REQUIRED", "Zoho access expired");
        return { client, connection, apiKeyId: "key-1" };
      },
      recordCall: (r) => calls.push(r),
    }),
  );

  async function rpc(method: string, params?: unknown) {
    const res = await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text);
  }

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const { result, error } = await rpc("tools/call", { name, arguments: args });
    if (error) throw new Error(JSON.stringify(error));
    return { ...result, body: JSON.parse(result.content[0].text) };
  }

  return { rpc, callTool, calls, requests: f.requests };
}

describe("MCP tools", () => {
  it("lists every tool as read-only with an input schema", async () => {
    const { rpc } = setup([]);
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: { name: string }) => t.name).sort();

    expect(names).toEqual([
      "get_connection_info",
      "get_customer",
      "get_item",
      "get_low_stock_items",
      "get_sales_order",
      "list_customers",
      "list_items",
      "list_locations",
      "list_sales_orders",
      "search_customers",
      "search_items",
      "search_sales_orders",
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("search_items returns compact items with pagination and logs the call", async () => {
    const { callTool, calls, requests } = setup([
      ok({
        items: [
          { item_id: "901", name: "Indigo Kurta - M", sku: "KUR-IND-M", status: "active", rate: 1499, stock_on_hand: 4, available_stock: 4, reorder_level: 5, unit: "pcs", some_noisy_field: "x" },
        ],
        page_context: { page: 1, per_page: 25, has_more_page: true },
      }),
    ]);

    const { body, isError } = await callTool("search_items", { query: "kurta" });

    expect(isError).toBeFalsy();
    expect(requests[0].url.searchParams.get("search_text")).toBe("kurta");
    expect(body.results[0]).toEqual({
      item_id: "901",
      name: "Indigo Kurta - M",
      sku: "KUR-IND-M",
      status: "active",
      unit: "pcs",
      selling_price: 1499,
      stock_on_hand: 4,
      reorder_level: 5,
      below_reorder_level: true,
    });
    expect(body.pagination).toEqual({ page: 1, per_page: 25, has_more: true, next_page: 2 });
    expect(calls).toMatchObject([{ tool: "search_items", status: "ok", zohoRequests: 1, apiKeyId: "key-1" }]);
  });

  it("get_item separates committed stock from what can actually be sold, per location", async () => {
    // Shapes taken from a live Zoho Inventory (India) organization.
    const { callTool } = setup([
      ok({
        item: {
          item_id: "901", name: "Indigo Kurta - M", sku: "KUR-IND-M", stock_on_hand: 3, available_stock: 3,
          committed_stock: 2, actual_committed_stock: 2, available_for_sale_stock: 1, actual_available_for_sale_stock: 1,
          reorder_level: 5,
          locations: [{ location_id: "42", location_name: "Head Office", location_stock_on_hand: 3, location_actual_available_for_sale_stock: 1 }],
        },
      }),
    ]);

    const { body } = await callTool("get_item", { item_id: "901" });

    expect(body).toMatchObject({ stock_on_hand: 3, committed_stock: 2, available_for_sale: 1, below_reorder_level: true });
    expect(body.locations).toEqual([{ location_id: "42", location_name: "Head Office", stock_on_hand: 3, available_for_sale: 1 }]);
  });

  it("get_sales_order by number resolves the number, then returns tracking and line items", async () => {
    const { callTool, requests } = setup([
      ok({ salesorders: [{ salesorder_id: "7001", salesorder_number: "SO-00042" }], page_context: {} }),
      ok({
        salesorder: {
          salesorder_id: "7001",
          salesorder_number: "SO-00042",
          customer_name: "Priya Sharma",
          order_status: "confirmed",
          shipped_status: "partially_shipped",
          paid_status: "unpaid",
          total: 2998,
          currency_code: "INR",
          shipping_address: { address: "12 MG Road", city: "Pune", state: "Maharashtra", country: "India" },
          line_items: [{ item_id: "901", sku: "KUR-IND-M", name: "Indigo Kurta - M", quantity: 2, quantity_shipped: 1, rate: 1499, item_total: 2998 }],
          packages: [{ package_number: "PKG-00011", status: "shipped", carrier: "Delhivery", tracking_number: "DLV123456" }],
        },
      }),
    ]);

    const { body } = await callTool("get_sales_order", { salesorder_number: "SO-00042" });

    expect(requests.map((r) => r.url.pathname)).toEqual(["/inventory/v1/salesorders", "/inventory/v1/salesorders/7001"]);
    expect(body).toMatchObject({
      salesorder_number: "SO-00042",
      status: "confirmed",
      shipped_status: "partially_shipped",
      paid_status: "unpaid",
      line_items: [{ sku: "KUR-IND-M", quantity: 2, quantity_shipped: 1 }],
      packages: [{ carrier: "Delhivery", tracking_number: "DLV123456" }],
    });
    // Street address is intentionally not exposed.
    expect(body.shipping_location).toEqual({ city: "Pune", state: "Maharashtra", country: "India" });
  });

  it("rejects invalid arguments before calling Zoho", async () => {
    const { rpc, requests } = setup([]);
    const { result, error } = await rpc("tools/call", { name: "get_item", arguments: { item_id: "abc" } });

    const message = JSON.stringify(error ?? result);
    expect(message).toMatch(/numeric Zoho ID/);
    expect(requests).toHaveLength(0);
  });

  it("returns typed, agent-readable errors with a hint", async () => {
    const { callTool, calls } = setup([json(404, { code: 1002, message: "Item does not exist." })]);

    const { isError, body } = await callTool("get_item", { item_id: "123" });

    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(body.error.hint).toMatch(/list_ or search_/);
    expect(calls).toMatchObject([{ tool: "get_item", status: "error", errorCode: "NOT_FOUND" }]);
  });

  it("tells the agent not to retry when the merchant must reconnect", async () => {
    const { callTool, requests } = setup([], { status: "needs_reauth" });

    const { isError, body } = await callTool("list_items");

    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "REAUTH_REQUIRED", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it("get_low_stock_items scans pages and sorts the most urgent first", async () => {
    const page = (items: object[], hasMore: boolean) =>
      ok({ items, page_context: { page: 1, per_page: 200, has_more_page: hasMore } });
    const { callTool } = setup([
      page([{ item_id: "1", name: "A", stock_on_hand: 4, reorder_level: 5 }, { item_id: "2", name: "B", stock_on_hand: 50, reorder_level: 5 }], true),
      page([{ item_id: "3", name: "C", stock_on_hand: 0, reorder_level: 10 }], false),
    ]);

    const { body } = await callTool("get_low_stock_items", { max_pages: 2 });

    expect(body.results.map((i: { item_id: string }) => i.item_id)).toEqual(["3", "1"]);
    expect(body).toMatchObject({ scanned_items: 3, complete: true });
  });
});
