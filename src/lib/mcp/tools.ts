import type { McpServer, ServerContext, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ZohoInventoryClient } from "@/lib/zoho/client";
import { ConnectorError } from "@/lib/zoho/errors";
import * as inventory from "@/lib/zoho/inventory";

/** What a tool needs to run, resolved from the authenticated request. */
export interface ToolContext {
  client: ZohoInventoryClient;
  connection: {
    id: string;
    zoho_org_id: string;
    zoho_org_name: string | null;
    currency_code: string | null;
    time_zone: string | null;
    api_domain: string;
    scopes: string[];
    status: string;
  };
  apiKeyId: string | null;
}

export interface ToolCallRecord {
  tool: string;
  connectionId: string;
  apiKeyId: string | null;
  status: "ok" | "error";
  errorCode?: string;
  latencyMs: number;
  zohoRequests: number;
}

export interface ToolDeps {
  /** Resolves the caller's connection from the request's auth info. Throws REAUTH_REQUIRED-style errors. */
  resolveContext: (authExtra: Record<string, unknown> | undefined) => Promise<ToolContext>;
  recordCall: (record: ToolCallRecord) => void;
}

export const SERVER_INSTRUCTIONS = `Read-only access to one merchant's Zoho Inventory organization: products and stock, sales orders, customers and locations.
- Use search_* tools when you have a name, SKU, order number or email; use list_* tools to browse with filters.
- IDs from one tool (item_id, customer_id, salesorder_id) can be passed to get_* tools for full details.
- stock_on_hand from list/search tools includes units already committed to open orders. Before telling a customer something is available, call get_item and use available_for_sale.
- Results are paginated: if pagination.has_more is true, call again with page = pagination.next_page. Prefer narrowing filters over paging through everything; each page uses the merchant's Zoho API quota.
- On an error, follow error.hint. Do not retry REAUTH_REQUIRED or FORBIDDEN_SCOPE.
- This connector cannot create, edit or cancel anything in Zoho.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const page = z.number().int().min(1).default(1).describe("1-based page number.");
const perPage = z.number().int().min(1).max(200).default(25).describe("Results per page (max 200).");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format, in the organization's time zone.");
const zohoId = (what: string) =>
  z
    .string()
    .regex(/^\d+$/, `${what} is a numeric Zoho ID; use a list_ or search_ tool to find it`)
    .describe(`Zoho ${what}.`);

export function registerInventoryTools(server: McpServer, deps: ToolDeps) {
  function tool<S extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    run: (args: z.output<S>, ctx: ToolContext) => Promise<object>,
  ) {
    server.registerTool(
      name,
      {
        ...config,
        // A generic S leaves the SDK's conditional callback type unresolved; pin it to the base schema type.
        inputSchema: config.inputSchema as unknown as StandardSchemaWithJSON,
        annotations: { title: config.title, ...READ_ONLY },
      },
      // The SDK validates args against inputSchema before calling us.
      async (args: unknown, serverCtx: ServerContext) => {
        const started = performance.now();
        let ctx: ToolContext | undefined;
        try {
          ctx = await deps.resolveContext(serverCtx.http?.authInfo?.extra);
          const result = await run(args as z.output<S>, ctx);
          record(ctx, name, started, "ok");
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const error = toConnectorError(err);
          if (ctx) record(ctx, name, started, "error", error.code);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(error.toAgentPayload()) }] };
        }
      },
    );
  }

  function record(ctx: ToolContext, name: string, started: number, status: "ok" | "error", errorCode?: string) {
    deps.recordCall({
      tool: name,
      connectionId: ctx.connection.id,
      apiKeyId: ctx.apiKeyId,
      status,
      errorCode,
      latencyMs: performance.now() - started,
      zohoRequests: ctx.client.requestCount,
    });
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  tool(
    "get_connection_info",
    {
      title: "Get connection info",
      description:
        "Returns the connected Zoho organization (name, currency, time zone) and the granted scopes. Call this first if you need the currency or time zone to interpret amounts and dates.",
      inputSchema: z.object({}),
    },
    async (_args, { connection }) => ({
      organization_id: connection.zoho_org_id,
      organization_name: connection.zoho_org_name,
      currency_code: connection.currency_code,
      time_zone: connection.time_zone,
      api_domain: connection.api_domain,
      scopes: connection.scopes,
      status: connection.status,
      capabilities: "read-only: items, stock, sales orders, customers, locations",
    }),
  );

  // -------------------------------------------------------------------------
  // Items and stock
  // -------------------------------------------------------------------------

  tool(
    "list_items",
    {
      title: "List items",
      description:
        "Lists products with SKU, price, stock on hand and reorder level. stock_on_hand includes units committed to open orders; use get_item for available_for_sale. Use search_items instead if you have a name or SKU.",
      inputSchema: z.object({
        status: z.enum(["active", "inactive", "all"]).default("active").describe("Filter by item status."),
        page,
        per_page: perPage,
      }),
    },
    (args, { client }) => inventory.listItems(client, args),
  );

  tool(
    "search_items",
    {
      title: "Search items",
      description:
        "Finds products by name/description text or exact SKU and returns the same fields as list_items. To answer 'can I order X?', follow up with get_item for available_for_sale.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(100).optional().describe("Text to match against item name or description."),
          sku: z.string().trim().min(1).max(100).optional().describe("Exact SKU."),
          status: z.enum(["active", "inactive", "all"]).default("active"),
          page,
          per_page: perPage,
        })
        .refine((a) => a.query || a.sku, "Provide query or sku"),
    },
    (args, { client }) =>
      inventory.listItems(client, { search: args.query, sku: args.sku, status: args.status, page: args.page, per_page: args.per_page }),
  );

  tool(
    "get_item",
    {
      title: "Get item",
      description: "Full details for one product: stock_on_hand, committed_stock (reserved by open orders) and available_for_sale (what can be promised to a new customer), plus per-location stock for multi-location organizations.",
      inputSchema: z.object({ item_id: zohoId("item_id") }),
    },
    (args, { client }) => inventory.getItem(client, args.item_id),
  );

  tool(
    "get_low_stock_items",
    {
      title: "Get low-stock items",
      description:
        "Active items whose stock on hand is at or below their reorder level (Zoho's own reorder rule), most urgent first. Scans up to max_pages x 200 items; if `complete` is false, the catalog is larger than what was scanned.",
      inputSchema: z.object({
        max_pages: z.number().int().min(1).max(5).default(3).describe("Pages of 200 items to scan. Each page is one Zoho API call."),
      }),
    },
    (args, { client }) => inventory.findLowStockItems(client, { maxPages: args.max_pages }),
  );

  // -------------------------------------------------------------------------
  // Sales orders
  // -------------------------------------------------------------------------

  tool(
    "list_sales_orders",
    {
      title: "List sales orders",
      description:
        "Lists sales orders, newest first, with status, payment, invoicing and shipping state. Filter by status, customer_id and/or date range.",
      inputSchema: z.object({
        status: z.enum(["all", "draft", "confirmed", "closed", "void", "onhold"]).default("all"),
        customer_id: zohoId("customer_id").optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        page,
        per_page: perPage,
      }),
    },
    (args, { client }) => inventory.listSalesOrders(client, args),
  );

  tool(
    "search_sales_orders",
    {
      title: "Search sales orders",
      description:
        "Finds sales orders by order number, reference number or customer name. Use this to answer 'where is my order?' when the customer gives an order or reference number.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100).describe("Order number (e.g. SO-00012), reference number, or customer name."),
        page,
        per_page: perPage,
      }),
    },
    (args, { client }) => inventory.listSalesOrders(client, { search: args.query, page: args.page, per_page: args.per_page }),
  );

  tool(
    "get_sales_order",
    {
      title: "Get sales order",
      description:
        "Full details for one sales order: line items with packed/shipped/invoiced quantities, packages with carrier and tracking number, invoices with balance due, and shipping city/state. Pass salesorder_id or salesorder_number.",
      inputSchema: z
        .object({
          salesorder_id: zohoId("salesorder_id").optional(),
          salesorder_number: z.string().trim().min(1).max(50).optional().describe("Human-facing order number, e.g. SO-00012."),
        })
        .refine((a) => a.salesorder_id || a.salesorder_number, "Provide salesorder_id or salesorder_number"),
    },
    (args, { client }) =>
      args.salesorder_id
        ? inventory.getSalesOrder(client, args.salesorder_id)
        : inventory.getSalesOrderByNumber(client, args.salesorder_number!),
  );

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  tool(
    "list_customers",
    {
      title: "List customers",
      description: "Lists active customers with contact details and outstanding receivable amount.",
      inputSchema: z.object({ page, per_page: perPage }),
    },
    (args, { client }) => inventory.listCustomers(client, args),
  );

  tool(
    "search_customers",
    {
      title: "Search customers",
      description: "Finds customers by name, company, email or phone. Use the returned customer_id with list_sales_orders to see their orders.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100),
        page,
        per_page: perPage,
      }),
    },
    (args, { client }) => inventory.listCustomers(client, { search: args.query, page: args.page, per_page: args.per_page }),
  );

  tool(
    "get_customer",
    {
      title: "Get customer",
      description: "Details for one customer, including outstanding receivable amount.",
      inputSchema: z.object({ customer_id: zohoId("customer_id") }),
    },
    (args, { client }) => inventory.getCustomer(client, args.customer_id),
  );

  // -------------------------------------------------------------------------
  // Locations
  // -------------------------------------------------------------------------

  tool(
    "list_locations",
    {
      title: "List locations",
      description:
        "Lists the organization's stock locations (warehouses, stores). Use with get_item to explain where stock is held.",
      inputSchema: z.object({}),
    },
    async (_args, { client }) => ({ results: await inventory.listLocations(client) }),
  );
}

function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  console.error("unexpected tool error", err);
  return new ConnectorError("UPSTREAM_ERROR", "Unexpected connector error", { cause: err });
}
