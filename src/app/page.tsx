import Link from "next/link";

const QUESTIONS = [
  "Where is order SO-00042, and what's the tracking number?",
  "Can a customer order 2 indigo kurtas in size M right now?",
  "Which products are below their reorder level?",
  "What does Priya Sharma still owe us?",
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-12 px-4 py-16 sm:py-24">
      <header className="flex flex-col gap-4">
        <p className="label">Agent Studio · Private connector</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Zoho Inventory Connector</h1>
        <p className="max-w-2xl text-lg text-muted">
          Lets a merchant&apos;s AI agents answer order, stock and customer questions straight from Zoho Inventory, over
          the Model Context Protocol. It&apos;s read-only, scoped to one organization, and every call is logged.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/dashboard" className="btn btn-primary">
            Connect Zoho Inventory
          </Link>
          <a href="https://github.com/amit429/zoho-inventory-mcp-connector#readme" className="btn btn-secondary">
            Docs and source
          </a>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="label">Questions an agent can answer</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {QUESTIONS.map((q) => (
            <li key={q} className="card text-sm">
              “{q}”
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="label">How it works</h2>
        <ol className="flex flex-col gap-3 text-sm">
          <Step n={1} title="Connect">
            Sign in and approve read-only access in Zoho. Tokens are encrypted (AES-256-GCM) before they are stored.
          </Step>
          <Step n={2} title="Issue a key">
            Create an API key for each agent. Only its hash is stored, and you can revoke it at any time.
          </Step>
          <Step n={3} title="Point your agent at the endpoint">
            Add <span className="code">/api/mcp</span> with the key as a bearer token. The agent gets 12 tools for
            items, stock, sales orders, customers and locations.
          </Step>
        </ol>
      </section>
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="card flex gap-4">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border font-mono text-xs">
        {n}
      </span>
      <div className="flex flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-muted">{children}</span>
      </div>
    </li>
  );
}
