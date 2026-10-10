import type { CorrectionFlowQualificationFixture } from "@/lib/ai/correction-flow-qualification";
import {
  assertCorrectionFlowQualificationConsent,
  buildCorrectionFlowQualificationManifest,
  correctionFlowManifestEnvelopeHash,
  correctionFlowProjectionHash,
  type CorrectionFlowProviderCallMetrics,
  type CorrectionFlowProviderStage,
  type CorrectionFlowQualificationConsent,
  type CorrectionFlowQualificationManifest
} from "@/lib/ai/correction-flow-qualification";
import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  type CoverLetterProviderOutput,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import {
  APPLICATION_DOCUMENT_THINKING_LEVEL
} from "@/lib/ai/application-document-version";
import { assertConservativeApplicationDocumentWireBound } from "@/lib/ai/client";
import {
  buildCoverLetterGeminiJsonSchema,
  buildCoverLetterSystemPrompt,
  coverLetterProviderSchema,
  coverLetterSchema
} from "@/lib/ai/documents";
import { buildGeminiJsonRequest, callGeminiJsonProvider, GeminiProviderError } from "@/lib/ai/gemini";
import { hashAiInput } from "@/lib/ai/input-hash";
import {
  buildJobMatchResponseJsonSchema,
  buildJobMatchSystemPrompt,
  validateAndNormalizeJobMatchOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import {
  JOB_MATCH_MODEL,
  JOB_MATCH_PROMPT_VERSION,
  JOB_MATCH_THINKING_LEVEL
} from "@/lib/ai/job-match-version";
import { assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  buildTailoredResumeGeminiJsonSchema,
  buildTailoredResumeSystemPrompt,
  tailoredResumeProviderSchema,
  tailoredResumeSchema,
  type TailoredResumeOutput
} from "@/lib/ai/resume";
import { PublicApiError } from "@/lib/api-errors";

type ProviderFetch = typeof fetch;

export type CorrectionFlowProviderFetches = Readonly<{
  gemini?: ProviderFetch;
}>;

export type CorrectionFlowProviderCredentials = Readonly<{
  geminiApiKey: string;
}>;

type ProviderUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}>;

type CoverLetterOutput = ReturnType<typeof coverLetterSchema.parse>;

export class CorrectionFlowProviderAdapterError extends Error {
  readonly code: string;
  readonly fieldPath: string | null;
  readonly billingStatus: "known" | "not_charged" | "uncertain";
  readonly providerCompleted: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly estimatedCostMicros: number | null;

  constructor(code: string, message: string, options: {
    billingStatus?: "known" | "not_charged" | "uncertain";
    providerCompleted?: boolean;
    usage?: ProviderUsage | null;
    estimatedCostMicros?: number | null;
    fieldPath?: string | null;
  } = {}) {
    super(message);
    this.name = "CorrectionFlowProviderAdapterError";
    this.code = code;
    this.fieldPath = options.fieldPath ?? null;
    this.billingStatus = options.billingStatus ?? "not_charged";
    this.providerCompleted = options.providerCompleted ?? false;
    this.inputTokens = options.usage?.inputTokens ?? null;
    this.outputTokens = options.usage?.outputTokens ?? null;
    this.cachedInputTokens = options.usage?.cachedInputTokens ?? null;
    this.estimatedCostMicros = options.estimatedCostMicros ?? null;
  }
}

function adapterError(code: string, message: string, fieldPath: string | null = null) {
  return new CorrectionFlowProviderAdapterError(code, message, { fieldPath });
}

function outputFieldPath(path: readonly PropertyKey[]) {
  let value = "output";
  for (const part of path) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      value += `[${part}]`;
    } else if (typeof part === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(part)) {
      value += `.${part}`;
    } else {
      return null;
    }
  }
  return value.length <= 240 ? value : null;
}

function validatorOutputFieldPath(sourcePath: string) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*(?:(?:\.[A-Za-z][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/u.test(sourcePath)) {
    return null;
  }
  const parts: PropertyKey[] = [];
  for (const part of sourcePath.match(/[A-Za-z][A-Za-z0-9_-]*|\[\d+\]/gu) ?? []) {
    parts.push(part.startsWith("[") ? Number(part.slice(1, -1)) : part);
  }
  return outputFieldPath(parts);
}

function claimValidationFailure(error: unknown) {
  if (!(error instanceof PublicApiError)) return {
    code: "PROVIDER_DOCUMENT_CLAIM_INVALID",
    fieldPath: null
  };
  const code = error.details?.code;
  const sourcePath = error.details?.fieldPath;
  return {
    code: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code)
      ? code
      : "PROVIDER_DOCUMENT_CLAIM_INVALID",
    fieldPath: typeof sourcePath === "string"
      ? validatorOutputFieldPath(sourcePath)
      : null
  };
}

