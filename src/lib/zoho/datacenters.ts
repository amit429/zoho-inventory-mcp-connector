/**
 * Zoho runs separate data centers; an account lives in exactly one, and its
 * OAuth tokens only work against that DC's hosts. The callback tells us the
 * account's DC via `accounts-server`, which we validate against this
 * allowlist before sending our client secret anywhere.
 */
export const ZOHO_DATA_CENTERS = {
  in: { label: "India", accountsServer: "https://accounts.zoho.in", apiDomain: "https://www.zohoapis.in" },
  com: { label: "United States", accountsServer: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com" },
  eu: { label: "Europe", accountsServer: "https://accounts.zoho.eu", apiDomain: "https://www.zohoapis.eu" },
  au: { label: "Australia", accountsServer: "https://accounts.zoho.com.au", apiDomain: "https://www.zohoapis.com.au" },
  jp: { label: "Japan", accountsServer: "https://accounts.zoho.jp", apiDomain: "https://www.zohoapis.jp" },
  ca: { label: "Canada", accountsServer: "https://accounts.zohocloud.ca", apiDomain: "https://www.zohoapis.ca" },
  sa: { label: "Saudi Arabia", accountsServer: "https://accounts.zoho.sa", apiDomain: "https://www.zohoapis.sa" },
} as const;

export type ZohoDataCenter = keyof typeof ZOHO_DATA_CENTERS;

export function isZohoDataCenter(value: string): value is ZohoDataCenter {
  return Object.hasOwn(ZOHO_DATA_CENTERS, value);
}

const ALLOWED_ACCOUNTS_SERVERS = new Set<string>(Object.values(ZOHO_DATA_CENTERS).map((dc) => dc.accountsServer));
const ALLOWED_API_DOMAINS = new Set<string>(Object.values(ZOHO_DATA_CENTERS).map((dc) => dc.apiDomain));

export function isAllowedAccountsServer(url: string): boolean {
  return ALLOWED_ACCOUNTS_SERVERS.has(url.replace(/\/$/, ""));
}

export function isAllowedApiDomain(url: string): boolean {
  return ALLOWED_API_DOMAINS.has(url.replace(/\/$/, ""));
}
