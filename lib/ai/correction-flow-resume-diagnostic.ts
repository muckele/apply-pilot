import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

import { PublicApiError } from "@/lib/api-errors";
import {
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  APPLICATION_DOCUMENT_MODEL,
  APPLICATION_DOCUMENT_PROMPT_VERSION,
  APPLICATION_DOCUMENT_THINKING_LEVEL
} from "@/lib/ai/application-document-version";
import { assertConservativeApplicationDocumentWireBound } from "@/lib/ai/client";
import {
  buildGeminiJsonRequest,
  callGeminiJsonProvider,
  GeminiProviderError,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { hashAiInput } from "@/lib/ai/input-hash";
import { assertAiInputWithinLimits, AI_FEATURE_POLICIES } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  buildTailoredResumeGeminiJsonSchema,
  buildTailoredResumeSystemPrompt,
  tailoredResumeSchema
} from "@/lib/ai/resume";

export const CORRECTION_FLOW_RESUME_DIAGNOSTIC_CONTRACT_VERSION = "1" as const;
export const CORRECTION_FLOW_RESUME_DIAGNOSTIC_STEP_TIMEOUT_MS = 180_000 as const;

const FROZEN_SYNTHETIC_PAYLOAD_HASH =
  "8101fc98203c04abb7963b211a0a8542ed81f5faf8772e98cf6719e0635635c0";
const FROZEN_SYNTHETIC_REVIEWED_EVIDENCE_HASH =
  "7646bd358e0b45e25d74d1a85c66a7d9ed8bb7eafbd39b833e8a3863c29505ec";

const providerModeSchema = z.enum(["offline_stubbed", "live_synthetic"]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export type CorrectionFlowResumeDiagnosticManifest = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_RESUME_DIAGNOSTIC_CONTRACT_VERSION;
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  generatedAt: string;
  callCount: 1;
  stepTimeoutMs: typeof CORRECTION_FLOW_RESUME_DIAGNOSTIC_STEP_TIMEOUT_MS;
  noRetry: true;
  noFallback: true;
  syntheticApplicantOnly: true;
  rawOutputRetention: false;
  productionWrites: false;
  employerInteraction: false;
  safeLabel: string;
  call: Readonly<{
    stage: "tailored_resume";
    provider: "google-gemini-developer-api";
    model: typeof APPLICATION_DOCUMENT_MODEL;
    promptVersion: typeof APPLICATION_DOCUMENT_PROMPT_VERSION;
    thinkingLevel: typeof APPLICATION_DOCUMENT_THINKING_LEVEL;
    maximumInputTokens: number;
    maximumOutputTokens: number;
    maximumCostMicros: number;
  }>;
  conservativeReservationMicros: number;
  payloadHash: string;
  reviewedEvidenceHash: string;
  schemaHash: string;
  wireRequestHash: string;
  manifestHash: string;
}>;

function diagnosticCall() {
  const maximumCostMicros = estimateAiCostMicros({
    model: APPLICATION_DOCUMENT_MODEL,
    inputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens
  });
  return Object.freeze({
    stage: "tailored_resume" as const,
    provider: "google-gemini-developer-api" as const,
    model: APPLICATION_DOCUMENT_MODEL,
    promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL,
    maximumInputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens,
    maximumOutputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens,
    maximumCostMicros
  });
}

function productionRequestBody(payload: ApplicationDocumentPayload) {
  const systemPrompt = buildTailoredResumeSystemPrompt(payload);
  const responseJsonSchema = buildTailoredResumeGeminiJsonSchema(payload);
  const { policy } = assertAiInputWithinLimits("RESUME_TAILOR", systemPrompt, {
    payload,
    responseJsonSchema
  });
  const body = buildGeminiJsonRequest({
    systemPrompt,
    payload,
    responseJsonSchema,
    maxOutputTokens: policy.maxOutputTokens,
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
  });
  assertConservativeApplicationDocumentWireBound("RESUME_TAILOR", policy.maxInputTokens, body);
  return body;
}

