import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog
} from "@/lib/ai/application-document-facts";
import { buildCorrectionFlowDocumentReviewBundle } from "@/lib/ai/correction-flow-document-review-bundle";
import { hashAiInput } from "@/lib/ai/input-hash";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";

const hash = (character: string) => character.repeat(64);

function validInput() {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const tailoredResume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const coverLetter = assembleCoverLetterProviderOutput(payload, syntheticCoverLetterOutput());
  return {
    payload,
    tailoredResume,
    coverLetter,
    binding: {
      manifestHash: hash("1"),
      exactHead: "a".repeat(40),
      payloadHash: hashAiInput("correctionFlowResumeDiagnosticPayload", "1", payload),
      reviewedEvidenceHash: hashAiInput(
        "correctionFlowResumeDiagnosticReviewedEvidence", "1", payload.reviewedEvidence
      ),
      factCatalogHash: hashAiInput(
        "applicationDocumentFactCatalog", "7", buildApplicationDocumentFactCatalog(payload)
      ),
      promptVersion: "7",
      model: "gemini-3.8-flash",
      thinkingLevel: "LOW" as const,
      generationId: "generation-bundle"
    },
    expectedValidatedOutputHashes: {
      tailoredResume: hashAiInput("correctionFlowDocumentDiagnosticResume", "1", tailoredResume),
      coverLetter: hashAiInput("correctionFlowDocumentDiagnosticCoverLetter", "1", coverLetter)
    }
  };
}

test("the one-shot bundle revalidates assembled documents and exact in-memory exports", async () => {
  const input = validInput();
  const bundle = await buildCorrectionFlowDocumentReviewBundle(input);
  assert.equal(bundle.safe.envelope.manifestHash, input.binding.manifestHash);
  assert.equal(bundle.safe.verification.inMemoryOnly, true);
  assert.equal(bundle.safe.verification.resume.docxRoundTripExact, true);
  assert.equal(bundle.safe.verification.resume.pdfCriticalFactsPresent, true);
  assert.equal(bundle.safe.verification.coverLetter.docxRoundTripExact, true);
  assert.equal(bundle.safe.verification.coverLetter.pdfCriticalFactsPresent, true);
  assert.doesNotMatch(JSON.stringify(bundle.safe), /professionalSummary|Dear Synthetic|Synthetic owner confirms/u);

  const claim = bundle.claim();
  assert.deepEqual(claim.documents.map((document) => document.kind), ["resume", "cover_letter"]);
  assert.match(claim.renderedPdfs[0].bytes.toString("utf8"), /^%PDF-1\.4/u);
  assert.equal(claim.envelope.documents[0].renderedPdfHash, bundle.safe.verification.resume.pdfByteHash);
  assert.equal(claim.envelope.documents[1].renderedPdfHash, bundle.safe.verification.coverLetter.pdfByteHash);
  assert.throws(() => bundle.claim(), /already claimed/u);
  claim.dispose();
  assert.equal(claim.hasPrivateInput(), false);
  assert.throws(() => claim.documents, /released/u);
});

test("disposal overwrites PDF buffers and clears document and evidence references", async () => {
  const bundle = await buildCorrectionFlowDocumentReviewBundle(validInput());
  const claim = bundle.claim();
  const resumePdf = claim.renderedPdfs[0].bytes;
  const coverPdf = claim.renderedPdfs[1].bytes;
  assert.equal(resumePdf.some((byte) => byte !== 0), true);
  assert.equal(coverPdf.some((byte) => byte !== 0), true);
  claim.dispose();
  assert.equal(resumePdf.every((byte) => byte === 0), true);
  assert.equal(coverPdf.every((byte) => byte === 0), true);
  assert.equal(claim.hasPrivateInput(), false);
  claim.dispose();
});

test("provider wire shapes, stale hashes, and mismatched evidence never produce a bundle", async () => {
  const valid = validInput();
  await assert.rejects(buildCorrectionFlowDocumentReviewBundle({
    ...valid,
    tailoredResume: syntheticTailoredResumeOutput()
  }));
  await assert.rejects(buildCorrectionFlowDocumentReviewBundle({
    ...valid,
    expectedValidatedOutputHashes: {
      ...valid.expectedValidatedOutputHashes,
      tailoredResume: hash("c")
    }
  }), /validated output hash/u);
  await assert.rejects(buildCorrectionFlowDocumentReviewBundle({
    ...valid,
    tailoredResume: {
      ...valid.tailoredResume,
      claimEvidence: valid.tailoredResume.claimEvidence.map((entry, index) => index === 0 ? {
        ...entry,
        citations: [{ ...entry.citations[0], excerpt: "Invented source excerpt." }]
      } : entry)
    }
  }));
  await assert.rejects(buildCorrectionFlowDocumentReviewBundle({
    ...valid,
    binding: { ...valid.binding, payloadHash: hash("d") }
  }), /payload hash/u);
});
