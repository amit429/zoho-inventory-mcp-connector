import { ZohoInventoryClient, type ZohoClientConfig } from "@/lib/zoho/client";

export interface RecordedRequest {
  url: URL;
  authorization: string | null;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

/** A fetch stub that answers from a queue of responders and records every request. */
export function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      url: new URL(input instanceof Request ? input.url : input.toString()),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    requests.push(req);
    const responder = responders.shift();
    if (!responder) throw new Error(`Unexpected request to ${req.url}`);
    return responder(req);
  }) as typeof fetch;
  return { impl, requests };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const ok = (body: object) => json(200, { code: 0, message: "success", ...body });

export function testClient(fetchImpl: typeof fetch, overrides: Partial<ZohoClientConfig> = {}) {
  const sleeps: number[] = [];
  const tokenCalls: (string | undefined)[] = [];
  let tokenVersion = 1;
  const rateLimiterKeys: string[] = [];

  const client = new ZohoInventoryClient({
    connectionId: "conn-1",
    organizationId: "60012345",
    apiDomain: "https://www.zohoapis.in",
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    tokens: {
      // Hands out token-1; after a rejection, token-2, and so on.
      async getAccessToken(_id, rejected) {
        tokenCalls.push(rejected);
        if (rejected) tokenVersion++;
        return `token-${tokenVersion}`;
      },
    },
    rateLimiter: {
      async acquire(key) {
        rateLimiterKeys.push(key);
      },
    },
    ...overrides,
  });
  return { client, sleeps, tokenCalls, rateLimiterKeys };
}