export function buildCorrectionFlowResumeDiagnosticManifest({
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
}): CorrectionFlowResumeDiagnosticManifest {
  if (!/^[a-f0-9]{40}$/u.test(exactHead)) throw new Error("Diagnostic exact head must be a full Git SHA.");
  providerModeSchema.parse(providerMode);
  const normalizedLabel = safeLabel.trim();
  if (!normalizedLabel || normalizedLabel.length > 160) throw new Error("Diagnostic safe label is invalid.");
  if (!payload.reviewedEvidence) throw new Error("Diagnostic reviewed evidence is required.");
  const payloadHash = hashAiInput("correctionFlowResumeDiagnosticPayload", "1", payload);
  const reviewedEvidenceHash = hashAiInput(
    "correctionFlowResumeDiagnosticReviewedEvidence",
    "1",
    payload.reviewedEvidence
  );
  if (
    payloadHash !== FROZEN_SYNTHETIC_PAYLOAD_HASH ||
    reviewedEvidenceHash !== FROZEN_SYNTHETIC_REVIEWED_EVIDENCE_HASH
  ) {
    throw new Error("Resume diagnostic requires the exact frozen synthetic fixture.");
  }
  const call = diagnosticCall();
  const core = Object.freeze({
    contractVersion: CORRECTION_FLOW_RESUME_DIAGNOSTIC_CONTRACT_VERSION,
    exactHead,
    providerMode,
    generatedAt: generatedAt.toISOString(),
    callCount: 1 as const,
    stepTimeoutMs: CORRECTION_FLOW_RESUME_DIAGNOSTIC_STEP_TIMEOUT_MS,
    noRetry: true as const,
    noFallback: true as const,
    syntheticApplicantOnly: true as const,
    rawOutputRetention: false as const,
    productionWrites: false as const,
    employerInteraction: false as const,
    safeLabel: normalizedLabel,
    call,
    conservativeReservationMicros: call.maximumCostMicros,
    payloadHash,
    reviewedEvidenceHash,
    schemaHash: hashAiInput(
      "correctionFlowResumeDiagnosticSchema",
      "1",
      buildTailoredResumeGeminiJsonSchema(payload)
    ),
    wireRequestHash: hashAiInput("correctionFlowProviderWire", "1", productionRequestBody(payload))
  });
  return Object.freeze({
    ...core,
    manifestHash: hashAiInput("correctionFlowResumeDiagnosticManifest", "1", core)
  });
}

export const correctionFlowResumeDiagnosticConsent = z.object({
  manifestHash: sha256Schema,
  exactHead: z.string().regex(/^[a-f0-9]{40}$/u),
  providerMode: providerModeSchema,
  approvedCallCount: z.literal(1),
  approvedConservativeReservationMicros: z.number().int().nonnegative(),
  approvedStepTimeoutMs: z.literal(CORRECTION_FLOW_RESUME_DIAGNOSTIC_STEP_TIMEOUT_MS),
  syntheticApplicantDataSharingApproved: z.literal(true),
  existingCredentialUseApproved: z.boolean(),
  noRetry: z.literal(true),
  noFallback: z.literal(true),
  noOwnerData: z.literal(true),
  noProductionWrites: z.literal(true),
  noEmployerInteraction: z.literal(true),
  rawOutputRetention: z.literal(false),
  approvedAt: z.string().datetime({ offset: true })
}).strict();

export type CorrectionFlowResumeDiagnosticConsent = z.infer<typeof correctionFlowResumeDiagnosticConsent>;

function assertConsent(
  manifest: CorrectionFlowResumeDiagnosticManifest,
  value: unknown
) {
  const consent = correctionFlowResumeDiagnosticConsent.parse(value);
  if (
    consent.manifestHash !== manifest.manifestHash ||
    consent.exactHead !== manifest.exactHead ||
    consent.providerMode !== manifest.providerMode ||
    consent.approvedConservativeReservationMicros !== manifest.conservativeReservationMicros ||
    consent.existingCredentialUseApproved !== (manifest.providerMode === "live_synthetic")
  ) throw new Error("Resume diagnostic consent does not match the frozen manifest.");
  return consent;
}

