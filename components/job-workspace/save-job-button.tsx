"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Loader2 } from "lucide-react";

// Saves the job to the tracker as SAVED. Shown only when the job has no tracker record yet,
// so it can never move an existing application backwards.
export function SaveJobButton({ jobId, className = "job-button" }: { jobId: string; className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobPostingId: jobId, status: "SAVED", nextAction: "Tailor your documents, then apply with the Apply Kit." })
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "Couldn't save this job.");
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't save this job.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={save} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}
        Save job
      </button>
      {error ? <p role="alert" className="job-message job-message-error">{error}</p> : null}
    </>
  );
}
