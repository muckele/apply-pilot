"use client";

import { useState } from "react";
import { Archive, BookmarkPlus, BriefcaseBusiness, ExternalLink, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

type PendingAction = "save" | "interested" | "archive" | "match" | null;

type JobReviewActionsProps = {
  jobId: string;
  applyUrl: string;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string } | null;
}

function requestErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function JobReviewActions({ jobId, applyUrl }: JobReviewActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function saveApplication(status: "SAVED" | "INTERESTED") {
    setPending(status === "SAVED" ? "save" : "interested");
    setMessage(null);

    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobPostingId: jobId,
          status,
          nextAction:
            status === "INTERESTED"
              ? "Build apply packet and decide whether to apply."
              : "Review fit analysis and decide whether to apply."
        })
      });
      const json = await readJson(response);

      if (!response.ok) {
        setMessage(json?.error ?? "Could not update the CRM record.");
        return;
      }

      setMessage(status === "INTERESTED" ? "Marked interested in CRM." : "Saved to CRM.");
      router.refresh();
    } catch (error) {
      setMessage(requestErrorMessage(error, "Could not update the CRM record."));
    } finally {
      setPending(null);
    }
  }

  async function archiveJob() {
    setPending("archive");
    setMessage(null);

    try {
      const response = await fetch(`/api/jobs/${jobId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ARCHIVED" })
      });
      const json = await readJson(response);

      if (!response.ok) {
        setMessage(json?.error ?? "Could not archive the job.");
        return;
      }

      setMessage("Archived.");
      router.refresh();
    } catch (error) {
      setMessage(requestErrorMessage(error, "Could not archive the job."));
    } finally {
      setPending(null);
    }
  }

  async function refreshMatch() {
    setPending("match");
    setMessage(null);

    try {
      const response = await fetchWithAiCostConfirmation(`/api/jobs/${jobId}/match`, { method: "POST" });
      const json = await readJson(response);

      if (!response.ok) {
        setMessage(json?.error ?? "Could not refresh fit score.");
        return;
      }

      setMessage("Fit score refreshed.");
      router.refresh();
    } catch (error) {
      setMessage(requestErrorMessage(error, "Could not refresh fit score."));
    } finally {
      setPending(null);
    }
  }

  const secondaryButton =
    "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => saveApplication("SAVED")}
          disabled={Boolean(pending)}
          className={secondaryButton}
        >
          {pending === "save" ? <Loader2 className="animate-spin" size={15} /> : <BookmarkPlus size={15} />}
          Save to CRM
        </button>
        <button
          type="button"
          onClick={() => saveApplication("INTERESTED")}
          disabled={Boolean(pending)}
          className={secondaryButton}
        >
          {pending === "interested" ? <Loader2 className="animate-spin" size={15} /> : <BriefcaseBusiness size={15} />}
          Interested
        </button>
        <button type="button" onClick={refreshMatch} disabled={Boolean(pending)} className={secondaryButton}>
          {pending === "match" ? <Loader2 className="animate-spin" size={15} /> : <Sparkles size={15} />}
          Refresh score
        </button>
        <Link
          href={`/jobs/${jobId}`}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <BriefcaseBusiness size={15} />
          Build packet
        </Link>
        <a
          href={applyUrl}
          target={applyUrl.startsWith("http") ? "_blank" : undefined}
          rel={applyUrl.startsWith("http") ? "noreferrer" : undefined}
          className={secondaryButton}
        >
          <ExternalLink size={15} />
          Apply link
        </a>
        <button type="button" onClick={archiveJob} disabled={Boolean(pending)} className={secondaryButton}>
          {pending === "archive" ? <Loader2 className="animate-spin" size={15} /> : <Archive size={15} />}
          Archive
        </button>
      </div>
      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p> : null}
    </div>
  );
}