function nonemptyCredential(value: string, provider: string) {
  if (!value.trim()) throw adapterError("PROVIDER_CREDENTIAL_MISSING", `${provider} credential is required.`);
  return value.trim();
}

function metrics(
  manifest: CorrectionFlowQualificationManifest,
  stage: CorrectionFlowProviderStage,
  usage: ProviderUsage
): CorrectionFlowProviderCallMetrics {
  const plan = manifest.calls.find((entry) => entry.stage === stage);
  if (!plan) throw adapterError("PROVIDER_STAGE_NOT_APPROVED", "Provider stage is absent from the manifest.");
  const estimatedCostMicros = estimateAiCostMicros({ model: plan.model, ...usage });
  if (
    usage.inputTokens > plan.maximumInputTokens ||
    usage.outputTokens > plan.maximumOutputTokens ||
    usage.cachedInputTokens > usage.inputTokens ||
    estimatedCostMicros > plan.maximumCostMicros
  ) {
    throw new CorrectionFlowProviderAdapterError(
      "CONSERVATIVE_RESERVATION_EXCEEDED",
      "Provider usage exceeded the approved qualification envelope.",
      { billingStatus: "known", providerCompleted: true, usage, estimatedCostMicros }
    );
  }
  return {
    stage,
    provider: plan.provider,
    model: plan.model,
    promptVersion: plan.promptVersion,
    ...usage,
    estimatedCostMicros,
    billingStatus: "known",
    providerCompleted: true,
    mocked: manifest.providerMode === "offline_stubbed"
  };
}

function reviewedCorrectionFact(fixture: CorrectionFlowQualificationFixture) {
  const value = fixture.predeterminedCorrection;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const correction = value as Record<string, unknown>;
  const fact = correction.fact;
  return correction.kind === "OWNER_ATTESTATION" &&
    correction.reuseScope === "JOB_ONLY" &&
    correction.masterProfileOptIn === false &&
    typeof fact === "string" && fact.trim()
    ? fact
    : null;
}

function hasExactReviewedCorrection(input: { reviewedEvidence?: unknown }, expectedFact: string) {
  const reviewed = input.reviewedEvidence;
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) return false;
  const evidence = reviewed as Record<string, unknown>;
  if (!sameKeys(evidence, ["schema", "snapshotId", "snapshotHash", "facts", "unresolvedGapIds"])) {
    return false;
  }
  const facts = evidence.facts;
  const unresolvedGapIds = evidence.unresolvedGapIds;
  if (
    evidence.schema !== "apply-pilot/job-match-reviewed-evidence/v1" ||
    typeof evidence.snapshotId !== "string" || !/^[A-Za-z0-9_-]{1,191}$/u.test(evidence.snapshotId) ||
    typeof evidence.snapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.snapshotHash) ||
    !Array.isArray(unresolvedGapIds) || unresolvedGapIds.length !== 0 ||
    !Array.isArray(facts) || facts.length !== 1
  ) return false;
  const fact = facts[0];
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) return false;
  const record = fact as Record<string, unknown>;
  return sameKeys(record, ["gapId", "fact", "provenance", "sourceRef"]) &&
    typeof record.gapId === "string" && /^gap:[0-9]+$/u.test(record.gapId) &&
    record.fact === expectedFact &&
    record.provenance === "OWNER_ATTESTED" &&
    record.sourceRef === null;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

