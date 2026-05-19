"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

type JobCrmActionsProps = {
  jobId: string;
  compact?: boolean;
};

export function JobCrmActions({ jobId, compact = false }: JobCrmActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"save" | "applied" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function updateApplication(action: "save" | "applied") {
    setPending(action);
    setMessage(null);

    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobPostingId: jobId,
        status: action === "applied" ? "APPLIED" : "SAVED",
        nextAction:
          action === "applied"
            ? "Track recruiter response and schedule follow-up."
            : "Review fit analysis and decide whether to apply."
      })
    });
    const json = (await response.json()) as { error?: string };

    setPending(null);

    if (!response.ok) {
      setMessage(json.error ?? "Could not update the CRM record.");
      return;
    }

    setMessage(action === "applied" ? "Marked applied and saved in CRM." : "Saved to CRM.");
    router.refresh();
  }

  const buttonClass =
    "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={Boolean(pending)}
          onClick={() => updateApplication("save")}
        >
          {pending === "save" ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Save size={15} aria-hidden="true" />
          )}
          Save
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={Boolean(pending)}
          onClick={() => updateApplication("applied")}
        >
          {pending === "applied" ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={15} aria-hidden="true" />
          )}
          Mark applied
        </button>
      </div>
      {message ? (
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p>
      ) : null}
    </div>
  );
}
