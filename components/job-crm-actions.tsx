"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

type JobCrmActionsProps = {
  jobId: string;
  compact?: boolean;
  resumeVersions?: Array<{ id: string; title: string }>;
  coverLetters?: Array<{ id: string; title: string }>;
  defaultResumeVersionId?: string | null;
  defaultCoverLetterVersionId?: string | null;
};

export function JobCrmActions({
  jobId,
  compact = false,
  resumeVersions = [],
  coverLetters = [],
  defaultResumeVersionId = null,
  defaultCoverLetterVersionId = null
}: JobCrmActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"save" | "applied" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resumeVersionId, setResumeVersionId] = useState(defaultResumeVersionId ?? resumeVersions[0]?.id ?? "");
  const [coverLetterVersionId, setCoverLetterVersionId] = useState(
    defaultCoverLetterVersionId ?? coverLetters[0]?.id ?? ""
  );

  useEffect(() => {
    if (!resumeVersions.length) {
      setResumeVersionId("");
      return;
    }

    if (!resumeVersionId || !resumeVersions.some((version) => version.id === resumeVersionId)) {
      setResumeVersionId(defaultResumeVersionId ?? resumeVersions[0].id);
    }
  }, [defaultResumeVersionId, resumeVersionId, resumeVersions]);

  useEffect(() => {
    if (!coverLetters.length) {
      setCoverLetterVersionId("");
      return;
    }

    if (!coverLetterVersionId || !coverLetters.some((document) => document.id === coverLetterVersionId)) {
      setCoverLetterVersionId(defaultCoverLetterVersionId ?? coverLetters[0].id);
    }
  }, [coverLetterVersionId, coverLetters, defaultCoverLetterVersionId]);

  async function updateApplication(action: "save" | "applied") {
    setPending(action);
    setMessage(null);

    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobPostingId: jobId,
        status: action === "applied" ? "APPLIED" : "SAVED",
        resumeVersionId: resumeVersionId || undefined,
        coverLetterVersionId: coverLetterVersionId || undefined,
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
      {!compact ? (
        <div className="grid gap-3">
          <label className="block text-xs font-medium text-slate-600">
            Resume version used
            <select
              value={resumeVersionId}
              onChange={(event) => setResumeVersionId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="">Not selected</option>
              {resumeVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Cover letter used
            <select
              value={coverLetterVersionId}
              onChange={(event) => setCoverLetterVersionId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="">Not selected</option>
              {coverLetters.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
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
