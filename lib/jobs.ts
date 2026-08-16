import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { JOB_MATCH_PROMPT_VERSION, scoreJobMatch } from "@/lib/ai/job-match";
import { hashAiInput } from "@/lib/ai/usage";

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

export async function runJobMatch(
  userId: string,
  jobPostingId: string,
  options: { force?: boolean; automation?: boolean; highCostConfirmed?: boolean } = {}
) {
  const [job, resume, profile] = await Promise.all([
    prisma.jobPosting.findFirstOrThrow({
      where: { id: jobPostingId, userId }
    }),
    prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" }
    }),
    prisma.userProfile.findUnique({
      where: { userId }
    })
  ]);

  const matchInput = {
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
    resume: resume
      ? {
          summary: resume.summary,
          rawText: resume.rawText,
          skills: resume.skills,
          achievements: resume.achievements,
          workHistory: resume.workHistory
        }
      : null,
    profile: profile
      ? {
          careerGoals: profile.careerGoals,
          preferredRoles: profile.preferredRoles,
          preferredLocations: profile.preferredLocations,
          remotePreference: profile.remotePreference,
          salaryTargetMin: profile.salaryTargetMin,
          skillsToEmphasize: profile.skillsToEmphasize,
          skillsNotToExaggerate: profile.skillsNotToExaggerate
        }
      : null
  };
  const inputHash = hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, matchInput);

  if (!options.force && job.overallFitScore !== null) {
    const existingAnalysis = await prisma.aIAnalysis.findFirst({
      where: { userId, jobPostingId: job.id, type: "JOB_MATCH", inputHash },
      orderBy: { createdAt: "desc" }
    });

    if (existingAnalysis) {
      return { job, match: existingAnalysis.output, cached: true };
    }
  }

  const match = await scoreJobMatch(matchInput, userId, options);

  const updatedJob = await prisma.$transaction(async (tx) => {
    const updated = await tx.jobPosting.update({
      where: { id: job.id },
      data: {
        overallFitScore: match.overallFitScore,
        resumeKeywordScore: match.resumeKeywordScore,
        skillsMatchScore: match.skillsMatchScore,
        experienceMatchScore: match.experienceMatchScore,
        careerGoalScore: match.careerGoalScore,
        locationWorkStyleScore: match.locationWorkStyleScore,
        compensationScore: match.compensationScore,
        confidenceScore: match.confidenceScore,
        keyMatchReason: match.whyGoodMatch[0],
        matchRecommendation: match.recommendation,
        missingKeywords: match.missingKeywords,
        supportedKeywords: match.supportedKeywords,
        suggestedResumeAngle: match.suggestedResumeAngle,
        suggestedCoverLetterAngle: match.suggestedCoverLetterAngle,
        concerns: match.concerns
      }
    });

    await tx.aIAnalysis.create({
      data: {
        userId,
        jobPostingId: job.id,
        type: "JOB_MATCH",
        model: match.model,
        promptName: "jobMatchPrompt",
        promptVersion: match.promptVersion,
        inputHash: match.inputHash,
        input: {
          jobId: job.id,
          resumeId: resume?.id,
          profileId: profile?.id
        },
        output: match,
        confidence: match.confidenceScore
      }
    });

    return updated;
  });

  return { job: updatedJob, match, cached: false };
}
