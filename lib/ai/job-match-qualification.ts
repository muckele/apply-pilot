import { z } from "zod";

import { hashAiInput } from "@/lib/ai/input-hash";
import {
  buildJobMatchResponseJsonSchema,
  buildJobMatchSystemPrompt,
  JOB_MATCH_MODEL,
  JOB_MATCH_PROMPT_VERSION,
  JOB_MATCH_THINKING_LEVEL,
  getJobMatchEvidenceReferences,
  type JobMatchModelOutput,
  type JobMatchOutput,
  type MatchInput,
  validateAndNormalizeJobMatchOutput
} from "@/lib/ai/job-match";
import { callGeminiJsonProvider, GeminiProviderError, type GeminiUsage } from "@/lib/ai/gemini";
import { AI_FEATURE_POLICIES, assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";

export const QUALIFICATION_MAX_CALLS = 4;
export const QUALIFICATION_REQUEST_TIMEOUT_MS = 180_000;
export const QUALIFICATION_MAX_RESPONSE_BYTES = 256_000;
export const QUALIFICATION_RECIPIENT = "google-gemini-developer-api" as const;
export const QUALIFICATION_REVIEW_ARTIFACT_VERSION = "2" as const;
const QUALIFICATION_CONTRACT_VERSION = "1";

type Recommendation = JobMatchModelOutput["recommendation"];
type ExpectedBand = "likely_fit_conditional" | "borderline" | "clear_gap";

export type QualificationCase = {
  id: string;
  safeLabel: string;
  expectedRecommendation: Recommendation;
  expectedBand: ExpectedBand;
  provenance: {
    sourceUrl: string;
    capturedAt: string;
    sourceBodySha256: string;
    sourceEvidenceSha256: string;
    sourceEvidence: readonly string[];
  };
  jobProjectionHash: string;
  humanReview: {
    status: "pending_private_applicant_evidence_review";
    openGaps: readonly string[];
  };
  job: MatchInput["job"];
};

export type ApplicantQualificationSnapshot = {
  masterResumeId: string;
  parsedAt: string | null;
  resume: NonNullable<MatchInput["resume"]>;
  profile: NonNullable<MatchInput["profile"]>;
};

export type PreparedPrivateInput = {
  caseId: string;
  safeLabel: string;
  expectedRecommendation: Recommendation;
  expectedBand: ExpectedBand;
  jobProjectionHash: string;
  openGapsHash: string;
  humanReviewAttestation: QualificationHumanReviewAttestation | null;
  inputHash: string;
  input: MatchInput;
};

export type QualificationSafeManifest = {
  contractVersion: typeof QUALIFICATION_CONTRACT_VERSION;
  readiness:
    | "ready_for_separate_execution_consent"
    | "blocked_pricing_review_required"
    | "blocked_human_review_required";
  model: typeof JOB_MATCH_MODEL;
  promptVersion: typeof JOB_MATCH_PROMPT_VERSION;
  thinkingLevel: typeof JOB_MATCH_THINKING_LEVEL;
  recipient: typeof QUALIFICATION_RECIPIENT;
  caseCount: number;
  noRetry: true;
  noDatabaseWrites: true;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maximumCostMicros: number | null;
  masterResumeIdHash: string;
  parsedAt: string | null;
  resumeProjectionHash: string;
  profileProjectionHash: string;
  cases: Array<{
    index: number;
    id: string;
    safeLabel: string;
    expectedRecommendation: Recommendation;
    expectedBand: ExpectedBand;
    sourceUrl: string;
    capturedAt: string;
    sourceBodySha256: string;
    sourceEvidenceSha256: string;
    jobProjectionHash: string;
    inputHash: string;
    humanReviewStatus: "pending_private_applicant_evidence_review" | "complete";
    humanReviewAttestationHash: string | null;
    openGapsHash: string;
    openGapCount: number;
  }>;
  manifestHash: string;
};

export type QualificationPreparation = {
  safeManifest: QualificationSafeManifest;
  privateInputs: readonly Readonly<PreparedPrivateInput>[];
};

export type QualificationExpectedCheckpoint = Pick<
  QualificationSafeManifest,
  "manifestHash" | "resumeProjectionHash" | "profileProjectionHash"
>;

export type QualificationExecutionConsent = {
  recipient: typeof QUALIFICATION_RECIPIENT;
  model: typeof JOB_MATCH_MODEL;
  promptVersion: typeof JOB_MATCH_PROMPT_VERSION;
  approvedManifestHash: string;
  approvedCallCount: number;
  approvedMaximumCostMicros: number;
  privateApplicantDataSharingApproved: true;
  existingCredentialUseApproved: true;
  noRetry: true;
  noDatabaseWrites: true;
  noRoutingWrites: true;
  noEmployerInteraction: true;
  approvedAt: string;
};

const qualificationReviewArtifactSchema = z.object({
  version: z.literal(QUALIFICATION_REVIEW_ARTIFACT_VERSION),
  caseId: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  jobProjectionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  openGapsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewGuideHash: z.string().regex(/^[a-f0-9]{64}$/u),
  factsCurrent: z.literal(true),
  requirements: z.array(z.object({
    jobRef: z.string().min(1),
    disposition: z.enum(["supported", "gap", "unknown", "not_material"]),
    applicantRefs: z.array(z.string().min(1)),
    userAttestationIds: z.array(z.string().min(1))
  }).strict()),
  clarifications: z.array(z.object({
    questionId: z.string().min(1),
    answer: z.enum(["yes", "no", "not_sure", "skip"]),
    context: z.string().max(2_000)
  }).strict()),
  userAttestations: z.array(z.object({
    id: z.string().min(1),
    caseId: z.string().min(1),
    questionId: z.string().min(1),
    jobRefs: z.array(z.string().min(1)),
    sourceType: z.literal("USER_ATTESTATION"),
    context: z.string().trim().min(1).max(2_000),
    recordedAt: z.string().datetime({ offset: true }),
    resumeMutation: z.literal(false),
    profileMutation: z.literal(false)
  }).strict()),
  preferences: z.object({
    location: z.enum(["aligned", "conflict", "unknown", "not_applicable"]),
    workStyle: z.enum(["aligned", "conflict", "unknown", "not_applicable"]),
    compensation: z.enum(["aligned", "conflict", "unknown", "not_applicable"])
  }).strict(),
  recommendation: z.enum(["apply now", "consider", "skip"]),
  rationale: z.string().trim().min(1).max(2_000),
  documentApproval: z.literal("not_available")
}).strict();

export type QualificationReviewArtifactData = Readonly<z.infer<typeof qualificationReviewArtifactSchema>>;

export type QualificationHumanReviewAttestation = {
  caseId: string;
  inputHash: string;
  openGapsHash: string;
  expectedRecommendation: Recommendation;
  reviewedRecommendation: Recommendation;
  status: "complete";
  reviewedAt: string;
  reviewArtifactHash: string;
  reviewArtifact: QualificationReviewArtifactData;
};

export type QualificationDisagreementCategory =
  | "recommendation"
  | "missing_material_gap"
  | "unsupported_positive_match"
  | "compensation"
  | "preference"
  | "advice_claim"
  | "other_review_required";

export type QualificationReviewCase = (input: {
  index: number;
  caseId: string;
  safeLabel: string;
  inputHash: string;
  matchInput: MatchInput;
  normalizedOutput: JobMatchOutput;
}) => Promise<{ disagreementCategories: QualificationDisagreementCategory[] }>;

export type QualificationCompletedCallMetrics = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostMicros: number | null;
  billingKnown: boolean;
  providerCompleted: boolean;
}>;

