import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { after } from "next/server";
import { verifyApiKey } from "@/lib/connector/api-keys";
import { loadConnection, zohoClientFor } from "@/lib/connector/runtime";
import { logToolCall } from "@/lib/connector/usage";
import { registerInventoryTools, SERVER_INSTRUCTIONS } from "@/lib/mcp/tools";
import { ConnectorError } from "@/lib/zoho/errors";

const mcp = createMcpHandler(
  (server) =>
    registerInventoryTools(server, {
      async resolveContext(authExtra) {
        const connectionId = typeof authExtra?.connectionId === "string" ? authExtra.connectionId : undefined;
        const connection = connectionId ? await loadConnection(connectionId) : null;
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
      extra: { connectionId: verified.connectionId, apiKeyId: verified.apiKeyId },
    };
  },
  { required: true },
);

export { handler as GET, handler as POST, handler as DELETE };
