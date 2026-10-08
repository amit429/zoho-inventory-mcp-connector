import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { after } from "next/server";
import { verifyApiKey } from "@/lib/connector/api-keys";
import { zohoClientFor, type ConnectionRow } from "@/lib/connector/runtime";
import { logToolCall } from "@/lib/connector/usage";
import { registerInventoryTools, SERVER_INSTRUCTIONS } from "@/lib/mcp/tools";
import { ConnectorError } from "@/lib/zoho/errors";

const mcp = createMcpHandler(
  (server) =>
    registerInventoryTools(server, {
      async resolveContext(authExtra) {
        // Loaded together with the API key in verifyApiKey: no extra query per call.
        const connection = authExtra?.connection as ConnectionRow | undefined;
        if (!connection || connection.status === "revoked") {
          throw new ConnectorError("REAUTH_REQUIRED", "This connection no longer exists");
        }
        if (connection.status === "needs_reauth") {
          throw new ConnectorError(
            "REAUTH_REQUIRED",
            `Zoho access expired or was revoked (${connection.last_error ?? "unknown reason"})`,
          );
        }
        return {
          client: zohoClientFor(connection),
          connection,
          apiKeyId: typeof authExtra?.apiKeyId === "string" ? authExtra.apiKeyId : null,
        };
      },
      // Write the usage row after the response is sent so it adds no latency.
      recordCall: (record) => after(() => logToolCall(record)),
    }),
  {
    serverInfo: { name: "zoho-inventory-connector", version: "1.0.0" },
    instructions: SERVER_INSTRUCTIONS,
  },
);

/**
 * Agents authenticate with a per-connection API key: `Authorization: Bearer zic_...`.
 * The key decides which merchant's Zoho organization the tools read from.
 */
const handler = withMcpAuth(
  mcp,
  async (_req, bearerToken) => {
    const verified = await verifyApiKey(bearerToken);
    if (!verified) return undefined;
    return {
      token: bearerToken!,
      clientId: verified.apiKeyId,
      scopes: ["inventory:read"],
      extra: { connection: verified.connection, apiKeyId: verified.apiKeyId },
    };
  },
  { required: true },
);

/**
 * Reports how long this function spent on the request (Server-Timing), and
 * logs slow ones, so latency can be split between the connector and whatever
 * sits in front of it (network, platform queueing, cold starts).
 */
async function timed(req: Request): Promise<Response> {
  const started = performance.now();
  const res = await handler(req);
  const ms = performance.now() - started;
  if (ms > 3_000) console.warn(`slow mcp request: ${Math.round(ms)}ms`);
  const headers = new Headers(res.headers);
  headers.set("server-timing", `handler;dur=${ms.toFixed(0)}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export { timed as GET, timed as POST, timed as DELETE };
