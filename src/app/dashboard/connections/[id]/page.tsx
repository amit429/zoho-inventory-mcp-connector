import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { ConnectionRow } from "@/lib/connector/runtime";
import { appUrl } from "@/lib/env";
import { requireUser, supabaseServer } from "@/lib/supabase/server";
import { disconnectAction, revokeKeyAction } from "../../actions";
import { StatusBadge } from "../../status-badge";
import { CopyField } from "./copy-field";
import { CreateKeyForm } from "./create-key-form";

export default function ConnectionPage(props: PageProps<"/dashboard/connections/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Connection {...props} />
    </Suspense>
  );
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ToolCallRow {
  tool: string;
  status: "ok" | "error";
  error_code: string | null;
  latency_ms: number;
  zoho_requests: number;
  created_at: string;
}

async function Connection({ params, searchParams }: PageProps<"/dashboard/connections/[id]">) {
  await requireUser();
  const { id } = await params;
  const { connected } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await supabaseServer();
  const since = daysAgo(7);
  const [connectionRes, keysRes, callsRes] = await Promise.all([
    supabase.from("connections").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("api_keys")
      .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
      .eq("connection_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("tool_calls")
      .select("tool, status, error_code, latency_ms, zoho_requests, created_at")
      .eq("connection_id", id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const connection = connectionRes.data as ConnectionRow | null;
  if (!connection) notFound();
  const keys = (keysRes.data ?? []) as ApiKeyRow[];
  const calls = (callsRes.data ?? []) as ToolCallRow[];
  const endpoint = `${appUrl()}/api/mcp`;

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link href="/dashboard" className="text-sm text-muted hover:text-fg">
          ← Connections
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{connection.zoho_org_name ?? "Zoho organization"}</h1>
            <p className="font-mono text-xs text-muted">
              org {connection.zoho_org_id} · {connection.currency_code ?? "—"} · {connection.time_zone ?? "—"}
            </p>
          </div>
          <StatusBadge status={connection.status} />
        </div>
        {connected && <p className="notice notice-ok">Zoho Inventory connected. Create an API key below to give an agent access.</p>}
        {connection.status === "needs_reauth" && (
          <p className="notice notice-warn">
            Zoho access stopped working ({connection.last_error ?? "token revoked or expired"}). Agents get a
            REAUTH_REQUIRED error until you{" "}
            <a className="underline" href="/api/oauth/zoho/start">
              reconnect
            </a>
            .
          </p>
        )}
      </div>

      <section className="card flex flex-col gap-4">
        <h2 className="font-medium">Agent endpoint</h2>
        <CopyField label="MCP server URL (Streamable HTTP)" value={endpoint} />
        <p className="text-sm text-muted">
          Send <span className="code">Authorization: Bearer &lt;api key&gt;</span> with every request. The key decides
          which organization the tools read from.
        </p>
      </section>

      <section className="card flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">API keys</h2>
          <p className="text-sm text-muted">Create one key per agent so you can see and revoke each one separately.</p>
        </div>
        <CreateKeyForm connectionId={connection.id} endpoint={endpoint} />
        {keys.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{k.name}</span>
                  <span className="font-mono text-xs text-muted">
                    {k.key_prefix}… · created {formatDate(k.created_at)} · last used{" "}
                    {k.last_used_at ? formatDate(k.last_used_at) : "never"}
                  </span>
                </div>
                {k.revoked_at ? (
                  <span className="text-xs text-muted">Revoked {formatDate(k.revoked_at)}</span>
                ) : (
                  <form action={revokeKeyAction}>
                    <input type="hidden" name="connectionId" value={connection.id} />
                    <input type="hidden" name="keyId" value={k.id} />
                    <button type="submit" className="btn btn-danger px-3 py-1.5 text-xs">
                      Revoke
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Usage calls={calls} />

      <section className="card flex flex-col gap-3">
        <h2 className="font-medium">Disconnect</h2>
        <p className="text-sm text-muted">
          Revokes the refresh token at Zoho and permanently deletes the stored tokens, all API keys and usage logs for
          this organization.
        </p>
        <form action={disconnectAction}>
          <input type="hidden" name="connectionId" value={connection.id} />
          <button type="submit" className="btn btn-danger">
            Disconnect Zoho Inventory
          </button>
        </form>
      </section>
    </>
  );
}

function Usage({ calls }: { calls: ToolCallRow[] }) {
  const total = calls.length;
  const errors = calls.filter((c) => c.status === "error").length;
  const latencies = calls.map((c) => c.latency_ms).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;
  const zohoRequests = calls.reduce((sum, c) => sum + c.zoho_requests, 0);

  const byTool = new Map<string, number>();
  for (const c of calls) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + 1);
  const topTools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <section className="card flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Usage · last 7 days</h2>
        <p className="text-sm text-muted">Tool arguments aren&apos;t stored, since they can contain customer details.</p>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Tool calls" value={total.toLocaleString()} />
        <Stat label="Error rate" value={total ? `${((errors / total) * 100).toFixed(1)}%` : "—"} />
        <Stat label="p95 latency" value={p95 !== null ? `${p95} ms` : "—"} />
        <Stat label="Zoho API requests" value={zohoRequests.toLocaleString()} />
      </dl>

      {total === 0 ? (
        <p className="text-sm text-muted">No calls yet. Point an agent at the endpoint above to see activity here.</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="label">Most used tools</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {topTools.map(([tool, count]) => (
                <li key={tool} className="flex justify-between gap-3">
                  <span className="font-mono text-xs">{tool}</span>
                  <span className="tabular-nums text-muted">{count}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="label">Recent calls</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {calls.slice(0, 8).map((c, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="truncate font-mono text-xs">
                    {c.status === "ok" ? "✓" : "✕"} {c.tool}
                    {c.error_code && <span className="text-muted"> · {c.error_code}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">{c.latency_ms} ms</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="label">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

/** Start of the usage window. Kept out of the component body: it reads the clock. */
function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}
