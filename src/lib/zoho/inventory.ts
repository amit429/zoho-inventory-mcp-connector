import type { ZohoInventoryClient } from "./client";
import { ConnectorError } from "./errors";

/**
 * Typed read operations over Zoho Inventory, returning compact records.
 *
 * Zoho responses are large (an item has 80+ fields). Agents pay for every
 * token they read, and noisy payloads make them worse at answering, so each
 * mapper keeps only the fields a support or ops agent actually uses.
 */

type Raw = Record<string, unknown>;

interface ZohoPageContext {
  page?: number;
  per_page?: number;
  has_more_page?: boolean;
}

export interface Pagination {
  page: number;
  per_page: number;
  has_more: boolean;
  next_page: number | null;
}

export interface Page<T> {
  results: T[];
  pagination: Pagination;
}

export interface PageParams {
  page?: number;
  per_page?: number;
}

function toPagination(ctx: ZohoPageContext | undefined, params: PageParams, count: number): Pagination {
  const page = ctx?.page ?? params.page ?? 1;
  const perPage = ctx?.per_page ?? params.per_page ?? count;
  const hasMore = ctx?.has_more_page ?? false;
  return { page, per_page: perPage, has_more: hasMore, next_page: hasMore ? page + 1 : null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface Organization {
  organization_id: string;
  name: string;
  currency_code: string | null;
  time_zone: string | null;
  is_default: boolean;
}

/** Lists the organizations the token can access. Used during OAuth, before an org is chosen. */
export async function listOrganizations(client: Pick<ZohoInventoryClient, "get">): Promise<Organization[]> {
  const res = await client.get<{ organizations?: Raw[] }>("/organizations");
  return arr(res.organizations).map((o) => ({
    organization_id: String(o.organization_id),
    name: str(o.name) ?? "Unnamed organization",
    currency_code: str(o.currency_code),
    time_zone: str(o.time_zone),
    is_default: o.is_default_org === true,
  }));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemSummary {
  item_id: string;
  name: string;
  sku: string | null;
  status: string | null;
  unit: string | null;
  selling_price: number | null;
  stock_on_hand: number | null;
  available_stock: number | null;
  reorder_level: number | null;
  below_reorder_level: boolean;
}

export interface ItemDetail extends ItemSummary {
  description: string | null;
  purchase_price: number | null;
  upc: string | null;
  ean: string | null;
  warehouses: {
    warehouse_id: string;
    warehouse_name: string | null;
    stock_on_hand: number | null;
    available_stock: number | null;
  }[];
}

function mapItem(i: Raw): ItemSummary {
  const stock = num(i.available_stock) ?? num(i.stock_on_hand);
  const reorder = num(i.reorder_level);
  return {
    item_id: String(i.item_id),
    name: str(i.name) ?? "",
    sku: str(i.sku),
    status: str(i.status),
    unit: str(i.unit),
    selling_price: num(i.rate),
    stock_on_hand: num(i.stock_on_hand),
    available_stock: num(i.available_stock),
    reorder_level: reorder,
    below_reorder_level: reorder !== null && reorder > 0 && stock !== null && stock <= reorder,
  };
}

export type ItemStatusFilter = "active" | "inactive" | "all";
const ITEM_FILTER: Record<ItemStatusFilter, string> = {
  active: "Status.Active",
  inactive: "Status.Inactive",
  all: "Status.All",
};

export async function listItems(
  client: ZohoInventoryClient,
  params: PageParams & { status?: ItemStatusFilter; search?: string; sku?: string },
): Promise<Page<ItemSummary>> {
  const res = await client.get<{ items?: Raw[]; page_context?: ZohoPageContext }>("/items", {
    page: params.page,
    per_page: params.per_page,
    filter_by: ITEM_FILTER[params.status ?? "active"],
    search_text: params.search,
    sku: params.sku,
  });
  const results = arr(res.items).map(mapItem);
  return { results, pagination: toPagination(res.page_context, params, results.length) };
}

export async function getItem(client: ZohoInventoryClient, itemId: string): Promise<ItemDetail> {
  const res = await client.get<{ item?: Raw }>(`/items/${encodeURIComponent(itemId)}`);
  if (!res.item) throw new ConnectorError("NOT_FOUND", `Item ${itemId} not found`);
  const i = res.item;
  return {
    ...mapItem(i),
    description: str(i.description),
    purchase_price: num(i.purchase_rate),
    upc: str(i.upc),
    ean: str(i.ean),
    warehouses: arr(i.warehouses).map((w) => ({
      warehouse_id: String(w.warehouse_id),
      warehouse_name: str(w.warehouse_name),
      stock_on_hand: num(w.warehouse_stock_on_hand),
      available_stock: num(w.warehouse_available_stock),
    })),
  };
}

/**
 * Zoho has no "low stock" endpoint, so this scans active items page by page.
 * Bounded by maxPages because each page costs one request from the org's
 * per-minute and daily quota.
 */
export async function findLowStockItems(
  client: ZohoInventoryClient,
  { maxPages = 3 }: { maxPages?: number } = {},
): Promise<{ results: ItemSummary[]; scanned_items: number; complete: boolean }> {
  const low: ItemSummary[] = [];
  let scanned = 0;
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= maxPages) {
    const res = await listItems(client, { page, per_page: 200, status: "active" });
    scanned += res.results.length;
    low.push(...res.results.filter((i) => i.below_reorder_level));
    hasMore = res.pagination.has_more;
    page++;
  }
  // Most urgent first: furthest below its reorder level.
  const headroom = (i: ItemSummary) => (i.available_stock ?? i.stock_on_hand ?? 0) - (i.reorder_level ?? 0);
  low.sort((a, b) => headroom(a) - headroom(b));
  return { results: low, scanned_items: scanned, complete: !hasMore };
}

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

export interface SalesOrderSummary {
  salesorder_id: string;
  salesorder_number: string | null;
  reference_number: string | null;
  date: string | null;
  expected_shipment_date: string | null;
  customer_id: string | null;
  customer_name: string | null;
  status: string | null;
  invoiced_status: string | null;
  paid_status: string | null;
  shipped_status: string | null;
  total: number | null;
  currency_code: string | null;
}

export interface SalesOrderDetail extends SalesOrderSummary {
  line_items: {
    item_id: string | null;
    sku: string | null;
    name: string | null;
    quantity: number | null;
    quantity_packed: number | null;
    quantity_shipped: number | null;
    quantity_invoiced: number | null;
    rate: number | null;
    item_total: number | null;
  }[];
  shipping_location: { city: string | null; state: string | null; country: string | null } | null;
  packages: {
    package_number: string | null;
    status: string | null;
    shipment_number: string | null;
    carrier: string | null;
    tracking_number: string | null;
    shipment_date: string | null;
  }[];
  invoices: { invoice_number: string | null; status: string | null; total: number | null; balance: number | null }[];
  notes: string | null;
}

function mapSalesOrder(s: Raw): SalesOrderSummary {
  return {
    salesorder_id: String(s.salesorder_id),
    salesorder_number: str(s.salesorder_number),
    reference_number: str(s.reference_number),
    date: str(s.date),
    expected_shipment_date: str(s.shipment_date),
    customer_id: str(s.customer_id),
    customer_name: str(s.customer_name),
    status: str(s.order_status) ?? str(s.status),
    invoiced_status: str(s.invoiced_status),
    paid_status: str(s.paid_status),
    shipped_status: str(s.shipped_status),
    total: num(s.total),
    currency_code: str(s.currency_code),
  };
}

export type SalesOrderStatusFilter = "all" | "draft" | "confirmed" | "closed" | "void" | "onhold";
const SALES_ORDER_FILTER: Record<SalesOrderStatusFilter, string> = {
  all: "Status.All",
  draft: "Status.Draft",
  confirmed: "Status.Confirmed",
  closed: "Status.Closed",
  void: "Status.Void",
  onhold: "Status.OnHold",
};

export async function listSalesOrders(
  client: ZohoInventoryClient,
  params: PageParams & {
    status?: SalesOrderStatusFilter;
    customer_id?: string;
    search?: string;
    date_from?: string;
    date_to?: string;
  },
): Promise<Page<SalesOrderSummary>> {
  const res = await client.get<{ salesorders?: Raw[]; page_context?: ZohoPageContext }>("/salesorders", {
    page: params.page,
    per_page: params.per_page,
    filter_by: SALES_ORDER_FILTER[params.status ?? "all"],
    customer_id: params.customer_id,
    search_text: params.search,
    date_start: params.date_from,
    date_end: params.date_to,
    sort_column: "date",
    sort_order: "D",
  });
  const results = arr(res.salesorders).map(mapSalesOrder);
  return { results, pagination: toPagination(res.page_context, params, results.length) };
}

export async function getSalesOrder(client: ZohoInventoryClient, salesorderId: string): Promise<SalesOrderDetail> {
  const res = await client.get<{ salesorder?: Raw }>(`/salesorders/${encodeURIComponent(salesorderId)}`);
  if (!res.salesorder) throw new ConnectorError("NOT_FOUND", `Sales order ${salesorderId} not found`);
  const s = res.salesorder;
  const ship = (s.shipping_address ?? null) as Raw | null;
  return {
    ...mapSalesOrder(s),
    line_items: arr(s.line_items).map((l) => ({
      item_id: str(l.item_id),
      sku: str(l.sku),
      name: str(l.name),
      quantity: num(l.quantity),
      quantity_packed: num(l.quantity_packed),
      quantity_shipped: num(l.quantity_shipped),
      quantity_invoiced: num(l.quantity_invoiced),
      rate: num(l.rate),
      item_total: num(l.item_total),
    })),
    // City/state/country is enough to answer "where is it going"; street address is left out on purpose.
    shipping_location: ship ? { city: str(ship.city), state: str(ship.state), country: str(ship.country) } : null,
    packages: arr(s.packages).map((p) => ({
      package_number: str(p.package_number),
      status: str(p.status),
      shipment_number: str(p.shipment_number),
      carrier: str(p.carrier),
      tracking_number: str(p.tracking_number),
      shipment_date: str(p.shipment_date),
    })),
    invoices: arr(s.invoices).map((inv) => ({
      invoice_number: str(inv.invoice_number),
      status: str(inv.status),
      total: num(inv.total),
      balance: num(inv.balance),
    })),
    notes: str(s.notes),
  };
}

/** Resolves a human-facing order number (e.g. "SO-00042") to the full order. */
export async function getSalesOrderByNumber(client: ZohoInventoryClient, number: string): Promise<SalesOrderDetail> {
  const page = await listSalesOrders(client, { search: number, per_page: 25 });
  const match = page.results.find((o) => o.salesorder_number?.toLowerCase() === number.toLowerCase());
  if (!match) throw new ConnectorError("NOT_FOUND", `No sales order numbered ${number}`);
  return getSalesOrder(client, match.salesorder_id);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface CustomerSummary {
  customer_id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  outstanding_receivable: number | null;
  currency_code: string | null;
}

function mapCustomer(c: Raw): CustomerSummary {
  return {
    customer_id: String(c.contact_id),
    name: str(c.contact_name) ?? "",
    company_name: str(c.company_name),
    email: str(c.email),
    phone: str(c.mobile) ?? str(c.phone),
    status: str(c.status),
    outstanding_receivable: num(c.outstanding_receivable_amount),
    currency_code: str(c.currency_code),
  };
}

export async function listCustomers(
  client: ZohoInventoryClient,
  params: PageParams & { search?: string },
): Promise<Page<CustomerSummary>> {
  const res = await client.get<{ contacts?: Raw[]; page_context?: ZohoPageContext }>("/contacts", {
    page: params.page,
    per_page: params.per_page,
    filter_by: "Status.Active",
    contact_type: "customer",
    search_text: params.search,
  });
  const results = arr(res.contacts).map(mapCustomer);
  return { results, pagination: toPagination(res.page_context, params, results.length) };
}

export async function getCustomer(client: ZohoInventoryClient, customerId: string): Promise<CustomerSummary> {
  const res = await client.get<{ contact?: Raw }>(`/contacts/${encodeURIComponent(customerId)}`);
  if (!res.contact) throw new ConnectorError("NOT_FOUND", `Customer ${customerId} not found`);
  return mapCustomer(res.contact);
}

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

export interface Warehouse {
  warehouse_id: string;
  name: string;
  status: string | null;
  is_primary: boolean;
  city: string | null;
  state: string | null;
}

export async function listWarehouses(client: ZohoInventoryClient): Promise<Warehouse[]> {
  const res = await client.get<{ warehouses?: Raw[] }>("/settings/warehouses");
  return arr(res.warehouses).map((w) => ({
    warehouse_id: String(w.warehouse_id),
    name: str(w.warehouse_name) ?? "",
    status: str(w.status),
    is_primary: w.is_primary === true,
    city: str(w.city),
    state: str(w.state),
  }));
}
