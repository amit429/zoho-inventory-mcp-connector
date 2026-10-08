/**
 * Seeds a Zoho Inventory organization with FICTIONAL demo data for a D2C
 * apparel brand: items with stock and reorder levels, customers, and sales
 * orders in different states.
 *
 * The connector itself only ever holds read-only scopes. Seeding needs write
 * scopes, so it uses a separate, short-lived "Self Client" grant:
 *
 *   1. https://api-console.zoho.in -> Add Client -> Self Client
 *   2. Generate Code with scopes:
 *        ZohoInventory.items.CREATE,ZohoInventory.contacts.CREATE,
 *        ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE,
 *        ZohoInventory.settings.READ
 *      (duration 10 minutes)
 *   3. ZOHO_SELF_CLIENT_ID=... ZOHO_SELF_CLIENT_SECRET=... ZOHO_SELF_CLIENT_CODE=... \
 *        npm run seed
 *
 * Optional: ZOHO_ACCOUNTS_SERVER (default https://accounts.zoho.in), ZOHO_ORG_ID
 * (default: the account's default organization).
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_SERVER ?? "https://accounts.zoho.in";

const ITEMS = [
  { name: "Indigo Block-Print Kurta - S", sku: "KUR-IND-S", rate: 1499, purchase_rate: 620, stock: 18, reorder: 5 },
  { name: "Indigo Block-Print Kurta - M", sku: "KUR-IND-M", rate: 1499, purchase_rate: 620, stock: 3, reorder: 5 },
  { name: "Indigo Block-Print Kurta - L", sku: "KUR-IND-L", rate: 1499, purchase_rate: 620, stock: 0, reorder: 5 },
  { name: "Mustard Linen Kurta - M", sku: "KUR-MUS-M", rate: 1899, purchase_rate: 800, stock: 22, reorder: 6 },
  { name: "Ivory Chikankari Kurta - M", sku: "KUR-IVO-M", rate: 2499, purchase_rate: 1100, stock: 7, reorder: 4 },
  { name: "Handloom Cotton Dupatta - Rust", sku: "DUP-RST", rate: 799, purchase_rate: 300, stock: 40, reorder: 10 },
  { name: "Handloom Cotton Dupatta - Teal", sku: "DUP-TEA", rate: 799, purchase_rate: 300, stock: 9, reorder: 10 },
  { name: "Straight Palazzo - Black - M", sku: "PAL-BLK-M", rate: 999, purchase_rate: 380, stock: 30, reorder: 8 },
  { name: "Straight Palazzo - White - M", sku: "PAL-WHT-M", rate: 999, purchase_rate: 380, stock: 2, reorder: 8 },
  { name: "Jute Tote Bag", sku: "BAG-JUT", rate: 599, purchase_rate: 210, stock: 55, reorder: 15 },
  { name: "Oxidised Jhumka Earrings", sku: "JWL-JHU", rate: 449, purchase_rate: 150, stock: 12, reorder: 12 },
  { name: "Gift Wrap Add-on", sku: "GFT-WRP", rate: 99, purchase_rate: 20, stock: 200, reorder: 50 },
];

// All fictional: placeholder phone numbers and example.com (RFC 2606) emails.
const CUSTOMERS = [
  { name: "Priya Sharma", email: "priya.sharma@example.com", phone: "+91 90000 00001", city: "Pune", state: "Maharashtra" },
  { name: "Arjun Mehta", email: "arjun.mehta@example.com", phone: "+91 90000 00002", city: "Bengaluru", state: "Karnataka" },
  { name: "Ananya Iyer", email: "ananya.iyer@example.com", phone: "+91 90000 00003", city: "Chennai", state: "Tamil Nadu" },
  { name: "Rohan Gupta", email: "rohan.gupta@example.com", phone: "+91 90000 00004", city: "New Delhi", state: "Delhi" },
  { name: "Meera Nair", email: "meera.nair@example.com", phone: "+91 90000 00005", city: "Kochi", state: "Kerala" },
  { name: "Kabir Singh", email: "kabir.singh@example.com", phone: "+91 90000 00006", city: "Jaipur", state: "Rajasthan" },
  { name: "Ishita Banerjee", email: "ishita.banerjee@example.com", phone: "+91 90000 00007", city: "Kolkata", state: "West Bengal" },
  { name: "Vikram Rao", email: "vikram.rao@example.com", phone: "+91 90000 00008", city: "Hyderabad", state: "Telangana" },
];

// [customer index, [sku, qty][], confirm?, days ago]
const ORDERS: [number, [string, number][], boolean, number][] = [
  [0, [["KUR-IND-M", 2]], true, 1],
  [0, [["DUP-TEA", 1], ["GFT-WRP", 1]], true, 12],
  [1, [["KUR-MUS-M", 1], ["PAL-BLK-M", 1]], true, 2],
  [2, [["KUR-IVO-M", 1]], false, 0],
  [3, [["BAG-JUT", 3]], true, 5],
  [4, [["KUR-IND-S", 1], ["JWL-JHU", 2]], true, 3],
  [5, [["PAL-WHT-M", 2]], true, 8],
  [6, [["DUP-RST", 2], ["BAG-JUT", 1]], false, 1],
  [7, [["KUR-IND-L", 1]], true, 4],
  [1, [["JWL-JHU", 1], ["GFT-WRP", 1]], true, 20],
];

async function main() {
  const token = await accessToken();
  const apiDomain = process.env.ZOHO_API_DOMAIN ?? "https://www.zohoapis.in";

  const api = async (method: "GET" | "POST", path: string, body?: object, orgId?: string) => {
    const url = new URL(`/inventory/v1${path}`, apiDomain);
    if (orgId) url.searchParams.set("organization_id", orgId);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown> & { code: number; message: string };
    if (json.code !== 0) throw new Error(`${method} ${path}: ${json.message} (code ${json.code})`);
    await new Promise((r) => setTimeout(r, 700)); // stay well under 100 req/min
    return json;
  };

  const orgs = (await api("GET", "/organizations")).organizations as { organization_id: string; name: string; is_default_org: boolean }[];
  const org = orgs.find((o) => o.organization_id === process.env.ZOHO_ORG_ID) ?? orgs.find((o) => o.is_default_org) ?? orgs[0];
  console.log(`Seeding "${org.name}" (${org.organization_id})`);
  const orgId = org.organization_id;

  const itemIds = new Map<string, string>();
  for (const i of ITEMS) {
    const res = await api(
      "POST",
      "/items",
      {
        name: i.name,
        sku: i.sku,
        unit: "pcs",
        item_type: "inventory",
        product_type: "goods",
        rate: i.rate,
        purchase_rate: i.purchase_rate,
        reorder_level: i.reorder,
        initial_stock: i.stock,
        initial_stock_rate: i.purchase_rate,
      },
      orgId,
    );
    itemIds.set(i.sku, (res.item as { item_id: string }).item_id);
    console.log(`  item ${i.sku} (stock ${i.stock}, reorder ${i.reorder})`);
  }

  const customerIds: string[] = [];
  for (const c of CUSTOMERS) {
    const res = await api(
      "POST",
      "/contacts",
      {
        contact_name: c.name,
        contact_type: "customer",
        contact_persons: [{ first_name: c.name.split(" ")[0], last_name: c.name.split(" ")[1], email: c.email, mobile: c.phone, is_primary_contact: true }],
        billing_address: { city: c.city, state: c.state, country: "India" },
        shipping_address: { address: "Demo address (fictional)", city: c.city, state: c.state, country: "India" },
      },
      orgId,
    );
    customerIds.push((res.contact as { contact_id: string }).contact_id);
    console.log(`  customer ${c.name}`);
  }

  for (const [n, [customer, lines, confirm, daysAgo]] of ORDERS.entries()) {
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const res = await api(
      "POST",
      "/salesorders",
      {
        customer_id: customerIds[customer],
        date,
        reference_number: `WEB-${String(10_401 + n)}`,
        line_items: lines.map(([sku, quantity]) => ({
          item_id: itemIds.get(sku),
          quantity,
          rate: ITEMS.find((i) => i.sku === sku)!.rate,
        })),
      },
      orgId,
    );
    const so = res.salesorder as { salesorder_id: string; salesorder_number: string };
    if (confirm) await api("POST", `/salesorders/${so.salesorder_id}/status/confirmed`, undefined, orgId);
    console.log(`  sales order ${so.salesorder_number} for ${CUSTOMERS[customer].name}${confirm ? " (confirmed)" : " (draft)"}`);
  }

  console.log("\nDone. Low-stock items: KUR-IND-M, KUR-IND-L, DUP-TEA, PAL-WHT-M, JWL-JHU.");
}

async function accessToken(): Promise<string> {
  if (process.env.ZOHO_SEED_ACCESS_TOKEN) return process.env.ZOHO_SEED_ACCESS_TOKEN;
  const { ZOHO_SELF_CLIENT_ID: id, ZOHO_SELF_CLIENT_SECRET: secret, ZOHO_SELF_CLIENT_CODE: code } = process.env;
  if (!id || !secret || !code) {
    throw new Error("Set ZOHO_SEED_ACCESS_TOKEN, or ZOHO_SELF_CLIENT_ID + ZOHO_SELF_CLIENT_SECRET + ZOHO_SELF_CLIENT_CODE");
  }
  const res = await fetch(new URL("/oauth/v2/token", ACCOUNTS), {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: id, client_secret: secret, code }),
  });
  const json = (await res.json()) as { access_token?: string; api_domain?: string; error?: string };
  if (!json.access_token) throw new Error(`Self-client code exchange failed: ${json.error ?? res.status}`);
  if (json.api_domain && !process.env.ZOHO_API_DOMAIN) process.env.ZOHO_API_DOMAIN = json.api_domain;
  return json.access_token;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
