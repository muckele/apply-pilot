import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCorrectionFlowDocumentReviewEnvelope,
  createCorrectionFlowDocumentReviewAttestation,
  isCorrectionFlowDocumentReviewCurrent
} from "@/lib/ai/correction-flow-document-review-contract";

const hash = (character: string) => character.repeat(64);

function envelopeInput() {
  return {
    manifestHash: hash("1"),
    exactHead: "a".repeat(40),
    payloadHash: hash("2"),
    sourceResumeHash: hash("3"),
    profileHash: hash("4"),
    jobProjectionHash: hash("5"),
    reviewedEvidenceHash: hash("6"),
    factCatalogHash: hash("7"),
    promptVersion: "8",
    model: "gemini-3.8-flash",
    thinkingLevel: "LOW",
    generationId: "generation-2026-10-10T04:00:00.000Z",
    documents: [
      { kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: hash("9") },
      { kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: hash("b") }
    ]
  };
}

function validSubmission(envelopeHash: string) {
  return {
    envelopeHash,
    documents: [
      {
        kind: "resume",
        validatedOutputHash: hash("8"),
        renderedPdfHash: hash("9"),
        disposition: "approved",
        reason: null,
        reviewedAllPages: true,
        reviewedWritingQuality: true,
        reviewedVisualLayout: true
      },
      {
        kind: "cover_letter",
        validatedOutputHash: hash("a"),
        renderedPdfHash: hash("b"),
        disposition: "needs_revision",
        reason: "tone",
        reviewedAllPages: true,
        reviewedWritingQuality: true,
        reviewedVisualLayout: true
      }
    ]
  } as const;
}

function delivered() {
  return [
    { kind: "resume", renderedPdfHash: hash("9"), delivered: true },
    { kind: "cover_letter", renderedPdfHash: hash("b"), delivered: true }
  ] as const;
}

test("the review envelope and attestation bind both exact documents in source order", () => {
  const first = buildCorrectionFlowDocumentReviewEnvelope(envelopeInput());
  const second = buildCorrectionFlowDocumentReviewEnvelope(envelopeInput());
  assert.deepEqual(first, second);
  assert.match(first.envelopeHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.documents.map((document) => document.kind), ["resume", "cover_letter"]);

  const attestation = createCorrectionFlowDocumentReviewAttestation(
    first,
    delivered(),
    validSubmission(first.envelopeHash),
    "2026-10-10T04:05:00.000Z"
  );
  assert.equal(attestation.reviewEnvelopeHash, first.envelopeHash);
  assert.deepEqual(attestation.documents.map((document) => ({
    kind: document.kind,
    disposition: document.disposition,
    deliveredPdfHash: document.deliveredPdfHash,
    reviewedAllPages: document.reviewedAllPages,
    reviewedWritingQuality: document.reviewedWritingQuality,
    reviewedVisualLayout: document.reviewedVisualLayout
  })), [
    {
      kind: "resume",
      disposition: "approved",
      deliveredPdfHash: hash("9"),
      reviewedAllPages: true,
      reviewedWritingQuality: true,
      reviewedVisualLayout: true
    },
    {
      kind: "cover_letter",
      disposition: "needs_revision",
      deliveredPdfHash: hash("b"),
      reviewedAllPages: true,
      reviewedWritingQuality: true,
      reviewedVisualLayout: true
    }
  ]);
  assert.match(attestation.attestationHash, /^[a-f0-9]{64}$/u);
  assert.equal(isCorrectionFlowDocumentReviewCurrent(attestation, first), true);
  assert.doesNotMatch(JSON.stringify(attestation), /professionalSummary|coverLetter|sourceExcerpt|rawOutput/u);
});

