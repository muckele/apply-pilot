"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Undo2 } from "lucide-react";

import { BigWindow } from "@/components/ui/big-window";

// "Did you apply?" (G-7): the page's one large window, shown when the user comes back after opening
// the employer's application (never window.confirm), and the notice that lets a "Not applying"
// answer be undone. "Yes, I applied" is the user's attestation and records Applied in one click,
// with the documents attached to the application; if the server refuses, the window offers the
// full confirmation, where the documents and minutes are chosen by hand.

export type ApplyReturnAction = "NOT_APPLYING" | "UNDO_NOT_APPLYING";
type ApplyReturnBusy = ApplyReturnAction | "APPLIED";

export const APPLIED_LIST_HREF = "/applications?status=APPLIED";

export function appliedErrorMessage(code: string | undefined, fallback: string) {
  switch (code) {
    case "APPLICATION_DOCUMENT_EVIDENCE_STALE":
      return "Apply Pilot could not record this application: your master résumé or reviewed evidence changed after a selected document was written. Generate a new version or pick a current one, then record it again.";
    case "APPLICATION_DOCUMENT_REVIEW_REQUIRED":
      return "Apply Pilot could not record this application: a selected document needs your review first. Review it below, then record it again.";
    case "APPLICATION_SENT_DOCUMENT_CHANGED":
      return "A document changed after this page loaded. The kit now shows the latest version; check it is the one you sent, then confirm again.";
    default:
      return fallback;
  }
}

type Variant = "kit" | "job";

// The "Not applying" notice's look in each place it shows.
const STYLES: Record<Variant, { copy: string; secondary: string; error: string }> = {
  kit: {
    copy: "text-sm text-slate-700",
    secondary: "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60",
    error: "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
  },
  job: {
    copy: "job-card-copy",
    secondary: "job-button",
    error: "job-message job-message-error"
  }
};

// Records that the user opened the employer's application. keepalive lets the request finish while
// the browser switches to the new tab. "nothing-to-ask": the application has already moved past
// the point where "I applied" can be recorded (from another tab or device, say).
export async function recordApplicationOpened(jobId: string): Promise<"recorded" | "nothing-to-ask" | "failed"> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/apply-return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "OPENED" }),
      keepalive: true
    });
    if (!response.ok) return "failed";
    const json = (await response.json().catch(() => null)) as { opened?: unknown } | null;
    return json && json.opened === null ? "nothing-to-ask" : "recorded";
  } catch {
    return "failed";
  }
}

export function useApplyReturnAnswer(jobId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<ApplyReturnBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last "Yes, I applied" was refused: the window then offers the full confirmation.
  const [yesRefused, setYesRefused] = useState(false);

  // One click: the server records the documents attached to this application (no ids sent).
  async function recordApplied() {
    if (busy) return false;
    setBusy("APPLIED");
    setError(null);
    setYesRefused(false);
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobPostingId: jobId, status: "APPLIED" })
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
        setError(appliedErrorMessage(json?.code, json?.error ?? "Apply Pilot could not record this application. Nothing changed; try again."));
        setYesRefused(true);
        if (response.status === 409) router.refresh();
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach Apply Pilot. Nothing was recorded; try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function send(action: ApplyReturnAction) {
    setBusy(action);
    setError(null);
    setYesRefused(false);
    try {
      const response = await fetch(`/api/jobs/${jobId}/apply-return`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "Apply Pilot could not save your answer. Nothing changed; try again.");
        // 409: answered or changed elsewhere (another tab or device); reload to show where it stands.
        if (response.status === 409) router.refresh();
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach Apply Pilot. Nothing changed; try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    error,
    yesRefused,
    send,
    recordApplied,
    clearError: () => {
      setError(null);
      setYesRefused(false);
    }
  };
}

export function ApplyReturnWindow({
  company,
  onYes,
  onNotYet,
  onNotApplying,
  busy,
  error,
  choose = null
}: {
  company: string;
  onYes: () => void;
  // Also Esc: nothing is recorded and the question comes back on the next visit.
  onNotYet: () => void;
  onNotApplying: () => void;
  busy: ApplyReturnBusy | null;
  error: string | null;
  // After a refused "Yes": the full confirmation (a button in the kit, a link from the job page).
  choose?: { onClick: () => void } | { href: string } | null;
}) {
  const titleId = useId();
  const working = busy !== null;
  return (
    <BigWindow labelledBy={titleId} onClose={working ? () => undefined : onNotYet} dataAttribute="data-apply-return">
      <h2 id={titleId} tabIndex={-1} className="job-section-title">Did you submit your application to {company}?</h2>
      <p className="job-card-copy">
        You opened the employer&apos;s application from Apply Pilot. Choose Yes only if you submitted it: Apply Pilot then records it
        as applied, with the résumé and cover letter attached to this application.
      </p>
      {error ? <p role="alert" className="job-message job-message-error" data-apply-return-error>{error}</p> : null}
      {choose ? (
        "href" in choose ? (
          <Link href={choose.href} className="job-button job-button-primary job-button-large" data-apply-return-choose>Choose what I sent</Link>
        ) : (
          <button type="button" className="job-button job-button-primary job-button-large" onClick={choose.onClick} data-apply-return-choose>Choose what I sent</button>
        )
      ) : (
        <button type="button" onClick={onYes} disabled={working} className="job-button job-button-primary job-button-large" data-apply-return-yes>
          {busy === "APPLIED" ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
          Yes, I applied
        </button>
      )}
      <button type="button" onClick={onNotYet} disabled={working} className="job-button" data-apply-return-not-yet>Not yet</button>
      <button type="button" onClick={onNotApplying} disabled={working} className="job-link-button" data-apply-return-not-applying>
        {busy === "NOT_APPLYING" ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : null}
        Not applying
      </button>
    </BigWindow>
  );
}

// After a one-click "Yes, I applied": where the application now is.
export function ApplyRecordedNotice({ variant }: { variant: Variant }) {
  return (
    <p
      role="status"
      className={variant === "kit" ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" : "job-message job-message-success"}
      data-applied-recorded
    >
      Recorded as applied.{" "}
      <Link href={APPLIED_LIST_HREF} className={variant === "kit" ? "font-semibold underline" : "job-inline-link"}>See it in your applications</Link>
    </p>
  );
}

export function ApplyReturnDeclinedNotice({
  variant,
  onUndo,
  busy,
  error
}: {
  variant: Variant;
  onUndo: () => void;
  busy: boolean;
  error: string | null;
}) {
  const style = STYLES[variant];
  return (
    <div role="status" className={variant === "kit" ? "space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" : "job-card job-apply-return"} data-apply-return-declined>
      <p className={variant === "kit" ? undefined : style.copy}>
        You said you are not applying for this job, so it is archived and out of your active applications.
      </p>
      {error ? <p role="alert" className={style.error} data-apply-return-error>{error}</p> : null}
      <button type="button" onClick={onUndo} disabled={busy} className={style.secondary} data-apply-return-undo>
        {busy ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : <Undo2 className="mr-2" size={15} aria-hidden="true" />}
        Undo
      </button>
    </div>
  );
}
