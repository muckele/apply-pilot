import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { PublicApiError } from "@/lib/api-errors";
import {
  buildEvidenceCorrectionReview,
  normalizeEvidenceCorrectionDecisions,
  type EvidenceCorrectionDecision
} from "@/lib/jobs/evidence-correction-review";
import {
  evidenceSnapshotReviewPayloadSchema,
  resolveCurrentReviewedEvidence,
  type EvidenceSnapshotReviewPayload,
  type EvidenceSnapshotSaveInput
} from "@/lib/jobs/evidence-snapshot-contracts";
import {
  buildCurrentJobMatchInput,
  currentJobMatchInputHash
} from "@/lib/jobs/current-job-match";
import { prisma } from "@/lib/prisma";

const SNAPSHOT_SCHEMA_VERSION = 1;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function evidenceError(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
  return new PublicApiError(message, status, { code, ...details });
}

function requestHash(jobId: string, input: EvidenceSnapshotSaveInput) {
  return sha256({ jobId, input });
}

function responseFor(snapshot: {
  id: string;
  snapshotHash: string;
  createdAt: Date;
}, currentEvidenceSnapshotId: string | null, replayed: boolean, invalidations = emptyInvalidations()) {
  return {
    schema: "apply-pilot/evidence-snapshot-save-response/v1" as const,
    snapshot: {
      id: snapshot.id,
      hash: snapshot.snapshotHash,
      createdAt: snapshot.createdAt.toISOString(),
      isCurrent: snapshot.id === currentEvidenceSnapshotId
    },
    replayed,
    invalidations
  };
}

function emptyInvalidations() {
  return {
    assessmentIds: [] as string[],
    resumeDocumentIds: [] as string[],
    coverLetterDocumentIds: [] as string[],
    totalCount: 0,
    reason: "EVIDENCE_SNAPSHOT_CHANGED" as const
  };
}

async function resolveCommittedReplay(
  userId: string,
  jobId: string,
  expectedRequestHash: string,
  requestId: string
) {
  const existing = await prisma.evidenceSnapshot.findUnique({
    where: { userId_requestId: { userId, requestId } },
    select: { id: true, jobPostingId: true, requestHash: true, snapshotHash: true, createdAt: true }
  });
  if (!existing || existing.jobPostingId !== jobId || existing.requestHash !== expectedRequestHash) {
    throw evidenceError("This evidence request ID is already bound to different content.", 409,
      "EVIDENCE_IDEMPOTENCY_CONFLICT");
  }
  const job = await prisma.jobPosting.findFirst({
    where: { id: jobId, userId },
    select: { currentEvidenceSnapshotId: true }
  });
  if (!job) throw evidenceError("This job was not found.", 404, "EVIDENCE_JOB_NOT_FOUND");
  return responseFor(existing, job.currentEvidenceSnapshotId, true);
}

export function isEvidenceSnapshotSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010" || !error.meta || typeof error.meta !== "object") return false;
  return "code" in error.meta && error.meta.code === "40001";
}

async function resolveReplayAfterSerializationConflict(
  userId: string,
  jobId: string,
  expectedRequestHash: string,
  requestId: string
) {
  const replay = await prisma.evidenceSnapshot.findUnique({
    where: { userId_requestId: { userId, requestId } },
    select: { id: true }
  });
  if (replay) return resolveCommittedReplay(userId, jobId, expectedRequestHash, requestId);
  throw evidenceError("The evidence source changed during this save. Review and save it again.", 409,
    "EVIDENCE_SOURCE_STALE");
}

