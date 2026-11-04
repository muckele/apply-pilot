import type { Prisma, PrismaClient } from "@prisma/client";

import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";
import { PublicApiError } from "@/lib/api-errors";
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";

type SourceClient = PrismaClient | Prisma.TransactionClient;

export async function readApplicationDocumentEvidence(
  client: SourceClient,
  userId: string,
  jobPostingId: string
) {
  const [job, resume, profile] = await Promise.all([
    client.jobPosting.findFirstOrThrow({
      where: { id: jobPostingId, userId },
      include: {
        currentEvidenceSnapshot: {
          select: CURRENT_EVIDENCE_SNAPSHOT_SELECT
        }
      }
    }),
    client.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" }
    }),
    client.userProfile.findUnique({ where: { userId } })
  ]);
  const evidence = resolveCurrentReviewedEvidence(job, resume);
  if (!evidence.currentEvidenceSourceValid || !evidence.effectiveEvidenceSnapshotId) {
    throw new PublicApiError("Save the current evidence review before generating application documents.", 409, {
      code: evidence.currentEvidenceSourceValid ? "EVIDENCE_SNAPSHOT_REQUIRED" : "EVIDENCE_SOURCE_STALE"
    });
  }
  return {
    job,
    resume,
    profile,
    payload: buildApplicationDocumentPayload(job, resume, profile, evidence.reviewedEvidence)
  };
}