export type QualificationTransportRequest = {
  caseId: string;
  expectedRecommendation: Recommendation;
  model: typeof JOB_MATCH_MODEL;
  promptVersion: typeof JOB_MATCH_PROMPT_VERSION;
  thinkingLevel: typeof JOB_MATCH_THINKING_LEVEL;
  systemPrompt: string;
  payload: MatchInput;
  responseJsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type QualificationTransportResponse = {
  value: unknown;
  usage: GeminiUsage;
  finishReason: "STOP";
  responseBytes: number;
  elapsedMs: number;
  requestId: string | null;
};

export type QualificationTransport = (
  request: QualificationTransportRequest
) => Promise<QualificationTransportResponse>;

type QualificationFailedCall = {
  index: number;
  caseId: string;
  inputHash: string;
  billingDisposition: "known" | "not_charged" | "uncertain";
  providerResponded: boolean | null;
  requestId: string | null;
  httpStatus: number | null;
  providerCode: string | null;
  elapsedMs: number | null;
  responseBytes: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostMicros: number | null;
};

const masterEnvelopeSchema = z.object({
  resume: z.object({
    id: z.string().min(1),
    parsedAt: z.string().datetime({ offset: true }).nullable(),
    summary: z.string().nullable(),
    rawText: z.string().nullable(),
    skills: z.array(z.string()),
    achievements: z.array(z.string()),
    workHistory: z.unknown(),
    projects: z.unknown(),
    education: z.unknown(),
    certifications: z.unknown()
  }).passthrough()
}).passthrough();

const profileEnvelopeSchema = z.object({
  profile: z.object({
    careerGoals: z.string().nullable(),
    preferredRoles: z.array(z.string()),
    preferredLocations: z.array(z.string()),
    remotePreference: z.string(),
    salaryTargetMin: z.number().finite().nullable(),
    salaryTargetMax: z.number().finite().nullable(),
    skillsToEmphasize: z.array(z.string()),
    skillsNotToExaggerate: z.array(z.string())
  }).passthrough()
}).passthrough();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function buildApplicantQualificationSnapshot(
  masterResponse: unknown,
  profileResponse: unknown
): ApplicantQualificationSnapshot {
  const master = masterEnvelopeSchema.parse(masterResponse).resume;
  const profile = profileEnvelopeSchema.parse(profileResponse).profile;
  return immutableClone({
    masterResumeId: master.id,
    parsedAt: master.parsedAt,
    resume: {
      summary: master.summary,
      rawText: master.rawText,
      skills: master.skills,
      achievements: master.achievements,
      workHistory: master.workHistory,
      projects: master.projects,
      education: master.education,
      certifications: master.certifications
    },
    profile: {
      careerGoals: profile.careerGoals,
      preferredRoles: profile.preferredRoles,
      preferredLocations: profile.preferredLocations,
      remotePreference: profile.remotePreference,
      salaryTargetMin: profile.salaryTargetMin,
      salaryTargetMax: profile.salaryTargetMax,
      skillsToEmphasize: profile.skillsToEmphasize,
      skillsNotToExaggerate: profile.skillsNotToExaggerate
    }
  });
}

function safeManifestCore(
  snapshot: ApplicantQualificationSnapshot,
  cases: readonly QualificationCase[],
  privateInputs: readonly PreparedPrivateInput[],
  maximumCostMicros: number | null
): Omit<QualificationSafeManifest, "manifestHash"> {
  const humanReviewComplete = privateInputs.every((entry) => entry.humanReviewAttestation !== null);
  return {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    readiness: maximumCostMicros === null
      ? "blocked_pricing_review_required" as const
      : humanReviewComplete
        ? "ready_for_separate_execution_consent" as const
        : "blocked_human_review_required" as const,
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    thinkingLevel: JOB_MATCH_THINKING_LEVEL,
    recipient: QUALIFICATION_RECIPIENT,
    caseCount: cases.length,
    noRetry: true as const,
    noDatabaseWrites: true as const,
    requestTimeoutMs: QUALIFICATION_REQUEST_TIMEOUT_MS,
    maxResponseBytes: QUALIFICATION_MAX_RESPONSE_BYTES,
    maximumCostMicros,
    masterResumeIdHash: hashAiInput("jobMatchQualificationMasterResumeId", "1", snapshot.masterResumeId),
    parsedAt: snapshot.parsedAt,
    resumeProjectionHash: hashAiInput("jobMatchQualificationResumeProjection", "1", snapshot.resume),
    profileProjectionHash: hashAiInput("jobMatchQualificationProfileProjection", "1", snapshot.profile),
    cases: cases.map((entry, index) => ({
      index: index + 1,
      id: entry.id,
      safeLabel: entry.safeLabel,
      expectedRecommendation: entry.expectedRecommendation,
      expectedBand: entry.expectedBand,
      sourceUrl: entry.provenance.sourceUrl,
      capturedAt: entry.provenance.capturedAt,
      sourceBodySha256: entry.provenance.sourceBodySha256,
      sourceEvidenceSha256: entry.provenance.sourceEvidenceSha256,
      jobProjectionHash: entry.jobProjectionHash,
      inputHash: privateInputs[index].inputHash,
      humanReviewStatus: privateInputs[index].humanReviewAttestation
        ? "complete" as const
        : "pending_private_applicant_evidence_review" as const,
      humanReviewAttestationHash: privateInputs[index].humanReviewAttestation
        ? hashAiInput("jobMatchQualificationHumanReview", "1", privateInputs[index].humanReviewAttestation)
        : null,
      openGapsHash: privateInputs[index].openGapsHash,
      openGapCount: entry.humanReview.openGaps.length
    }))
  };
}

function currentMaximumCostMicros(now: Date) {
  try {
    const policy = AI_FEATURE_POLICIES.JOB_MATCH;
    return estimateAiCostMicros({
      model: JOB_MATCH_MODEL,
      inputTokens: policy.maxInputTokens,
      outputTokens: policy.maxOutputTokens,
      now
    }) * QUALIFICATION_MAX_CALLS;
  } catch {
    return null;
  }
}

function canonicalReviewArtifactMatches({
  attestation,
  caseId,
  inputHash,
  jobProjectionHash,
  openGapsHash,
  input
}: {
  attestation: QualificationHumanReviewAttestation;
  caseId: string;
  inputHash: string;
  jobProjectionHash: string;
  openGapsHash: string;
  input: MatchInput;
}) {
  const parsed = qualificationReviewArtifactSchema.safeParse(attestation.reviewArtifact);
  if (!parsed.success) return false;
  const artifact = parsed.data;
  if (
    hashAiInput(
      "jobMatchQualificationHumanReviewArtifact",
      QUALIFICATION_REVIEW_ARTIFACT_VERSION,
      artifact
    ) !== attestation.reviewArtifactHash
    || artifact.caseId !== caseId
    || artifact.inputHash !== inputHash
    || artifact.jobProjectionHash !== jobProjectionHash
    || artifact.openGapsHash !== openGapsHash
    || artifact.recommendation !== attestation.reviewedRecommendation
  ) return false;

  const refs = getJobMatchEvidenceReferences(input);
  if (
    artifact.requirements.length !== refs.gap.length
    || artifact.requirements.some((entry, index) => entry.jobRef !== refs.gap[index])
  ) return false;
  const allowedApplicantRefs = new Set(refs.applicant);
  const clarificationById = new Map(artifact.clarifications.map((entry) => [entry.questionId, entry]));
  const attestationById = new Map(artifact.userAttestations.map((entry) => [entry.id, entry]));
  if (
    clarificationById.size !== artifact.clarifications.length
    || attestationById.size !== artifact.userAttestations.length
    || artifact.userAttestations.some((entry) =>
      entry.caseId !== caseId
      || clarificationById.get(entry.questionId)?.answer !== "yes"
      || entry.resumeMutation !== false
      || entry.profileMutation !== false)
  ) return false;
  return artifact.requirements.every((entry) => {
    const unique = new Set(entry.applicantRefs);
    const uniqueAttestations = new Set(entry.userAttestationIds);
    const hasSupport = entry.applicantRefs.length > 0 || entry.userAttestationIds.length > 0;
    return unique.size === entry.applicantRefs.length
      && uniqueAttestations.size === entry.userAttestationIds.length
      && entry.applicantRefs.every((ref) => allowedApplicantRefs.has(ref))
      && entry.userAttestationIds.every((id) => attestationById.get(id)?.jobRefs.includes(entry.jobRef))
      && (entry.disposition === "supported") === hasSupport;
  });
}

export function buildQualificationPreparation(
  snapshotValue: ApplicantQualificationSnapshot,
  casesValue: readonly QualificationCase[],
  now = new Date(),
  humanReviewsValue: readonly QualificationHumanReviewAttestation[] = []
): QualificationPreparation {
  if (casesValue.length !== QUALIFICATION_MAX_CALLS) {
    throw new Error(`JOB_MATCH qualification requires exactly ${QUALIFICATION_MAX_CALLS} frozen cases.`);
  }
  const snapshot = immutableClone(snapshotValue);
  const cases = immutableClone(casesValue);
  const humanReviews = immutableClone(humanReviewsValue);
  if (new Set(humanReviews.map((entry) => entry.caseId)).size !== humanReviews.length) {
    throw new Error("JOB_MATCH qualification human review case IDs must be unique.");
  }
  const ids = new Set<string>();
  const privateInputs = cases.map((entry) => {
    if (ids.has(entry.id)) throw new Error("JOB_MATCH qualification case IDs must be unique.");
    ids.add(entry.id);
    const actualJobHash = hashAiInput("jobMatchQualificationJobProjection", "1", entry.job);
    if (actualJobHash !== entry.jobProjectionHash) {
      throw new Error(`JOB_MATCH qualification job projection hash mismatch for ${entry.id}.`);
    }
    const sourceEvidenceHash = hashAiInput(
      "jobMatchQualificationSourceEvidence",
      "1",
      entry.provenance.sourceEvidence
    );
    if (sourceEvidenceHash !== entry.provenance.sourceEvidenceSha256) {
      throw new Error(`JOB_MATCH qualification source evidence hash mismatch for ${entry.id}.`);
    }
    const input: MatchInput = immutableClone({
      job: entry.job,
      resume: snapshot.resume,
      profile: snapshot.profile
    });
    const systemPrompt = buildJobMatchSystemPrompt(input);
    const responseJsonSchema = buildJobMatchResponseJsonSchema(input);
    assertAiInputWithinLimits("JOB_MATCH", systemPrompt, { matchInput: input, responseJsonSchema });
    const inputHash = hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, input);
    const openGapsHash = hashAiInput("jobMatchQualificationOpenGaps", "1", entry.humanReview.openGaps);
    const humanReviewAttestation = humanReviews.find((review) => review.caseId === entry.id) ?? null;
    if (humanReviewAttestation && (
      humanReviewAttestation.inputHash !== inputHash
      || humanReviewAttestation.openGapsHash !== openGapsHash
      || humanReviewAttestation.expectedRecommendation !== entry.expectedRecommendation
      || !["apply now", "consider", "skip"].includes(humanReviewAttestation.reviewedRecommendation)
      || humanReviewAttestation.status !== "complete"
      || !Number.isFinite(Date.parse(humanReviewAttestation.reviewedAt))
      || !/^[a-f0-9]{64}$/u.test(humanReviewAttestation.reviewArtifactHash)
      || !canonicalReviewArtifactMatches({
        attestation: humanReviewAttestation,
        caseId: entry.id,
        inputHash,
        jobProjectionHash: actualJobHash,
        openGapsHash,
        input
      })
    )) {
      throw new Error(`JOB_MATCH qualification human review attestation mismatch for ${entry.id}.`);
    }
    return immutableClone({
      caseId: entry.id,
      safeLabel: entry.safeLabel,
      expectedRecommendation: entry.expectedRecommendation,
      expectedBand: entry.expectedBand,
      jobProjectionHash: actualJobHash,
      openGapsHash,
      humanReviewAttestation,
      inputHash,
      input
    });
  });
  if (humanReviews.some((review) => !ids.has(review.caseId))) {
    throw new Error("JOB_MATCH qualification human review references an unknown case.");
  }
  const maximumCostMicros = currentMaximumCostMicros(now);
  const core = safeManifestCore(snapshot, cases, privateInputs, maximumCostMicros);
  const safeManifest = immutableClone({
    ...core,
    manifestHash: hashAiInput("jobMatchQualificationManifest", QUALIFICATION_CONTRACT_VERSION, core)
  });
  return deepFreeze({ safeManifest, privateInputs: deepFreeze(privateInputs) });
}

