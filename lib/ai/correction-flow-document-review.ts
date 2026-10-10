import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import {
  buildCorrectionFlowDocumentDiagnosticManifest,
  createCorrectionFlowDocumentReviewGenerationRunner,
  type CorrectionFlowDocumentDiagnosticReceipt,
  type CorrectionFlowDocumentReviewGenerationAuthorization
} from "@/lib/ai/correction-flow-document-diagnostic";
import type { CorrectionFlowDocumentReviewAttestation } from "@/lib/ai/correction-flow-document-review-contract";
import {
  CORRECTION_FLOW_DOCUMENT_REVIEW_SESSION_TIMEOUT_MS,
  startCorrectionFlowDocumentOwnerReview
} from "@/lib/ai/correction-flow-document-owner-review";
import { hashAiInput } from "@/lib/ai/input-hash";

export const CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION = "2" as const;
export const CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS =
  CORRECTION_FLOW_DOCUMENT_REVIEW_SESSION_TIMEOUT_MS;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerModeSchema = z.enum(["offline_stubbed", "live_synthetic"]);
const requiredOwnerAttestations = Object.freeze([
  "reviewedAllPages",
  "reviewedWritingQuality",
  "reviewedVisualLayout"
] as const);

export type CorrectionFlowDocumentReviewManifest = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION;
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  generatedAt: string;
  callCount: 2;
  stepTimeoutMs: 180_000;
  noRetry: true;
  noFallback: true;
  stopAfterFirstFailure: true;
  syntheticApplicantOnly: true;
  recipient: "google-gemini-developer-api";
  rawProviderOutputRetention: false;
  validatedDocumentPersistentRetention: false;
  validatedDocumentLocalDisplay: true;
  validatedDocumentLifetimeMs: typeof CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS;
  requiredOwnerAttestations: typeof requiredOwnerAttestations;
  safeReceiptOnly: true;
  productionWrites: false;
  databaseWrites: false;
  employerInteraction: false;
  jobMatchCalls: 0;
  safeLabel: string;
  calls: ReturnType<typeof buildCorrectionFlowDocumentDiagnosticManifest>["calls"];
  conservativeReservationMicros: number;
  payloadHash: string;
  reviewedEvidenceHash: string;
  factCatalogCount: number;
  factCatalogHash: string;
  generationId: string;
  manifestHash: string;
}>;

export function buildCorrectionFlowDocumentReviewManifest({
  exactHead,
  providerMode,
  generatedAt,
  payload,
  safeLabel
}: {
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  generatedAt: Date;
  payload: ApplicationDocumentPayload;
  safeLabel: string;
}): CorrectionFlowDocumentReviewManifest {
  const generation = buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead,
    providerMode,
    generatedAt,
    payload,
    safeLabel
  });
  const core = Object.freeze({
    contractVersion: CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION,
    exactHead: generation.exactHead,
    providerMode: generation.providerMode,
    generatedAt: generation.generatedAt,
    callCount: generation.callCount,
    stepTimeoutMs: generation.stepTimeoutMs,
    noRetry: true as const,
    noFallback: true as const,
    stopAfterFirstFailure: true as const,
    syntheticApplicantOnly: true as const,
    recipient: "google-gemini-developer-api" as const,
    rawProviderOutputRetention: false as const,
    validatedDocumentPersistentRetention: false as const,
    validatedDocumentLocalDisplay: true as const,
    validatedDocumentLifetimeMs: CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS,
    requiredOwnerAttestations,
    safeReceiptOnly: true as const,
    productionWrites: false as const,
    databaseWrites: false as const,
    employerInteraction: false as const,
    jobMatchCalls: 0 as const,
    safeLabel: generation.safeLabel,
    calls: generation.calls,
    conservativeReservationMicros: generation.conservativeReservationMicros,
    payloadHash: generation.payloadHash,
    reviewedEvidenceHash: generation.reviewedEvidenceHash,
    factCatalogCount: generation.factCatalogCount,
    factCatalogHash: generation.factCatalogHash,
    generationId: hashAiInput("correctionFlowDocumentReviewGeneration", "2", {
      exactHead: generation.exactHead,
      generatedAt: generation.generatedAt,
      payloadHash: generation.payloadHash,
      calls: generation.calls.map((call) => call.wireRequestHash)
    })
  });
  return Object.freeze({
    ...core,
    manifestHash: hashAiInput("correctionFlowDocumentReviewManifest", "2", core)
  });
}

