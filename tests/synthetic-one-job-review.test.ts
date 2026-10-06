import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { SyntheticOneJobReview } from "@/components/synthetic-one-job-review";
import { SYNTHETIC_ONE_JOB_FIXTURE } from "@/evaluation/synthetic-one-job-fixture";
import { renderGenericDocument } from "@/lib/documents/export-renderer";
import { defaultResumeFormat } from "@/lib/documents/resume-format";
import {
  buildSyntheticReviewSnapshot,
  validateSyntheticReview
} from "@/lib/jobs/synthetic-one-job-review";

test("synthetic review contract requires every material answer and source-backed change", () => {
  const incomplete = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    answers: [{ questionId: "independent-and-team-work", answer: "yes", evidence: "" }]
  });
  assert.deepEqual(incomplete.map((issue) => issue.path), [
    "answers.independent-and-team-work.evidence",
    "answers.work-authorization"
  ]);

  const unsupported = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    changes: [{ id: "change-1", summary: "Added a claim.", sourceRefs: [], sourceExcerpts: [] }],
    answers: SYNTHETIC_ONE_JOB_FIXTURE.review.questions.map((question) => ({
      questionId: question.id,
      answer: "no" as const,
      evidence: ""
    }))
  });
  assert.deepEqual(unsupported.map((issue) => issue.path), ["changes.change-1.sourceRefs"]);

  const reordered = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    answers: [...SYNTHETIC_ONE_JOB_FIXTURE.review.answers].reverse().map((answer) => ({
      ...answer,
      answer: "no" as const
    }))
  });
  assert.deepEqual(reordered.map((issue) => issue.path), ["answers"]);

  const unsupportedEdit = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    resumeText: "Invented executive claim",
    answers: SYNTHETIC_ONE_JOB_FIXTURE.review.answers.map((answer) => ({ ...answer, answer: "no" as const }))
  });
  assert.deepEqual(unsupportedEdit.map((issue) => issue.path), ["resumeText"]);

  const unvalidatedSelection = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    selectedCoverLetterId: "unvalidated-cover",
    answers: SYNTHETIC_ONE_JOB_FIXTURE.review.answers.map((answer) => ({ ...answer, answer: "no" as const }))
  });
  assert.deepEqual(unvalidatedSelection.map((issue) => issue.path), ["selectedCoverLetterId"]);

  const authorizationYesNeedsNoInventedNarrative = validateSyntheticReview({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    answers: SYNTHETIC_ONE_JOB_FIXTURE.review.answers.map((answer) => ({
      ...answer,
      answer: "yes" as const,
      evidence: answer.questionId === "independent-and-team-work" ? "Led a launch independently, then paired with support." : ""
    }))
  });
  assert.deepEqual(authorizationYesNeedsNoInventedNarrative, []);
});

test("exact synthetic approval snapshot changes for document, selection, or answer edits", () => {
  const base = buildSyntheticReviewSnapshot(SYNTHETIC_ONE_JOB_FIXTURE.review);
  assert.notEqual(buildSyntheticReviewSnapshot({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    resumeText: `${SYNTHETIC_ONE_JOB_FIXTURE.review.resumeText}\nEdited`
  }), base);
  assert.notEqual(buildSyntheticReviewSnapshot({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    selectedCoverLetterId: "different-cover"
  }), base);
  assert.notEqual(buildSyntheticReviewSnapshot({
    ...SYNTHETIC_ONE_JOB_FIXTURE.review,
    answers: SYNTHETIC_ONE_JOB_FIXTURE.review.answers.map((answer, index) =>
      index === 0 ? { ...answer, answer: "not_sure" as const } : answer)
  }), base);
});

test("one-job surface separates match, eligibility, and document approval with secondary technical detail", () => {
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const html = renderToStaticMarkup(React.createElement(
    AppRouterContext.Provider,
    { value: router as never },
    React.createElement(SyntheticOneJobReview, { fixture: SYNTHETIC_ONE_JOB_FIXTURE })
  ));
  assert.match(html, /Synthetic local review only/i);
  assert.match(html, /Application packet/);
  assert.match(html, /Experience match/);
  assert.match(html, /Eligibility not confirmed/);
  assert.match(html, /Exact document review/);
  assert.match(html, /Independent and team delivery/);
  assert.match(html, /Work authorization/);
  assert.match(html, /Review supporting evidence/);
  assert.match(html, /Edit document text/);
  assert.match(html, /Formatted resume/);
  assert.match(html, /Formatted cover letter/);
  assert.doesNotMatch(html, /82% fit|apply now|ATS unscored|CRM|resume\.skills\[|job\.requirements\[|Open apply link|I applied|evaluator|profile preferences/i);
  assert.doesNotMatch(SYNTHETIC_ONE_JOB_FIXTURE.review.coverLetterText, /source résumé|explicit applicant attestations|work authorization/i);
  assert.match(SYNTHETIC_ONE_JOB_FIXTURE.review.resumeText, /Los Angeles \| synthetic@example\.test/);
  assert.match(SYNTHETIC_ONE_JOB_FIXTURE.review.coverLetterText, /I led synthetic customer discovery and technical demonstrations and built source-backed workflows with TypeScript and SQL\./);
  assert.doesNotMatch(SYNTHETIC_ONE_JOB_FIXTURE.review.coverLetterText, /Long Beach|I lead|I build|I also created/i);
});

test("existing PDF export renderer preserves both reviewed synthetic documents", async () => {
  const { review } = SYNTHETIC_ONE_JOB_FIXTURE;
  const resumePdf = await renderGenericDocument({
    content: review.resumeText,
    format: "pdf",
    resumeFormat: defaultResumeFormat
  });
  const resumeExportText = resumePdf.toString("utf8");
  assert.match(resumeExportText, /Bachelor of Arts in Business Administration/);
  assert.match(resumeExportText, /Synthetic evidence workspace/);

  const coverPdf = await renderGenericDocument({
    content: `Synthetic Laserfiche Cover Letter\n\n${review.coverLetterText}`,
    format: "pdf",
    resumeFormat: defaultResumeFormat
  });
  const coverExportText = coverPdf.toString("utf8");
  assert.match(coverExportText, /Synthetic Laserfiche Cover Letter/);
  assert.match(coverExportText, /customer discovery/);
  assert.match(coverExportText, /technical demonstrations/);
  assert.doesNotMatch(coverExportText, /source résumé|explicit applicant attestations|work authorization/i);
});