test("every authority binding invalidates an earlier review attestation", () => {
  const envelope = buildCorrectionFlowDocumentReviewEnvelope(envelopeInput());
  const attestation = createCorrectionFlowDocumentReviewAttestation(
    envelope,
    delivered(),
    validSubmission(envelope.envelopeHash),
    "2026-10-10T04:05:00.000Z"
  );
  const mutations: Array<[string, (value: ReturnType<typeof envelopeInput>) => void]> = [
    ["manifestHash", (value) => { value.manifestHash = hash("c"); }],
    ["exactHead", (value) => { value.exactHead = "b".repeat(40); }],
    ["payloadHash", (value) => { value.payloadHash = hash("c"); }],
    ["sourceResumeHash", (value) => { value.sourceResumeHash = hash("c"); }],
    ["profileHash", (value) => { value.profileHash = hash("c"); }],
    ["jobProjectionHash", (value) => { value.jobProjectionHash = hash("c"); }],
    ["reviewedEvidenceHash", (value) => { value.reviewedEvidenceHash = hash("c"); }],
    ["factCatalogHash", (value) => { value.factCatalogHash = hash("c"); }],
    ["promptVersion", (value) => { value.promptVersion = "9"; }],
    ["model", (value) => { value.model = "gemini-other"; }],
    ["thinkingLevel", (value) => { value.thinkingLevel = "MEDIUM"; }],
    ["generationId", (value) => { value.generationId = "generation-other"; }],
    ["resume output", (value) => { value.documents[0].validatedOutputHash = hash("c"); }],
    ["resume PDF", (value) => { value.documents[0].renderedPdfHash = hash("c"); }],
    ["cover output", (value) => { value.documents[1].validatedOutputHash = hash("c"); }],
    ["cover PDF", (value) => { value.documents[1].renderedPdfHash = hash("c"); }]
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(envelopeInput());
    mutate(changed);
    assert.equal(
      isCorrectionFlowDocumentReviewCurrent(
        attestation,
        buildCorrectionFlowDocumentReviewEnvelope(changed)
      ),
      false,
      label
    );
  }
  assert.equal(isCorrectionFlowDocumentReviewCurrent(
    attestation,
    { ...envelope, exactHead: "c".repeat(40) }
  ), false, "forged envelope retains an old envelopeHash");
  assert.throws(() => createCorrectionFlowDocumentReviewAttestation(
    { ...envelope, exactHead: "c".repeat(40) },
    delivered(),
    validSubmission(envelope.envelopeHash),
    "2026-10-10T04:05:00.000Z"
  ), /envelope hash is invalid/iu);
});

test("review attestation rejects incomplete, stale, reordered, duplicated, or prose-bearing submissions", () => {
  const envelope = buildCorrectionFlowDocumentReviewEnvelope(envelopeInput());
  const valid = validSubmission(envelope.envelopeHash);
  const invalid: unknown[] = [
    { ...valid, envelopeHash: hash("c") },
    { ...valid, documents: valid.documents.slice(0, 1) },
    { ...valid, documents: [valid.documents[1], valid.documents[0]] },
    { ...valid, documents: [valid.documents[0], valid.documents[0]] },
    { ...valid, documents: [{ ...valid.documents[0], reviewedAllPages: false }, valid.documents[1]] },
    { ...valid, documents: [{ ...valid.documents[0], reviewedWritingQuality: false }, valid.documents[1]] },
    { ...valid, documents: [{ ...valid.documents[0], reviewedVisualLayout: false }, valid.documents[1]] },
    { ...valid, documents: [{ ...valid.documents[0], disposition: "maybe" }, valid.documents[1]] },
    { ...valid, documents: [{ ...valid.documents[0], reason: "free form prose" }, valid.documents[1]] },
    { ...valid, documents: [{ ...valid.documents[0], professionalSummary: "private prose" }, valid.documents[1]] },
    { ...valid, rawOutput: "private raw packet" }
  ];
  for (const candidate of invalid) {
    assert.throws(() => createCorrectionFlowDocumentReviewAttestation(
      envelope,
      delivered(),
      candidate,
      "2026-10-10T04:05:00.000Z"
    ));
  }
  assert.throws(() => createCorrectionFlowDocumentReviewAttestation(
    envelope,
    delivered().slice(0, 1),
    valid,
    "2026-10-10T04:05:00.000Z"
  ));
  assert.throws(() => createCorrectionFlowDocumentReviewAttestation(
    envelope,
    [delivered()[1], delivered()[0]],
    valid,
    "2026-10-10T04:05:00.000Z"
  ));
  assert.throws(() => createCorrectionFlowDocumentReviewAttestation(
    envelope,
    [{ ...delivered()[0], delivered: false }, delivered()[1]],
    valid,
    "2026-10-10T04:05:00.000Z"
  ));
});
