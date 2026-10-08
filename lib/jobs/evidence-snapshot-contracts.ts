import { z } from "zod";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";

const opaqueId = z.string().trim().min(1).max(191).regex(/^[A-Za-z0-9:_-]+$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedFact = z.string().trim().min(1).max(4_000);
const jobOnlyReuse = {
  reuseScope: z.literal("JOB_ONLY"),
  masterProfileOptIn: z.literal(false)
} as const;

const unresolvedInputSchema = z.object({
  gapId: opaqueId,
  kind: z.literal("UNRESOLVED"),
  ...jobOnlyReuse
}).strict();

const sourceCorrectionInputSchema = z.object({
  gapId: opaqueId,
  kind: z.literal("SOURCE_CORRECTION"),
  sourceFactId: z.string().trim().min(1).max(512),
  sourceExcerpt: boundedFact,
  correctedFact: boundedFact,
  ...jobOnlyReuse
}).strict();

const ownerAttestationInputSchema = z.object({
  gapId: opaqueId,
  kind: z.literal("OWNER_ATTESTATION"),
  attestedFact: boundedFact,
  ownerAttested: z.literal(true),
  ...jobOnlyReuse
}).strict();

export const evidenceSnapshotDecisionInputSchema = z.discriminatedUnion("kind", [
  unresolvedInputSchema,
  sourceCorrectionInputSchema,
  ownerAttestationInputSchema
]);

export const evidenceSnapshotSaveBodySchema = z.object({
  schema: z.literal("apply-pilot/evidence-snapshot-save/v1"),
  requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/u),
  resumeId: opaqueId,
  resumeUpdatedAt: z.string().datetime({ offset: true }),
  reviewedAnalysis: z.object({
    id: opaqueId,
    inputHash: sha256,
    model: z.literal(JOB_MATCH_MODEL),
    promptVersion: z.literal(JOB_MATCH_PROMPT_VERSION)
  }).strict(),
  decisions: z.array(evidenceSnapshotDecisionInputSchema).max(100)
}).strict().superRefine((value, context) => {
  value.decisions.forEach((decision, index) => {
    if (decision.kind === "SOURCE_CORRECTION" && decision.correctedFact !== decision.sourceExcerpt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A source-backed fact must match the complete cited source excerpt exactly.",
        path: ["decisions", index, "correctedFact"]
      });
    }
  });
});

const persistedBase = {
  gapId: opaqueId,
  reuseScope: z.literal("JOB_ONLY"),
  masterProfileOptIn: z.literal(false)
} as const;

const persistedSourceDecisionSchema = z.object({
  ...persistedBase,
  status: z.literal("RESOLVED"),
  fact: boundedFact,
  provenance: z.object({
    kind: z.literal("EXISTING_SOURCE"),
    sourceFactId: z.string().trim().min(1).max(512),
    sourceRef: z.string().trim().min(1).max(512),
    sourceExcerpt: boundedFact
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.fact !== value.provenance.sourceExcerpt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A persisted source-backed fact must preserve its complete cited source excerpt.",
      path: ["fact"]
    });
  }
});

const persistedAttestationDecisionSchema = z.object({
  ...persistedBase,
  status: z.literal("RESOLVED"),
  fact: boundedFact,
  provenance: z.object({
    kind: z.literal("OWNER_ATTESTED"),
    ownerAttested: z.literal(true)
  }).strict()
}).strict();

const persistedUnresolvedDecisionSchema = z.object({
  ...persistedBase,
  status: z.literal("UNRESOLVED"),
  fact: z.null(),
  provenance: z.object({ kind: z.literal("NONE") }).strict()
}).strict();

export const evidenceSnapshotReviewPayloadSchema = z.object({
  schema: z.literal("apply-pilot/evidence-snapshot-payload/v1"),
  decisions: z.array(z.union([
    persistedSourceDecisionSchema,
    persistedAttestationDecisionSchema,
    persistedUnresolvedDecisionSchema
  ])).max(100)
}).strict();

export const evidenceSnapshotSaveResponseSchema = z.object({
  schema: z.literal("apply-pilot/evidence-snapshot-save-response/v1"),
  snapshot: z.object({
    id: opaqueId,
    hash: sha256,
    createdAt: z.string().datetime({ offset: true }),
    isCurrent: z.boolean()
  }).strict(),
  replayed: z.boolean(),
  invalidations: z.object({
    assessmentIds: z.array(opaqueId).max(100),
    resumeDocumentIds: z.array(opaqueId).max(100),
    coverLetterDocumentIds: z.array(opaqueId).max(100),
    totalCount: z.number().int().min(0).max(300),
    reason: z.literal("EVIDENCE_SNAPSHOT_CHANGED")
  }).strict()
}).strict();

