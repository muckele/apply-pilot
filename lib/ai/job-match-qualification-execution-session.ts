import { z } from "zod";

import {
  assertQualificationExecutionPreflight,
  QUALIFICATION_MAX_CALLS,
  QUALIFICATION_RECIPIENT,
  QualificationRunStoppedError,
  runJobMatchQualification,
  type QualificationDisagreementCategory,
  type QualificationCompletedCallMetrics,
  type QualificationExecutionConsent,
  type QualificationPreparation,
  type QualificationReviewCase,
  type QualificationTransport
} from "@/lib/ai/job-match-qualification";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match";

const consentDraftSchema = z.object({
  recipient: z.literal(QUALIFICATION_RECIPIENT),
  model: z.literal(JOB_MATCH_MODEL),
  promptVersion: z.literal(JOB_MATCH_PROMPT_VERSION),
  approvedManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  approvedCallCount: z.literal(QUALIFICATION_MAX_CALLS),
  approvedMaximumCostMicros: z.number().int().nonnegative(),
  privateApplicantDataSharingApproved: z.literal(true),
  existingCredentialUseApproved: z.literal(true),
  noRetry: z.literal(true),
  noDatabaseWrites: z.literal(true),
  noRoutingWrites: z.literal(true),
  noEmployerInteraction: z.literal(true)
}).strict();

const disagreementCategorySchema = z.enum([
  "recommendation",
  "missing_material_gap",
  "unsupported_positive_match",
  "compensation",
  "preference",
  "advice_claim",
  "other_review_required"
]);

const providerReviewSchema = z.object({
  caseId: z.string().min(1),
  disagreementCategories: z.array(disagreementCategorySchema).max(7)
}).strict();

export type QualificationExecutionPhase =
  | "awaiting_separate_google_consent"
  | "execution_starting"
  | "executing"
  | "reviewing_provider_result"
  | "execution_complete"
  | "execution_stopped";

type PendingProviderReview = Parameters<QualificationReviewCase>[0];

export type QualificationExecutionActivation = Readonly<{
  activateTransport: () => QualificationTransport | Promise<QualificationTransport>;
  clock?: () => Date;
}>;

function activationFailureReport(manifestHash: string) {
  return Object.freeze({
    status: "stopped" as const,
    manifestHash,
    completedCaseCount: 0,
    failedCaseIndex: null,
    failureCode: "CREDENTIAL_ACTIVATION_FAILED",
    noRetryAttempted: true as const,
    totalKnownEstimatedCostMicros: 0,
    failedCall: null,
    results: []
  });
}

function internalFailureReport(manifestHash: string, completedCaseCount: number) {
  return Object.freeze({
    status: "stopped" as const,
    manifestHash,
    completedCaseCount,
    failedCaseIndex: null,
    failureCode: "INTERNAL_EXECUTION_FAILED",
    noRetryAttempted: true as const,
    totalKnownEstimatedCostMicros: null,
    failedCall: null,
    results: []
  });
}

