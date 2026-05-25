"use client";

import { useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";

import { SecondaryButton } from "@/components/ui";

type ActionState = "idle" | "exporting" | "deleting" | "error" | "done";

export function AccountDataControls() {
  const [state, setState] = useState<ActionState>("idle");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function exportAccountData() {
    setState("exporting");
    setMessage("");

    const response = await fetch("/api/account/export");

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      setState("error");
      setMessage(error?.error ?? "Account export failed.");
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `jobmatch-crm-export-${today}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setState("done");
    setMessage("Export downloaded as JSON.");
  }

  async function deleteAccountData() {
    setState("deleting");
    setMessage("");

    const response = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation })
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      setState("error");
      setMessage(error?.error ?? "Account deletion failed.");
      return;
    }

    window.location.assign("/login?accountDeleted=1");
  }

  const busy = state === "exporting" || state === "deleting";
  const canDelete = confirmation === "DELETE MY DATA";

  return (
    <div className="space-y-5 p-5">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
        Export includes your profile, jobs, applications, generated documents, interview records, and saved email snippets.
        It excludes encrypted OAuth tokens, sessions, and stored file bytes.
      </div>

      <SecondaryButton type="button" onClick={exportAccountData} disabled={busy}>
        {state === "exporting" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Download className="mr-2" size={15} />}
        Export account data
      </SecondaryButton>

      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="flex items-start gap-3">
          <Trash2 className="mt-0.5 shrink-0 text-red-600" size={18} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-sm font-semibold text-red-950">Delete account data</p>
              <p className="mt-1 text-sm leading-6 text-red-800">
                This removes your private CRM records, documents, Gmail connection, applications, and sessions. This action
                cannot be undone.
              </p>
            </div>
            <label className="block text-sm font-medium text-red-950">
              Type DELETE MY DATA to confirm
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="mt-1 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-950 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
              />
            </label>
            <button
              type="button"
              onClick={deleteAccountData}
              disabled={!canDelete || busy}
              className="inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state === "deleting" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Trash2 className="mr-2" size={15} />}
              Delete my account data
            </button>
          </div>
        </div>
      </div>

      {message ? (
        <p className={`text-sm ${state === "error" ? "text-red-700" : "text-emerald-700"}`}>{message}</p>
      ) : null}
    </div>
  );
}
