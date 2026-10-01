import { z } from "zod";

import { jobMatchPrompt } from "@/prompts/jobMatchPrompt";
import { generateJson } from "@/lib/ai/client";

export const JOB_MATCH_PROMPT_VERSION = "3";

export type JobMatchEvidenceCitation = {
  ref: string;
  excerpt: string;
};

export type JobMatchModelFactualMatch = {
  applicantEvidence: JobMatchEvidenceCitation[];
  jobEvidence: JobMatchEvidenceCitation[];
  supportedKeywords: string[];
};

export type JobMatchFactualMatch = JobMatchModelFactualMatch & {
  claim: string;
};

export type JobMatchRequirementGap = {
  requirement: string;
  jobRequirement: JobMatchEvidenceCitation;
  missingKeywords: string[];
};

export type JobMatchModelOutput = {
  contractVersion: "3";
  overallFitScore: number;
  resumeKeywordScore: number;
  skillsMatchScore: number;
  experienceMatchScore: number;
  careerGoalScore: number;
  locationWorkStyleScore: number;
  compensationScore: number | null;
  confidenceScore: number;
  confidenceBasis: string;
  factualMatches: JobMatchModelFactualMatch[];
  requirementGaps: JobMatchRequirementGap[];
  advice: {
    keywordsToEmphasize: string[];
    resumeAngle: string;
    coverLetterAngle: string;
  };
  recommendation: "apply now" | "consider" | "skip";
};

export type CompensationAssessmentReason =
  | "assessed"
  | "model_did_not_assess"
  | "missing_applicant_salary_target"
  | "missing_job_salary"
  | "missing_both";

export type JobMatchOutput = Omit<JobMatchModelOutput, "factualMatches"> & {
  factualMatches: JobMatchFactualMatch[];
  compensationAssessment: {
    score: number | null;
    reason: CompensationAssessmentReason;
  };
  confidenceAssessment: {
    score: number;
    label: "Uncalibrated model self-assessment";
    basis: string;
  };
  whyGoodMatch: string[];
  concerns: string[];
  missingKeywords: string[];
  supportedKeywords: string[];
  keywordsToEmphasize: string[];
  suggestedResumeAngle: string;
  suggestedCoverLetterAngle: string;
};

export type MatchInput = {
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
    salaryTargetMax?: number | null;
    skillsToEmphasize?: string[];
    skillsNotToExaggerate?: string[];
  } | null;
};

const scoreSchema = z.number().min(0).max(100).transform((value) => Math.round(value));
const recommendationSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["apply now", "consider", "skip"])
);
const citationSchema = z.object({
  ref: z.string().min(1),
  excerpt: z.string().min(1)
}).strict();

const jobMatchModelOutputSchema: z.ZodType<JobMatchModelOutput, z.ZodTypeDef, unknown> = z.object({
  contractVersion: z.literal("3"),
  overallFitScore: scoreSchema,
  resumeKeywordScore: scoreSchema,
  skillsMatchScore: scoreSchema,
  experienceMatchScore: scoreSchema,
  careerGoalScore: scoreSchema,
  locationWorkStyleScore: scoreSchema,
  compensationScore: z.union([scoreSchema, z.null()]),
  confidenceScore: scoreSchema,
  confidenceBasis: z.string().min(1),
  factualMatches: z.array(z.object({
    applicantEvidence: z.array(citationSchema).min(1),
    jobEvidence: z.array(citationSchema).min(1),
    supportedKeywords: z.array(z.string().min(1)).min(1)
  }).strict()),
  requirementGaps: z.array(z.object({
    requirement: z.string().min(1),
    jobRequirement: citationSchema,
    missingKeywords: z.array(z.string().min(1))
  }).strict()),
  advice: z.object({
    keywordsToEmphasize: z.array(z.string().min(1)),
    resumeAngle: z.string().min(1),
    coverLetterAngle: z.string().min(1)
  }).strict(),
  recommendation: recommendationSchema
}).strict();

type ResolvedEvidence = { found: true; value: unknown } | { found: false };

function indexedValue(ref: string, prefix: string, values: unknown[] | undefined): ResolvedEvidence {
  const match = ref.match(new RegExp(`^${prefix.replace(".", "\\.")}\\[(\\d+)\\]$`));
  if (!match || !values) return { found: false };
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 && index < values.length
    ? { found: true, value: values[index] }
    : { found: false };
}

