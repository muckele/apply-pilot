"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Pencil, RotateCcw, ShieldAlert } from "lucide-react";

import { ApplyPacketBuilder } from "@/components/apply-packet-builder";
import { FormattedDocumentPreview } from "@/components/formatted-document-preview";
import { PrimaryButton } from "@/components/ui";
import type { SyntheticOneJobFixture } from "@/evaluation/synthetic-one-job-fixture";
import {
  buildSyntheticReviewSnapshot,
  validateSyntheticReview,
  type SyntheticAnswerValue,
  type SyntheticReviewState
} from "@/lib/jobs/synthetic-one-job-review";

export function SyntheticOneJobReview({ fixture }: { fixture: SyntheticOneJobFixture }) {
  const [review, setReview] = useState<SyntheticReviewState>(fixture.review);
  const [approvedSnapshot, setApprovedSnapshot] = useState<string | null>(null);
  const [approvalAttempted, setApprovalAttempted] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const currentSnapshot = useMemo(() => buildSyntheticReviewSnapshot(review), [review]);
  const issues = useMemo(() => validateSyntheticReview(review), [review]);
  const approved = approvedSnapshot === currentSnapshot;
  const invalidated = approvedSnapshot !== null && !approved;
  const documentChanged = review.selectedResumeId !== review.validatedBaseline.resumeId
    || review.selectedCoverLetterId !== review.validatedBaseline.coverLetterId
    || review.resumeText !== review.validatedBaseline.resumeText
    || review.coverLetterText !== review.validatedBaseline.coverLetterText;
  const unansweredCount = review.answers.filter((answer) =>
    !answer.answer || answer.answer === "not_sure" || answer.answer === "skip").length;
  const gapCount = review.answers.filter((answer) => answer.answer === "no").length;
  const workAuthorization = review.answers.find((answer) => answer.questionId === "work-authorization")?.answer;
  const documentState = documentChanged
    ? "documents-changed"
    : approved
      ? "approved"
      : invalidated
        ? "review-changed"
        : "awaiting";
  const suitability = workAuthorization === "no"
    ? {
        label: "Not eligible for this role",
        detail: "Work authorization is a required condition for this posting. Document review can continue, but this is not an apply recommendation."
      }
    : unansweredCount > 0
      ? {
          label: "Eligibility not confirmed",
          detail: "Answer the remaining applicant questions before deciding whether this role is suitable."
        }
      : gapCount > 0
        ? {
            label: "A requirement is not demonstrated",
            detail: "The documents can still be reviewed, but the applicant answer shows a requirement gap."
          }
        : {
            label: "Applicant answers complete",
            detail: "Experience evidence and applicant answers are complete. This still does not authorize an application."
          };

  function updateAnswer(questionId: string, update: { answer?: SyntheticAnswerValue; evidence?: string }) {
    setReview((current) => ({
      ...current,
      answers: current.answers.map((answer) => {
        if (answer.questionId !== questionId) return answer;
        const next = { ...answer, ...update };
        return update.answer && update.answer !== "yes" ? { ...next, evidence: "" } : next;
      })
    }));
  }

  function approve() {
    setApprovalAttempted(true);
    if (issues.length === 0) setApprovedSnapshot(currentSnapshot);
  }

  function restoreValidatedDocuments() {
    setReview((current) => ({
      ...current,
      selectedResumeId: current.validatedBaseline.resumeId,
      selectedCoverLetterId: current.validatedBaseline.coverLetterId,
      resumeText: current.validatedBaseline.resumeText,
      coverLetterText: current.validatedBaseline.coverLetterText
    }));
    setApprovalAttempted(false);
    setIsEditing(false);
  }

  return (
    <div className="product-page product-page-themed space-y-6" data-synthetic-one-job-review>
      <header className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 shrink-0" size={22} aria-hidden="true" />
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em]">Synthetic local review only</p>
            <h1 className="mt-2 text-2xl font-semibold">{fixture.job.company} · {fixture.job.title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6">Public fixture data and in-memory state only. Document approval here never grants permission to apply or submit.</p>
          </div>
        </div>
      </header>

      <section className="product-surface overflow-hidden rounded-xl border bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Application packet</h2>
          <p className="mt-1 text-sm text-slate-600">{fixture.job.location} · {fixture.job.workArrangement} · {fixture.job.compensation}</p>
        </div>
        <ApplyPacketBuilder
          previewMode="synthetic-local"
          job={{ ...fixture.job, applyUrl: "" }}
          resumeVersions={[{
            id: review.selectedResumeId,
            title: "Laserfiche tailored resume — synthetic",
            atsCompatibility: null,
            jobFitScore: fixture.job.fitScore,
            createdAt: "2026-10-05T17:00:00.000Z"
          }]}
          coverLetters={[{
            id: review.selectedCoverLetterId,
            title: "Laserfiche cover letter — synthetic",
            createdAt: "2026-10-05T17:00:00.000Z"
          }]}
          application={null}
          syntheticReview={{
            supportedCount: fixture.supportedRequirements.length,
            unresolvedCount: unansweredCount,
            gapCount,
            suitabilityLabel: suitability.label,
            suitabilityDetail: suitability.detail,
            documentState
          }}
        />
      </section>

      <section className="product-surface rounded-xl border bg-white p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">Application suitability</h2>
        <p className="mt-1 text-sm text-slate-600">Answer these applicant-only questions. Résumé silence is never treated as Yes.</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {review.questions.map((question) => {
            const answer = review.answers.find((entry) => entry.questionId === question.id);
            return (
              <fieldset key={question.id} data-synthetic-question className="rounded-lg border border-slate-200 p-4">
                <legend className="px-1 text-sm font-semibold text-slate-950">{question.title}</legend>
                <p className="mt-1 text-sm leading-6 text-slate-700">{question.question}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{question.whyItMatters}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(["yes", "no", "not_sure", "skip"] as const).map((value) => (
                    <label key={value} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                      <input
                        type="radio"
                        name={`answer-${question.id}`}
                        value={value}
                        checked={answer?.answer === value}
                        onChange={() => updateAnswer(question.id, { answer: value })}
                      />
                      {value === "not_sure" ? "Not sure" : value === "skip" ? "Skip" : value[0].toUpperCase() + value.slice(1)}
                    </label>
                  ))}
                </div>
                {answer?.answer === "yes" && question.yesEvidencePrompt ? <label className="mt-3 block text-xs font-medium text-slate-700">
                  {question.yesEvidencePrompt}
                  <textarea
                    value={answer?.evidence ?? ""}
                    onChange={(event) => updateAnswer(question.id, { evidence: event.target.value })}
                    rows={3}
                    className="mt-1 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label> : null}
              </fieldset>
            );
          })}
        </div>
      </section>

      <section className="product-surface rounded-xl border bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Exact document review</h2>
            <p className="mt-1 text-sm text-slate-600">Review the employer-facing pages. Formatting estimates are previews; export acceptance is outside this demo.</p>
          </div>
          {!isEditing ? <PrimaryButton type="button" className="min-h-11" onClick={() => setIsEditing(true)}>
            <Pencil className="mr-2" size={15} aria-hidden="true" /> Edit document text
          </PrimaryButton> : null}
        </div>
        <div className="mt-5 grid gap-6 xl:grid-cols-2">
          <FormattedDocumentPreview text={review.resumeText} title="Formatted resume" />
          <FormattedDocumentPreview text={review.coverLetterText} title="Formatted cover letter" />
        </div>
        {isEditing ? <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-amber-950">Editing invalidates document approval</h3>
              <p className="mt-1 text-xs leading-5 text-amber-900">This local demo can approve only the validated fixture text. Restore it to recover the reviewed state.</p>
            </div>
            {documentChanged ? <PrimaryButton type="button" className="min-h-11 shrink-0" onClick={restoreValidatedDocuments}>
              <RotateCcw className="mr-2" size={15} aria-hidden="true" /> Restore validated documents
            </PrimaryButton> : null}
          </div>
          <div className="mt-4 grid gap-5 xl:grid-cols-2">
            <div>
              <label className="text-sm font-semibold text-slate-800" htmlFor="synthetic-resume-text">Tailored resume text</label>
              <textarea id="synthetic-resume-text" aria-label="Synthetic tailored resume" value={review.resumeText} onChange={(event) => setReview((current) => ({ ...current, resumeText: event.target.value }))} rows={18} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-3 font-mono text-sm leading-6" />
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-800" htmlFor="synthetic-cover-text">Cover letter text</label>
              <textarea id="synthetic-cover-text" aria-label="Synthetic cover letter" value={review.coverLetterText} onChange={(event) => setReview((current) => ({ ...current, coverLetterText: event.target.value }))} rows={18} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-3 font-mono text-sm leading-6" />
            </div>
          </div>
        </div> : null}
      </section>

      <details className="product-surface rounded-xl border bg-white">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-900 sm:px-5">
          <span>Review supporting evidence</span>
          <span className="text-xs font-normal text-slate-500">{fixture.supportedRequirements.length} matches · {review.changes.length} document changes</span>
        </summary>
        <div className="space-y-5 border-t border-slate-200 p-4 sm:p-5">
          <div className="grid gap-3 lg:grid-cols-2">
            {fixture.supportedRequirements.map((entry) => (
              <article key={entry.requirement} className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <h3 className="text-sm font-semibold text-emerald-950">{entry.requirement}</h3>
                <p className="mt-2 text-sm leading-6 text-emerald-900">{entry.rationale}</p>
                <p className="mt-2 text-xs text-emerald-800">Evidence: {entry.evidence.join(" · ")}</p>
              </article>
            ))}
          </div>
          <div className="space-y-3">
            {review.changes.map((change) => (
              <article key={change.id} className="rounded-lg border border-slate-200 p-4">
                <h3 className="text-sm font-semibold text-slate-950">{change.summary}</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {change.sourceExcerpts.map((excerpt) => <li key={excerpt}>{excerpt}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </details>

      <section className="product-surface rounded-xl border bg-white p-5" aria-live="polite">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Local exact-document approval</h2>
            {approved ? (
              <p className="mt-1 flex items-center gap-2 text-sm font-medium text-emerald-700">
                <CheckCircle2 size={16} aria-hidden="true" /> Exact synthetic documents approved locally.
              </p>
            ) : invalidated ? (
              <p className="mt-1 text-sm font-medium text-amber-800">
                {documentChanged
                  ? "Document review changed. Restore the validated documents to recover the previous approval."
                  : "Review changed. Recheck the updated applicant answers before approving again."}
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-600">Nothing is stored. Review and answer both material questions.</p>
            )}
          </div>
          {approved || (documentChanged && isEditing) ? null : documentChanged ? (
            <PrimaryButton type="button" className="min-h-11" onClick={restoreValidatedDocuments}>
              <RotateCcw className="mr-2" size={15} aria-hidden="true" /> Restore validated documents
            </PrimaryButton>
          ) : (
            <PrimaryButton type="button" className="min-h-11" onClick={approve}>
              {invalidated ? "Approve updated review" : "Approve exact synthetic documents"}
            </PrimaryButton>
          )}
        </div>
        {approvalAttempted && issues.length > 0 ? (
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-rose-700">
            {issues.map((issue) => <li key={issue.path}>{issue.message}</li>)}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
