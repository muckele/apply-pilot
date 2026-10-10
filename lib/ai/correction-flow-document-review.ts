import { isDeepStrictEqual } from "node:util";

import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import {
  buildCorrectionFlowDocumentReviewManifest,
  correctionFlowDocumentReviewConsent,
  CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION,
  CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS,
  createCorrectionFlowDocumentReviewGenerationRunner,
  type CorrectionFlowDocumentDiagnosticReceipt,
  type CorrectionFlowDocumentReviewConsent,
  type CorrectionFlowDocumentReviewManifest
} from "@/lib/ai/correction-flow-document-diagnostic";
import type { CorrectionFlowDocumentReviewAttestation } from "@/lib/ai/correction-flow-document-review-contract";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";

export {
  buildCorrectionFlowDocumentReviewManifest,
  correctionFlowDocumentReviewConsent,
  CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION,
  CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS
};
export type { CorrectionFlowDocumentReviewConsent, CorrectionFlowDocumentReviewManifest };

type ReviewReady = Readonly<{
  reviewUrl: string;
  stateUrl: string;
  submissionUrl: string;
  cancelUrl: string;
  pdfUrls: readonly [string, string];
}>;

export type CorrectionFlowDocumentReviewReceipt = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION;
  status: "approved" | "needs_revision" | "stopped";
  manifestHash: string;
  exactHead: string;
  providerMode: CorrectionFlowDocumentReviewManifest["providerMode"];
  conservativeReservationMicros: number;
  providerCallsStarted: number;
  providerCallsCompleted: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownCachedInputTokens: number;
  knownEstimatedCostMicros: number;
  unknownBillingCallCount: number;
  noRetryAttempted: true;
  noFallbackAttempted: true;
  stoppedAfterFirstFailure: true;
  rawProviderOutputRetained: false;
  validatedDocumentPersistentRetention: false;
  safeReceiptOnly: true;
  failureStage: "tailored_resume" | "cover_letter" | "verify_exports" | "owner_review" | null;
  failureCode: string | null;
  failureClass: "unsupported_applicant_term" | "source_relation_mismatch" | null;
  failureFieldPath: string | null;
  envelopeHash: string | null;
  reviewAttestation: CorrectionFlowDocumentReviewAttestation | null;
}>;

function reviewReceipt(
  manifest: CorrectionFlowDocumentReviewManifest,
  diagnostic: CorrectionFlowDocumentDiagnosticReceipt,
  input: {
    status?: CorrectionFlowDocumentReviewReceipt["status"];
    failureStage?: CorrectionFlowDocumentReviewReceipt["failureStage"];
    failureCode?: string | null;
    envelopeHash?: string | null;
    reviewAttestation?: CorrectionFlowDocumentReviewAttestation | null;
  } = {}
): CorrectionFlowDocumentReviewReceipt {
  return Object.freeze({
    contractVersion: CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION,
    status: input.status ?? "stopped",
    manifestHash: manifest.manifestHash,
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    conservativeReservationMicros: manifest.conservativeReservationMicros,
    providerCallsStarted: diagnostic.providerCallsStarted,
    providerCallsCompleted: diagnostic.providerCallsCompleted,
    knownInputTokens: diagnostic.knownInputTokens,
    knownOutputTokens: diagnostic.knownOutputTokens,
    knownCachedInputTokens: diagnostic.knownCachedInputTokens,
    knownEstimatedCostMicros: diagnostic.knownEstimatedCostMicros,
    unknownBillingCallCount: diagnostic.unknownBillingCallCount,
    noRetryAttempted: true,
    noFallbackAttempted: true,
    stoppedAfterFirstFailure: true,
    rawProviderOutputRetained: false,
    validatedDocumentPersistentRetention: false,
    safeReceiptOnly: true,
    failureStage: input.failureStage === undefined ? diagnostic.failureStage : input.failureStage,
    failureCode: input.failureCode === undefined ? diagnostic.failureCode : input.failureCode,
    failureClass: diagnostic.failureClass,
    failureFieldPath: diagnostic.failureFieldPath,
    envelopeHash: input.envelopeHash ?? null,
    reviewAttestation: input.reviewAttestation ?? null
  });
}

