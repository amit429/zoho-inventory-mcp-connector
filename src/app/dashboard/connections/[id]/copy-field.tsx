"use client";

import { useState } from "react";

export function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <div className="flex items-start gap-2">
        {multiline ? (
          <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2">{value}</pre>
        ) : (
          <code className="code min-w-0 flex-1 truncate px-3 py-2">{value}</code>
        )}
        <button type="button" onClick={copy} className="btn btn-secondary shrink-0 px-3 py-2 text-xs">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
