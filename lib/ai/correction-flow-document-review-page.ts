import type { CorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { documentReviewCss as css, documentReviewJavascript as javascript } from "@/lib/ai/correction-flow-document-review-assets";
import { buildCanonicalApplicationDocumentLayoutV2 } from "@/lib/documents/application-document-layout-v2";

type ReviewPaths = Readonly<{
  reviewPath: string;
  statePath: string;
  submissionPath: string;
  cancelPath: string;
  resumePdfPath: string;
  coverLetterPdfPath: string;
}>;

type ReviewCitation = Readonly<{ ref: string; excerpt: string }>;
type ReviewEvidence = Readonly<{ claim: string; citations: readonly ReviewCitation[] }>;
type ReviewDocument = Readonly<{
  kind: "resume" | "cover_letter";
  title: string;
  text: string;
  evidence: readonly ReviewEvidence[];
}>;
export type CorrectionFlowDocumentReviewContext = Readonly<{
  outputOrigin?: "authored_sample";
  sourceResumeText: string;
  reviewedFacts: readonly string[];
  reviewedResumeFacts?: readonly string[];
  correctionHistory?: readonly Readonly<{ requirement: string; evidenceBefore: string; fact: string; provenance: "OWNER_ATTESTED" | "SUBMITTED_RESUME" }>[];
  targetJob: Readonly<{
    title: string;
    company: string;
    location: string;
    description: string;
    requirements: readonly string[];
    preferredQualifications: readonly string[];
    detectedTechStack: readonly string[];
  }>;
}>;

const pathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u;

function checkedPaths(paths: ReviewPaths) {
  for (const value of Object.values(paths)) {
    if (!pathPattern.test(value) || value.includes("//") || value.includes("..")) {
      throw new Error("Document review paths must be exact local absolute paths.");
    }
  }
  return paths;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildCorrectionFlowDocumentReviewView(input: {
  envelope: CorrectionFlowDocumentReviewEnvelope;
  context: CorrectionFlowDocumentReviewContext;
  documents: readonly [ReviewDocument, ReviewDocument];
  paths: ReviewPaths;
}) {
  const paths = checkedPaths(input.paths);
  const expectedKinds = ["resume", "cover_letter"] as const;
  const documents = input.documents.map((document, index) => {
    const expected = input.envelope.documents[index];
    if (document.kind !== expectedKinds[index] || expected.kind !== document.kind) {
      throw new Error("Document review view requires resume then cover letter.");
    }
    const layout = buildCanonicalApplicationDocumentLayoutV2({
      artifactType: document.kind === "resume" ? "RESUME" : "COVER_LETTER",
      content: document.text
    });
    return Object.freeze({
      kind: document.kind,
      title: document.title,
      validatedOutputHash: expected.validatedOutputHash,
      renderedPdfHash: expected.renderedPdfHash,
      pdfPath: document.kind === "resume" ? paths.resumePdfPath : paths.coverLetterPdfPath,
      text: document.text,
      layout,
      pages: Object.freeze(layout.pages.map((page) => Object.freeze(
        page.blocks.map((block) => block.text)
      ))),
      evidence: Object.freeze(document.evidence.map((entry) => Object.freeze({
        claim: entry.claim,
        citations: Object.freeze(entry.citations.map((citation) => Object.freeze({ ...citation })))
      })))
    });
  }) as [
    Readonly<{
      kind: "resume";
      title: string;
      validatedOutputHash: string;
      renderedPdfHash: string;
      pdfPath: string;
      text: string;
      layout: ReturnType<typeof buildCanonicalApplicationDocumentLayoutV2>;
      pages: readonly (readonly string[])[];
      evidence: readonly ReviewEvidence[];
    }>,
    Readonly<{
      kind: "cover_letter";
      title: string;
      validatedOutputHash: string;
      renderedPdfHash: string;
      pdfPath: string;
      text: string;
      layout: ReturnType<typeof buildCanonicalApplicationDocumentLayoutV2>;
      pages: readonly (readonly string[])[];
      evidence: readonly ReviewEvidence[];
    }>
  ];
  return Object.freeze({
    phase: "reviewing" as const,
    memoryNotice: "Validated synthetic documents remain only in this local process until review closes.",
    envelopeHash: input.envelope.envelopeHash,
    context: Object.freeze({
      outputOrigin: input.context.outputOrigin,
      sourceResumeText: input.context.sourceResumeText,
      reviewedFacts: Object.freeze([...input.context.reviewedFacts]),
      reviewedResumeFacts: Object.freeze([...(input.context.reviewedResumeFacts ?? [])]),
      correctionHistory: Object.freeze((input.context.correctionHistory ?? []).map((entry) => Object.freeze({ ...entry }))),
      targetJob: Object.freeze({
        ...input.context.targetJob,
        requirements: Object.freeze([...input.context.targetJob.requirements]),
        preferredQualifications: Object.freeze([...input.context.targetJob.preferredQualifications]),
        detectedTechStack: Object.freeze([...input.context.targetJob.detectedTechStack])
      })
    }),
    documents: Object.freeze(documents)
  });
}

function documentCard(kind: "resume" | "cover_letter", pdfPath: string) {
  const label = kind === "resume" ? "Resume" : "Cover letter";
  return `<section id="review-${kind}" class="document" data-document-card="${kind}"${kind === "cover_letter" ? " hidden" : ""}>
    <div class="document-heading"><div><h3 tabindex="-1" data-document-title>${label}</h3><p class="muted" data-page-count></p></div><a class="pdf-link" data-open-pdf href="${escapeAttribute(pdfPath)}" target="_blank" rel="noopener noreferrer">Open exact ${label} PDF in a new tab</a></div>
    <p class="muted document-origin" data-document-origin></p>
    <div class="view-switch" aria-label="${label} viewing mode"><button data-document-view="layout" aria-pressed="true">Page layout</button><button data-document-view="reading" aria-pressed="false">Readable text</button></div>
    <div data-layout-document><p class="muted">Layout preview from the export renderer. Open the exact PDF to inspect the delivered file.</p><nav class="page-switch" data-page-switch aria-label="${label} pages"></nav><div data-document-pages></div></div>
    <div class="document-page" data-readable-document hidden><div class="page-reading" data-reading-content></div></div>
    <details class="preview-details" data-embedded-preview><summary>Embedded PDF preview (browser support varies)</summary>
      <iframe class="pdf" data-document-pdf="${kind}" title="Exact ${label} PDF" data-pdf-path="${escapeAttribute(pdfPath)}"></iframe>
    </details>
    <details class="preview-details"><summary>Read document text</summary><div data-document-text></div></details>
    <details class="preview-details"><summary>Technical details: exact document identifiers</summary><p class="exact-identifiers" data-document-hash></p></details>
    <details class="evidence"><summary>Supporting source evidence</summary><ul data-document-evidence></ul></details>
    <fieldset><legend>${label} decision</legend><p class="muted">These checks record what you inspected. You can select Needs revision after reviewing it.</p>
      <label><input type="radio" name="${kind}-disposition" value="approved"> Approve exact document</label>
      <label><input type="radio" name="${kind}-disposition" value="needs_revision"> Needs revision</label>
      <label>Revision category <select><option value="">None</option><option value="clarity">Clarity</option><option value="tone">Tone</option><option value="formatting">Formatting</option><option value="length">Length</option><option value="other">Other</option></select></label>
      <label><input type="checkbox" data-attestation="all-pages"> I reviewed every PDF page</label>
      <label><input type="checkbox" data-attestation="writing"> I reviewed the writing quality</label>
      <label><input type="checkbox" data-attestation="layout"> I reviewed the visual layout</label>
    </fieldset>
  </section>`;
}

function html(pathsValue: ReviewPaths) {
  const paths = checkedPaths(pathsValue);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic document review</title><link rel="stylesheet" href="/document-review.css"><script defer src="/document-review.js"></script></head>
  <body><main data-document-review-page data-state-path="${escapeAttribute(paths.statePath)}" data-submission-path="${escapeAttribute(paths.submissionPath)}" data-cancel-path="${escapeAttribute(paths.cancelPath)}">
    <header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">AP</span>Apply Pilot</div><details class="review-settings"><summary>Settings</summary><label class="appearance">Appearance <select id="review-theme" aria-label="Appearance"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label></details></header>
    <h1>Prepare your application</h1><p class="muted" data-workspace-job></p>
    <div class="notice"><strong>Synthetic local review only</strong><p data-output-origin></p><p>This proof does not authorize an application, export-for-use, employer interaction, or submission.</p></div>
    <nav class="stage-nav" aria-label="Application preparation"><button data-go-stage="background" aria-current="step"><span class="step-number">1</span>Background and target job</button><button data-go-stage="corrections" aria-current="false"><span class="step-number">2</span>Missing-fact corrections</button><button data-go-stage="documents" aria-current="false"><span class="step-number">3</span>Tailored documents</button></nav>
    <section data-review-stage="background"><div class="section-intro"><div><h2 tabindex="-1">Background and target job</h2><p>Read your complete master résumé against the target role. The source stays separate from tailored documents and new facts you confirm.</p></div><button class="primary" data-go-stage="corrections">Continue to corrections</button></div>
      <nav class="background-controls" aria-label="Background view"><button class="compare-choice" data-background-view="both" aria-pressed="true">Compare source and job</button><button data-background-view="source" aria-pressed="false">Expand master résumé</button><button data-background-view="job" aria-pressed="false">Read target job</button></nav>
      <div class="context-grid" data-view="both" aria-label="Source and target context"><article class="context-panel" data-source-panel><span class="badge">Master source</span><h2>Master résumé</h2><div class="context-copy" data-source-resume></div></article><article class="context-panel" data-job-panel><span class="badge">Target role</span><h2 data-job-title></h2><p class="context-meta" data-job-meta></p><h3>Job description</h3><p data-job-description></p><h3>Requirements</h3><ul class="context-list" data-job-requirements></ul><h3>Preferred qualifications</h3><ul class="context-list" data-job-preferred></ul><h3>Technology context</h3><ul class="context-list" data-job-stack></ul></article></div>
    </section>
    <section data-review-stage="corrections" hidden><div class="section-intro"><div><h2 tabindex="-1">Missing-fact corrections</h2><p>Review saved corrections used by this draft. To edit a fact, cancel this review and return to evidence correction; changes require a new assessment and document review. A missing résumé fact is not proof that you lack a qualification.</p></div><button class="primary" data-go-stage="documents">Continue to documents</button></div>
      <h3 data-correction-history-label>Saved correction history</h3>
      <div class="correction-history" data-correction-history></div>
      <div class="correction-grid"><article class="correction-panel" data-reviewed-resume-panel hidden><h3>Reviewed résumé corrections</h3><p>Resolved from the submitted résumé, not new qualifications.</p><ul class="context-list" data-reviewed-resume-facts></ul></article><article class="correction-panel"><h3>User-added facts for this job</h3><p>Owner-attested additions are kept separate from the master résumé.</p><ul class="context-list" data-reviewed-facts></ul></article></div>
      <p class="muted">These are the saved corrections used by this draft. To change a fact, cancel this review and return to evidence correction. A new assessment and document review are required; earlier approvals cannot carry forward.</p><button data-go-stage="background">Return to background</button>
    </section>
    <section data-review-stage="documents" hidden><div class="section-intro"><div><h2 tabindex="-1">Tailored documents</h2><p>Review one document at a time. Compare the role's requirements with the supported experience, inspect every PDF page, then decide on each exact document.</p></div></div>
      <nav class="document-switch" aria-label="Choose a document"><button data-review-kind="resume" aria-pressed="true" aria-controls="review-resume">Review résumé</button><button data-review-kind="cover_letter" aria-pressed="false" aria-controls="review-cover_letter">Review cover letter</button><button data-go-stage="background">Return to source and job</button></nav>
      <div class="documents">${documentCard("resume", paths.resumePdfPath)}${documentCard("cover_letter", paths.coverLetterPdfPath)}</div>
      <div class="actions review-actions"><button class="primary" id="submit-review" type="button">Submit both review decisions</button></div>
    </section>
    <div class="actions"><button id="cancel-review" type="button">Cancel local review</button></div>
    <p id="review-status" class="status" aria-live="polite"></p>
  </main></body></html>`;
}

export const correctionFlowDocumentReviewHtml = Object.assign(html, { css, javascript });
export type CorrectionFlowDocumentReviewPaths = ReviewPaths;
