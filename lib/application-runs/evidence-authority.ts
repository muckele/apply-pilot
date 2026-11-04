import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";

type RunEvidenceAuthority = Readonly<{
  userId: string;
  jobPostingId: string;
  resumeVersionId: string | null;
  coverLetterVersionId: string | null;
}>;

type LockedJob = { id: string; currentEvidenceSnapshotId: string | null; evidenceSnapshotGeneration: number };
type LockedResume = { id: string; updatedAt: Date };
type LockedSnapshot = { id: string; resumeId: string; sourceResumeUpdatedAt: Date };
type LockedArtifact = { id: string; evidenceSnapshotId: string | null };

export function applicationRunEvidenceStale(): PublicApiError {
  return new PublicApiError(
    "Regenerate and prepare this application run from the current reviewed evidence.",
    409,
    { code: "RUN_DOCUMENT_EVIDENCE_STALE" }
  );
}

export async function assertCurrentApplicationRunEvidenceInTransaction(
  tx: Prisma.TransactionClient,
  run: RunEvidenceAuthority
): Promise<string> {
  try {
    return await assertLockedCurrentApplicationRunEvidence(tx, run);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2010" &&
      error.meta &&
      typeof error.meta === "object" &&
      "code" in error.meta &&
      error.meta.code === "55P03"
    ) {
      throw applicationRunEvidenceStale();
    }
    throw error;
  }
}

async function assertLockedCurrentApplicationRunEvidence(
  tx: Prisma.TransactionClient,
  run: RunEvidenceAuthority
): Promise<string> {
  const jobs = await tx.$queryRaw<LockedJob[]>`
    SELECT "id", "currentEvidenceSnapshotId", "evidenceSnapshotGeneration"
    FROM "JobPosting"
    WHERE "id" = ${run.jobPostingId} AND "userId" = ${run.userId}
    FOR SHARE
  `;
  const job = jobs[0];
  if (!job) throw applicationRunEvidenceStale();
  if (!job.currentEvidenceSnapshotId) {
    if (job.evidenceSnapshotGeneration === 0) return "LEGACY_UNVERSIONED";
    throw applicationRunEvidenceStale();
  }

  const resumes = await tx.$queryRaw<LockedResume[]>`
    SELECT "id", "updatedAt"
    FROM "Resume"
    WHERE "userId" = ${run.userId} AND "isMaster" = TRUE
    ORDER BY "updatedAt" DESC, "id" DESC
    LIMIT 1
    FOR SHARE NOWAIT
  `;
  const resume = resumes[0];
  if (!resume) throw applicationRunEvidenceStale();

  const snapshots = await tx.$queryRaw<LockedSnapshot[]>`
    SELECT "id", "resumeId", "sourceResumeUpdatedAt"
    FROM "EvidenceSnapshot"
    WHERE "id" = ${job.currentEvidenceSnapshotId}
      AND "userId" = ${run.userId}
      AND "jobPostingId" = ${run.jobPostingId}
    FOR SHARE NOWAIT
  `;
  const snapshot = snapshots[0];
  if (
    !snapshot ||
    snapshot.resumeId !== resume.id ||
    snapshot.sourceResumeUpdatedAt.getTime() !== resume.updatedAt.getTime()
  ) {
    throw applicationRunEvidenceStale();
  }

  if (run.resumeVersionId) {
    const rows = await tx.$queryRaw<LockedArtifact[]>`
      SELECT "id", "evidenceSnapshotId"
      FROM "ResumeVersion"
      WHERE "id" = ${run.resumeVersionId}
        AND "userId" = ${run.userId}
        AND "jobPostingId" = ${run.jobPostingId}
      FOR SHARE NOWAIT
    `;
    if (rows.length !== 1 || rows[0].evidenceSnapshotId !== snapshot.id) {
      throw applicationRunEvidenceStale();
    }
  }

  if (run.coverLetterVersionId) {
    const rows = await tx.$queryRaw<LockedArtifact[]>`
      SELECT "id", "evidenceSnapshotId"
      FROM "GeneratedDocument"
      WHERE "id" = ${run.coverLetterVersionId}
        AND "userId" = ${run.userId}
        AND "jobPostingId" = ${run.jobPostingId}
        AND "type" = 'COVER_LETTER'
      FOR SHARE NOWAIT
    `;
    if (rows.length !== 1 || rows[0].evidenceSnapshotId !== snapshot.id) {
      throw applicationRunEvidenceStale();
    }
  }

  return snapshot.id;
}
