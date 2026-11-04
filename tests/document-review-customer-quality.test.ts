import assert from "node:assert/strict";
import test from "node:test";
import { getCoverLetterUncitedLines, validateCoverLetterClaims } from "@/lib/ai/application-document-claims";
import { correctionFlowDocumentReviewHtml } from "@/lib/ai/correction-flow-document-review-page";
import { syntheticCorrectionFlowDocumentPayload, syntheticCoverLetterOutput } from "@/evaluation/correction-flow-provider-stub";
import { assembleCoverLetterProviderOutput } from "@/lib/ai/application-document-facts";

test("cover-letter context reaches coaching and SQL requirements without granting applicant qualifications", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const lines = getCoverLetterUncitedLines(payload);
  assert.ok(lines.includes("Your posting highlights experience coaching service operations professionals."));
  assert.ok(lines.includes("Your posting highlights working knowledge of SQL and operational workflow automation."));
  assert.ok(lines.includes("I am applying for the Service Operations Director position at Northwind Service Cloud."));
  const letter = assembleCoverLetterProviderOutput(payload, syntheticCoverLetterOutput());
  assert.throws(() => validateCoverLetterClaims(payload, {
    ...letter, coverLetter: letter.coverLetter + "\nI meet every requirement in your posting."
  }));
});

test("customer review supplies a full readable staged workspace and the application's theme preference", () => {
  const html = correctionFlowDocumentReviewHtml({reviewPath:"/review/t",statePath:"/state/t",submissionPath:"/submit/t",cancelPath:"/cancel/t",resumePdfPath:"/resume.pdf",coverLetterPdfPath:"/letter.pdf"});
  assert.match(html, /Background and target job/u);
  assert.match(html, /Missing-fact corrections/u);
  assert.match(html, /Tailored documents/u);
  assert.match(html, /Expand master résumé/u);
  assert.match(html, /Appearance/u);
  assert.match(correctionFlowDocumentReviewHtml.javascript, /apply-pilot-theme/u);
  assert.match(correctionFlowDocumentReviewHtml.javascript, /addEventListener\('change'/u);
  assert.doesNotMatch(correctionFlowDocumentReviewHtml.css, /grid-template-columns: 320px/u);
});
