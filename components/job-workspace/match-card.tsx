import { Check, Minus, X } from "lucide-react";

import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import type { ChecklistView, EstimateView } from "@/lib/jobs/job-view-types";
import { topChecklistItems, type ChecklistStatus } from "@/lib/jobs/requirement-checklist";

export function fitTier(score: number) {
  return score >= 75 ? "high" : score >= 55 ? "medium" : "low";
}

export function FitBadge({ score, compact = false }: { score: number | null; compact?: boolean }) {
  if (score === null) {
    return <span className="job-fit job-fit-none" title="Not scored yet">Not scored</span>;
  }
  return (
    <span className={`job-fit job-fit-${fitTier(score)}`} title="Apply Pilot's fit estimate, not an employer score">
      {score}%{compact ? "" : " fit"}<span className="sr-only"> (Apply Pilot&apos;s estimate)</span>
    </span>
  );
}

const BASIS_TEXT: Record<EstimateView["basis"], string> = {
  REVIEWED_EVIDENCE: "Includes the lines you added for this job.",
  MASTER_RESUME: "Based on your master résumé.",
  MASTER_RESUME_NO_NEW_FACTS: "Based on your master résumé; your review didn't add any lines."
};

export function CheckIcon({ status }: { status: ChecklistStatus }) {
  if (status === "shown") return <Check size={15} aria-hidden="true" />;
  if (status === "not_shown") return <X size={15} aria-hidden="true" />;
  return <Minus size={15} aria-hidden="true" />;
}

export const CHECK_LABEL: Record<ChecklistStatus, string> = {
  shown: "On your résumé",
  not_shown: "Not on your résumé",
  not_assessed: "Not checked"
};

export function MatchCard({
  jobId,
  estimate,
  checklist,
  onSeeBreakdown,
  limit = 5
}: {
  jobId: string;
  estimate: EstimateView | null;
  checklist: ChecklistView;
  onSeeBreakdown?: () => void;
  limit?: number;
}) {
  if (!estimate) {
    return (
      <section className="job-card job-match-card" data-match-card aria-labelledby={`match-${jobId}`}>
        <h2 id={`match-${jobId}`} className="job-card-title">Your match</h2>
        <p className="job-match-unscored">Not scored yet</p>
        <p className="job-card-copy">See what this job asks for, line by line, next to your résumé.</p>
        <ScoreJobButton jobId={jobId} />
      </section>
    );
  }
  const { counts } = checklist;
  const top = topChecklistItems(checklist.items, limit);
  const more = [
    top.more.shown ? `+${top.more.shown} more you have` : null,
    top.more.notShown ? `+${top.more.notShown} more not on your résumé` : null,
    top.more.notAssessed ? `+${top.more.notAssessed} not checked` : null
  ].filter(Boolean);
  return (
    <section className="job-card job-match-card" data-match-card aria-labelledby={`match-${jobId}`}>
      <div className="job-match-head">
        <h2 id={`match-${jobId}`} className="job-card-title">Your match</h2>
        <p className={`job-match-score job-fit-${fitTier(estimate.score)}`}>{estimate.score}%</p>
      </div>
      <p className="job-hint">Apply Pilot&apos;s estimate, not an employer score. {BASIS_TEXT[estimate.basis]}</p>
      {counts.total ? (
        <p className="job-match-count">
          {counts.notAssessed === counts.total
            ? "Apply Pilot didn't check these requirements."
            : `You have ${counts.shown} of ${counts.total} must-haves`}
        </p>
      ) : null}
      {top.items.length ? (
        <ul className="job-checklist">
          {top.items.map((item, index) => (
            <li key={`${item.jobRef ?? "item"}-${index}`} data-check={item.status} className={`job-check-${item.status}`}>
              <CheckIcon status={item.status} />
              <span>{item.requirement}</span>
              <span className="sr-only"> — {CHECK_LABEL[item.status]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {more.length ? <p className="job-hint">{more.join(" · ")}</p> : null}
      {onSeeBreakdown ? (
        <button type="button" className="job-link-button" onClick={onSeeBreakdown}>See full breakdown</button>
      ) : null}
    </section>
  );
}