export function createCorrectionFlowProviderAdapter({
  manifest,
  consent,
  fixture,
  credentials,
  fetches = {}
}: {
  manifest: CorrectionFlowQualificationManifest;
  consent: CorrectionFlowQualificationConsent;
  fixture: CorrectionFlowQualificationFixture;
  credentials: CorrectionFlowProviderCredentials;
  fetches?: CorrectionFlowProviderFetches;
}) {
  assertCorrectionFlowQualificationConsent(manifest, consent);
  if (manifest.providerMode === "offline_stubbed" &&
    typeof fetches.gemini !== "function") {
    throw adapterError(
      "OFFLINE_TRANSPORT_REQUIRED",
      "Offline qualification requires an explicit Gemini stub transport."
    );
  }
  if (manifest.providerMode === "live_synthetic" &&
    fetches.gemini !== undefined) {
    throw adapterError(
      "LIVE_TRANSPORT_OVERRIDE_FORBIDDEN",
      "Live qualification requires the supported provider transports."
    );
  }
  const geminiApiKey = nonemptyCredential(credentials.geminiApiKey, "Gemini");
  const started: CorrectionFlowProviderStage[] = [];
  const completed: CorrectionFlowProviderStage[] = [];
  let stopped = false;
  let inFlight: CorrectionFlowProviderStage | null = null;

  const expectedManifest = buildCorrectionFlowQualificationManifest({
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    generatedAt: new Date(manifest.generatedAt),
    fixture
  });
  if (correctionFlowManifestEnvelopeHash(expectedManifest) !==
    correctionFlowManifestEnvelopeHash(manifest)) {
    throw adapterError("MANIFEST_FIXTURE_MISMATCH", "Qualification manifest is not canonical for the fixture.");
  }
  const correctionFact = reviewedCorrectionFact(fixture);

  function assertPayload(stage: CorrectionFlowProviderStage, input: {
    job?: unknown;
    resume?: unknown;
    profile?: unknown;
    reviewedEvidence?: unknown;
  }) {
    const projections = [
      ["job", "Job", input.job, manifest.fixture.jobProjectionHash],
      ["resume", "Resume", input.resume, manifest.fixture.resumeProjectionHash],
      ["profile", "Profile", input.profile, manifest.fixture.profileProjectionHash]
    ] as const;
    const mismatch = projections.find(([, projectionName, projection, expected]) =>
      correctionFlowProjectionHash(projectionName, projection) !== expected);
    if (mismatch) {
      throw adapterError(
        "MANIFEST_INPUT_MISMATCH",
        "Qualification input does not match the frozen manifest.",
        mismatch[0]
      );
    }
    if (!correctionFact) {
      throw adapterError("MANIFEST_CORRECTION_INVALID", "Qualification correction is invalid.");
    }
    const reviewedEvidenceAbsent = input.reviewedEvidence === null || input.reviewedEvidence === undefined;
    const exactCorrectionPresent = hasExactReviewedCorrection(input, correctionFact);
    if ((stage === "initial_match" && !reviewedEvidenceAbsent) ||
      (stage !== "initial_match" && !exactCorrectionPresent)) {
      throw adapterError(
        "MANIFEST_CORRECTION_MISMATCH",
        "Qualification reviewed evidence does not match the approved stage.",
        "reviewedEvidence"
      );
    }
  }

  function begin(stage: CorrectionFlowProviderStage, input: Parameters<typeof assertPayload>[1]) {
    if (stopped) throw adapterError("PROVIDER_ADAPTER_STOPPED", "Qualification adapter is stopped; no retry is permitted.");
    if (inFlight !== null || started.length !== completed.length) {
      throw adapterError("PROVIDER_CALL_IN_FLIGHT", "A qualification provider call is already in flight.");
    }
    if (started.length >= manifest.callCount) {
      throw adapterError("PROVIDER_CALL_LIMIT_REACHED", "Qualification provider-call limit has been reached.");
    }
    const expected = manifest.calls[started.length]?.stage;
    if (expected !== stage) {
      throw adapterError("PROVIDER_CALL_ORDER_MISMATCH", "Qualification provider call is out of order.");
    }
    assertPayload(stage, input);
    started.push(stage);
    inFlight = stage;
  }

  function finish(stage: CorrectionFlowProviderStage) {
    if (inFlight !== stage) {
      throw adapterError("PROVIDER_CALL_STATE_INVALID", "Qualification provider-call state is invalid.");
    }
    completed.push(stage);
    inFlight = null;
  }

  async function scoreMatch(
    stage: "initial_match" | "updated_match",
    input: MatchInput,
    signal: AbortSignal
  ) {
    begin(stage, input);
    try {
      const systemPrompt = buildJobMatchSystemPrompt(input);
      const responseJsonSchema = buildJobMatchResponseJsonSchema(input);
      const { policy } = assertAiInputWithinLimits("JOB_MATCH", systemPrompt, {
        matchInput: input,
        responseJsonSchema
      });
      const response = await callGeminiJsonProvider({
        apiKey: geminiApiKey,
        model: JOB_MATCH_MODEL,
        systemPrompt,
        payload: input,
        responseJsonSchema,
        maxOutputTokens: policy.maxOutputTokens,
        thinkingLevel: JOB_MATCH_THINKING_LEVEL,
        timeoutMs: manifest.stepTimeoutMs,
        maxResponseBytes: 1_000_000,
        fetchImpl: fetches.gemini,
        signal
      });
      const usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens
      };
      let normalized;
      try {
        normalized = validateAndNormalizeJobMatchOutput(input, response.value).normalized;
      } catch {
        const estimatedCostMicros = estimateAiCostMicros({ model: JOB_MATCH_MODEL, ...usage });
        throw new CorrectionFlowProviderAdapterError(
          "PROVIDER_OUTPUT_INVALID",
          "Gemini returned an invalid bounded qualification output.",
          { billingStatus: "known", providerCompleted: true, usage, estimatedCostMicros }
        );
      }
      const callMetrics = metrics(manifest, stage, usage);
      finish(stage);
      const inputHash = hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, input);
      return {
        result: {
          ...normalized,
          model: JOB_MATCH_MODEL,
          promptVersion: JOB_MATCH_PROMPT_VERSION,
          inputHash,
          usage: {
            provider: "gemini" as const,
            model: JOB_MATCH_MODEL,
            promptVersion: JOB_MATCH_PROMPT_VERSION,
            requestHash: inputHash,
            ...usage,
            estimatedCostMicros: callMetrics.estimatedCostMicros!,
            mocked: manifest.providerMode === "offline_stubbed"
          }
        },
        metrics: callMetrics
      };
    } catch (error) {
      stopped = true;
      inFlight = null;
      if (error instanceof CorrectionFlowProviderAdapterError) throw error;
      if (error instanceof GeminiProviderError) {
        const usage = error.usage ? {
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          cachedInputTokens: error.usage.cachedInputTokens
        } : null;
        throw new CorrectionFlowProviderAdapterError(
          "GEMINI_PROVIDER_FAILED",
          "Gemini qualification request did not complete safely.",
          {
            billingStatus: error.billingDisposition,
            providerCompleted: error.providerResponded,
            usage,
            estimatedCostMicros: usage ? estimateAiCostMicros({ model: JOB_MATCH_MODEL, ...usage }) : null
          }
        );
      }
      throw adapterError("GEMINI_PROVIDER_FAILED", "Gemini qualification request did not complete safely.");
    }
  }

  async function geminiDocument<T>({
    stage,
    feature,
    promptName,
    systemPrompt,
    payload,
    schema,
    providerSchema,
    decodeProvider,
    responseJsonSchema,
    validate,
    signal
  }: {
    stage: "tailored_resume" | "cover_letter";
    feature: "RESUME_TAILOR" | "COVER_LETTER";
    promptName: "resumeTailorPrompt" | "coverLetterPrompt";
    systemPrompt: string;
    payload: ApplicationDocumentPayload;
    schema: typeof tailoredResumeSchema | typeof coverLetterSchema;
    providerSchema: typeof tailoredResumeProviderSchema | typeof coverLetterProviderSchema;
    decodeProvider(value: unknown): unknown;
    responseJsonSchema: Record<string, unknown>;
    validate(value: unknown): T;
    signal: AbortSignal;
  }) {
    begin(stage, payload);
    try {
      const { policy } = assertAiInputWithinLimits(feature, systemPrompt, {
        payload,
        responseJsonSchema
      });
      const plan = manifest.calls.find((entry) => entry.stage === stage);
      if (!plan) throw adapterError("PROVIDER_STAGE_NOT_APPROVED", "Provider stage is absent from the manifest.");
      const requestBody = buildGeminiJsonRequest({
        systemPrompt,
        payload,
        responseJsonSchema,
        maxOutputTokens: policy.maxOutputTokens,
        thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
      });
      assertConservativeApplicationDocumentWireBound(feature, policy.maxInputTokens, requestBody);
      const response = await callGeminiJsonProvider({
        apiKey: geminiApiKey,
        model: plan.model,
        systemPrompt,
        payload,
        responseJsonSchema,
        maxOutputTokens: policy.maxOutputTokens,
        thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL,
        timeoutMs: manifest.stepTimeoutMs,
        maxResponseBytes: 1_000_000,
        fetchImpl: fetches.gemini,
        signal
      });
      const usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens
      };
      const callMetrics = metrics(manifest, stage, usage);
      const providerParsed = providerSchema.safeParse(response.value);
      if (!providerParsed.success) {
        const fieldPath = outputFieldPath(providerParsed.error.issues[0]?.path ?? []);
        throw new CorrectionFlowProviderAdapterError(
          "PROVIDER_DOCUMENT_SCHEMA_INVALID",
          "Gemini returned a qualification document with an unsupported shape.",
          { billingStatus: "known", providerCompleted: true, usage,
            estimatedCostMicros: callMetrics.estimatedCostMicros, fieldPath }
        );
      }
      let result: T;
      try {
        const assembled = decodeProvider(providerParsed.data);
        const parsed = schema.safeParse(assembled);
        if (!parsed.success) {
          throw new CorrectionFlowProviderAdapterError(
            "PROVIDER_DOCUMENT_SCHEMA_INVALID",
            "Assembled qualification document has an unsupported shape.",
            { billingStatus: "known", providerCompleted: true, usage,
              estimatedCostMicros: callMetrics.estimatedCostMicros,
              fieldPath: outputFieldPath(parsed.error.issues[0]?.path ?? []) }
          );
        }
        result = validate(parsed.data);
      } catch (error) {
        if (error instanceof CorrectionFlowProviderAdapterError) throw error;
        const failure = claimValidationFailure(error);
        throw new CorrectionFlowProviderAdapterError(
          failure.code,
          "Gemini returned a qualification document that failed factual validation.",
          { billingStatus: "known", providerCompleted: true, usage,
            estimatedCostMicros: callMetrics.estimatedCostMicros, fieldPath: failure.fieldPath }
        );
      }
      finish(stage);
      const inputHash = hashAiInput(promptName, plan.promptVersion, payload);
      return {
        result: {
          ...(result as object),
          model: plan.model,
          promptVersion: plan.promptVersion,
          inputHash,
          usage: {
            provider: "gemini" as const,
            model: plan.model,
            promptVersion: plan.promptVersion,
            requestHash: inputHash,
            ...usage,
            estimatedCostMicros: callMetrics.estimatedCostMicros!,
            mocked: manifest.providerMode === "offline_stubbed"
          }
        } as T & {
          model: string;
          promptVersion: string;
          inputHash: string;
          usage: Record<string, unknown>;
        },
        metrics: callMetrics
      };
    } catch (error) {
      stopped = true;
      inFlight = null;
      if (error instanceof CorrectionFlowProviderAdapterError) throw error;
      if (error instanceof GeminiProviderError) {
        const usage = error.usage ? {
          inputTokens: error.usage.inputTokens,
          outputTokens: error.usage.outputTokens,
          cachedInputTokens: error.usage.cachedInputTokens
        } : null;
        throw new CorrectionFlowProviderAdapterError(
          "GEMINI_PROVIDER_FAILED",
          "Gemini qualification request did not complete safely.",
          {
            billingStatus: error.billingDisposition,
            providerCompleted: error.providerResponded,
            usage,
            estimatedCostMicros: usage ? estimateAiCostMicros({
              model: manifest.calls.find((entry) => entry.stage === stage)!.model,
              ...usage
            }) : null
          }
        );
      }
      throw adapterError("GEMINI_PROVIDER_FAILED", "Gemini qualification request did not complete safely.");
    }
  }

  return Object.freeze({
    scoreMatch,
    tailorResume(payload: ApplicationDocumentPayload, signal: AbortSignal) {
      return geminiDocument<TailoredResumeOutput>({
        stage: "tailored_resume",
        feature: "RESUME_TAILOR",
        promptName: "resumeTailorPrompt",
        systemPrompt: buildTailoredResumeSystemPrompt(payload),
        payload,
        schema: tailoredResumeSchema,
        providerSchema: tailoredResumeProviderSchema,
        decodeProvider: (value) => assembleTailoredResumeProviderOutput(
          payload,
          value as TailoredResumeProviderOutput
        ),
        responseJsonSchema: buildTailoredResumeGeminiJsonSchema(payload),
        validate: (value) => validateTailoredResumeClaims(payload, value as TailoredResumeOutput),
        signal
      });
    },
    draftCoverLetter(payload: ApplicationDocumentPayload, signal: AbortSignal) {
      return geminiDocument<CoverLetterOutput>({
        stage: "cover_letter",
        feature: "COVER_LETTER",
        promptName: "coverLetterPrompt",
        systemPrompt: buildCoverLetterSystemPrompt(payload),
        payload,
        schema: coverLetterSchema,
        providerSchema: coverLetterProviderSchema,
        decodeProvider: (value) => assembleCoverLetterProviderOutput(
          payload,
          value as CoverLetterProviderOutput
        ),
        responseJsonSchema: buildCoverLetterGeminiJsonSchema(payload),
        validate: (value) => validateCoverLetterClaims(payload, value as CoverLetterOutput),
        signal
      });
    },
    completedStages() {
      return Object.freeze([...completed]);
    }
  });
}
