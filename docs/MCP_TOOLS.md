# MCP tool reference

The machine-readable spec, exactly what `tools/list` returns, is in [`mcp-tools.json`](mcp-tools.json). It's generated from the server with `npm run export:tools`. This page is the human-readable version, with real responses captured from the seeded demo organization.

## Connection

| | |
|---|---|
| Endpoint | `POST https://zoho-inventory-connector.vercel.app/api/mcp` |
| Transport | MCP Streamable HTTP (stateless). Supports the 2026-07-28 protocol and 2025-era clients |
| Auth | `Authorization: Bearer zic_…` (per-agent key from the dashboard). A missing or invalid key → `401` with `WWW-Authenticate: Bearer error="invalid_token"` |
| Response | `text/event-stream`; the JSON-RPC message is on the `data:` line |
| Tool results | JSON in `result.content[0].text` and in `result.structuredContent`; failures have `result.isError: true` |
| Annotations | Every tool: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |

### Server instructions (sent to the agent at initialization)

> Read-only access to one merchant's Zoho Inventory organization: products and stock, sales orders, customers and locations.
> - Use search_* tools when you have a name, SKU, order number or email; use list_* tools to browse with filters.
> - IDs from one tool (item_id, customer_id, salesorder_id) can be passed to get_* tools for full details.
> - stock_on_hand from list/search tools includes units already committed to open orders. Before telling a customer something is available, call get_item and use available_for_sale.
> - Results are paginated: if pagination.has_more is true, call again with page = pagination.next_page. Prefer narrowing filters over paging through everything; each page uses the merchant's Zoho API quota.
> - On an error, follow error.hint. Do not retry REAUTH_REQUIRED or FORBIDDEN_SCOPE.
> - This connector cannot create, edit or cancel anything in Zoho.

### Common parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | 1 | |
| `per_page` | integer 1–200 | 25 | Zoho's maximum is 200 |

Paginated responses include `pagination: { page, per_page, has_more, next_page }`.

## Tools

