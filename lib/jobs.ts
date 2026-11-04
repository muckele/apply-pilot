import { Prisma, type JobPosting, type PrismaClient } from "@prisma/client";

import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION, scoreJobMatch } from "@/lib/ai/job-match";
import type { AiInvocationOptions } from "@/lib/ai/client";
import { PublicApiError } from "@/lib/api-errors";
import { buildJobMatchPostingUpdate } from "@/lib/jobs/job-match-projection";
import { buildCurrentJobMatchContext, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";

export async function upsertNormalizedJob({
  userId,
  jobSourceId,
  job
}: {
  userId: string;
  jobSourceId?: string;
  job: NormalizedJob;
}) {
  const normalizedCompany = normalizeText(job.company);
  const normalizedTitle = normalizeText(job.title);
  const normalizedLocation = normalizeText(job.location);
  const normalizedApplyUrl = normalizeUrl(job.applyUrl ?? job.sourceUrl);

  return prisma.jobPosting.upsert({
    where: {
      userId_normalizedCompany_normalizedTitle_normalizedLocation_normalizedApplyUrl: {
        userId,
        normalizedCompany,
        normalizedTitle,
        normalizedLocation,
        normalizedApplyUrl
      }
    },
    create: {
      userId,
      jobSourceId,
      title: job.title,
      normalizedTitle,
      company: job.company,
      normalizedCompany,
      location: job.location,
      normalizedLocation,
      remoteStatus: job.remoteStatus,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      datePosted: job.datePosted,
      sourceUrl: job.sourceUrl,
      applyUrl: job.applyUrl,
      normalizedApplyUrl,
      description: job.description,
      requirements: job.requirements,
      preferredQualifications: job.preferredQualifications,
      benefits: job.benefits,
      detectedTechStack: job.detectedTechStack,
      seniorityLevel: job.seniorityLevel,
      companySize: job.companySize,
      sourceType: job.sourceType,
      lastCheckedAt: new Date()
    },
    update: {
      location: job.location,
      normalizedLocation,
      remoteStatus: job.remoteStatus,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      datePosted: job.datePosted,
      sourceUrl: job.sourceUrl,
      applyUrl: job.applyUrl,
      description: job.description,
      requirements: job.requirements,
      preferredQualifications: job.preferredQualifications,
      benefits: job.benefits,
      detectedTechStack: job.detectedTechStack,
      seniorityLevel: job.seniorityLevel,
      companySize: job.companySize,
      sourceType: job.sourceType,
      lastCheckedAt: new Date()
    }
  });
}

type JobMatchScorer = typeof scoreJobMatch;
export type JobMatchRunner = (
  userId: string,
  jobPostingId: string,
  options?: { force?: boolean } & AiInvocationOptions
) => Promise<{ job: JobPosting; match: unknown; cached: boolean }>;

function staleJobMatchError() {
  return new PublicApiError(
    "The job, resume, profile, or reviewed evidence changed while fit scoring was running. Run the assessment again.",
    409,
    { code: "JOB_MATCH_INPUT_STALE" }
  );
}

export function createJobMatchRunner({
  prismaClient,
  score
}: {
  prismaClient: PrismaClient;
  score: JobMatchScorer;
}): JobMatchRunner {
  return async function runBoundJobMatch(
    userId: string,
    jobPostingId: string,
    options: { force?: boolean } & AiInvocationOptions = {}
  ) {
    const [job, resume, profile] = await Promise.all([
      prismaClient.jobPosting.findFirstOrThrow({
        where: { id: jobPostingId, userId },
        include: {
          currentEvidenceSnapshot: {
            select: CURRENT_EVIDENCE_SNAPSHOT_SELECT
          }
        }
      }),
      prismaClient.resume.findFirst({
        where: { userId, isMaster: true },
        orderBy: { updatedAt: "desc" }
      }),
      prismaClient.userProfile.findUnique({
        where: { userId }
      })
    ]);

    const evidenceContext = buildCurrentJobMatchContext({ job, resume, profile });
    const { matchInput } = evidenceContext;
    const evidenceBindingId = evidenceContext.effectiveEvidenceSnapshotId;
    const inputHash = currentJobMatchInputHash(matchInput);

    if (!options.force && job.overallFitScore !== null) {
      const existingAnalysis = await prismaClient.aIAnalysis.findFirst({
        where: {
          userId,
          jobPostingId: job.id,
          evidenceSnapshotId: evidenceBindingId,
          type: "JOB_MATCH",
          promptVersion: JOB_MATCH_PROMPT_VERSION,
          inputHash,
          model: JOB_MATCH_MODEL
        },
        orderBy: { createdAt: "desc" }
      });

      if (existingAnalysis) {
        return { job, match: existingAnalysis.output, cached: true };
      }
    }

    const match = await score(matchInput, userId, {
      automation: options.automation,
      highCostConfirmed: options.highCostConfirmed
    });

    try {
      const updatedJob = await prismaClient.$transaction(async (tx) => {
        const lockedJobs = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "JobPosting"
          WHERE "id" = ${jobPostingId} AND "userId" = ${userId}
          FOR UPDATE
        `;
        if (lockedJobs.length !== 1) throw staleJobMatchError();

        const [freshJob, freshResume, freshProfile] = await Promise.all([
          tx.jobPosting.findUniqueOrThrow({
            where: { id: jobPostingId },
            include: {
              currentEvidenceSnapshot: {
                select: CURRENT_EVIDENCE_SNAPSHOT_SELECT
              }
            }
          }),
          tx.resume.findFirst({
            where: { userId, isMaster: true },
            orderBy: { updatedAt: "desc" }
          }),
          tx.userProfile.findUnique({ where: { userId } })
        ]);
        const freshContext = buildCurrentJobMatchContext({
          job: freshJob,
          resume: freshResume,
          profile: freshProfile
        });
        const freshInput = freshContext.matchInput;
        if (
          currentJobMatchInputHash(freshInput) !== match.inputHash ||
          (freshJob.currentEvidenceSnapshotId ?? null) !== (job.currentEvidenceSnapshotId ?? null) ||
          freshJob.evidenceSnapshotGeneration !== job.evidenceSnapshotGeneration ||
          freshContext.effectiveEvidenceSnapshotId !== evidenceBindingId
        ) {
          throw staleJobMatchError();
        }

        const updated = await tx.jobPosting.update({
          where: { id: freshJob.id },
          data: buildJobMatchPostingUpdate(match)
        });

        await tx.aIAnalysis.create({
          data: {
            userId,
            jobPostingId: freshJob.id,
            evidenceSnapshotId: freshContext.effectiveEvidenceSnapshotId,
            type: "JOB_MATCH",
            model: match.model,
            promptName: "jobMatchPrompt",
            promptVersion: match.promptVersion,
            inputHash: match.inputHash,
            input: {
              jobId: freshJob.id,
              resumeId: freshResume?.id,
              profileId: freshProfile?.id,
              evidenceSnapshotId: freshContext.effectiveEvidenceSnapshotId,
              evidenceSnapshotGeneration: freshJob.evidenceSnapshotGeneration
            },
            output: match,
            confidence: match.confidenceScore
          }
        });

        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return { job: updatedJob, match, cached: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw staleJobMatchError();
      }
      throw error;
    }
  };
}

export const runJobMatch = createJobMatchRunner({ prismaClient: prisma, score: scoreJobMatch });
