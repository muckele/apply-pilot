"use client";

import { useId } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { fitTier } from "@/components/job-workspace/match-card";
import { BigWindow } from "@/components/ui/big-window";
import type { ResultWindowView } from "@/lib/apply-page/result-window";
import { GRADE_EXPLANATION } from "@/lib/jobs/grade";

// The window after every score (G-6). No prices: the hidden credit line and the out-of-credits
// upgrade route plug in once a real credit source exists (D037); until then both props are null.
export type ResultWindowProps = {
  view: ResultWindowView;
  onCreate: () => void;
  onClose: () => void;
  // B: close and go to step 2. Also how a blocked Create points there.
  onAddExperience: () => void;
  // C/D: close and open "Apply on my own".
  onApplyOnMyOwn: () => void;
  creating?: boolean;
  status?: { tone: "info" | "success" | "error"; text: string } | null;
  // Set while something stops Create (unsaved lines in step 2, writing switched off).
  createBlockedReason?: string | null;
  credit?: { left: number } | null;
  upgradeHref?: string | null;
};

const CREATE = "Create my résumé and cover letter";
const JOBS_HREF = "/jobs";

export function ResultWindow({
  view,
  onCreate,
  onClose,
  onAddExperience,
  onApplyOnMyOwn,
  creating = false,
  status = null,
  createBlockedReason = null,
  credit = null,
  upgradeHref = null
}: ResultWindowProps) {
  const titleId = useId();
  const outOfCredits = credit !== null && credit.left <= 0 && upgradeHref !== null;

  const create = outOfCredits ? (
    <>
      <p className="job-card-copy">You&apos;ve used all your credits.</p>
      <a className="job-button job-button-primary job-button-large" href={upgradeHref ?? undefined}>Upgrade your plan</a>
    </>
  ) : (
    <>
      <button
        type="button"
        className="job-button job-button-primary job-button-large"
        onClick={onCreate}
        disabled={creating || createBlockedReason !== null}
        aria-busy={creating || undefined}
      >
        {creating ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
        {creating ? "Creating…" : CREATE}
      </button>
      {credit !== null ? <p className="job-hint" data-credit-line>Uses 1 credit · {credit.left} left</p> : null}
    </>
  );

  return (
    <BigWindow labelledBy={titleId} onClose={creating ? () => undefined : onClose} dataAttribute="data-result-window">
      <h2 id={titleId} tabIndex={-1} className="job-section-title" data-grade={view.letter}>
        <span className={`job-match-score job-fit-${fitTier(view.score)}`}>{view.letter}</span> · {view.score}
      </h2>
      {view.kind === "strong" ? (
        <p className="job-card-copy">Strong match. {view.why}</p>
      ) : view.kind === "close" ? (
        <>
          <p className="job-card-copy">Close match. {view.why}</p>
          {view.missing.length ? (
            <div data-missing>
              <p className="job-card-copy">Still missing:</p>
              <ul className="job-plain-list">{view.missing.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="job-card-copy">This may not be a good fit. Let&apos;s look at other jobs.</p>
      )}
      <p className="job-hint">{GRADE_EXPLANATION}</p>

      {createBlockedReason && view.kind !== "weak" ? <p className="job-note" data-create-blocked>{createBlockedReason}</p> : null}
      {status ? (
        <p role={status.tone === "error" ? "alert" : "status"} className={`job-message job-message-${status.tone}`}>{status.text}</p>
      ) : null}

      {view.kind === "weak" ? (
        <>
          <a className="job-button job-button-primary job-button-large" href={JOBS_HREF}>Find other jobs</a>
          <button type="button" className="job-link-button" onClick={onApplyOnMyOwn}>Apply on my own</button>
        </>
      ) : (
        <>
          {create}
          {createBlockedReason ? (
            <button type="button" className="job-button" onClick={onAddExperience}>Go to step 2</button>
          ) : view.kind === "close" ? (
            <button type="button" className="job-button" onClick={onAddExperience} disabled={creating}>Add my experience first</button>
          ) : null}
          {view.kind === "close" ? (
            <a className="job-link-button" href={JOBS_HREF}>Find better-fit jobs</a>
          ) : (
            <button type="button" className="job-link-button" onClick={onClose} disabled={creating}>Not now</button>
          )}
        </>
      )}
    </BigWindow>
  );
}
