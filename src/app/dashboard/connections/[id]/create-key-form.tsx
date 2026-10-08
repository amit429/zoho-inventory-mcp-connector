"use client";

import { useActionState } from "react";
import { createKeyAction, type CreateKeyState } from "../../actions";
import { CopyField } from "./copy-field";

export function CreateKeyForm({ connectionId, endpoint }: { connectionId: string; endpoint: string }) {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createKeyAction, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <input type="hidden" name="connectionId" value={connectionId} />
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
          Key name
          <input name="name" placeholder="e.g. Support agent" required maxLength={60} className="input" />
        </label>
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Creating…" : "Create API key"}
        </button>
      </form>

      {state.error && <p className="notice notice-error">{state.error}</p>}

      {state.key && (
        <div className="flex flex-col gap-3 rounded-lg border border-accent p-4">
          <p className="text-sm font-medium">Copy this key now. It won&apos;t be shown again.</p>
          <CopyField label="API key" value={state.key} />
          <CopyField
            label="MCP client config"
            multiline
            value={JSON.stringify(
              {
                mcpServers: {
                  "zoho-inventory": { url: endpoint, headers: { Authorization: `Bearer ${state.key}` } },
                },
              },
              null,
              2,
            )}
          />
        </div>
      )}
    </div>
  );
}