export function assertQualificationExecutionConsent(
  preparation: QualificationPreparation,
  consent: QualificationExecutionConsent
) {
  const manifest = preparation.safeManifest;
  const valid = manifest.readiness === "ready_for_separate_execution_consent"
    && consent.recipient === QUALIFICATION_RECIPIENT
    && consent.model === JOB_MATCH_MODEL
    && consent.promptVersion === JOB_MATCH_PROMPT_VERSION
    && consent.approvedManifestHash === manifest.manifestHash
    && consent.approvedCallCount === manifest.caseCount
    && consent.approvedMaximumCostMicros === manifest.maximumCostMicros
    && consent.privateApplicantDataSharingApproved === true
    && consent.existingCredentialUseApproved === true
    && consent.noRetry === true
    && consent.noDatabaseWrites === true
    && consent.noRoutingWrites === true
    && consent.noEmployerInteraction === true
    && Number.isFinite(Date.parse(consent.approvedAt));
  if (!valid) throw new Error("JOB_MATCH qualification execution consent is incomplete or does not match the prepared manifest hash.");
}

function assertPreparedInputUnchanged(prepared: Readonly<PreparedPrivateInput>) {
  const jobHash = hashAiInput("jobMatchQualificationJobProjection", "1", prepared.input.job);
  const inputHash = hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, prepared.input);
  if (jobHash !== prepared.jobProjectionHash || inputHash !== prepared.inputHash) {
    throw new Error(`JOB_MATCH qualification immutable input check failed for ${prepared.caseId}.`);
  }
}