function exactValue(ref: string, values: Record<string, unknown>): ResolvedEvidence {
  return Object.prototype.hasOwnProperty.call(values, ref) && values[ref] !== null && values[ref] !== undefined
    ? { found: true, value: values[ref] }
    : { found: false };
}

function resolveApplicantEvidence(input: MatchInput, ref: string): ResolvedEvidence {
  const exact = exactValue(ref, {
    "resume.summary": input.resume?.summary,
    "resume.rawText": input.resume?.rawText,
    "resume.workHistory": input.resume?.workHistory,
    "profile.careerGoals": input.profile?.careerGoals,
    "profile.remotePreference": input.profile?.remotePreference,
    "profile.salaryTargetMin": input.profile?.salaryTargetMin,
    "profile.salaryTargetMax": input.profile?.salaryTargetMax
  });
  if (exact.found) return exact;

  const indexed = [
    indexedValue(ref, "resume.skills", input.resume?.skills),
    indexedValue(ref, "resume.achievements", input.resume?.achievements),
    indexedValue(ref, "profile.preferredRoles", input.profile?.preferredRoles),
    indexedValue(ref, "profile.preferredLocations", input.profile?.preferredLocations),
    indexedValue(ref, "profile.skillsToEmphasize", input.profile?.skillsToEmphasize)
  ].find((candidate) => candidate.found);
  return indexed ?? { found: false };
}

function resolveJobEvidence(input: MatchInput, ref: string): ResolvedEvidence {
  const exact = exactValue(ref, {
    "job.title": input.job.title,
    "job.company": input.job.company,
    "job.location": input.job.location,
    "job.remoteStatus": input.job.remoteStatus,
    "job.salaryMin": input.job.salaryMin,
    "job.salaryMax": input.job.salaryMax,
    "job.description": input.job.description
  });
  if (exact.found) return exact;

  const indexed = [
    indexedValue(ref, "job.requirements", input.job.requirements),
    indexedValue(ref, "job.preferredQualifications", input.job.preferredQualifications),
    indexedValue(ref, "job.detectedTechStack", input.job.detectedTechStack)
  ].find((candidate) => candidate.found);
  return indexed ?? { found: false };
}

