import type { CorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
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
  sourceResumeText: string;
  reviewedFacts: readonly string[];
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
      pages: readonly (readonly string[])[];
      evidence: readonly ReviewEvidence[];
    }>,
    Readonly<{
      kind: "cover_letter";
      title: string;
      validatedOutputHash: string;
      renderedPdfHash: string;
      pdfPath: string;
      pages: readonly (readonly string[])[];
      evidence: readonly ReviewEvidence[];
    }>
  ];
  return Object.freeze({
    phase: "reviewing" as const,
    memoryNotice: "Validated synthetic documents remain only in this local process until review closes.",
    envelopeHash: input.envelope.envelopeHash,
    context: Object.freeze({
      sourceResumeText: input.context.sourceResumeText,
      reviewedFacts: Object.freeze([...input.context.reviewedFacts]),
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

const css = `
:root { color-scheme: light; font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
* { box-sizing: border-box; }
body { margin: 0; }
main { width: min(1180px, 100%); margin: 0 auto; padding: 20px; }
.notice { border: 1px solid #f59e0b; background: #fffbeb; border-radius: 12px; padding: 16px; }
.context-grid { display: grid; gap: 16px; margin-top: 20px; }
.context-panel { border: 1px solid #cbd5e1; border-radius: 10px; background: white; padding: 16px; min-width: 0; }
.context-panel h2 { margin: 0 0 10px; font-size: 1.1rem; }
.context-panel h3 { margin: 16px 0 6px; font-size: 0.95rem; }
.context-copy { white-space: pre-wrap; overflow-wrap: anywhere; background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; max-height: 360px; overflow: auto; font: 0.875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.context-meta { color: #475569; margin: 0 0 10px; }
.context-list { margin: 6px 0 0; padding-left: 20px; }
.documents { display: grid; gap: 20px; margin-top: 20px; }
.document { border: 1px solid #cbd5e1; border-radius: 12px; background: white; padding: 20px; min-width: 0; overflow-wrap: anywhere; }
.document > h2 { margin-top: 0; }
.pdf { width: 100%; height: 78vh; min-height: 680px; border: 1px solid #94a3b8; background: #e2e8f0; }
.fallback { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #e2e8f0; background: #f8fafc; padding: 12px; max-height: 420px; overflow: auto; }
.evidence { border-top: 1px solid #e2e8f0; margin-top: 16px; padding-top: 12px; }
fieldset { border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 16px; padding: 12px; }
label { display: block; min-height: 40px; padding: 6px 0; }
button { min-height: 44px; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
#submit-review { background: #0f766e; color: white; }
#cancel-review { background: #e2e8f0; color: #0f172a; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
.status { min-height: 24px; margin-top: 12px; font-weight: 700; }
@media (min-width: 900px) { .context-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
@media (max-width: 600px) { main { padding: 12px; } .document { padding: 12px; } .pdf { min-height: 520px; } }
`;

const javascript = `
(() => {
  const root = document.querySelector('[data-document-review-page]');
  if (!root) return;
  const paths = {
    state: root.dataset.statePath,
    submit: root.dataset.submissionPath,
    cancel: root.dataset.cancelPath
  };
  let state = null;
  const status = document.getElementById('review-status');
  const byKind = (kind) => document.querySelector('[data-document-card="' + kind + '"]');
  const render = (view) => {
    state = view;
    document.querySelector('[data-source-resume]').textContent = view.context.sourceResumeText;
    const reviewedFacts = document.querySelector('[data-reviewed-facts]');
    reviewedFacts.replaceChildren();
    view.context.reviewedFacts.forEach((fact) => {
      const item = document.createElement('li');
      item.textContent = fact;
      reviewedFacts.append(item);
    });
    const job = view.context.targetJob;
    document.querySelector('[data-job-title]').textContent = job.title;
    document.querySelector('[data-job-meta]').textContent = [job.company, job.location].filter(Boolean).join(' · ');
    document.querySelector('[data-job-description]').textContent = job.description;
    for (const [selector, values] of [
      ['[data-job-requirements]', job.requirements],
      ['[data-job-preferred]', job.preferredQualifications],
      ['[data-job-stack]', job.detectedTechStack]
    ]) {
      const list = document.querySelector(selector);
      list.replaceChildren();
      values.forEach((value) => {
        const item = document.createElement('li');
        item.textContent = value;
        list.append(item);
      });
    }
    for (const documentView of view.documents) {
      const card = byKind(documentView.kind);
      card.querySelector('[data-document-title]').textContent = documentView.title;
      card.querySelector('[data-document-hash]').textContent = 'Validated output ' + documentView.validatedOutputHash;
      const text = card.querySelector('[data-document-text]');
      text.replaceChildren();
      documentView.pages.forEach((page, index) => {
        const heading = document.createElement('h3');
        heading.textContent = 'Text fallback · page ' + (index + 1);
        const pre = document.createElement('pre');
        pre.className = 'fallback';
        pre.textContent = page.join('\\n');
        text.append(heading, pre);
      });
      const evidence = card.querySelector('[data-document-evidence]');
      evidence.replaceChildren();
      documentView.evidence.forEach((entry) => {
        const item = document.createElement('li');
        item.textContent = entry.claim + ' — ' + entry.citations.map((citation) => citation.excerpt).join(' · ');
        evidence.append(item);
      });
    }
  };
  fetch(paths.state, { cache: 'no-store', credentials: 'omit' })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('state')))
    .then(render)
    .catch(() => { status.textContent = 'Review state is unavailable.'; });

  const collect = () => ({
    envelopeHash: state.envelopeHash,
    documents: ['resume', 'cover_letter'].map((kind) => {
      const card = byKind(kind);
      const identity = state.documents.find((entry) => entry.kind === kind);
      return {
        kind,
        validatedOutputHash: identity.validatedOutputHash,
        renderedPdfHash: identity.renderedPdfHash,
        disposition: card.querySelector('input[name="' + kind + '-disposition"]:checked')?.value,
        reason: card.querySelector('select').value || null,
        reviewedAllPages: card.querySelector('[data-attestation="all-pages"]').checked,
        reviewedWritingQuality: card.querySelector('[data-attestation="writing"]').checked,
        reviewedVisualLayout: card.querySelector('[data-attestation="layout"]').checked
      };
    })
  });
  document.getElementById('submit-review').addEventListener('click', async () => {
    if (!state) return;
    const response = await fetch(paths.submit, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collect())
    });
    status.textContent = response.ok ? 'Review recorded. This local session is closed.' : 'Complete both exact document reviews before submitting.';
  });
  document.getElementById('cancel-review').addEventListener('click', () => {
    navigator.sendBeacon(paths.cancel, new Blob([], { type: 'text/plain' }));
    status.textContent = 'Review cancelled.';
  });
  addEventListener('pagehide', () => navigator.sendBeacon(paths.cancel, new Blob([], { type: 'text/plain' })));
})();
`;

function documentCard(kind: "resume" | "cover_letter", pdfPath: string) {
  const label = kind === "resume" ? "Resume" : "Cover letter";
  return `<section class="document" data-document-card="${kind}">
    <h2 data-document-title>${label}</h2>
    <p data-document-hash></p>
    <iframe class="pdf" data-document-pdf="${kind}" title="Exact ${label} PDF" src="${escapeAttribute(pdfPath)}"></iframe>
    <div data-document-text></div>
    <details class="evidence"><summary>Review server-resolved evidence bindings</summary><ul data-document-evidence></ul></details>
    <fieldset><legend>${label} decision</legend>
      <label><input type="radio" name="${kind}-disposition" value="approved"> Approve exact document</label>
      <label><input type="radio" name="${kind}-disposition" value="needs_revision"> Needs revision</label>
      <label>Revision category <select><option value="">None</option><option value="clarity">Clarity</option><option value="tone">Tone</option><option value="formatting">Formatting</option><option value="length">Length</option><option value="other">Other</option></select></label>
      <label><input type="checkbox" data-attestation="all-pages"> Review every PDF page</label>
      <label><input type="checkbox" data-attestation="writing"> Review the writing quality</label>
      <label><input type="checkbox" data-attestation="layout"> Review the visual layout</label>
    </fieldset>
  </section>`;
}

function html(pathsValue: ReviewPaths) {
  const paths = checkedPaths(pathsValue);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic document review</title><link rel="stylesheet" href="/document-review.css"><script defer src="/document-review.js"></script></head>
  <body><main data-document-review-page data-state-path="${escapeAttribute(paths.statePath)}" data-submission-path="${escapeAttribute(paths.submissionPath)}" data-cancel-path="${escapeAttribute(paths.cancelPath)}">
    <header class="notice"><strong>Synthetic local review only</strong><h1>Review both exact application documents</h1><p>This proof does not authorize an application, export-for-use, employer interaction, or submission.</p></header>
    <section class="context-grid" aria-label="Source and target context">
      <article class="context-panel"><h2>Source résumé and evidence</h2><pre class="context-copy" data-source-resume></pre><h3>Current reviewed facts</h3><ul class="context-list" data-reviewed-facts></ul></article>
      <article class="context-panel"><h2>Target job context</h2><h3 data-job-title></h3><p class="context-meta" data-job-meta></p><p data-job-description></p><h3>Requirements</h3><ul class="context-list" data-job-requirements></ul><h3>Preferred qualifications</h3><ul class="context-list" data-job-preferred></ul><h3>Technology context</h3><ul class="context-list" data-job-stack></ul></article>
    </section>
    <div class="documents">${documentCard("resume", paths.resumePdfPath)}${documentCard("cover_letter", paths.coverLetterPdfPath)}</div>
    <div class="actions"><button id="submit-review" type="button">Submit both review decisions</button><button id="cancel-review" type="button">Cancel local review</button></div>
    <p id="review-status" class="status" aria-live="polite"></p>
  </main></body></html>`;
}

export const correctionFlowDocumentReviewHtml = Object.assign(html, { css, javascript });
export type CorrectionFlowDocumentReviewPaths = ReviewPaths;