export function createCorrectionFlowDocumentReviewRunner({
  manifest,
  consent: consentValue,
  payload,
  credentials,
  fetchImpl,
  now,
  onReviewReady = () => undefined,
  startReview = startCorrectionFlowDocumentOwnerReview
}: {
  manifest: CorrectionFlowDocumentReviewManifest;
  consent: CorrectionFlowDocumentReviewConsent;
  payload: ApplicationDocumentPayload;
  credentials: Readonly<{ geminiApiKey: string }>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onReviewReady?: (review: ReviewReady) => void | Promise<void>;
  startReview?: typeof startCorrectionFlowDocumentOwnerReview;
}) {
  const canonical = buildCorrectionFlowDocumentReviewManifest({
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    generatedAt: new Date(manifest.generatedAt),
    payload,
    safeLabel: manifest.safeLabel
  });
  if (!isDeepStrictEqual(canonical, manifest)) {
    throw new Error("Document review payload or metadata does not match the frozen manifest.");
  }
  if (manifest.providerMode === "live_synthetic" && startReview !== startCorrectionFlowDocumentOwnerReview) {
    throw new Error("Live document review server override is forbidden.");
  }
  const generation = createCorrectionFlowDocumentReviewGenerationRunner({
    manifest,
    consent: consentValue,
    payload,
    credentials,
    fetchImpl,
    now
  });

  return Object.freeze({
    async run(signal: AbortSignal): Promise<CorrectionFlowDocumentReviewReceipt> {
      const generated = await generation.run(signal);
      if (generated.receipt.status !== "passed" || !generated.bundle) {
        return reviewReceipt(manifest, generated.receipt);
      }
      const bundle = generated.bundle;
      const envelopeHash = bundle.safe.envelope.envelopeHash;
      if (signal.aborted) {
        bundle.dispose();
        return reviewReceipt(manifest, generated.receipt, {
          status: "stopped",
          failureStage: "owner_review",
          failureCode: "EXECUTION_CANCELLED",
          envelopeHash
        });
      }
      let claim: ReturnType<typeof bundle.claim> | null = null;
      let review: Awaited<ReturnType<typeof startCorrectionFlowDocumentOwnerReview>> | null = null;
      const onAbort = () => review?.close("signal");
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        claim = bundle.claim();
        review = await startReview({
          envelope: claim.envelope,
          documents: claim.documents,
          renderedPdfs: claim.renderedPdfs,
          now,
          sessionTimeoutMs: CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS,
          signal
        });
        if (signal.aborted) {
          review.close("signal");
          await review.closed;
          throw new Error("Document review was cancelled during startup.");
        }
        claim.releaseOwnership();
        claim = null;
        await onReviewReady({
          reviewUrl: review.reviewUrl,
          stateUrl: review.stateUrl,
          submissionUrl: review.submissionUrl,
          cancelUrl: review.cancelUrl,
          pdfUrls: review.pdfUrls
        });
        const attestation = await review.finished;
        await review.closed;
        const status = attestation.documents.every((document) => document.disposition === "approved")
          ? "approved" as const
          : "needs_revision" as const;
        return reviewReceipt(manifest, generated.receipt, {
          status,
          failureStage: null,
          failureCode: null,
          envelopeHash,
          reviewAttestation: attestation
        });
      } catch {
        review?.close(signal.aborted ? "signal" : "error");
        if (review) await review.closed;
        return reviewReceipt(manifest, generated.receipt, {
          status: "stopped",
          failureStage: "owner_review",
          failureCode: signal.aborted ? "EXECUTION_CANCELLED" : "OWNER_REVIEW_INCOMPLETE",
          envelopeHash
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        claim?.dispose();
        bundle.dispose();
      }
    }
  });
}
