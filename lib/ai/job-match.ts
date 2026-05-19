import { jobMatchPrompt } from "@/prompts/jobMatchPrompt";
import { scoreFromRatio, uniqueStrings } from "@/lib/normalize";
import { generateJson, getOpenAIModel } from "@/lib/ai/client";

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

const defaultSkills = [
  "javascript",
  "react",
  "node",
  "express",
  "python",
  "sql",
  "mongodb",
  "postgresql",
  "django",
  "rest api",
  "aws",
  "customer success",
  "sales",
  "operations",
  "implementation"
];

function hasTerm(text: string, term: string) {
  const normalizedTerm = term.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${normalizedTerm}\\b`, "i").test(text);
}

function heuristicMatch(input: MatchInput): JobMatchOutput {
  const text = `${input.job.title} ${input.job.description} ${(input.job.requirements ?? []).join(" ")} ${(input.job.detectedTechStack ?? []).join(" ")}`.toLowerCase();
  const candidateSkills = uniqueStrings([
    ...(input.resume?.skills ?? []),
    ...(input.profile?.skillsToEmphasize ?? []),
    ...defaultSkills
  ]).map((skill) => skill.toLowerCase());
  const supportedKeywords = candidateSkills.filter((skill) => hasTerm(text, skill));
  const visibleKeywords = uniqueStrings([
    ...(input.job.detectedTechStack ?? []),
    ...(input.job.requirements ?? [])
      .join(" ")
      .split(/[,.;\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 2 && part.length < 45)
  ]);
  const missingKeywords = visibleKeywords
    .filter((keyword) => !supportedKeywords.some((supported) => keyword.toLowerCase().includes(supported)))
    .slice(0, 10);
  const roleText = `${input.job.title} ${input.job.description}`.toLowerCase();
  const targetRoleHit = (input.profile?.preferredRoles ?? []).some((role) =>
    roleText.includes(role.toLowerCase().replace(" / ", " "))
  );
  const skillsMatchScore = scoreFromRatio(
    supportedKeywords.length / Math.max(6, supportedKeywords.length + missingKeywords.length)
  );
  const roleScore = targetRoleHit ? 92 : roleText.includes("engineer") ? 78 : 68;
  const locationScore =
    input.job.remoteStatus?.toLowerCase().includes("remote") ||
    (input.job.location ?? "").toLowerCase().includes("los angeles") ||
    (input.job.location ?? "").toLowerCase().includes("fontana")
      ? 90
      : 70;
  const overallFitScore = Math.round(skillsMatchScore * 0.45 + roleScore * 0.3 + locationScore * 0.25);

  return {
    overallFitScore,
    resumeKeywordScore: skillsMatchScore,
    skillsMatchScore,
    experienceMatchScore: roleText.includes("senior") ? 58 : 76,
    careerGoalScore: roleScore,
    locationWorkStyleScore: locationScore,
    compensationScore: input.job.salaryMin && input.profile?.salaryTargetMin
      ? input.job.salaryMin >= input.profile.salaryTargetMin
        ? 90
        : 62
      : null,
    confidenceScore: input.resume?.rawText ? 78 : 58,
    whyGoodMatch: [
      "The role overlaps with customer-facing technical work, software implementation, and SaaS operations.",
      supportedKeywords.length
        ? `Supported keywords include ${supportedKeywords.slice(0, 5).join(", ")}.`
        : "The posting has some broad role alignment, but a parsed master resume would improve confidence."
    ],
    concerns: roleText.includes("senior")
      ? ["The posting appears to target a more senior profile; apply only if requirements are flexible."]
      : ["Confirm the required years of experience and avoid overstating unsupported tools."],
    missingKeywords,
    supportedKeywords,
    keywordsToEmphasize: supportedKeywords.slice(0, 8),
    suggestedResumeAngle:
      "Lead with customer-facing technical problem solving, implementation experience, full-stack training, and operations ownership.",
    suggestedCoverLetterAngle:
      "Connect software engineering training with sales, business development, and operational leadership for a practical customer-facing technical profile.",
    recommendation: overallFitScore >= 78 ? "apply now" : overallFitScore >= 62 ? "consider" : "skip"
  };
}

export async function scoreJobMatch(input: MatchInput) {
  const fallback = heuristicMatch(input);

  const output = await generateJson<JobMatchOutput>({
    promptName: "jobMatchPrompt",
    systemPrompt: jobMatchPrompt,
    payload: input,
    fallback
  });

  return {
    ...output,
    model: getOpenAIModel()
  };
}
