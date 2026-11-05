"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, Loader2, Sparkles, XCircle } from "lucide-react";

import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { fetchWithAiCostConfirmation, fetchWithApprovedAiCost } from "@/lib/ai/browser-request";
import {
  documentCreationConfirmation,
  documentCreationMaximumMicros,
  formatUsdCentsCeiling,
  formatUsdMicros,
  planDocumentCreation,
  stepMaximumMicros,
  type DocumentCreationQuote,
  type DocumentCreationStep
} from "@/lib/jobs/document-creation-plan";
import type { EvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { evidenceSnapshotSaveResponseSchema } from "@/lib/jobs/evidence-snapshot-contracts";
import {
  EMPTY_GAP_DRAFT,
  EMPTY_SAVED_LINE_DRAFT,
  buildEvidenceSaveBody,
  decisionKind,
  gapDraftComplete,
  resumeLines,
  savedLineDraftComplete,
  type GapChoice,
  type GapDraft,
  type SavedLineDraft
} from "@/lib/jobs/tailor-decisions";

// Read once by JobWorkspace after the refresh, so the "ready" notice survives the reload.
export function documentsCreatedKey(jobId: string) {
  return `apply-pilot:documents-created:${jobId}`;
}

export type TailorFlowProps = {
  jobId: string;
  // null when there is no master résumé yet.
  review: EvidenceCorrectionReview | null;
  hasValidCurrentSnapshot: boolean;
  // Gaps from a shown estimate that cannot back a new review save (see lib/jobs/fit-estimate.ts).
  readOnlyGaps: string[];
  quote: DocumentCreationQuote | null;
  generationAvailable: boolean;
  hasDocuments: boolean;
  onPendingFactChanges?: (pending: boolean) => void;
  // Optional: let the page own the outcome message, so it survives this component being
  // remounted when the page refreshes with a new review.
  message?: TailorFlowMessage | null;
  onMessage?: (message: TailorFlowMessage | null) => void;
};

export type TailorFlowMessage = { tone: "success" | "error" | "info"; text: string };

// Identity of the review the gap answers are drafted against. When it changes (a save, a new
// score, another tab), drafts must start over.
export function tailorReviewIdentity(review: EvidenceCorrectionReview | null, hasValidCurrentSnapshot: boolean) {
  if (!review) return "no-resume";
  return [review.analysisId ?? "unscored", review.resumeUpdatedAt, hasValidCurrentSnapshot ? "saved" : "unsaved",
    ...review.gaps.map((gap) => gap.id + gap.requirement), ...review.acceptedFacts.map((fact) => fact.factId)].join("|");
}

type StepState = "pending" | "running" | "done" | "failed";

const STEP_LABELS: Record<DocumentCreationStep, string> = {
  save: "Saving your answers",
  rescore: "Updating your fit estimate",
  resume: "Writing your tailored résumé",
  cover: "Writing your cover letter"
};

const DONE_PHRASES: Record<DocumentCreationStep, string> = {
  save: "Your answers were saved.",
  rescore: "Your fit estimate was updated.",
  resume: "Your résumé was created.",
  cover: "Your cover letter was created."
};

const ENDPOINTS: Record<Exclude<DocumentCreationStep, "save">, string> = {
  rescore: "match",
  resume: "tailored-resume",
  cover: "cover-letter"
};

type ErrorPayload = { error?: string; billingStatus?: string; actualCostMicros?: number } | null;

function describeFailure(json: ErrorPayload, fallback: string) {
  const parts = [typeof json?.error === "string" ? json.error : fallback];
  if (json?.billingStatus === "not_charged") parts.push("You weren't charged for this step.");
  if (json?.billingStatus === "uncertain") parts.push("The charge for this step is uncertain; check AI usage before trying again.");
  if (json?.billingStatus === "known" && typeof json.actualCostMicros === "number" && json.actualCostMicros >= 0) {
    parts.push(`Recorded cost: ${formatUsdMicros(json.actualCostMicros)}.`);
  }
  return parts.join(" ");
}

const CHOICES: Array<[GapChoice, string]> = [
  ["skip", "Skip"],
  ["add", "I have this — add a line"],
  ["onResume", "It's already on my résumé"]
];

export function TailorFlow({
  jobId,
  review,
  hasValidCurrentSnapshot,
  readOnlyGaps,
  quote,
  generationAvailable,
  hasDocuments,
  onPendingFactChanges,
  message: ownedMessage,
  onMessage
}: TailorFlowProps) {
  const router = useRouter();
  const [gapDrafts, setGapDrafts] = useState<Record<string, GapDraft>>({});
  const [lineDrafts, setLineDrafts] = useState<Record<string, SavedLineDraft>>({});
  const [includeCover, setIncludeCover] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Array<{ step: DocumentCreationStep; state: StepState }>>([]);
  const [localMessage, setLocalMessage] = useState<TailorFlowMessage | null>(null);
  const message = onMessage ? ownedMessage ?? null : localMessage;
  const setMessage = onMessage ?? setLocalMessage;
  const requestId = useRef<string | null>(null);

  const reviewable = Boolean(review?.analysisId);
  const lines = useMemo(() => (review ? resumeLines(review) : []), [review]);
  const gapDraft = (id: string) => gapDrafts[id] ?? EMPTY_GAP_DRAFT;
  const lineDraft = (id: string) => lineDrafts[id] ?? EMPTY_SAVED_LINE_DRAFT;
  const decisionKinds = (review?.gaps ?? []).map((gap) => decisionKind(gapDraft(gap.id)));
  const acceptedActions = (review?.acceptedFacts ?? []).map((fact) => lineDraft(fact.factId).action);
  const plan = planDocumentCreation({
    hasValidCurrentSnapshot,
    reviewable,
    includeCoverLetter: includeCover,
    decisionKinds,
    acceptedFactActions: acceptedActions
  });
  const pendingFactChanges = decisionKinds.some((kind) => kind !== "UNRESOLVED") || acceptedActions.some((action) => action !== "RETAIN");
  const draftsComplete = (review?.gaps ?? []).every((gap) => gapDraftComplete(gapDraft(gap.id))) &&
    (review?.acceptedFacts ?? []).every((fact) => savedLineDraftComplete(lineDraft(fact.factId)));
  const canCreate = Boolean(review) && plan.ok && draftsComplete && generationAvailable && !running;
  const createLabel = hasDocuments ? "Create new versions" : includeCover ? "Create my résumé and cover letter" : "Create my résumé";

  useEffect(() => {
    onPendingFactChanges?.(pendingFactChanges);
  }, [onPendingFactChanges, pendingFactChanges]);

  function changed() {
    requestId.current = null;
    setMessage(null);
  }

  function updateGap(id: string, patch: Partial<GapDraft>) {
    changed();
    setGapDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_GAP_DRAFT), ...patch } }));
  }

  function updateLine(id: string, patch: Partial<SavedLineDraft>) {
    changed();
    setLineDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_SAVED_LINE_DRAFT), ...patch } }));
  }

  async function create() {
    if (!review || !plan.ok || !canCreate) return;
    const steps = plan.steps;
    if (quote && !window.confirm(documentCreationConfirmation(steps, quote))) {
      setMessage({ tone: "info", text: "Canceled. Nothing was sent and nothing was charged." });
      return;
    }
    setRunning(true);
    setMessage(null);
    setProgress(steps.map((step) => ({ step, state: "pending" })));
    const mark = (index: number, state: StepState) =>
      setProgress((current) => current.map((item, position) => (position === index ? { ...item, state } : item)));
    const completed: DocumentCreationStep[] = [];
    try {
      for (const [index, step] of steps.entries()) {
        mark(index, "running");
        if (step === "save") {
          requestId.current ??= crypto.randomUUID();
          const response = await fetch(`/api/jobs/${jobId}/evidence-snapshots`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildEvidenceSaveBody(review, gapDrafts, lineDrafts, requestId.current))
          });
          const json: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(describeFailure(json as ErrorPayload, "Your answers couldn't be saved."));
          const saved = evidenceSnapshotSaveResponseSchema.parse(json);
          if (!saved.snapshot.isCurrent) {
            throw new Error("These answers were saved earlier and have since been replaced. Reload the page and try again.");
          }
        } else {
          const url = `/api/jobs/${jobId}/${ENDPOINTS[step]}`;
          const response = quote
            ? await fetchWithApprovedAiCost(url, { method: "POST" }, stepMaximumMicros(step, quote))
            : await fetchWithAiCostConfirmation(url, { method: "POST" });
          if (!response.ok) {
            const json = (await response.json().catch(() => null)) as ErrorPayload;
            throw new Error(describeFailure(json, `${STEP_LABELS[step]} failed.`));
          }
        }
        completed.push(step);
        mark(index, "done");
      }
      setMessage({
        tone: "success",
        text: steps.includes("cover")
          ? "Your résumé and cover letter are ready to review below."
          : "Your résumé is ready to review below."
      });
      setGapDrafts({});
      setLineDrafts({});
      requestId.current = null;
      try {
        window.sessionStorage.setItem(documentsCreatedKey(jobId), steps.includes("cover") ? "both" : "resume");
      } catch {}
      router.refresh();
    } catch (error) {
      setProgress((current) => current.map((item) => (item.state === "running" ? { ...item, state: "failed" } : item)));
      const done = completed.map((step) => DONE_PHRASES[step]).join(" ");
      setMessage({ tone: "error", text: [done, error instanceof Error ? error.message : "Something went wrong."].filter(Boolean).join(" ") });
      if (completed.length) {
        if (completed.includes("save")) {
          setGapDrafts({});
          setLineDrafts({});
          requestId.current = null;
        }
        router.refresh();
      }
    } finally {
      setRunning(false);
    }
  }

  const maximum = plan.ok && quote ? documentCreationMaximumMicros(plan.steps, quote) : null;
  const blockedReason = !review
    ? "Add your master résumé first, so Apply Pilot has facts to work from."
    : !generationAvailable
      ? "Document writing is switched off on this server (no AI provider is configured)."
      : !plan.ok
        ? plan.reason === "SCORE_FIRST"
          ? "Score this job first, so Apply Pilot can see what it asks for."
          : "Check this job again before adding lines, so your answers match its current gaps."
        : !draftsComplete
          ? "Finish each line you started (with the confirmation box ticked), or set it back to Skip."
          : null;

  return (
    <div className="job-tailor" data-tailor-flow>
      {!review ? (
        <p className="job-note">
          Apply Pilot needs your master résumé before it can compare it with this job.{" "}
          <Link className="job-inline-link" href="/resumes">Add your résumé</Link>
        </p>
      ) : !reviewable && !hasValidCurrentSnapshot ? (
        <div className="job-callout" data-unscored>
          <p className="job-callout-title">Score this job first</p>
          <p>Apply Pilot compares your résumé with the posting, line by line, and shows what you have and what isn&apos;t on your résumé. Use <strong>Score this job</strong> in the match card. It uses Google Gemini and asks you to confirm the cost first.</p>
        </div>
      ) : null}

      {review && review.gaps.length ? (
        <section aria-labelledby="gaps-heading" className="job-step">
          <h3 id="gaps-heading" className="job-step-title">Anything missing? <span className="job-step-optional">Optional</span></h3>
          <p className="job-step-copy">
            These requirements aren&apos;t shown on your résumé. That doesn&apos;t mean you lack them. If you have one, add a line in your own words, or point to the résumé line that already shows it. Lines you add are used for this job only and never change your master résumé.
          </p>
          <fieldset disabled={running} className="job-gap-list">
            {review.gaps.map((gap) => {
              const draft = gapDraft(gap.id);
              return (
                <fieldset key={gap.id} className="job-gap" data-gap={gap.id}>
                  <legend className="job-gap-requirement">{gap.requirement}</legend>
                  <div className="job-gap-choices" role="radiogroup" aria-label={`What to do about: ${gap.requirement}`}>
                    {CHOICES.map(([value, label]) => (
                      <label key={value} className="job-choice" data-checked={draft.choice === value}>
                        <input
                          type="radio"
                          name={`gap-${gap.id}`}
                          value={value}
                          checked={draft.choice === value}
                          onChange={() => updateGap(gap.id, { choice: value })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  {draft.choice === "add" ? (
                    <div className="job-gap-detail">
                      <label className="job-field">
                        Your line for this requirement
                        <textarea
                          rows={2}
                          value={draft.line}
                          placeholder="Say what you did, as it should read on your résumé."
                          onChange={(event) => updateGap(gap.id, { line: event.target.value })}
                        />
                      </label>
                      <label className="job-check">
                        <input type="checkbox" checked={draft.attested} onChange={(event) => updateGap(gap.id, { attested: event.target.checked })} />
                        This is true. I&apos;m adding it myself; it isn&apos;t in my résumé yet.
                      </label>
                    </div>
                  ) : null}
                  {draft.choice === "onResume" ? (
                    <div className="job-gap-detail">
                      <label className="job-field">
                        Choose the résumé line that shows it
                        <select value={draft.resumeLine} onChange={(event) => updateGap(gap.id, { resumeLine: event.target.value })}>
                          <option value="">Choose a line…</option>
                          {lines.map((line) => <option key={line} value={line}>{line}</option>)}
                        </select>
                      </label>
                      <p className="job-hint">Apply Pilot uses the line exactly as written on your résumé.</p>
                    </div>
                  ) : null}
                </fieldset>
              );
            })}
          </fieldset>
        </section>
      ) : review && reviewable ? (
        <p className="job-note">Every requirement Apply Pilot checked is shown on your résumé. Nothing to add.</p>
      ) : null}

      {review && !reviewable && readOnlyGaps.length ? (
        <section aria-labelledby="gaps-heading" className="job-step">
          <h3 id="gaps-heading" className="job-step-title">Not shown on your résumé</h3>
          <ul className="job-plain-list">{readOnlyGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
          <p className="job-step-copy">You skipped these last time. To add a line for one, check this job again first.</p>
          <ScoreJobButton jobId={jobId} label="Check this job again" variant="secondary" disabled={running} />
        </section>
      ) : null}

      {review && review.acceptedFacts.length ? (
        <section aria-labelledby="saved-lines-heading" className="job-step">
          <h3 id="saved-lines-heading" className="job-step-title">Lines you&apos;ve added for this job</h3>
          <fieldset disabled={running} className="job-gap-list">
            {review.acceptedFacts.map((fact) => {
              const draft = lineDraft(fact.factId);
              return (
                <fieldset key={fact.factId} className="job-gap" data-saved-line={fact.factId}>
                  <legend className="job-gap-requirement">{fact.fact}</legend>
                  <p className="job-hint">{fact.provenance.kind === "EXISTING_SOURCE" ? "From your résumé" : "Added by you"}</p>
                  <div className="job-gap-choices" role="radiogroup" aria-label={`Keep or change: ${fact.fact}`}>
                    {([["RETAIN", "Keep"], ["REMOVE", "Remove"], ["REPLACE_OWNER_ATTESTATION", "Change"]] as const).map(([value, label]) => (
                      <label key={value} className="job-choice" data-checked={draft.action === value}>
                        <input type="radio" name={`line-${fact.factId}`} value={value} checked={draft.action === value} onChange={() => updateLine(fact.factId, { action: value })} />
                        {label}
                      </label>
                    ))}
                  </div>
                  {draft.action === "REPLACE_OWNER_ATTESTATION" ? (
                    <div className="job-gap-detail">
                      <label className="job-field">
                        New line
                        <textarea rows={2} value={draft.line} onChange={(event) => updateLine(fact.factId, { line: event.target.value })} />
                      </label>
                      <label className="job-check">
                        <input type="checkbox" checked={draft.attested} onChange={(event) => updateLine(fact.factId, { attested: event.target.checked })} />
                        This is true. I&apos;m adding it myself; it isn&apos;t in my résumé yet.
                      </label>
                    </div>
                  ) : null}
                </fieldset>
              );
            })}
          </fieldset>
        </section>
      ) : null}

      {review ? (
        <details className="job-disclosure">
          <summary>See everything Apply Pilot read from your résumé ({review.facts.length})</summary>
          <ul className="job-fact-list" data-extracted-facts>
            {review.facts.map((fact) => (
              <li key={fact.id}><span className="job-fact-label">{fact.label}</span><span className="job-fact-value">{fact.value}</span></li>
            ))}
          </ul>
        </details>
      ) : null}

      <section aria-labelledby="create-heading" className="job-step job-create">
        <h3 id="create-heading" className="job-step-title">Create your documents</h3>
        <p className="job-step-copy">
          Apply Pilot writes a résumé{includeCover ? " and cover letter" : ""} for this job using only facts from your résumé and the lines you approved above. You review and edit them next. Nothing is sent to the employer.
        </p>
        <label className="job-check">
          <input type="checkbox" checked={includeCover} disabled={running} onChange={(event) => { changed(); setIncludeCover(event.target.checked); }} />
          Include a cover letter
        </label>
        <div className="job-create-row">
          <button type="button" className="job-button job-button-primary job-button-large" onClick={create} disabled={!canCreate}>
            {running ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
            {createLabel}
          </button>
          {maximum !== null ? (
            <p className="job-hint">One confirmation · at most {formatUsdCentsCeiling(maximum)} in AI costs, usually less.</p>
          ) : !quote && review ? (
            <p className="job-hint">Each AI step asks you to confirm its cost.</p>
          ) : null}
        </div>
        {blockedReason ? <p className="job-hint" data-blocked-reason>{blockedReason}</p> : null}
        {progress.length ? (
          <ol className="job-progress" aria-label="Progress">
            {progress.map(({ step, state }) => (
              <li key={step} data-state={state}>
                {state === "done" ? <CheckCircle2 size={16} aria-hidden="true" /> : state === "running" ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : state === "failed" ? <XCircle size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                <span>{STEP_LABELS[step]}</span>
                <span className="sr-only">{state === "done" ? " — done" : state === "running" ? " — in progress" : state === "failed" ? " — failed" : ""}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`job-message job-message-${message.tone}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
