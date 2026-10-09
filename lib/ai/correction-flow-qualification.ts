import { z } from "zod";

import { hashAiInput } from "@/lib/ai/input-hash";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { AI_FEATURE_POLICIES } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";

export const CORRECTION_FLOW_QUALIFICATION_CONTRACT_VERSION = "1" as const;
export const CORRECTION_FLOW_QUALIFICATION_MAX_CALLS = 4 as const;
export const CORRECTION_FLOW_QUALIFICATION_STEP_TIMEOUT_MS = 180_000 as const;
export const CORRECTION_FLOW_OPENAI_MODEL = "gpt-4o-mini" as const;
export const CORRECTION_FLOW_DOCUMENT_PROMPT_VERSION = "3" as const;

const providerModeSchema = z.enum(["offline_stubbed", "live_synthetic"]);
const providerStageSchema = z.enum([
  "initial_match",
  "updated_match",
  "tailored_resume",
  "cover_letter"
]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export type CorrectionFlowProviderMode = z.infer<typeof providerModeSchema>;
export type CorrectionFlowProviderStage = z.infer<typeof providerStageSchema>;
export type CorrectionFlowFailureStage =
  | CorrectionFlowProviderStage
  | "apply_correction"
  | "verify_exports"
  | "cleanup";

const dataCategories = Object.freeze([
  "synthetic_job_projection",
  "synthetic_resume_projection_including_raw_text",
  "synthetic_profile_preferences",
  "synthetic_job_only_reviewed_evidence"
] as const);

function callPlan() {
  const jobMatchMaximum = estimateAiCostMicros({
    model: JOB_MATCH_MODEL,
    inputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens
  });
  const resumeMaximum = estimateAiCostMicros({
    model: CORRECTION_FLOW_OPENAI_MODEL,
    inputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens
  });
  const coverMaximum = estimateAiCostMicros({
    model: CORRECTION_FLOW_OPENAI_MODEL,
    inputTokens: AI_FEATURE_POLICIES.COVER_LETTER.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.COVER_LETTER.maxOutputTokens
  });
  return Object.freeze([
    Object.freeze({
      stage: "initial_match" as const,
      provider: "google-gemini-developer-api" as const,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      maximumInputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens,
      maximumOutputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens,
      maximumCostMicros: jobMatchMaximum
    }),
    Object.freeze({
      stage: "updated_match" as const,
      provider: "google-gemini-developer-api" as const,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      maximumInputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens,
      maximumOutputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens,
      maximumCostMicros: jobMatchMaximum
    }),
    Object.freeze({
      stage: "tailored_resume" as const,
      provider: "openai-api" as const,
      model: CORRECTION_FLOW_OPENAI_MODEL,
      promptVersion: CORRECTION_FLOW_DOCUMENT_PROMPT_VERSION,
      maximumInputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens,
      maximumOutputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens,
      maximumCostMicros: resumeMaximum
    }),
    Object.freeze({
      stage: "cover_letter" as const,
      provider: "openai-api" as const,
      model: CORRECTION_FLOW_OPENAI_MODEL,
      promptVersion: CORRECTION_FLOW_DOCUMENT_PROMPT_VERSION,
      maximumInputTokens: AI_FEATURE_POLICIES.COVER_LETTER.maxInputTokens,
      maximumOutputTokens: AI_FEATURE_POLICIES.COVER_LETTER.maxOutputTokens,
      maximumCostMicros: coverMaximum
    })
  ]);
}

export type CorrectionFlowQualificationFixture = Readonly<{
  safeLabel: string;
  job: unknown;
  resume: unknown;
  profile: unknown;
  predeterminedCorrection: unknown;
}>;

export type CorrectionFlowQualificationManifest = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_QUALIFICATION_CONTRACT_VERSION;
  exactHead: string;
  providerMode: CorrectionFlowProviderMode;
  generatedAt: string;
  callCount: typeof CORRECTION_FLOW_QUALIFICATION_MAX_CALLS;
  stepTimeoutMs: typeof CORRECTION_FLOW_QUALIFICATION_STEP_TIMEOUT_MS;
  noRetry: true;
  syntheticApplicantOnly: true;
  productionWrites: false;
  employerInteraction: false;
  calls: ReturnType<typeof callPlan>;
  conservativeReservationMicros: number;
  dataCategories: typeof dataCategories;
  fixture: Readonly<{
    safeLabel: string;
    jobProjectionHash: string;
    resumeProjectionHash: string;
    profileProjectionHash: string;
    correctionHash: string;
  }>;
  manifestHash: string;
}>;

