import Link from "next/link";
import { Suspense } from "react";
import type { ConnectionRow } from "@/lib/connector/runtime";
import { requireUser, supabaseServer } from "@/lib/supabase/server";
import { ZOHO_DATA_CENTERS } from "@/lib/zoho/datacenters";
import { StatusBadge } from "./status-badge";

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-sm text-muted">Each connection gives your agents read-only access to one Zoho Inventory organization.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Flash searchParams={searchParams} />
        <Connections />
      </Suspense>
    </>
  );
}

async function Flash({ searchParams }: Pick<PageProps<"/dashboard">, "searchParams">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  if (error) return <p className="notice notice-error">{error}</p>;
  if (params.disconnected) return <p className="notice notice-ok">Disconnected. Zoho access was revoked and all keys were deleted.</p>;
  return null;
}

async function Connections() {
  await requireUser();
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("connections")
    .select("id, zoho_org_name, zoho_org_id, api_domain, status, created_at")
    .order("created_at", { ascending: false });
  const connections = (data ?? []) as Pick<ConnectionRow, "id" | "zoho_org_name" | "zoho_org_id" | "api_domain" | "status" | "created_at">[];

  return (
    <>
      {connections.length > 0 && (
        <ul className="flex flex-col gap-3">
          {connections.map((c) => (
            <li key={c.id}>
              <Link href={`/dashboard/connections/${c.id}`} className="card flex items-center justify-between gap-4 hover:border-accent">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{c.zoho_org_name ?? "Zoho organization"}</span>
                  <span className="truncate font-mono text-xs text-muted">
                    org {c.zoho_org_id} · {new URL(c.api_domain).hostname}
                  </span>
                </div>
                <StatusBadge status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="card flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{connections.length ? "Connect another organization" : "Connect Zoho Inventory"}</h2>
          <p className="text-sm text-muted">
            You&apos;ll be sent to Zoho to approve <strong>read-only</strong> access to items, sales orders, customers and
            settings. Pick the region your Zoho account is in.
          </p>
        </div>
        <form action="/api/oauth/zoho/start" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Zoho data center
            <select name="dc" defaultValue="in" className="input">
              {Object.entries(ZOHO_DATA_CENTERS).map(([key, dc]) => (
                <option key={key} value={key}>
                  {dc.label} ({new URL(dc.accountsServer).hostname})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary">
            Connect with Zoho
          </button>
        </form>
      </section>
    </>
  );
}