function assertPreparationIntegrity(preparation: QualificationPreparation) {
  const manifest = preparation.safeManifest;
  const { manifestHash, ...core } = manifest;
  if (
    hashAiInput("jobMatchQualificationManifest", QUALIFICATION_CONTRACT_VERSION, core) !== manifestHash
    || manifest.contractVersion !== QUALIFICATION_CONTRACT_VERSION
    || manifest.model !== JOB_MATCH_MODEL
    || manifest.promptVersion !== JOB_MATCH_PROMPT_VERSION
    || manifest.thinkingLevel !== JOB_MATCH_THINKING_LEVEL
    || manifest.recipient !== QUALIFICATION_RECIPIENT
    || manifest.caseCount !== QUALIFICATION_MAX_CALLS
    || manifest.cases.length !== QUALIFICATION_MAX_CALLS
    || preparation.privateInputs.length !== QUALIFICATION_MAX_CALLS
    || manifest.noRetry !== true
    || manifest.noDatabaseWrites !== true
    || manifest.requestTimeoutMs !== QUALIFICATION_REQUEST_TIMEOUT_MS
    || manifest.maxResponseBytes !== QUALIFICATION_MAX_RESPONSE_BYTES
    || manifest.maximumCostMicros === null
    || manifest.readiness !== (preparation.privateInputs.every((entry) => entry.humanReviewAttestation)
      ? "ready_for_separate_execution_consent"
      : "blocked_human_review_required")
  ) {
    throw new Error("JOB_MATCH qualification preparation integrity check failed.");
  }

  for (let index = 0; index < QUALIFICATION_MAX_CALLS; index += 1) {
    const prepared = preparation.privateInputs[index];
    const safeCase = manifest.cases[index];
    assertPreparedInputUnchanged(prepared);
    const attestationHash = prepared.humanReviewAttestation
      ? hashAiInput("jobMatchQualificationHumanReview", "1", prepared.humanReviewAttestation)
      : null;
    const attestation = prepared.humanReviewAttestation;
    if (
      safeCase.index !== index + 1
      || safeCase.id !== prepared.caseId
      || safeCase.safeLabel !== prepared.safeLabel
      || safeCase.expectedRecommendation !== prepared.expectedRecommendation
      || safeCase.expectedBand !== prepared.expectedBand
      || safeCase.jobProjectionHash !== prepared.jobProjectionHash
      || safeCase.inputHash !== prepared.inputHash
      || safeCase.openGapsHash !== prepared.openGapsHash
      || safeCase.humanReviewAttestationHash !== attestationHash
      || safeCase.humanReviewStatus !== (prepared.humanReviewAttestation
        ? "complete"
        : "pending_private_applicant_evidence_review")
      || (attestation !== null && (
        attestation.caseId !== prepared.caseId
        || attestation.inputHash !== prepared.inputHash
        || attestation.openGapsHash !== prepared.openGapsHash
        || attestation.expectedRecommendation !== prepared.expectedRecommendation
        || !["apply now", "consider", "skip"].includes(attestation.reviewedRecommendation)
        || attestation.status !== "complete"
        || !Number.isFinite(Date.parse(attestation.reviewedAt))
        || !/^[a-f0-9]{64}$/u.test(attestation.reviewArtifactHash)
        || !canonicalReviewArtifactMatches({
          attestation,
          caseId: prepared.caseId,
          inputHash: prepared.inputHash,
          jobProjectionHash: prepared.jobProjectionHash,
          openGapsHash: prepared.openGapsHash,
          input: prepared.input
        })
      ))
    ) {
      throw new Error("JOB_MATCH qualification case order or manifest correspondence check failed.");
    }
  }

  const first = preparation.privateInputs[0].input;
  if (
    hashAiInput("jobMatchQualificationResumeProjection", "1", first.resume) !== manifest.resumeProjectionHash
    || hashAiInput("jobMatchQualificationProfileProjection", "1", first.profile) !== manifest.profileProjectionHash
    || preparation.privateInputs.some((entry) =>
      hashAiInput("jobMatchQualificationResumeProjection", "1", entry.input.resume) !== manifest.resumeProjectionHash
      || hashAiInput("jobMatchQualificationProfileProjection", "1", entry.input.profile) !== manifest.profileProjectionHash
    )
  ) {
    throw new Error("JOB_MATCH qualification applicant projection correspondence check failed.");
  }
}