export type EvidenceSnapshotSaveInput = z.infer<typeof evidenceSnapshotSaveBodySchema>;
export type EvidenceSnapshotDecisionInput = z.infer<typeof evidenceSnapshotDecisionInputSchema>;
export type EvidenceSnapshotReviewPayload = z.infer<typeof evidenceSnapshotReviewPayloadSchema>;
export type EvidenceSnapshotSaveResponse = z.infer<typeof evidenceSnapshotSaveResponseSchema>;

export type JobMatchReviewedEvidence = Readonly<{
  schema: "apply-pilot/job-match-reviewed-evidence/v1";
  snapshotId: string;
  snapshotHash: string;
  facts: ReadonlyArray<Readonly<{
    gapId: string;
    fact: string;
    provenance: "SUBMITTED_RESUME" | "OWNER_ATTESTED";
    sourceRef: string | null;
  }>>;
  unresolvedGapIds: readonly string[];
}>;

export const CURRENT_EVIDENCE_SNAPSHOT_SELECT = Object.freeze({
  id: true,
  resumeId: true,
  sourceResumeUpdatedAt: true,
  snapshotHash: true,
  reviewPayload: true
});

type CurrentEvidenceSnapshot = {
  id: string;
  resumeId: string;
  sourceResumeUpdatedAt: Date;
  snapshotHash: string;
  reviewPayload: unknown;
};

type CurrentEvidenceSource = { id: string; updatedAt: Date } | null;

export function resolveCurrentReviewedEvidence(
  job: {
    currentEvidenceSnapshotId: string | null;
    evidenceSnapshotGeneration: number;
    currentEvidenceSnapshot?: CurrentEvidenceSnapshot | null;
  },
  resume: CurrentEvidenceSource
) {
  const snapshot = job.currentEvidenceSnapshot ?? null;
  if (job.currentEvidenceSnapshotId === null && snapshot === null) {
    return {
      reviewedEvidence: null,
      currentEvidenceSourceValid: true,
      effectiveEvidenceSnapshotId: null,
      requiresEvidenceRebase: job.evidenceSnapshotGeneration > 0
    } as const;
  }
  const valid = Boolean(
    job.currentEvidenceSnapshotId &&
    snapshot &&
    snapshot.id === job.currentEvidenceSnapshotId &&
    resume &&
    snapshot.resumeId === resume.id &&
    snapshot.sourceResumeUpdatedAt.getTime() === resume.updatedAt.getTime()
  );
  return {
    reviewedEvidence: valid && snapshot ? reviewedEvidenceFromSnapshot(snapshot) : null,
    currentEvidenceSourceValid: valid,
    effectiveEvidenceSnapshotId: valid ? job.currentEvidenceSnapshotId : null,
    requiresEvidenceRebase: !valid
  } as const;
}

export function isEvidenceBindingCurrent(input: {
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  artifactEvidenceSnapshotId: string | null;
}) {
  if (!input.currentEvidenceSourceValid) return false;
  return input.currentEvidenceSnapshotId !== null &&
    input.artifactEvidenceSnapshotId === input.currentEvidenceSnapshotId;
}

export function reviewedEvidenceFromSnapshot(snapshot: {
  id: string;
  snapshotHash: string;
  reviewPayload: unknown;
}): JobMatchReviewedEvidence {
  const payload = evidenceSnapshotReviewPayloadSchema.parse(snapshot.reviewPayload);
  return Object.freeze({
    schema: "apply-pilot/job-match-reviewed-evidence/v1" as const,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.snapshotHash,
    facts: payload.decisions.flatMap((decision) => decision.status === "RESOLVED" ? [{
      gapId: decision.gapId,
      fact: decision.provenance.kind === "EXISTING_SOURCE"
        ? decision.provenance.sourceExcerpt
        : decision.fact,
      provenance: decision.provenance.kind === "EXISTING_SOURCE"
        ? "SUBMITTED_RESUME" as const
        : "OWNER_ATTESTED" as const,
      sourceRef: decision.provenance.kind === "EXISTING_SOURCE" ? decision.provenance.sourceRef : null
    }] : []),
    unresolvedGapIds: payload.decisions.flatMap((decision) =>
      decision.status === "UNRESOLVED" ? [decision.gapId] : [])
  });
}
