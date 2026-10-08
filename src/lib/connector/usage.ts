import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ToolCallLog {
  connectionId: string;
  apiKeyId: string | null;
  tool: string;
  status: "ok" | "error";
  errorCode?: string;
  latencyMs: number;
  zohoRequests: number;
}

/** Records a tool call for the usage dashboard. Never throws: logging must not fail a tool call. */
export async function logToolCall(entry: ToolCallLog): Promise<void> {
  const { error } = await supabaseAdmin().from("tool_calls").insert({
    connection_id: entry.connectionId,
    api_key_id: entry.apiKeyId,
    tool: entry.tool,
    status: entry.status,
    error_code: entry.errorCode ?? null,
    latency_ms: Math.round(entry.latencyMs),
    zoho_requests: entry.zohoRequests,
  });
  if (error) console.error("failed to log tool call", error);
}
