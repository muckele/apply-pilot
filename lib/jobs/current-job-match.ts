import type { Prisma } from "@prisma/client";

import type { MatchInput } from "@/lib/ai/job-match";
import { hashAiInput } from "@/lib/ai/input-hash";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import type { JobMatchReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";
import {
  isEvidenceBindingCurrent,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";
import { prisma } from "@/lib/prisma";

export const JOB_MATCH_RESUME_SELECT = Object.freeze({
  id: true,
  updatedAt: true,
  summary: true,
  rawText: true,
  skills: true,
  achievements: true,
  workHistory: true,
  projects: true,
  education: true,
  certifications: true
}) satisfies Prisma.ResumeSelect;

export const JOB_MATCH_PROFILE_SELECT = Object.freeze({
  careerGoals: true,
  preferredRoles: true,
  preferredLocations: true,
  remotePreference: true,
  salaryTargetMin: true,
  salaryTargetMax: true,
  skillsToEmphasize: true,
  skillsNotToExaggerate: true
}) satisfies Prisma.UserProfileSelect;

export const CURRENT_JOB_MATCH_ANALYSIS_WHERE = Object.freeze({
  type: "JOB_MATCH" as const,
  model: JOB_MATCH_MODEL,
  promptVersion: JOB_MATCH_PROMPT_VERSION
}) satisfies Prisma.AIAnalysisWhereInput;

export const CURRENT_JOB_MATCH_ANALYSES = Object.freeze({
  where: CURRENT_JOB_MATCH_ANALYSIS_WHERE,
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { id: true, inputHash: true, evidenceSnapshotId: true }
});

export const JOB_MATCH_LIST_CANDIDATE_LIMIT = 500;

export function buildCurrentJobMatchInput(input: {
  job: MatchInput["job"];
  resume: MatchInput["resume"];
  profile: MatchInput["profile"];
  reviewedEvidence?: JobMatchReviewedEvidence | null;
  evidenceSnapshotGeneration?: number;
}): MatchInput {
  const { job, resume, profile } = input;
  const jobGeneration = (job as MatchInput["job"] & { evidenceSnapshotGeneration?: number })
    .evidenceSnapshotGeneration;
  return {
    evidenceSnapshotGeneration: input.evidenceSnapshotGeneration ?? jobGeneration ?? 0,
    job: {
      title: job.title,
      company: job.company,
      location: job.location,
      remoteStatus: job.remoteStatus,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      description: job.description,
      requirements: job.requirements,
      preferredQualifications: job.preferredQualifications,
      detectedTechStack: job.detectedTechStack
    },
    resume: resume ? {
      summary: resume.summary,
      rawText: resume.rawText,
      skills: resume.skills,
      achievements: resume.achievements,
      workHistory: resume.workHistory,
      projects: resume.projects,
      education: resume.education,
      certifications: resume.certifications
    } : null,
    profile: profile ? {
      careerGoals: profile.careerGoals,
      preferredRoles: profile.preferredRoles,
      preferredLocations: profile.preferredLocations,
      remotePreference: profile.remotePreference,
      salaryTargetMin: profile.salaryTargetMin,
      salaryTargetMax: profile.salaryTargetMax,
      skillsToEmphasize: profile.skillsToEmphasize,
      skillsNotToExaggerate: profile.skillsNotToExaggerate
    } : null,
    reviewedEvidence: input.reviewedEvidence ?? null
  };
}

export function currentJobMatchInputHash(input: MatchInput) {
  return hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, input);
}

export function buildCurrentJobMatchContext(input: {
  job: MatchInput["job"] & {
    currentEvidenceSnapshotId: string | null;
    evidenceSnapshotGeneration: number;
    currentEvidenceSnapshot?: {
      id: string;
      resumeId: string;
      sourceResumeUpdatedAt: Date;
      snapshotHash: string;
      reviewPayload: unknown;
    } | null;
  };
  resume: (NonNullable<MatchInput["resume"]> & { id: string; updatedAt: Date }) | null;
  profile: MatchInput["profile"];
}) {
  const evidence = resolveCurrentReviewedEvidence(input.job, input.resume);
  return {
    ...evidence,
    matchInput: buildCurrentJobMatchInput({
      job: input.job,
      resume: input.resume,
      profile: input.profile,
      reviewedEvidence: evidence.reviewedEvidence,
      evidenceSnapshotGeneration: input.job.evidenceSnapshotGeneration
    })
  };
}

export async function readCurrentJobMatchSources(userId: string) {
  const [resume, profile] = await Promise.all([
    prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" },
      select: JOB_MATCH_RESUME_SELECT
    }),
    prisma.userProfile.findUnique({ where: { userId }, select: JOB_MATCH_PROFILE_SELECT })
  ]);
  return { resume, profile };
}

export function hasCurrentJobMatchAnalysis(
  value: {
    currentEvidenceSnapshotId?: string | null;
    currentEvidenceSourceValid?: boolean;
    aiAnalyses?: readonly {
      inputHash?: string | null;
      evidenceSnapshotId?: string | null;
    }[] | null;
  },
  input: MatchInput
) {
  const expectedHash = currentJobMatchInputHash(input);
  const currentSnapshotId = value.currentEvidenceSnapshotId ?? null;
  const currentEvidenceSourceValid = value.currentEvidenceSourceValid ?? true;
  return Array.isArray(value.aiAnalyses) && value.aiAnalyses.some((analysis) =>
    analysis.inputHash === expectedHash && isEvidenceBindingCurrent({
      currentEvidenceSnapshotId: currentSnapshotId,
      currentEvidenceSourceValid,
      artifactEvidenceSnapshotId: analysis.evidenceSnapshotId ?? null,
    }));
}

type DenormalizedJobMatchFields = {
  overallFitScore: number | null;
  confidenceScore: number | null;
  matchRecommendation: string | null;
  keyMatchReason: string | null;
  missingKeywords: string[];
  supportedKeywords: string[];
  concerns: string[];
  suggestedResumeAngle: string | null;
  suggestedCoverLetterAngle: string | null;
};

export function currentJobMatchFields<T extends DenormalizedJobMatchFields>(job: T, isCurrent: boolean): T {
  if (isCurrent) return job;
  return {
    ...job,
    overallFitScore: null,
    confidenceScore: null,
    matchRecommendation: null,
    keyMatchReason: null,
    missingKeywords: [],
    supportedKeywords: [],
    concerns: [],
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  };
}