function outputFieldPath(path: readonly PropertyKey[]) {
  let value = "output";
  for (const part of path) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) value += `[${part}]`;
    else if (typeof part === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(part)) value += `.${part}`;
    else return null;
  }
  return value.length <= 240 ? value : null;
}

function validatorFieldPath(value: unknown) {
  if (typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:(?:\.[A-Za-z][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/u.test(value)) return null;
  const parts = (value.match(/[A-Za-z][A-Za-z0-9_-]*|\[\d+\]/gu) ?? [])
    .map((part) => part.startsWith("[") ? Number(part.slice(1, -1)) : part);
  return outputFieldPath(parts);
}

export type CorrectionFlowResumeDiagnosticReceipt = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_RESUME_DIAGNOSTIC_CONTRACT_VERSION;
  status: "passed" | "stopped";
  manifestHash: string;
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  conservativeReservationMicros: number;
  providerCallsStarted: number;
  providerCallsCompleted: number;
  providerHttpStatus: number | null;
  finishReason: "STOP" | null;
  jsonParseStatus: "parsed" | "not_parsed";
  knownInputTokens: number;
  knownOutputTokens: number;
  knownCachedInputTokens: number;
  knownEstimatedCostMicros: number;
  unknownBillingCallCount: number;
  noRetryAttempted: true;
  noFallbackAttempted: true;
  rawOutputRetained: false;
  failureCode: string | null;
  failureClass: "unsupported_applicant_term" | "source_relation_mismatch" | null;
  failureFieldPath: string | null;
  validatedOutputHash: string | null;
}>;

function baseReceipt(manifest: CorrectionFlowResumeDiagnosticManifest): CorrectionFlowResumeDiagnosticReceipt {
  return {
    contractVersion: CORRECTION_FLOW_RESUME_DIAGNOSTIC_CONTRACT_VERSION,
    status: "stopped",
    manifestHash: manifest.manifestHash,
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    conservativeReservationMicros: manifest.conservativeReservationMicros,
    providerCallsStarted: 0,
    providerCallsCompleted: 0,
    providerHttpStatus: null,
    finishReason: null,
    jsonParseStatus: "not_parsed",
    knownInputTokens: 0,
    knownOutputTokens: 0,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 0,
    unknownBillingCallCount: 0,
    noRetryAttempted: true,
    noFallbackAttempted: true,
    rawOutputRetained: false,
    failureCode: null,
    failureClass: null,
    failureFieldPath: null,
    validatedOutputHash: null
  };
}

function usageFields(usage: GeminiUsage | null) {
  const knownEstimatedCostMicros = usage ? estimateAiCostMicros({
    model: APPLICATION_DOCUMENT_MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens
  }) : 0;
  return {
    knownInputTokens: usage?.inputTokens ?? 0,
    knownOutputTokens: usage?.outputTokens ?? 0,
    knownCachedInputTokens: usage?.cachedInputTokens ?? 0,
    knownEstimatedCostMicros
  };
}

export function createCorrectionFlowResumeDiagnosticRunner({
  manifest,
  consent,
  payload,
  credentials,
  fetchImpl
}: {
  manifest: CorrectionFlowResumeDiagnosticManifest;
  consent: CorrectionFlowResumeDiagnosticConsent;
  payload: ApplicationDocumentPayload;
  credentials: Readonly<{ geminiApiKey: string }>;
  fetchImpl?: typeof fetch;
}) {
  const canonical = buildCorrectionFlowResumeDiagnosticManifest({
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    generatedAt: new Date(manifest.generatedAt),
    payload,
    safeLabel: manifest.safeLabel
  });
  if (!isDeepStrictEqual(canonical, manifest)) {
    throw new Error("Resume diagnostic payload or metadata does not match the frozen manifest.");
  }
  assertConsent(canonical, consent);
  if (manifest.providerMode === "offline_stubbed" && typeof fetchImpl !== "function") {
    throw new Error("Offline resume diagnostic requires an injected transport.");
  }
  if (manifest.providerMode === "live_synthetic" && fetchImpl !== undefined) {
    throw new Error("Live resume diagnostic transport override is forbidden.");
  }
  const apiKey = credentials.geminiApiKey.trim();
  if (!apiKey) throw new Error("Gemini credential is required.");
  let used = false;

  return Object.freeze({
    async run(signal: AbortSignal): Promise<CorrectionFlowResumeDiagnosticReceipt> {
      if (used) return { ...baseReceipt(manifest), failureCode: "DIAGNOSTIC_CALL_ALREADY_USED" };
      used = true;
      const initial = { ...baseReceipt(manifest), providerCallsStarted: 1 };
      let usage: GeminiUsage | null = null;
      try {
        const systemPrompt = buildTailoredResumeSystemPrompt(payload);
        const responseJsonSchema = buildTailoredResumeGeminiJsonSchema(payload);
        const response = await callGeminiJsonProvider({
          apiKey,
          model: APPLICATION_DOCUMENT_MODEL,
          systemPrompt,
          payload,
          responseJsonSchema,
          maxOutputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens,
          thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL,
          timeoutMs: manifest.stepTimeoutMs,
          maxResponseBytes: 1_000_000,
          fetchImpl,
          signal
        });
        usage = response.usage;
        const usageValues = usageFields(usage);
        if (
          usage.inputTokens > manifest.call.maximumInputTokens ||
          usage.outputTokens > manifest.call.maximumOutputTokens ||
          usage.cachedInputTokens > usage.inputTokens ||
          usageValues.knownEstimatedCostMicros > manifest.call.maximumCostMicros
        ) {
          return {
            ...initial,
            ...usageValues,
            providerCallsCompleted: 1,
            providerHttpStatus: 200,
            finishReason: "STOP",
            jsonParseStatus: "parsed",
            failureCode: "CONSERVATIVE_RESERVATION_EXCEEDED"
          };
        }
        const parsed = tailoredResumeSchema.safeParse(response.value);
        if (!parsed.success) {
          return {
            ...initial,
            ...usageValues,
            providerCallsCompleted: 1,
            providerHttpStatus: 200,
            finishReason: "STOP",
            jsonParseStatus: "parsed",
            failureCode: "PROVIDER_DOCUMENT_SCHEMA_INVALID",
            failureFieldPath: outputFieldPath(parsed.error.issues[0]?.path ?? [])
          };
        }
        let validated;
        try {
          validated = validateTailoredResumeClaims(payload, parsed.data);
        } catch (error) {
          const code = error instanceof PublicApiError &&
            typeof error.details?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.details.code)
            ? error.details.code
            : "PROVIDER_DOCUMENT_CLAIM_INVALID";
          const failureClass = error instanceof PublicApiError &&
            (error.details?.failureClass === "unsupported_applicant_term" ||
              error.details?.failureClass === "source_relation_mismatch")
            ? error.details.failureClass
            : null;
          return {
            ...initial,
            ...usageValues,
            providerCallsCompleted: 1,
            providerHttpStatus: 200,
            finishReason: "STOP",
            jsonParseStatus: "parsed",
            failureCode: code,
            failureClass,
            failureFieldPath: error instanceof PublicApiError
              ? validatorFieldPath(error.details?.fieldPath)
              : null
          };
        }
        return {
          ...initial,
          ...usageValues,
          status: "passed",
          providerCallsCompleted: 1,
          providerHttpStatus: 200,
          finishReason: "STOP",
          jsonParseStatus: "parsed",
          validatedOutputHash: hashAiInput("correctionFlowResumeDiagnosticValidatedOutput", "1", validated)
        };
      } catch (error) {
        const provider = error instanceof GeminiProviderError ? error : null;
        const providerUsage = provider?.usage ?? usage;
        return {
          ...initial,
          ...usageFields(providerUsage),
          providerCallsCompleted: provider?.providerResponded === true ? 1 : 0,
          providerHttpStatus: provider?.httpStatus ?? null,
          unknownBillingCallCount: provider?.billingDisposition === "not_charged" || providerUsage ? 0 : 1,
          failureCode: signal.aborted ? "EXECUTION_CANCELLED" : "GEMINI_PROVIDER_FAILED"
        };
      }
    }
  });
}