export function assertQualificationExecutionPreflight(
  preparation: QualificationPreparation,
  consent: QualificationExecutionConsent,
  now: Date
) {
  assertPreparationIntegrity(preparation);
  assertQualificationExecutionConsent(preparation, consent);
  const maximumCostMicros = currentMaximumCostMicros(now);
  if (maximumCostMicros === null || maximumCostMicros !== preparation.safeManifest.maximumCostMicros) {
    throw new Error("JOB_MATCH qualification pricing changed or expired after preparation.");
  }
}

const disagreementCategories = new Set<QualificationDisagreementCategory>([
  "recommendation",
  "missing_material_gap",
  "unsupported_positive_match",
  "compensation",
  "preference",
  "advice_claim",
  "other_review_required"
]);

function normalizeDisagreementCategories(value: unknown) {
  if (!Array.isArray(value) || value.length > disagreementCategories.size) {
    throw new Error("qualification_review_categories");
  }
  const unique = new Set<QualificationDisagreementCategory>();
  for (const category of value) {
    if (typeof category !== "string" || !disagreementCategories.has(category as QualificationDisagreementCategory)) {
      throw new Error("qualification_review_category");
    }
    unique.add(category as QualificationDisagreementCategory);
  }
  return [...unique];
}

function safeCostForUsage(usage: GeminiUsage | null, now: Date) {
  if (!usage) return null;
  try {
    return estimateAiCostMicros({
      model: JOB_MATCH_MODEL,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      now
    });
  } catch {
    return null;
  }
}

