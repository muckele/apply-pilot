import type { JobMatchOutput } from "@/lib/ai/job-match";

export function buildJobMatchPostingUpdate(match: JobMatchOutput) {
  return {
    overallFitScore: match.overallFitScore,
    resumeKeywordScore: match.resumeKeywordScore,
    skillsMatchScore: match.skillsMatchScore,
    experienceMatchScore: match.experienceMatchScore,
    careerGoalScore: match.careerGoalScore,
    locationWorkStyleScore: match.locationWorkStyleScore,
    compensationScore: match.compensationScore,
    confidenceScore: match.confidenceScore,
    keyMatchReason: match.whyGoodMatch[0] ?? null,
    matchRecommendation: match.recommendation,
    missingKeywords: match.missingKeywords,
    supportedKeywords: match.supportedKeywords,
    suggestedResumeAngle: match.suggestedResumeAngle,
    suggestedCoverLetterAngle: match.suggestedCoverLetterAngle,
    concerns: match.concerns
  };
}
