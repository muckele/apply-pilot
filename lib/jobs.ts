import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { scoreJobMatch } from "@/lib/ai/job-match";

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

export async function runJobMatch(userId: string, jobPostingId: string) {
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

  const match = await scoreJobMatch({ job, resume, profile });

  const updatedJob = await prisma.jobPosting.update({
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

  await prisma.aIAnalysis.create({
    data: {
      userId,
      jobPostingId: job.id,
      type: "JOB_MATCH",
      model: match.model,
      promptName: "jobMatchPrompt",
      input: {
        jobId: job.id,
        resumeId: resume?.id,
        profileId: profile?.id
      },
      output: match,
      confidence: match.confidenceScore
    }
  });

  return { job: updatedJob, match };
}
