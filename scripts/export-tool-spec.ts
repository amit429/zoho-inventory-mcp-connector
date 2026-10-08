/**
 * Writes docs/mcp-tools.json: the exact tools/list response the MCP server
 * returns (names, descriptions, JSON Schemas, annotations), plus the server
 * instructions. Generated from the code so the spec can't drift.
 *
 *   npm run export:tools
 */
import { writeFileSync } from "node:fs";
import { createMcpHandler } from "mcp-handler";
import { registerInventoryTools, SERVER_INSTRUCTIONS } from "../src/lib/mcp/tools";

async function main() {
  const handler = createMcpHandler(
    (server) =>
      registerInventoryTools(server, {
        resolveContext: async () => {
          throw new Error("not used: only listing tools");
        },
        recordCall: () => {},
      }),
    { serverInfo: { name: "zoho-inventory-connector", version: "1.0.0" }, instructions: SERVER_INSTRUCTIONS },
  );

  const res = await handler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const { result } = JSON.parse(data ? data.slice(6) : text);

  const spec = {
    server: { name: "zoho-inventory-connector", version: "1.0.0", transport: "Streamable HTTP", endpoint: "/api/mcp" },
    auth: { type: "bearer", header: "Authorization: Bearer zic_...", issuedBy: "connector dashboard, one key per agent" },
    instructions: SERVER_INSTRUCTIONS,
    tools: result.tools,
  };
  writeFileSync("docs/mcp-tools.json", JSON.stringify(spec, null, 2) + "\n");
  console.log(`Wrote docs/mcp-tools.json (${result.tools.length} tools)`);
}

main();