function evidenceText(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function comparable(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function validateCitation(
  citation: JobMatchEvidenceCitation,
  resolver: (ref: string) => ResolvedEvidence,
  source: "applicant" | "job"
) {
  const resolved = resolver(citation.ref);
  if (!resolved.found) {
    throw new Error(`JOB_MATCH returned an unknown ${source} evidence reference: ${citation.ref}`);
  }

  const haystack = comparable(evidenceText(resolved.value));
  const needle = comparable(citation.excerpt);
  if (!needle || !haystack.includes(needle)) {
    throw new Error(`JOB_MATCH returned an unsupported ${source} evidence excerpt for ${citation.ref}`);
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function includesKeyword(citations: JobMatchEvidenceCitation[], keyword: string) {
  return citations.some((citation) => containsWholeKeyword(citation.excerpt, keyword));
}

function applicantEvidenceText(input: MatchInput) {
  const values = [
    input.resume?.summary,
    input.resume?.rawText,
    input.resume?.workHistory,
    ...(input.resume?.skills ?? []),
    ...(input.resume?.achievements ?? []),
    ...(input.profile?.skillsToEmphasize ?? [])
  ].filter((value) => value !== null && value !== undefined);
  return comparable(values.map(evidenceText).join("\n"));
}

function containsWholeKeyword(text: string, keyword: string) {
  const normalizedText = comparable(text);
  const escaped = comparable(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(normalizedText);
}

function isPresentNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assessCompensation(input: MatchInput, modelScore: number | null) {
  const hasApplicantTarget = isPresentNumber(input.profile?.salaryTargetMin)
    || isPresentNumber(input.profile?.salaryTargetMax);
  const hasJobSalary = isPresentNumber(input.job.salaryMin) || isPresentNumber(input.job.salaryMax);

  let reason: CompensationAssessmentReason;
  let score = modelScore;
  if (!hasApplicantTarget && !hasJobSalary) {
    reason = "missing_both";
    score = null;
  } else if (!hasApplicantTarget) {
    reason = "missing_applicant_salary_target";
    score = null;
  } else if (!hasJobSalary) {
    reason = "missing_job_salary";
    score = null;
  } else if (modelScore === null) {
    reason = "model_did_not_assess";
  } else {
    reason = "assessed";
  }

  return { score, reason };
}

export function normalizeJobMatchOutput(input: MatchInput, output: JobMatchModelOutput): JobMatchOutput {
  for (const match of output.factualMatches) {
    if (Object.prototype.hasOwnProperty.call(match, "claim")) {
      throw new Error("JOB_MATCH returned a free-text factual claim; factual claims are derived locally from validated evidence.");
    }
    if (!uniqueStrings(match.supportedKeywords).length) {
      throw new Error("JOB_MATCH returned a factual match without a supported keyword.");
    }
    for (const citation of match.applicantEvidence) {
      validateCitation(citation, (ref) => resolveApplicantEvidence(input, ref), "applicant");
    }
    for (const citation of match.jobEvidence) {
      validateCitation(citation, (ref) => resolveJobEvidence(input, ref), "job");
    }
    for (const keyword of match.supportedKeywords) {
      if (!includesKeyword(match.applicantEvidence, keyword) || !includesKeyword(match.jobEvidence, keyword)) {
        throw new Error(`JOB_MATCH returned an unsupported matched keyword: ${keyword}`);
      }
    }
  }

  for (const gap of output.requirementGaps) {
    if (!/^job\.(requirements|preferredQualifications)\[\d+\]$/.test(gap.jobRequirement.ref)) {
      throw new Error(`JOB_MATCH gap did not cite a structured job requirement: ${gap.jobRequirement.ref}`);
    }
    const resolvedRequirement = resolveJobEvidence(input, gap.jobRequirement.ref);
    validateCitation(gap.jobRequirement, () => resolvedRequirement, "job");
    if (!resolvedRequirement.found
      || comparable(evidenceText(resolvedRequirement.value)) !== comparable(gap.jobRequirement.excerpt)) {
      throw new Error("JOB_MATCH gap did not cite the full structured job requirement.");
    }
    if (comparable(gap.requirement) !== comparable(gap.jobRequirement.excerpt)) {
      throw new Error("JOB_MATCH gap did not preserve the exact cited job requirement.");
    }
    for (const keyword of gap.missingKeywords) {
      if (!includesKeyword([gap.jobRequirement], keyword)) {
        throw new Error(`JOB_MATCH returned an unsupported missing keyword: ${keyword}`);
      }
      if (containsWholeKeyword(applicantEvidenceText(input), keyword)) {
        throw new Error(`JOB_MATCH marked ${keyword} missing although it is present in submitted applicant evidence.`);
      }
    }
  }

  const compensation = assessCompensation(input, output.compensationScore);
  const factualMatches = output.factualMatches.map((match) => {
    const supportedKeywords = uniqueStrings(match.supportedKeywords);
    return {
      ...match,
      supportedKeywords,
      claim: `Submitted applicant evidence matches job evidence for ${supportedKeywords.join(", ")}.`
    };
  });
  return {
    ...output,
    factualMatches,
    compensationScore: compensation.score,
    compensationAssessment: compensation,
    confidenceAssessment: {
      score: output.confidenceScore,
      label: "Uncalibrated model self-assessment",
      basis: output.confidenceBasis
    },
    whyGoodMatch: factualMatches.map((match) => match.claim),
    concerns: output.requirementGaps.map((gap) => gap.requirement),
    missingKeywords: uniqueStrings(output.requirementGaps.flatMap((gap) => gap.missingKeywords)),
    supportedKeywords: uniqueStrings(factualMatches.flatMap((match) => match.supportedKeywords)),
    keywordsToEmphasize: uniqueStrings(output.advice.keywordsToEmphasize),
    suggestedResumeAngle: output.advice.resumeAngle,
    suggestedCoverLetterAngle: output.advice.coverLetterAngle
  };
}

export async function scoreJobMatch(input: MatchInput, userId?: string) {
  const generated = await generateJson<JobMatchModelOutput>({
    promptName: "jobMatchPrompt",
    systemPrompt: jobMatchPrompt,
    payload: input,
    schema: jobMatchModelOutputSchema,
    context: userId
      ? { userId, feature: "JOB_MATCH", promptVersion: JOB_MATCH_PROMPT_VERSION }
      : undefined
  });
  const normalized = normalizeJobMatchOutput(input, generated.data);

  return {
    ...normalized,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