| Tool | Purpose | Zoho calls |
|---|---|---|
| [`get_connection_info`](#get_connection_info) | Org name, currency, time zone, scopes | 0 |
| [`list_items`](#list_items) | Browse products | 1 |
| [`search_items`](#search_items) | Find products by text or SKU | 1 |
| [`get_item`](#get_item) | One product, with committed and sellable stock and per-location stock | 1 |
| [`get_low_stock_items`](#get_low_stock_items) | Items at or below their reorder level | 1–5 |
| [`list_sales_orders`](#list_sales_orders) | Browse orders by status, customer, date | 1 |
| [`search_sales_orders`](#search_sales_orders) | Find orders by number, reference, customer name | 1 |
| [`get_sales_order`](#get_sales_order) | One order: lines, fulfilment, tracking, invoices | 1–2 |
| [`list_customers`](#list_customers) | Browse active customers | 1 |
| [`search_customers`](#search_customers) | Find customers by name, company, email, phone | 1 |
| [`get_customer`](#get_customer) | One customer with outstanding balance | 1 |
| [`list_locations`](#list_locations) | Stock locations / warehouses | 1 |

---

### `get_connection_info`

Returns the connected organization and granted scopes. Call it first if you need the currency or time zone to interpret amounts and dates.

**Input:** none.

```json
{
  "organization_id": "60091333111",
  "organization_name": "Amit test org",
  "currency_code": "INR",
  "time_zone": "Asia/Calcutta",
  "api_domain": "https://www.zohoapis.in",
  "scopes": ["ZohoInventory.items.READ", "ZohoInventory.salesorders.READ",
             "ZohoInventory.contacts.READ", "ZohoInventory.settings.READ"],
  "status": "active",
  "capabilities": "read-only: items, stock, sales orders, customers, locations"
}
```

---

### `list_items`

Lists products with SKU, price, stock on hand and reorder level. `stock_on_hand` includes units committed to open orders; use `get_item` for `available_for_sale`.

| Param | Type | Default |
|---|---|---|
| `status` | `"active"` \| `"inactive"` \| `"all"` | `"active"` |
| `page`, `per_page` | | 1, 25 |

**Output:** `{ results: Item[], pagination }`, with items as in `search_items` below.

---

### `search_items`

Finds products by name/description text or exact SKU. Provide `query` or `sku` (at least one).

| Param | Type | Default |
|---|---|---|
| `query` | string (1–100) | |
| `sku` | string (1–100), exact | |
| `status` | `"active"` \| `"inactive"` \| `"all"` | `"active"` |
| `page`, `per_page` | | 1, 25 |

`{"sku": "KUR-IND-M"}` →

```json
{
  "results": [{
    "item_id": "4285925000000038001",
    "name": "Indigo Block-Print Kurta - M",
    "sku": "KUR-IND-M",
    "status": "active",
    "unit": "pcs",
    "selling_price": 1499,
    "stock_on_hand": 3,
    "reorder_level": 5,
    "below_reorder_level": true
  }],
  "pagination": { "page": 1, "per_page": 25, "has_more": false, "next_page": null }
}
```

---

### `get_item`

Full details for one product, separating what's physically there from what can actually be sold.

| Param | Type |
|---|---|
| `item_id` | string, numeric Zoho ID (**required**) |

`{"item_id": "4285925000000038001"}` →

```json
{
  "item_id": "4285925000000038001",
  "name": "Indigo Block-Print Kurta - M",
  "sku": "KUR-IND-M",
  "status": "active",
  "unit": "pcs",
  "selling_price": 1499,
  "stock_on_hand": 3,
  "reorder_level": 5,
  "below_reorder_level": true,
  "description": null,
  "purchase_price": 620,
  "upc": null,
  "ean": null,
  "committed_stock": 2,
  "available_for_sale": 1,
  "locations": []
}
```

`locations` lists `{ location_id, location_name, stock_on_hand, available_for_sale }` per location for multi-location organizations. It's empty for single-location orgs, like this one.

---

### `get_low_stock_items`

Active items whose `stock_on_hand ≤ reorder_level` (Zoho's own reorder rule), most urgent (furthest below) first. Zoho has no low-stock endpoint, so this scans the catalog 200 items per page.

| Param | Type | Default |
|---|---|---|
| `max_pages` | integer 1–5 | 3 |

```json
{
  "results": [
    { "sku": "PAL-WHT-M", "name": "Straight Palazzo - White - M", "stock_on_hand": 2,  "reorder_level": 8,  "below_reorder_level": true, "...": "..." },
    { "sku": "KUR-IND-L", "name": "Indigo Block-Print Kurta - L", "stock_on_hand": 0,  "reorder_level": 5,  "below_reorder_level": true, "...": "..." },
    { "sku": "KUR-IND-M", "name": "Indigo Block-Print Kurta - M", "stock_on_hand": 3,  "reorder_level": 5,  "below_reorder_level": true, "...": "..." },
    { "sku": "DUP-TEA",   "name": "Handloom Cotton Dupatta - Teal", "stock_on_hand": 9, "reorder_level": 10, "below_reorder_level": true, "...": "..." },
    { "sku": "JWL-JHU",   "name": "Oxidised Jhumka Earrings",     "stock_on_hand": 12, "reorder_level": 12, "below_reorder_level": true, "...": "..." }
  ],
  "scanned_items": 12,
  "complete": true
}
```

`complete: false` means the catalog is larger than `max_pages × 200` and the list may be partial.

---

### `list_sales_orders`

Lists sales orders, newest first, with status, payment, invoicing and shipping state.

| Param | Type | Default |
|---|---|---|
| `status` | `"all"` \| `"draft"` \| `"confirmed"` \| `"closed"` \| `"void"` \| `"onhold"` | `"all"` |
| `customer_id` | numeric Zoho ID | |
| `date_from`, `date_to` | `YYYY-MM-DD` (org time zone) | |
| `page`, `per_page` | | 1, 25 |

`{"status": "confirmed", "per_page": 2}` →

```json
{
  "results": [
    {
      "salesorder_id": "4285925000000038115",
      "salesorder_number": "SO-00001",
      "reference_number": "WEB-10401",
      "date": "2026-10-07",
      "expected_shipment_date": null,
      "customer_id": "4285925000000039083",
      "customer_name": "Priya Sharma",
      "status": "confirmed",
      "invoiced_status": "not_invoiced",
      "paid_status": "unpaid",
      "shipped_status": "pending",
      "total": 2998,
      "currency_code": "INR"
    },
    { "salesorder_number": "SO-00003", "customer_name": "Arjun Mehta", "...": "..." }
  ],
  "pagination": { "page": 1, "per_page": 2, "has_more": true, "next_page": 2 }
}
```

---

### `search_sales_orders`

Finds orders by order number, reference number or customer name.

| Param | Type |
|---|---|
| `query` | string 1–100 (**required**), e.g. `SO-00012`, `WEB-10401`, `Priya` |
| `page`, `per_page` | 1, 25 |

**Output:** same shape as `list_sales_orders`.

---

### `get_sales_order`

Full order details: line items with packed/shipped/invoiced quantities, packages with carrier and tracking number, invoices with balance due, and shipping city/state/country (no street address). Pass `salesorder_id` **or** `salesorder_number`. A number costs one extra Zoho call to resolve.

| Param | Type |
|---|---|
| `salesorder_id` | numeric Zoho ID |
| `salesorder_number` | string, e.g. `SO-00001` |

`{"salesorder_number": "SO-00001"}` →

```json
{
  "salesorder_id": "4285925000000038115",
  "salesorder_number": "SO-00001",
  "reference_number": "WEB-10401",
  "date": "2026-10-07",
  "customer_name": "Priya Sharma",
  "status": "confirmed",
  "invoiced_status": "not_invoiced",
  "paid_status": "unpaid",
  "shipped_status": "pending",
  "total": 2998,
  "currency_code": "INR",
  "line_items": [{
    "item_id": "4285925000000038001",
    "sku": "KUR-IND-M",
    "name": "Indigo Block-Print Kurta - M",
    "quantity": 2, "quantity_packed": 0, "quantity_shipped": 0, "quantity_invoiced": 0,
    "rate": 1499, "item_total": 2998
  }],
  "shipping_location": { "city": "Pune", "state": "Maharashtra", "country": "India" },
  "packages": [],
  "invoices": [],
  "notes": null
}
```

Shipped orders fill `packages: [{ package_number, status, shipment_number, carrier, tracking_number, shipment_date }]` and invoiced ones fill `invoices: [{ invoice_number, status, total, balance }]`.

---

### `list_customers`

Lists active customers.

| Param | Type | Default |
|---|---|---|
| `page`, `per_page` | | 1, 25 |

---

### `search_customers`

Finds customers by name, company, email or phone. Use the `customer_id` with `list_sales_orders` to see their orders.

| Param | Type |
|---|---|
| `query` | string 1–100 (**required**) |
| `page`, `per_page` | 1, 25 |

`{"query": "Priya"}` →

```json
{
  "results": [{
    "customer_id": "4285925000000039083",
    "name": "Priya Sharma",
    "company_name": null,
    "email": "priya.sharma@example.com",
    "phone": "+91 90000 00001",
    "status": "active",
    "outstanding_receivable": 0,
    "currency_code": "INR"
  }],
  "pagination": { "page": 1, "per_page": 25, "has_more": false, "next_page": null }
}
```

`outstanding_receivable` counts **invoiced** amounts only; an unpaid order that hasn't been invoiced yet shows 0.

---

### `get_customer`

| Param | Type |
|---|---|
| `customer_id` | numeric Zoho ID (**required**) |

**Output:** a single customer, same fields as `search_customers` results.

---

### `list_locations`

Lists the organization's stock locations.

**Input:** none.

```json
{
  "results": [{
    "location_id": "4285925000000034097",
    "name": "Head Office",
    "type": "general",
    "is_primary": true,
    "is_active": true,
    "city": null,
    "state": "Maharashtra",
    "country": "India"
  }]
}
```

---

## Errors

`{"item_id": "999999999999"}` on `get_item` →

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Sorry! The item you are looking for is not available!",
    "retryable": false,
    "hint": "The record was not found. Use a list_ or search_ tool to find the correct ID."
  }
}
```

Invalid arguments (e.g. `{"item_id": "abc"}`) are rejected by schema validation before any Zoho call, with the message *"item_id is a numeric Zoho ID; use a list_ or search_ tool to find it"*.

The full error-code table is in [CAPABILITIES.md](CAPABILITIES.md#errors-the-agent-will-see).
