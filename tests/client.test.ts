import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "@/lib/zoho/client";
import { ConnectorError } from "@/lib/zoho/errors";
import { fakeFetch, json, ok, testClient } from "./helpers";

describe("ZohoInventoryClient", () => {
  it("sends the org id, OAuth header, and takes a rate-limit token per request", async () => {
    const f = fakeFetch(ok({ items: [] }));
    const { client, rateLimiterKeys } = testClient(f.impl);

    await client.get("/items", { page: 2, search_text: "shirt", sku: undefined });

    const { url, authorization } = f.requests[0];
    expect(url.origin + url.pathname).toBe("https://www.zohoapis.in/inventory/v1/items");
    expect(url.searchParams.get("organization_id")).toBe("60012345");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("search_text")).toBe("shirt");
    expect(url.searchParams.has("sku")).toBe(false);
    expect(authorization).toBe("Zoho-oauthtoken token-1");
    expect(rateLimiterKeys).toEqual(["zoho-org:60012345"]);
  });

  it("honors a short Retry-After on 429 and then succeeds", async () => {
    const f = fakeFetch(json(429, { code: 44, message: "Too many requests" }, { "retry-after": "2" }), ok({ items: [] }));
    const { client, sleeps } = testClient(f.impl);

    await expect(client.get("/items")).resolves.toMatchObject({ code: 0 });
    expect(sleeps).toEqual([2000]);
    expect(client.requestCount).toBe(2);
  });

  it("returns RATE_LIMITED instead of blocking when Retry-After is long", async () => {
    const f = fakeFetch(json(429, { code: 45, message: "Daily limit reached" }, { "retry-after": "3600" }));
    const { client, sleeps } = testClient(f.impl);

    const err = await client.get("/items").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 3_600_000, retryable: true, zohoCode: 45 });
    expect(sleeps).toEqual([]);
  });

  it("refreshes the token once on 401 and retries with the new token", async () => {
    const f = fakeFetch(json(401, { code: 14, message: "Invalid OAuth token" }), ok({ items: [] }));
    const { client, tokenCalls } = testClient(f.impl);

    await client.get("/items");

    expect(tokenCalls).toEqual([undefined, "token-1"]);
    expect(f.requests.map((r) => r.authorization)).toEqual(["Zoho-oauthtoken token-1", "Zoho-oauthtoken token-2"]);
  });

  it("gives up with REAUTH_REQUIRED if Zoho still says 401 after a refresh", async () => {
    const f = fakeFetch(json(401, { code: 14 }), json(401, { code: 14 }));
    const { client } = testClient(f.impl);

    await expect(client.get("/items")).rejects.toMatchObject({ code: "REAUTH_REQUIRED", retryable: false });
  });

  it("retries 5xx with backoff, then reports UPSTREAM_UNAVAILABLE", async () => {
    const f = fakeFetch(...Array.from({ length: 4 }, () => json(503, {})));
    const { client, sleeps } = testClient(f.impl);

    await expect(client.get("/items")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect(client.requestCount).toBe(4); // 1 try + 3 retries
    expect(sleeps).toHaveLength(3);
    sleeps.forEach((ms, attempt) => expect(ms).toBeLessThanOrEqual(500 * 2 ** attempt));
  });

  it("retries network errors", async () => {
    const f = fakeFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      ok({ items: [] }),
    );
    const { client } = testClient(f.impl);
    await expect(client.get("/items")).resolves.toMatchObject({ code: 0 });
  });

  it.each([
    [404, { code: 1002, message: "Item does not exist." }, "NOT_FOUND"],
    [400, { code: 2, message: "Invalid value passed for per_page" }, "INVALID_INPUT"],
    [401, { code: 14, message: "Invalid OAuth token" }, "REAUTH_REQUIRED"],
    [401, { code: 57, message: "You are not authorized to perform this operation" }, "FORBIDDEN_SCOPE"],
    [403, { code: 57, message: "You are not authorized to perform this operation" }, "FORBIDDEN_SCOPE"],
    [200, { code: 9999, message: "Something odd" }, "UPSTREAM_ERROR"],
  ])("maps HTTP %i / Zoho code to %s", async (status, body, expected) => {
    const f = fakeFetch(json(status, body), json(status, body));
    const { client } = testClient(f.impl);
    await expect(client.get("/items/1")).rejects.toMatchObject({ code: expected });
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
