import type { Prisma, PrismaClient } from "@prisma/client";

import { buildApplicationDocumentPayload, protectedResumeCitations } from "@/lib/ai/resume-tailoring-payload";
import { PublicApiError } from "@/lib/api-errors";
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";
import { assertReviewedOwnerFactsClean } from "@/lib/jobs/owner-fact-cleanup";

type SourceClient = PrismaClient | Prisma.TransactionClient;

export type ApplicationDocumentEvidenceOptions = Readonly<{
  // Tailoring keeps every résumé item the job's current match analysis cited as evidence.
  protectMatchEvidence?: boolean;
}>;

function matchCitations(output: unknown) {
  const matches = output && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>).factualMatches
    : null;
  if (!Array.isArray(matches)) return [];
  return protectedResumeCitations(matches.flatMap((match) => {
    const evidence = match && typeof match === "object" && !Array.isArray(match)
      ? (match as Record<string, unknown>).applicantEvidence
      : null;
    return Array.isArray(evidence) ? evidence : [];
  }));
}

export async function readApplicationDocumentEvidence(
  client: SourceClient,
  userId: string,
  jobPostingId: string,
  options: ApplicationDocumentEvidenceOptions = {}
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
  // Owner facts go onto the document as typed; one with pasted notes stops here, before any paid call.
  assertReviewedOwnerFactsClean(evidence.reviewedEvidence);
  if (!evidence.currentEvidenceSourceValid || !evidence.effectiveEvidenceSnapshotId) {
    throw new PublicApiError("Save the current evidence review before generating application documents.", 409, {
      code: evidence.currentEvidenceSourceValid ? "EVIDENCE_SNAPSHOT_REQUIRED" : "EVIDENCE_SOURCE_STALE"
    });
  }
  // The latest JOB_MATCH for this job and the current evidence snapshot. Its citations index the
  // same master résumé the snapshot is bound to; stale or unknown ones protect nothing.
  const match = options.protectMatchEvidence
    ? await client.aIAnalysis.findFirst({
        where: {
          userId,
          jobPostingId: job.id,
          type: "JOB_MATCH",
          evidenceSnapshotId: evidence.effectiveEvidenceSnapshotId
        },
        orderBy: { createdAt: "desc" },
        select: { output: true }
      })
    : null;
  return {
    job,
    resume,
    profile,
    payload: buildApplicationDocumentPayload(
      job,
      resume,
      profile,
      evidence.reviewedEvidence,
      options.protectMatchEvidence ? { citations: matchCitations(match?.output) } : null
    )
  };
}
