"use client";

import { useState } from "react";
import { Loader2, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";

export function GmailDisconnectControl({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [deleteSyncedData, setDeleteSyncedData] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function disconnect() {
    const confirmed = window.confirm(
      deleteSyncedData
        ? "Disconnect Gmail and delete synced Gmail snippets from the CRM?"
        : "Disconnect Gmail and keep saved CRM email snippets?"
    );

    if (!confirmed) {
      return;
    }

    setPending(true);
    setMessage(null);
    const response = await fetch("/api/gmail/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteSyncedData })
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    setPending(false);

    if (!response.ok) {
      setMessage(json?.error ?? "Could not disconnect Gmail.");
      return;
    }

    setMessage("Gmail disconnected.");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-600">
        <input
          type="checkbox"
          checked={deleteSyncedData}
          onChange={(event) => setDeleteSyncedData(event.target.checked)}
          disabled={!connected || pending}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600"
        />
        Delete synced Gmail snippets from CRM records when disconnecting.
      </label>
      <button
        type="button"
        disabled={!connected || pending}
        onClick={disconnect}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Unplug size={15} aria-hidden="true" />}
        Disconnect
      </button>
      {message ? <p className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
}
