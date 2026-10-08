import Link from "next/link";
import { Suspense } from "react";
import { getUser } from "@/lib/supabase/server";
import { signOut } from "../login/actions";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            Zoho Inventory Connector
          </Link>
          <Suspense fallback={null}>
            <Account />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10">{children}</main>
    </div>
  );
}

async function Account() {
  const user = await getUser();
  if (!user) return null;
  return (
    <form action={signOut} className="flex items-center gap-3 text-sm">
      <span className="hidden truncate text-muted sm:inline">{user.email}</span>
      <button type="submit" className="btn btn-secondary px-3 py-1.5">
        Sign out
      </button>
    </form>
  );
}