function failedCallMetadata({
  index,
  prepared,
  response,
  error,
  now
}: {
  index: number;
  prepared: Readonly<PreparedPrivateInput>;
  response: QualificationTransportResponse | null;
  error: unknown;
  now: Date;
}): QualificationFailedCall {
  if (response) {
    return {
      index,
      caseId: prepared.caseId,
      inputHash: prepared.inputHash,
      billingDisposition: "known",
      providerResponded: true,
      requestId: boundedRequestId(response.requestId),
      httpStatus: null,
      providerCode: null,
      elapsedMs: Number.isFinite(response.elapsedMs) && response.elapsedMs >= 0
        ? Math.round(response.elapsedMs)
        : null,
      responseBytes: Number.isSafeInteger(response.responseBytes) && response.responseBytes >= 0
        ? response.responseBytes
        : null,
      inputTokens: Number.isSafeInteger(response.usage.inputTokens) && response.usage.inputTokens >= 0
        ? response.usage.inputTokens
        : null,
      outputTokens: Number.isSafeInteger(response.usage.outputTokens) && response.usage.outputTokens >= 0
        ? response.usage.outputTokens
        : null,
      cachedInputTokens: Number.isSafeInteger(response.usage.cachedInputTokens)
        && response.usage.cachedInputTokens >= 0
        ? response.usage.cachedInputTokens
        : null,
      estimatedCostMicros: safeCostForUsage(response.usage, now)
    };
  }
  if (error instanceof GeminiProviderError) {
    return {
      index,
      caseId: prepared.caseId,
      inputHash: prepared.inputHash,
      billingDisposition: error.billingDisposition,
      providerResponded: error.providerResponded,
      requestId: boundedRequestId(error.requestId),
      httpStatus: Number.isSafeInteger(error.httpStatus) ? error.httpStatus : null,
      providerCode: boundedRequestId(error.providerCode),
      elapsedMs: null,
      responseBytes: null,
      inputTokens: error.usage?.inputTokens ?? null,
      outputTokens: error.usage?.outputTokens ?? null,
      cachedInputTokens: error.usage?.cachedInputTokens ?? null,
      estimatedCostMicros: error.billingDisposition === "not_charged"
        ? 0
        : safeCostForUsage(error.usage, now)
    };
  }
  return {
    index,
    caseId: prepared.caseId,
    inputHash: prepared.inputHash,
    billingDisposition: "uncertain",
    providerResponded: null,
    requestId: null,
    httpStatus: null,
    providerCode: null,
    elapsedMs: null,
    responseBytes: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    estimatedCostMicros: null
  };
}