export async function saveEvidenceSnapshot(
  userId: string,
  jobId: string,
  input: EvidenceSnapshotSaveInput
) {
  const expectedRequestHash = requestHash(jobId, input);
  try {
    return await prisma.$transaction(async (transaction) => {
      const lockedJobs = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "JobPosting"
        WHERE "id" = ${jobId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (lockedJobs.length !== 1) {
        throw evidenceError("This job was not found.", 404, "EVIDENCE_JOB_NOT_FOUND");
      }
      const job = await transaction.jobPosting.findUniqueOrThrow({
        where: { id: jobId },
        include: {
          currentEvidenceSnapshot: {
            select: {
              id: true,
              resumeId: true,
              sourceResumeUpdatedAt: true,
              snapshotHash: true,
              reviewPayload: true
            }
          }
        }
      });

      const replay = await transaction.evidenceSnapshot.findUnique({
        where: { userId_requestId: { userId, requestId: input.requestId } },
        select: { id: true, jobPostingId: true, requestHash: true, snapshotHash: true, createdAt: true }
      });
      if (replay) {
        if (replay.jobPostingId !== jobId || replay.requestHash !== expectedRequestHash) {
          throw evidenceError("This evidence request ID is already bound to different content.", 409,
            "EVIDENCE_IDEMPOTENCY_CONFLICT");
        }
        return responseFor(replay, job.currentEvidenceSnapshotId, true);
      }

      const [resume, latestMasterResume, profile, analysis, latestAnalysis, application] = await Promise.all([
        transaction.resume.findFirst({ where: { id: input.resumeId, userId, isMaster: true } }),
        transaction.resume.findFirst({
          where: { userId, isMaster: true },
          orderBy: { updatedAt: "desc" },
          select: { id: true }
        }),
        transaction.userProfile.findUnique({ where: { userId } }),
        transaction.aIAnalysis.findFirst({
          where: {
            id: input.reviewedAnalysis.id,
            userId,
            jobPostingId: jobId,
            type: "JOB_MATCH",
            model: JOB_MATCH_MODEL,
            promptVersion: JOB_MATCH_PROMPT_VERSION
          }
        }),
        transaction.aIAnalysis.findFirst({
          where: {
            userId,
            jobPostingId: jobId,
            type: "JOB_MATCH",
            model: JOB_MATCH_MODEL,
            promptVersion: JOB_MATCH_PROMPT_VERSION
          },
          orderBy: { createdAt: "desc" },
          select: { id: true }
        }),
        transaction.application.findUnique({
          where: { userId_jobPostingId: { userId, jobPostingId: jobId } },
          select: { resumeVersionId: true, coverLetterVersionId: true }
        })
      ]);

      if (
        !resume ||
        latestMasterResume?.id !== resume.id ||
        resume.updatedAt.toISOString() !== input.resumeUpdatedAt
      ) {
        throw evidenceError("The source resume changed after this review was opened.", 409,
          "EVIDENCE_SOURCE_STALE");
      }
      if (
        !analysis ||
        latestAnalysis?.id !== analysis.id ||
        analysis.inputHash !== input.reviewedAnalysis.inputHash ||
        analysis.model !== input.reviewedAnalysis.model ||
        analysis.promptVersion !== input.reviewedAnalysis.promptVersion ||
        analysis.evidenceSnapshotId !== resolveCurrentReviewedEvidence(job, resume).effectiveEvidenceSnapshotId
      ) {
        throw evidenceError("The fit assessment changed after this review was opened.", 409,
          "EVIDENCE_ANALYSIS_STALE");
      }
      const evidenceContext = resolveCurrentReviewedEvidence(job, resume);
      const currentInput = buildCurrentJobMatchInput({
        job,
        resume,
        profile,
        reviewedEvidence: evidenceContext.reviewedEvidence,
        evidenceSnapshotGeneration: job.evidenceSnapshotGeneration
      });
      if (currentJobMatchInputHash(currentInput) !== analysis.inputHash) {
        throw evidenceError("The fit assessment no longer matches the current source evidence.", 409,
          "EVIDENCE_ANALYSIS_STALE");
      }

      const review = buildEvidenceCorrectionReview({
        jobId,
        resumeId: resume.id,
        resumeUpdatedAt: resume.updatedAt.toISOString(),
        resume,
        analysisId: analysis.id,
        analysisOutput: analysis.output,
        selectedResumeDocumentId: application?.resumeVersionId ?? null,
        selectedCoverLetterDocumentId: application?.coverLetterVersionId ?? null
      });
      let decisions;
      try {
        decisions = normalizeEvidenceCorrectionDecisions(
          review,
          input.decisions as EvidenceCorrectionDecision[]
        );
      } catch (error) {
        throw evidenceError(
          error instanceof Error ? error.message : "The evidence review was invalid.",
          422,
          "EVIDENCE_REVIEW_INVALID"
        );
      }
      const payload: EvidenceSnapshotReviewPayload = evidenceSnapshotReviewPayloadSchema.parse({
        schema: "apply-pilot/evidence-snapshot-payload/v1",
        decisions
      });
      const sourceProjectionHash = sha256(review.facts);
      const gapProjectionHash = sha256(review.gaps);
      const snapshotHash = sha256({
        schema: "apply-pilot/evidence-snapshot-identity/v1",
        jobId,
        resumeId: resume.id,
        sourceResumeUpdatedAt: resume.updatedAt.toISOString(),
        reviewedAnalysisId: analysis.id,
        sourceProjectionHash,
        gapProjectionHash,
        reviewPayload: payload
      });
      const snapshot = await transaction.evidenceSnapshot.create({
        data: {
          userId,
          jobPostingId: jobId,
          resumeId: resume.id,
          reviewedAnalysisId: analysis.id,
          requestId: input.requestId,
          requestHash: expectedRequestHash,
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          sourceResumeUpdatedAt: resume.updatedAt,
          snapshotHash,
          sourceProjectionHash,
          gapProjectionHash,
          reviewPayload: payload as Prisma.InputJsonValue
        },
        select: { id: true, snapshotHash: true, createdAt: true }
      });
      await transaction.jobPosting.update({
        where: { id: jobId },
        data: {
          currentEvidenceSnapshotId: snapshot.id,
          evidenceSnapshotGeneration: { increment: 1 }
        }
      });
      const invalidations = {
        assessmentIds: [analysis.id],
        resumeDocumentIds: application?.resumeVersionId ? [application.resumeVersionId] : [],
        coverLetterDocumentIds: application?.coverLetterVersionId ? [application.coverLetterVersionId] : [],
        totalCount: 1 + Number(Boolean(application?.resumeVersionId)) + Number(Boolean(application?.coverLetterVersionId)),
        reason: "EVIDENCE_SNAPSHOT_CHANGED" as const
      };
      return responseFor(snapshot, snapshot.id, false, invalidations);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return resolveCommittedReplay(userId, jobId, expectedRequestHash, input.requestId);
    }
    if (isEvidenceSnapshotSerializationConflict(error)) {
      return resolveReplayAfterSerializationConflict(userId, jobId, expectedRequestHash, input.requestId);
    }
    throw error;
  }
}
