"use client";

import { useState } from "react";
import { FileText, Loader2, Mail, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";

export function JobActions({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function runAction(action: "match" | "resume" | "cover") {
    setPending(action);
    setMessage(null);
    const endpoint =
      action === "match"
        ? `/api/jobs/${jobId}/match`
        : action === "resume"
          ? `/api/jobs/${jobId}/tailored-resume`
          : `/api/jobs/${jobId}/cover-letter`;
    const response = await fetch(endpoint, { method: "POST" });
    const json = await response.json();
    setPending(null);

    if (!response.ok) {
      setMessage(json.error ?? "Action failed");
      return;
    }

    if (action === "match") {
      setMessage(`Updated fit score: ${json.match?.overallFitScore ?? json.job?.overallFitScore}%`);
    } else if (action === "resume") {
      setMessage(`Saved resume version: ${json.version?.title}`);
    } else {
      setMessage(`Saved cover letter: ${json.document?.title}`);
    }

    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="button" onClick={() => runAction("match")} disabled={Boolean(pending)}>
          {pending === "match" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Sparkles className="mr-2" size={15} />}
          Score match
        </PrimaryButton>
        <SecondaryButton type="button" onClick={() => runAction("resume")} disabled={Boolean(pending)}>
          {pending === "resume" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <FileText className="mr-2" size={15} />}
          Tailor resume
        </SecondaryButton>
        <SecondaryButton type="button" onClick={() => runAction("cover")} disabled={Boolean(pending)}>
          {pending === "cover" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Mail className="mr-2" size={15} />}
          Draft cover letter
        </SecondaryButton>
      </div>
      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}
    </div>
  );
}