export function buildCorrectionFlowQualificationManifest({
  exactHead,
  providerMode,
  generatedAt,
  fixture
}: {
  exactHead: string;
  providerMode: CorrectionFlowProviderMode;
  generatedAt: Date;
  fixture: CorrectionFlowQualificationFixture;
}): CorrectionFlowQualificationManifest {
  if (!/^[a-f0-9]{40}$/u.test(exactHead)) throw new Error("Qualification exact head must be a full Git SHA.");
  providerModeSchema.parse(providerMode);
  if (!fixture.safeLabel.trim() || fixture.safeLabel.length > 160) {
    throw new Error("Qualification fixture safe label is invalid.");
  }
  const calls = callPlan();
  const core = Object.freeze({
    contractVersion: CORRECTION_FLOW_QUALIFICATION_CONTRACT_VERSION,
    exactHead,
    providerMode,
    generatedAt: generatedAt.toISOString(),
    callCount: CORRECTION_FLOW_QUALIFICATION_MAX_CALLS,
    stepTimeoutMs: CORRECTION_FLOW_QUALIFICATION_STEP_TIMEOUT_MS,
    noRetry: true as const,
    syntheticApplicantOnly: true as const,
    productionWrites: false as const,
    employerInteraction: false as const,
    calls,
    conservativeReservationMicros: calls.reduce((total, entry) => total + entry.maximumCostMicros, 0),
    dataCategories,
    fixture: Object.freeze({
      safeLabel: fixture.safeLabel.trim(),
      jobProjectionHash: hashAiInput("correctionFlowJobProjection", "1", fixture.job),
      resumeProjectionHash: hashAiInput("correctionFlowResumeProjection", "1", fixture.resume),
      profileProjectionHash: hashAiInput("correctionFlowProfileProjection", "1", fixture.profile),
      correctionHash: hashAiInput("correctionFlowPredeterminedCorrection", "1", fixture.predeterminedCorrection)
    })
  });
  return Object.freeze({
    ...core,
    manifestHash: hashAiInput("correctionFlowQualificationManifest", "1", core)
  });
}

export const correctionFlowQualificationConsent = z.object({
  manifestHash: sha256Schema,
  exactHead: z.string().regex(/^[a-f0-9]{40}$/u),
  providerMode: providerModeSchema,
  approvedCallCount: z.literal(CORRECTION_FLOW_QUALIFICATION_MAX_CALLS),
  approvedConservativeReservationMicros: z.number().int().nonnegative(),
  approvedStepTimeoutMs: z.literal(CORRECTION_FLOW_QUALIFICATION_STEP_TIMEOUT_MS),
  syntheticApplicantDataSharingApproved: z.literal(true),
  existingCredentialUseApproved: z.boolean(),
  noRetry: z.literal(true),
  noOwnerData: z.literal(true),
  noProductionWrites: z.literal(true),
  noEmployerInteraction: z.literal(true),
  cleanupRequired: z.literal(true),
  approvedAt: z.string().datetime({ offset: true })
}).strict();

export type CorrectionFlowQualificationConsent = z.infer<typeof correctionFlowQualificationConsent>;

const providerCallMetricsSchema = z.object({
  stage: providerStageSchema,
  provider: z.enum(["google-gemini-developer-api", "openai-api"]),
  model: z.string().min(1).max(120),
  promptVersion: z.string().min(1).max(40),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  estimatedCostMicros: z.number().int().nonnegative().nullable(),
  billingStatus: z.enum(["known", "not_charged", "uncertain"]),
  providerCompleted: z.boolean(),
  mocked: z.boolean()
}).strict();

export type CorrectionFlowProviderCallMetrics = z.infer<typeof providerCallMetricsSchema>;

const artifactVerificationSchema = z.object({
  currentEvidenceSnapshotBound: z.boolean(),
  correctionPresent: z.boolean(),
  supersededFactAbsent: z.boolean(),
  unsupportedClaimsAbsent: z.boolean(),
  generatedContentSha256: sha256Schema,
  exportedTextSha256: sha256Schema
}).strict();

