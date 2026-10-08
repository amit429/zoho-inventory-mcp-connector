import Link from "next/link";
import { AuthForm } from "./auth-form";

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-4 py-16">
      <div className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-muted hover:text-fg">
          ← Zoho Inventory Connector
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Merchant sign in</h1>
        <p className="text-sm text-muted">Sign in to connect Zoho Inventory and issue keys for your agents.</p>
      </div>
      <AuthForm />
    </main>
  );
}
