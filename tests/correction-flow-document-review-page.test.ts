import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCorrectionFlowDocumentReviewEnvelope
} from "@/lib/ai/correction-flow-document-review-contract";
import {
  buildCorrectionFlowDocumentReviewView,
  correctionFlowDocumentReviewHtml
} from "@/lib/ai/correction-flow-document-review-page";
import { ownerReviewSecurityHeaders } from "@/lib/ai/local-owner-review-http";

const hash = (character: string) => character.repeat(64);

const paths = {
  reviewPath: "/review/token",
  statePath: "/api/state/token",
  submissionPath: "/api/review/token",
  cancelPath: "/api/cancel/token",
  resumePdfPath: `/artifacts/token/resume/${hash("9")}.pdf`,
  coverLetterPdfPath: `/artifacts/token/cover-letter/${hash("b")}.pdf`
} as const;

function envelope() {
  return buildCorrectionFlowDocumentReviewEnvelope({
    manifestHash: hash("1"),
    exactHead: "a".repeat(40),
    payloadHash: hash("2"),
    sourceResumeHash: hash("3"),
    profileHash: hash("4"),
    jobProjectionHash: hash("5"),
    reviewedEvidenceHash: hash("6"),
    factCatalogHash: hash("7"),
    promptVersion: "7",
    model: "gemini-3.8-flash",
    thinkingLevel: "LOW",
    generationId: "generation-review-page",
    documents: [
      { kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: hash("9") },
      { kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: hash("b") }
    ]
  });
}

test("the local page presents both exact PDFs, assembled text, evidence, and required bounded attestations", () => {
  const view = buildCorrectionFlowDocumentReviewView({
    envelope: envelope(),
    documents: [
      {
        kind: "resume",
        title: "Synthetic tailored resume",
        text: "Taylor Boundary\nSUMMARY\nValidated synthetic resume line.",
        evidence: [{ claim: "Validated synthetic resume line.", citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: "Source-bound synthetic fact." }] }]
      },
      {
        kind: "cover_letter",
        title: "Synthetic cover letter",
        text: "Dear Synthetic Employer Hiring Team,\n\nValidated synthetic cover-letter line.",
        evidence: [{ claim: "Validated synthetic cover-letter line.", citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: "Source-bound synthetic fact." }] }]
      }
    ],
    paths
  });
  assert.equal(view.envelopeHash, envelope().envelopeHash);
  assert.deepEqual(view.documents.map((document) => document.kind), ["resume", "cover_letter"]);
  assert.equal(view.documents[0].pages.flat().includes("Validated synthetic resume line."), true);
  assert.equal(view.documents[1].pages.flat().includes("Validated synthetic cover-letter line."), true);
  assert.equal(view.documents[0].pdfPath, paths.resumePdfPath);
  assert.equal(view.documents[1].pdfPath, paths.coverLetterPdfPath);

  const html = correctionFlowDocumentReviewHtml(paths);
  assert.match(html, /data-document-review-page/u);
  assert.match(html, /data-document-card="resume"/u);
  assert.match(html, /data-document-card="cover_letter"/u);
  assert.match(html, /data-document-pdf="resume"/u);
  assert.match(html, /data-document-pdf="cover_letter"/u);
  assert.match(html, /Review every PDF page/u);
  assert.match(html, /Review the writing quality/u);
  assert.match(html, /Review the visual layout/u);
  assert.match(html, /Approve exact document/u);
  assert.match(html, /Needs revision/u);
  assert.match(html, /Submit both review decisions/u);
  assert.match(html, /Synthetic local review only/u);
  assert.match(html, /does not authorize an application/u);
});

test("the page is read-only and has no match questionnaire, application action, secrets, or external assets", () => {
  const combined = [
    correctionFlowDocumentReviewHtml(paths),
    correctionFlowDocumentReviewHtml.css,
    correctionFlowDocumentReviewHtml.javascript
  ].join("\n");
  assert.doesNotMatch(combined, /SyntheticReviewState|applicant question|work authorization|not_sure|yesEvidencePrompt/u);
  assert.doesNotMatch(combined, /textarea|contenteditable|regenerate|download=/iu);
  assert.doesNotMatch(combined, /GEMINI_API_KEY|API key|type="password"|name="credential"|raw provider|rawOutput/u);
  assert.doesNotMatch(combined, /https?:\/\//u);
  assert.doesNotMatch(combined, />\s*(?:Apply|Fill|Submit application)\s*</iu);

  const source = readFileSync(fileURLToPath(new URL(
    "../lib/ai/correction-flow-document-review-page.ts",
    import.meta.url
  )), "utf8");
  assert.match(source, /paginateResumeText/u);
  assert.match(source, /CorrectionFlowDocumentReviewEnvelope/u);
  assert.doesNotMatch(source, /synthetic-one-job-review|SyntheticReviewState|buildSyntheticReviewSnapshot/u);
});

test("shared owner-review headers remain closed and permit only same-origin PDF frames when requested", () => {
  const ordinary = ownerReviewSecurityHeaders("text/html; charset=utf-8");
  const pdfReview = ownerReviewSecurityHeaders("text/html; charset=utf-8", { allowSameOriginPdfFrames: true });
  assert.equal(ordinary["cache-control"], "private, no-store");
  assert.match(ordinary["content-security-policy"], /default-src 'none'/u);
  assert.doesNotMatch(ordinary["content-security-policy"], /frame-src/u);
  assert.match(pdfReview["content-security-policy"], /frame-src 'self'/u);
  assert.match(pdfReview["content-security-policy"], /object-src 'none'/u);
  assert.match(pdfReview["content-security-policy"], /frame-ancestors 'none'/u);
  assert.equal(pdfReview["referrer-policy"], "no-referrer");
});