const exportVerificationSchema = z.object({
  resume: artifactVerificationSchema,
  coverLetter: artifactVerificationSchema
}).strict();

export type CorrectionFlowExportVerification = z.infer<typeof exportVerificationSchema>;

export type CorrectionFlowQualificationDriver = {
  initialMatch(signal: AbortSignal): Promise<CorrectionFlowProviderCallMetrics>;
  applyPredeterminedCorrection(signal: AbortSignal): Promise<void>;
  updatedMatch(signal: AbortSignal): Promise<CorrectionFlowProviderCallMetrics>;
  generateResume(signal: AbortSignal): Promise<CorrectionFlowProviderCallMetrics>;
  generateCoverLetter(signal: AbortSignal): Promise<CorrectionFlowProviderCallMetrics>;
  verifyExports(signal: AbortSignal): Promise<CorrectionFlowExportVerification>;
  cleanup(signal: AbortSignal): Promise<void>;
};

export type CorrectionFlowQualificationReceipt = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_QUALIFICATION_CONTRACT_VERSION;
  status: "passed" | "stopped";
  manifestHash: string;
  exactHead: string;
  providerMode: CorrectionFlowProviderMode;
  conservativeReservationMicros: number;
  providerCallsStarted: number;
  providerCallsCompleted: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownCachedInputTokens: number;
  knownEstimatedCostMicros: number;
  unknownBillingCallCount: number;
  noRetryAttempted: true;
  failureStage: CorrectionFlowFailureStage | null;
  failureCode: string | null;
  cleanupStatus: "completed" | "failed";
  exportVerification: CorrectionFlowExportVerification | null;
}>;

function assertConsent(
  manifest: CorrectionFlowQualificationManifest,
  value: unknown
): CorrectionFlowQualificationConsent {
  let consent: CorrectionFlowQualificationConsent;
  try {
    consent = correctionFlowQualificationConsent.parse(value);
  } catch {
    throw new Error("Correction-flow qualification consent is invalid.");
  }
  const expectedCredentialApproval = manifest.providerMode === "live_synthetic";
  if (
    consent.manifestHash !== manifest.manifestHash ||
    consent.exactHead !== manifest.exactHead ||
    consent.providerMode !== manifest.providerMode ||
    consent.approvedCallCount !== manifest.callCount ||
    consent.approvedConservativeReservationMicros !== manifest.conservativeReservationMicros ||
    consent.approvedStepTimeoutMs !== manifest.stepTimeoutMs ||
    consent.existingCredentialUseApproved !== expectedCredentialApproval
  ) {
    throw new Error("Correction-flow qualification consent does not match the frozen manifest.");
  }
  return consent;
}

function safeFailureCode(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "EXECUTION_CANCELLED";
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code)
    ? code
    : "STEP_FAILED";
}

function assertCallMetrics(
  manifest: CorrectionFlowQualificationManifest,
  expectedStage: CorrectionFlowProviderStage,
  metrics: CorrectionFlowProviderCallMetrics
) {
  const plan = manifest.calls.find((entry) => entry.stage === expectedStage);
  if (!plan ||
    metrics.stage !== expectedStage ||
    metrics.provider !== plan.provider ||
    metrics.model !== plan.model ||
    metrics.promptVersion !== plan.promptVersion ||
    metrics.mocked !== (manifest.providerMode === "offline_stubbed")) {
    throw Object.assign(new Error("Provider call did not match the frozen qualification plan."), {
      code: "PROVIDER_IDENTITY_MISMATCH"
    });
  }
  if (!metrics.providerCompleted || metrics.billingStatus !== "known" ||
    metrics.inputTokens === null || metrics.outputTokens === null ||
    metrics.cachedInputTokens === null || metrics.estimatedCostMicros === null) {
    throw Object.assign(new Error("Provider call metrics are incomplete."), {
      code: "PROVIDER_METRICS_INCOMPLETE"
    });
  }
  if (metrics.cachedInputTokens > metrics.inputTokens) {
    throw Object.assign(new Error("Provider call metrics are inconsistent."), {
      code: "PROVIDER_METRICS_INVALID"
    });
  }
  if (metrics.inputTokens > plan.maximumInputTokens || metrics.outputTokens > plan.maximumOutputTokens) {
    throw Object.assign(new Error("Provider usage exceeded the frozen token envelope."), {
      code: "CONSERVATIVE_RESERVATION_EXCEEDED"
    });
  }
  const expectedCostMicros = estimateAiCostMicros({
    model: plan.model,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cachedInputTokens: metrics.cachedInputTokens
  });
  if (metrics.estimatedCostMicros !== expectedCostMicros) {
    throw Object.assign(new Error("Provider usage cost does not match the frozen pricing registry."), {
      code: "PROVIDER_COST_MISMATCH"
    });
  }
  if (metrics.estimatedCostMicros !== null && metrics.estimatedCostMicros > plan.maximumCostMicros) {
    throw Object.assign(new Error("Provider usage exceeded the conservative reservation."), {
      code: "CONSERVATIVE_RESERVATION_EXCEEDED"
    });
  }
  return metrics;
}