function boundedRequestId(value: string | null) {
  if (!value) return null;
  return /^[A-Za-z0-9._~:/+=-]{1,200}$/u.test(value) ? value : null;
}

export class QualificationRunStoppedError extends Error {
  readonly safeReport: unknown;

  constructor(caseIndex: number, safeReport: unknown) {
    super(`JOB_MATCH qualification stopped at case ${caseIndex}; no retry was attempted.`);
    this.name = "QualificationRunStoppedError";
    this.safeReport = safeReport;
  }
}

export async function runJobMatchQualification({
  preparation,
  consent,
  transport,
  reviewCase,
  onProviderCallCompleted,
  now = new Date()
}: {
  preparation: QualificationPreparation;
  consent: QualificationExecutionConsent;
  transport: QualificationTransport;
  reviewCase: QualificationReviewCase;
  onProviderCallCompleted?: (metrics: QualificationCompletedCallMetrics) => void;
  now?: Date;
}) {
  assertQualificationExecutionPreflight(preparation, consent, now);
  const maximumCostMicros = preparation.safeManifest.maximumCostMicros as number;

  const results: Array<Record<string, unknown>> = [];
  let totalEstimatedCostMicros = 0;
  for (const [index, prepared] of preparation.privateInputs.entries()) {
    const reviewedRecommendation = prepared.humanReviewAttestation?.reviewedRecommendation;
    if (!reviewedRecommendation) {
      throw new Error("JOB_MATCH qualification cannot execute without a reviewed recommendation.");
    }
    let failureCode = "TRANSPORT_FAILED";
    let response: QualificationTransportResponse | null = null;
    let completedCallRecorded = false;
    try {
      const systemPrompt = buildJobMatchSystemPrompt(prepared.input);
      const responseJsonSchema = buildJobMatchResponseJsonSchema(prepared.input);
      const { policy } = assertAiInputWithinLimits("JOB_MATCH", systemPrompt, {
        matchInput: prepared.input,
        responseJsonSchema
      });
      response = await transport({
        caseId: prepared.caseId,
        expectedRecommendation: reviewedRecommendation,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION,
        thinkingLevel: JOB_MATCH_THINKING_LEVEL,
        systemPrompt,
        payload: prepared.input,
        responseJsonSchema,
        maxOutputTokens: policy.maxOutputTokens,
        timeoutMs: QUALIFICATION_REQUEST_TIMEOUT_MS,
        maxResponseBytes: QUALIFICATION_MAX_RESPONSE_BYTES
      });
      failureCode = "PROVIDER_RESPONSE_REJECTED";
      if (response.finishReason !== "STOP") throw new Error("finish_reason");
      if (!Number.isSafeInteger(response.responseBytes)
        || response.responseBytes < 0
        || response.responseBytes > QUALIFICATION_MAX_RESPONSE_BYTES) {
        failureCode = "RESPONSE_BODY_LIMIT_EXCEEDED";
        throw new Error("response_bound");
      }
      if (!Number.isFinite(response.elapsedMs)
        || response.elapsedMs < 0
        || response.elapsedMs > QUALIFICATION_REQUEST_TIMEOUT_MS) {
        failureCode = "REQUEST_TIME_LIMIT_EXCEEDED";
        throw new Error("time_bound");
      }
      if (response.usage.inputTokens > policy.maxInputTokens
        || response.usage.outputTokens > policy.maxOutputTokens) {
        failureCode = "TOKEN_LIMIT_EXCEEDED";
        throw new Error("token_bound");
      }
      const estimatedCostMicros = estimateAiCostMicros({
        model: JOB_MATCH_MODEL,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        now
      });
      if (estimatedCostMicros > maximumCostMicros / QUALIFICATION_MAX_CALLS) {
        failureCode = "COST_LIMIT_EXCEEDED";
        throw new Error("cost_bound");
      }
      failureCode = "MODEL_OUTPUT_VALIDATION_FAILED";
      const { normalized } = validateAndNormalizeJobMatchOutput(prepared.input, response.value);
      const retainedResult = {
        index: index + 1,
        caseId: prepared.caseId,
        safeLabel: prepared.safeLabel,
        inputHash: prepared.inputHash,
        expectedBand: prepared.expectedBand,
        proposedRecommendation: prepared.expectedRecommendation,
        reviewedRecommendation,
        modelRecommendation: normalized.recommendation,
        humanBandAgreement: normalized.recommendation === reviewedRecommendation,
        overallFitScore: normalized.overallFitScore,
        confidenceScore: normalized.confidenceScore,
        factualMatchCount: normalized.factualMatches.length,
        requirementGapCount: normalized.requirementGaps.length,
        finishReason: response.finishReason,
        requestId: boundedRequestId(response.requestId),
        elapsedMs: Math.round(response.elapsedMs),
        responseBytes: response.responseBytes,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        estimatedCostMicros
      };
      onProviderCallCompleted?.({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        estimatedCostMicros,
        billingKnown: true,
        providerCompleted: true
      });
      completedCallRecorded = true;
      failureCode = "TRANSIENT_HUMAN_REVIEW_FAILED";
      const review = await reviewCase({
        index: index + 1,
        caseId: prepared.caseId,
        safeLabel: prepared.safeLabel,
        inputHash: prepared.inputHash,
        matchInput: prepared.input,
        normalizedOutput: immutableClone(normalized)
      });
      const reviewedDisagreementCategories = normalizeDisagreementCategories(review.disagreementCategories);
      totalEstimatedCostMicros += estimatedCostMicros;
      results.push({
        ...retainedResult,
        disagreementCategories: reviewedDisagreementCategories,
      });
    } catch (error) {
      const failedCall = failedCallMetadata({
        index: index + 1,
        prepared,
        response,
        error,
        now
      });
      if (!completedCallRecorded
        && (failedCall.providerResponded === true || failedCall.billingDisposition === "not_charged")) {
        onProviderCallCompleted?.({
          inputTokens: failedCall.inputTokens,
          outputTokens: failedCall.outputTokens,
          cachedInputTokens: failedCall.cachedInputTokens,
          estimatedCostMicros: failedCall.estimatedCostMicros,
          billingKnown: failedCall.estimatedCostMicros !== null,
          providerCompleted: failedCall.providerResponded === true
        });
      }
      throw new QualificationRunStoppedError(index + 1, {
        status: "stopped",
        manifestHash: preparation.safeManifest.manifestHash,
        completedCaseCount: results.length,
        failedCaseIndex: index + 1,
        failureCode,
        noRetryAttempted: true,
        totalKnownEstimatedCostMicros: totalEstimatedCostMicros + (failedCall.estimatedCostMicros ?? 0),
        failedCall,
        results
      });
    }
  }

  return {
    status: "completed" as const,
    manifestHash: preparation.safeManifest.manifestHash,
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    recipient: QUALIFICATION_RECIPIENT,
    completedCaseCount: results.length,
    noRetryAttempted: true as const,
    totalEstimatedCostMicros,
    results
  };
}

export function createGeminiQualificationTransport({
  apiKey,
  fetchImpl
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): QualificationTransport {
  const key = apiKey.trim();
  if (!key) throw new Error("A Gemini API key is required for a separately consented qualification execution.");
  return async (request) => callGeminiJsonProvider({
    apiKey: key,
    model: request.model,
    systemPrompt: request.systemPrompt,
    payload: request.payload,
    responseJsonSchema: request.responseJsonSchema,
    maxOutputTokens: request.maxOutputTokens,
    thinkingLevel: request.thinkingLevel,
    timeoutMs: request.timeoutMs,
    maxResponseBytes: request.maxResponseBytes,
    fetchImpl
  });
}