export function createQualificationExecutionSession({
  preparation: initialPreparation,
  activation
}: {
  preparation: QualificationPreparation;
  activation: QualificationExecutionActivation;
}) {
  let preparation: QualificationPreparation | null = initialPreparation;
  let phase: QualificationExecutionPhase = "awaiting_separate_google_consent";
  let pendingReview: PendingProviderReview | null = null;
  let resolvePendingReview: ((value: { disagreementCategories: QualificationDisagreementCategory[] }) => void) | null = null;
  let rejectPendingReview: ((error: Error) => void) | null = null;
  let safeReport: unknown = null;
  let providerCallCount = 0;
  let providerCallsCompleted = 0;
  let providerCallsWithKnownBilling = 0;
  let knownInputTokens = 0;
  let knownOutputTokens = 0;
  let knownCachedInputTokens = 0;
  let knownEstimatedCostMicros = 0;
  let closed = false;
  let resolveFinished!: (report: unknown) => void;
  const finished = new Promise<unknown>((resolve) => { resolveFinished = resolve; });

  const reviewCase: QualificationReviewCase = async (input) => {
    if (closed) throw new Error("Qualification execution was cancelled.");
    pendingReview = input;
    phase = "reviewing_provider_result";
    return new Promise((resolve, reject) => {
      resolvePendingReview = resolve;
      rejectPendingReview = reject;
    });
  };

  const finish = (report: unknown, nextPhase: "execution_complete" | "execution_stopped") => {
    safeReport = report;
    phase = nextPhase;
    pendingReview = null;
    resolvePendingReview = null;
    rejectPendingReview = null;
    preparation = null;
    resolveFinished(report);
  };

  const recordCompletedCall = (metrics: QualificationCompletedCallMetrics) => {
    if (metrics.providerCompleted) providerCallsCompleted += 1;
    if (metrics.inputTokens !== null) knownInputTokens += metrics.inputTokens;
    if (metrics.outputTokens !== null) knownOutputTokens += metrics.outputTokens;
    if (metrics.cachedInputTokens !== null) knownCachedInputTokens += metrics.cachedInputTokens;
    if (metrics.estimatedCostMicros !== null) knownEstimatedCostMicros += metrics.estimatedCostMicros;
    if (metrics.billingKnown) providerCallsWithKnownBilling += 1;
  };

  const run = async (consent: QualificationExecutionConsent, executionNow: Date) => {
    const activePreparation = preparation;
    if (!activePreparation || closed) return;
    let transport: QualificationTransport;
    try {
      transport = await activation.activateTransport();
    } catch {
      finish(activationFailureReport(activePreparation.safeManifest.manifestHash), "execution_stopped");
      return;
    }
    if (closed) return;
    phase = "executing";
    const countedTransport: QualificationTransport = async (request) => {
      if (closed) throw new Error("Qualification execution was cancelled.");
      providerCallCount += 1;
      const response = await transport(request);
      if (closed) throw new Error("Qualification execution was cancelled.");
      return response;
    };
    try {
      const report = await runJobMatchQualification({
        preparation: activePreparation,
        consent,
        transport: countedTransport,
        reviewCase,
        onProviderCallCompleted: recordCompletedCall,
        now: executionNow
      });
      finish(report, "execution_complete");
    } catch (error) {
      if (closed) return;
      const report = error instanceof QualificationRunStoppedError
        ? error.safeReport
        : internalFailureReport(activePreparation.safeManifest.manifestHash, 0);
      finish(report, "execution_stopped");
    }
  };

  return Object.freeze({
    authorize(value: unknown) {
      if (closed || phase !== "awaiting_separate_google_consent" || !preparation) {
        throw new Error("Qualification execution consent is unavailable.");
      }
      const draft = consentDraftSchema.parse(value);
      const executionNow = activation.clock?.() ?? new Date();
      const consent: QualificationExecutionConsent = {
        ...draft,
        approvedAt: executionNow.toISOString()
      };
      assertQualificationExecutionPreflight(preparation, consent, executionNow);
      phase = "execution_starting";
      void run(consent, executionNow);
    },
    submitProviderReview(value: unknown) {
      if (closed || phase !== "reviewing_provider_result" || !pendingReview || !resolvePendingReview) {
        throw new Error("Qualification provider-result review is unavailable.");
      }
      const review = providerReviewSchema.parse(value);
      if (review.caseId !== pendingReview.caseId) {
        throw new Error("Qualification provider-result reviews must follow the frozen case order.");
      }
      const unique = [...new Set(review.disagreementCategories)];
      if (unique.length !== review.disagreementCategories.length) {
        throw new Error("Qualification provider-result review categories must be unique.");
      }
      const resolve = resolvePendingReview;
      pendingReview = null;
      resolvePendingReview = null;
      rejectPendingReview = null;
      phase = "executing";
      resolve({ disagreementCategories: unique });
    },
    view() {
      return {
        phase,
        providerCallCount,
        safeReport,
        providerResultReview: pendingReview
          ? {
              index: pendingReview.index,
              caseId: pendingReview.caseId,
              safeLabel: pendingReview.safeLabel,
              inputHash: pendingReview.inputHash,
              matchInput: pendingReview.matchInput,
              normalizedOutput: pendingReview.normalizedOutput
            }
          : null
      };
    },
    close() {
      if (closed) return;
      closed = true;
      const reject = rejectPendingReview;
      pendingReview = null;
      resolvePendingReview = null;
      rejectPendingReview = null;
      preparation = null;
      reject?.(new Error("Qualification execution was cancelled."));
    },
    hasPrivateInput: () => preparation !== null || pendingReview !== null,
    phase: () => phase,
    providerCallCount: () => providerCallCount,
    closureReceipt: () => {
      const unknownBillingCallCount = Math.max(0, providerCallCount - providerCallsWithKnownBilling);
      return {
        providerCallsStarted: providerCallCount,
        providerCallsCompleted,
        knownInputTokens,
        knownOutputTokens,
        knownCachedInputTokens,
        knownEstimatedCostMicros,
        unknownBillingCallCount,
        billingStatus: providerCallCount === 0
          ? "no_provider_calls_started" as const
          : unknownBillingCallCount > 0
            ? "unknown_for_started_calls" as const
            : "known_for_all_started_calls" as const
      };
    },
    finished
  });
}
