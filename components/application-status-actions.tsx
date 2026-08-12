"use client";

import { useState } from "react";
import type { ApplicationStatus } from "@prisma/client";
import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { applicationStatusOptions } from "@/lib/applications/pipeline";

type ApplicationStatusActionsProps = {
  applicationId: string;
  currentStatus: ApplicationStatus;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string } | null;
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not update application status.";
}

export function ApplicationStatusActions({ applicationId, currentStatus }: ApplicationStatusActionsProps) {
  const router = useRouter();
  const [status, setStatus] = useState<ApplicationStatus>(currentStatus);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function updateStatus() {
    if (status === currentStatus) {
      setMessage("No status change selected.");
      return;
    }

    setPending(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      });
      const json = await readJson(response);

      if (!response.ok) {
        setMessage(json?.error ?? "Could not update application status.");
        return;
      }

      setMessage("Status updated.");
      router.refresh();
    } catch (error) {
      setMessage(requestErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as ApplicationStatus)}
          disabled={pending}
          className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Application status"
        >
          {applicationStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={updateStatus}
          disabled={pending || status === currentStatus}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          Update
        </button>
      </div>
      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p> : null}
    </div>
  );
}