export function hasDirtyCorrectionFlowQualificationWorktree(status: string) {
  return status.trim().length > 0;
}

function stepTimeoutError() {
  return Object.assign(new Error("Qualification step exceeded its timeout."), {
    code: "STEP_TIMEOUT"
  });
}

function exportsPassed(value: CorrectionFlowExportVerification) {
  return [value.resume, value.coverLetter].every((artifact) =>
    artifact.currentEvidenceSnapshotBound &&
    artifact.correctionPresent &&
    artifact.supersededFactAbsent &&
    artifact.unsupportedClaimsAbsent);
}

export async function runCorrectionFlowQualification({
  manifest,
  consent: consentValue,
  driver,
  signal: suppliedSignal,
  stepTimeoutMs = manifest.stepTimeoutMs
}: {
  manifest: CorrectionFlowQualificationManifest;
  consent: unknown;
  driver: CorrectionFlowQualificationDriver;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
}): Promise<CorrectionFlowQualificationReceipt> {
  assertConsent(manifest, consentValue);
  if (!Number.isSafeInteger(stepTimeoutMs) || stepTimeoutMs < 1 || stepTimeoutMs > manifest.stepTimeoutMs) {
    throw new Error("Correction-flow qualification step timeout is invalid.");
  }
  const signal = suppliedSignal ?? new AbortController().signal;
  let status: "passed" | "stopped" = "stopped";
  let failureStage: CorrectionFlowFailureStage | null = null;
  let failureCode: string | null = null;
  let providerCallsStarted = 0;
  let providerCallsCompleted = 0;
  let knownInputTokens = 0;
  let knownOutputTokens = 0;
  let knownCachedInputTokens = 0;
  let knownEstimatedCostMicros = 0;
  let unknownBillingCallCount = 0;
  let exportVerification: CorrectionFlowExportVerification | null = null;
  let cleanupStatus: "completed" | "failed" = "completed";

  const recordKnownUsage = ({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedCostMicros
  }: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    estimatedCostMicros: number;
  }) => {
    knownInputTokens += inputTokens;
    knownOutputTokens += outputTokens;
    knownCachedInputTokens += cachedInputTokens;
    knownEstimatedCostMicros += estimatedCostMicros;
  };
  const coherentKnownUsage = (
    value: Record<string, unknown>,
    plan: CorrectionFlowQualificationManifest["calls"][number]
  ) => {
    const inputTokens = value.inputTokens;
    const outputTokens = value.outputTokens;
    const cachedInputTokens = value.cachedInputTokens;
    const estimatedCostMicros = value.estimatedCostMicros;
    if (value.billingStatus !== "known" ||
      !Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0 ||
      !Number.isSafeInteger(outputTokens) || Number(outputTokens) < 0 ||
      !Number.isSafeInteger(cachedInputTokens) || Number(cachedInputTokens) < 0 ||
      !Number.isSafeInteger(estimatedCostMicros) || Number(estimatedCostMicros) < 0 ||
      Number(cachedInputTokens) > Number(inputTokens)) {
      return null;
    }
    const usage = {
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
      cachedInputTokens: Number(cachedInputTokens),
      estimatedCostMicros: Number(estimatedCostMicros)
    };
    return usage.estimatedCostMicros === estimateAiCostMicros({ model: plan.model, ...usage })
      ? usage
      : null;
  };

  const boundedStep = async <T>(
    invoke: (stepSignal: AbortSignal) => Promise<T>,
    includeSuppliedSignal = true
  ): Promise<T> => {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(stepTimeoutError()), stepTimeoutMs);
    const stepSignal = includeSuppliedSignal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (stepSignal.aborted) reject(stepSignal.reason);
      else stepSignal.addEventListener("abort", () => reject(stepSignal.reason), { once: true });
    });
    try {
      return await Promise.race([invoke(stepSignal), aborted]);
    } finally {
      clearTimeout(timeout);
    }
  };

  const requireActive = () => {
    if (signal.aborted) {
      throw Object.assign(new Error("Qualification execution was cancelled."), {
        code: "EXECUTION_CANCELLED"
      });
    }
  };
  const providerCall = async (
    stage: CorrectionFlowProviderStage,
    invoke: (signal: AbortSignal) => Promise<CorrectionFlowProviderCallMetrics>
  ) => {
    requireActive();
    const plan = manifest.calls.find((entry) => entry.stage === stage);
    if (!plan) throw new Error("Qualification provider stage is not in the frozen manifest.");
    providerCallsStarted += 1;
    let rawMetrics: unknown;
    try {
      rawMetrics = await boundedStep(invoke);
    } catch (error) {
      const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
      const knownUsage = coherentKnownUsage(failure, plan);
      if (knownUsage) recordKnownUsage(knownUsage);
      else if (failure.billingStatus !== "not_charged") unknownBillingCallCount += 1;
      throw error;
    }
    let metrics: CorrectionFlowProviderCallMetrics;
    try {
      metrics = providerCallMetricsSchema.parse(rawMetrics);
    } catch (error) {
      unknownBillingCallCount += 1;
      throw Object.assign(new Error("Provider call metrics are invalid."), {
        code: "PROVIDER_METRICS_INVALID",
        cause: error
      });
    }
    if (metrics.providerCompleted) providerCallsCompleted += 1;
    const knownUsage = coherentKnownUsage(metrics, plan);
    if (knownUsage) recordKnownUsage(knownUsage);
    else if (metrics.billingStatus !== "not_charged") unknownBillingCallCount += 1;
    return assertCallMetrics(manifest, stage, metrics);
  };

  try {
    failureStage = "initial_match";
    await providerCall("initial_match", driver.initialMatch);
    failureStage = "apply_correction";
    requireActive();
    await boundedStep(driver.applyPredeterminedCorrection);
    failureStage = "updated_match";
    await providerCall("updated_match", driver.updatedMatch);
    failureStage = "tailored_resume";
    await providerCall("tailored_resume", driver.generateResume);
    failureStage = "cover_letter";
    await providerCall("cover_letter", driver.generateCoverLetter);
    failureStage = "verify_exports";
    requireActive();
    exportVerification = exportVerificationSchema.parse(await boundedStep(driver.verifyExports));
    if (!exportsPassed(exportVerification)) {
      throw Object.assign(new Error("Export verification failed."), {
        code: "EXPORT_VERIFICATION_FAILED"
      });
    }
    if (knownEstimatedCostMicros > manifest.conservativeReservationMicros) {
      throw Object.assign(new Error("Qualification usage exceeded its conservative reservation."), {
        code: "CONSERVATIVE_RESERVATION_EXCEEDED"
      });
    }
    status = "passed";
    failureStage = null;
  } catch (error) {
    status = "stopped";
    failureCode = safeFailureCode(error, signal);
  } finally {
    try {
      await boundedStep(driver.cleanup, false);
    } catch {
      cleanupStatus = "failed";
      status = "stopped";
      if (!failureCode) {
        failureStage = "cleanup";
        failureCode = "CLEANUP_FAILED";
      }
    }
  }

  return Object.freeze({
    contractVersion: CORRECTION_FLOW_QUALIFICATION_CONTRACT_VERSION,
    status,
    manifestHash: manifest.manifestHash,
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    conservativeReservationMicros: manifest.conservativeReservationMicros,
    providerCallsStarted,
    providerCallsCompleted,
    knownInputTokens,
    knownOutputTokens,
    knownCachedInputTokens,
    knownEstimatedCostMicros,
    unknownBillingCallCount,
    noRetryAttempted: true,
    failureStage,
    failureCode,
    cleanupStatus,
    exportVerification
  });
}
