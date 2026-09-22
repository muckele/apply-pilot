import { z } from "zod";

import { jobMatchPrompt } from "@/prompts/jobMatchPrompt";
import { generateJson } from "@/lib/ai/client";

export type JobMatchOutput = {
  overallFitScore: number;
  resumeKeywordScore: number;
  skillsMatchScore: number;
  experienceMatchScore: number;
  careerGoalScore: number;
  locationWorkStyleScore: number;
  compensationScore: number | null;
  confidenceScore: number;
  whyGoodMatch: string[];
  concerns: string[];
  missingKeywords: string[];
  supportedKeywords: string[];
  keywordsToEmphasize: string[];
  suggestedResumeAngle: string;
  suggestedCoverLetterAngle: string;
  recommendation: "apply now" | "consider" | "skip";
};

type MatchInput = {
  job: {
    title: string;
    company: string;
    location?: string | null;
    remoteStatus?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    description: string;
    requirements?: string[];
    preferredQualifications?: string[];
    detectedTechStack?: string[];
  };
  resume?: {
    summary?: string | null;
    rawText?: string | null;
    skills?: string[];
    achievements?: string[];
    workHistory?: unknown;
  } | null;
  profile?: {
    careerGoals?: string | null;
    preferredRoles?: string[];
    preferredLocations?: string[];
    remotePreference?: string;
    salaryTargetMin?: number | null;
    skillsToEmphasize?: string[];
    skillsNotToExaggerate?: string[];
  } | null;
};

const scoreSchema = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));
const recommendationSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["apply now", "consider", "skip"])
);

const jobMatchOutputSchema: z.ZodType<JobMatchOutput, z.ZodTypeDef, unknown> = z.object({
  overallFitScore: scoreSchema,
  resumeKeywordScore: scoreSchema,
  skillsMatchScore: scoreSchema,
  experienceMatchScore: scoreSchema,
  careerGoalScore: scoreSchema,
  locationWorkStyleScore: scoreSchema,
  compensationScore: z.union([scoreSchema, z.null()]),
  confidenceScore: scoreSchema,
  whyGoodMatch: z.array(z.string()),
  concerns: z.array(z.string()),
  missingKeywords: z.array(z.string()),
  supportedKeywords: z.array(z.string()),
  keywordsToEmphasize: z.array(z.string()),
  suggestedResumeAngle: z.string(),
  suggestedCoverLetterAngle: z.string(),
  recommendation: recommendationSchema
});

export async function scoreJobMatch(input: MatchInput, userId?: string) {
  const generated = await generateJson<JobMatchOutput>({
    promptName: "jobMatchPrompt",
    systemPrompt: jobMatchPrompt,
    payload: input,
    schema: jobMatchOutputSchema,
    context: userId ? { userId, feature: "JOB_MATCH", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