export const correctionFlowDocumentReviewConsent = z.object({
  manifestHash: sha256Schema,
  exactHead: z.string().regex(/^[a-f0-9]{40}$/u),
  providerMode: providerModeSchema,
  approvedCallCount: z.literal(2),
  approvedConservativeReservationMicros: z.literal(112_125),
  approvedStepTimeoutMs: z.literal(180_000),
  syntheticApplicantDataSharingApproved: z.literal(true),
  existingCredentialUseApproved: z.boolean(),
  noRetry: z.literal(true),
  noFallback: z.literal(true),
  stopAfterFirstFailure: z.literal(true),
  noOwnerData: z.literal(true),
  noProductionWrites: z.literal(true),
  noDatabaseWrites: z.literal(true),
  noEmployerInteraction: z.literal(true),
  noJobMatchCalls: z.literal(true),
  rawProviderOutputRetention: z.literal(false),
  validatedDocumentPersistentRetention: z.literal(false),
  validatedDocumentLocalDisplay: z.literal(true),
  validatedDocumentLifetimeMs: z.literal(CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS),
  safeReceiptOnly: z.literal(true),
  approvedAt: z.string().datetime({ offset: true })
}).strict();

export type CorrectionFlowDocumentReviewConsent = z.infer<typeof correctionFlowDocumentReviewConsent>;

function assertConsent(manifest: CorrectionFlowDocumentReviewManifest, value: unknown) {
  const consent = correctionFlowDocumentReviewConsent.parse(value);
  if (
    consent.manifestHash !== manifest.manifestHash ||
    consent.exactHead !== manifest.exactHead ||
    consent.providerMode !== manifest.providerMode ||
    consent.approvedConservativeReservationMicros !== manifest.conservativeReservationMicros ||
    consent.existingCredentialUseApproved !== (manifest.providerMode === "live_synthetic")
  ) {
    throw new Error("Document review consent does not match the frozen manifest.");
  }
  return consent;
}

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
  providerMode: z.infer<typeof providerModeSchema>;
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
  const consent = assertConsent(canonical, consentValue);
  if (manifest.providerMode === "live_synthetic" && startReview !== startCorrectionFlowDocumentOwnerReview) {
    throw new Error("Live document review server override is forbidden.");
  }
  const diagnosticManifest = buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    generatedAt: new Date(manifest.generatedAt),
    payload,
    safeLabel: manifest.safeLabel
  });
  if (!isDeepStrictEqual(diagnosticManifest.calls, manifest.calls)) {
    throw new Error("Document review generation plan changed.");
  }
  const authorization: CorrectionFlowDocumentReviewGenerationAuthorization = {
    contractVersion: "2",
    manifestHash: manifest.manifestHash,
    exactHead: manifest.exactHead,
    payloadHash: manifest.payloadHash,
    reviewedEvidenceHash: manifest.reviewedEvidenceHash,
    factCatalogHash: manifest.factCatalogHash,
    promptVersion: manifest.calls[0].promptVersion,
    model: manifest.calls[0].model,
    thinkingLevel: manifest.calls[0].thinkingLevel,
    generationId: manifest.generationId,
    rawProviderOutputRetention: false,
    validatedDocumentPersistentRetention: false,
    validatedDocumentLocalDisplay: true,
    safeReceiptOnly: true,
    approvedAt: consent.approvedAt
  };
  const generation = createCorrectionFlowDocumentReviewGenerationRunner({
    manifest: diagnosticManifest,
    authorization,
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
          sessionTimeoutMs: CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_LIFETIME_MS
        });
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
