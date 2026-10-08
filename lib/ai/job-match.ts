import { z } from "zod";

import { jobMatchPrompt } from "@/prompts/jobMatchPrompt";
import {
  type AiInvocationOptions,
  LocalAiUnavailableError
} from "@/lib/ai/client";
import {
  findCachedAiResponse,
  hashAiInput,
  reconcileAiReservation,
  reserveAiBudget
} from "@/lib/ai/application-plan-budget";
import { getAiFinancialPolicy, getAiRuntimeMode } from "@/lib/ai/config";
import {
  callGeminiJsonProvider,
  GeminiProviderError,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";

// Result contract remains v3; prompt/cache revision 3.2 makes factual evidence
// resume-only while retaining profile values as preference-fit context.
export const JOB_MATCH_PROMPT_VERSION = "3.2";
export const JOB_MATCH_PROVIDER = "gemini" as const;
export const JOB_MATCH_MODEL = "gemini-3.8-flash";
export const JOB_MATCH_THINKING_LEVEL = "MEDIUM" as const;

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
    projects?: unknown;
    education?: unknown;
    certifications?: unknown;
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

export class JobMatchOutputValidationError extends Error {
  readonly validationStage: "schema" | "semantic";
  readonly fieldPath: string | null;

  constructor(validationStage: "schema" | "semantic", fieldPath: string | null, message?: string) {
    super(message ?? "JOB_MATCH output failed " + validationStage + " validation.");
    this.name = "JobMatchOutputValidationError";
    this.validationStage = validationStage;
    this.fieldPath = fieldPath;
  }
}

const scoreSchema = z.number().min(0).max(100).transform((value) => Math.round(value));
const recommendationSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["apply now", "consider", "skip"])
);
const citationSchema = z.object({
  ref: z.string().min(1),
  excerpt: z.string().min(1)
}).strict();

export const jobMatchModelOutputSchema: z.ZodType<JobMatchModelOutput, z.ZodTypeDef, unknown> = z.object({
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
    missingKeywords: z.array(z.string().min(1)).min(1)
  }).strict()),
  advice: z.object({
    keywordsToEmphasize: z.array(z.string().min(1)),
    resumeAngle: z.string().min(1),
    coverLetterAngle: z.string().min(1)
  }).strict(),
  recommendation: recommendationSchema
}).strict();

const jsonScore = { type: "number", minimum: 0, maximum: 100 } as const;
const jsonString = { type: "string" } as const;

function referenceValueIsPresent(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function exactReferences(entries: Array<[string, unknown]>) {
  return entries.filter(([, value]) => referenceValueIsPresent(value)).map(([ref]) => ref);
}

function indexedReferences(prefix: string, values: unknown) {
  return Array.isArray(values)
    ? values.flatMap((value, index) => referenceValueIsPresent(value) ? [`${prefix}[${index}]`] : [])
    : [];
}

export function getJobMatchEvidenceReferences(input: MatchInput) {
  const workHistoryReferences = indexedReferences("resume.workHistory", input.resume?.workHistory);
  const applicant = [
    ...exactReferences([
      ["resume.summary", input.resume?.summary],
      ["resume.rawText", input.resume?.rawText]
    ]),
    ...indexedReferences("resume.skills", input.resume?.skills),
    ...indexedReferences("resume.achievements", input.resume?.achievements),
    ...workHistoryReferences,
    ...indexedReferences("resume.projects", input.resume?.projects),
    ...indexedReferences("resume.education", input.resume?.education),
    ...indexedReferences("resume.certifications", input.resume?.certifications)
  ];
  const preference = [
    ...exactReferences([["profile.careerGoals", input.profile?.careerGoals]]),
    ...indexedReferences("profile.preferredRoles", input.profile?.preferredRoles),
    ...indexedReferences("profile.preferredLocations", input.profile?.preferredLocations),
    ...exactReferences([
      ["profile.remotePreference", input.profile?.remotePreference],
      ["profile.salaryTargetMin", input.profile?.salaryTargetMin],
      ["profile.salaryTargetMax", input.profile?.salaryTargetMax]
    ]),
    ...indexedReferences("profile.skillsToEmphasize", input.profile?.skillsToEmphasize)
  ];
  const job = [
    ...exactReferences([
      ["job.title", input.job.title],
      ["job.company", input.job.company],
      ["job.location", input.job.location],
      ["job.remoteStatus", input.job.remoteStatus],
      ["job.salaryMin", input.job.salaryMin],
      ["job.salaryMax", input.job.salaryMax],
      ["job.description", input.job.description]
    ]),
    ...indexedReferences("job.requirements", input.job.requirements),
    ...indexedReferences("job.preferredQualifications", input.job.preferredQualifications),
    ...indexedReferences("job.detectedTechStack", input.job.detectedTechStack)
  ];
  const gap = [
    ...indexedReferences("job.requirements", input.job.requirements),
    ...indexedReferences("job.preferredQualifications", input.job.preferredQualifications)
  ];
  return { applicant, preference, job, gap };
}

function jsonCitation(refs: string[], emptySentinel: string) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ref: { type: "string", enum: refs.length ? refs : [emptySentinel] },
      excerpt: jsonString
    },
    required: ["ref", "excerpt"]
  };
}

// Kept explicit so the exact provider request is reviewable and does not rely on
// a provider-specific Zod converter at runtime. Reference enums are derived from
// the submitted input; local semantic validation remains authoritative.
export function buildJobMatchResponseJsonSchema(input: MatchInput) {
  const refs = getJobMatchEvidenceReferences(input);
  const applicantCitation = jsonCitation(refs.applicant, "__NO_SUBMITTED_APPLICANT_REFERENCE__");
  const jobCitation = jsonCitation(refs.job, "__NO_SUBMITTED_JOB_REFERENCE__");
  const gapCitation = jsonCitation(refs.gap, "__NO_SUBMITTED_GAP_REFERENCE__");
  const factualMatches: Record<string, unknown> = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        applicantEvidence: { type: "array", minItems: 1, items: applicantCitation },
        jobEvidence: { type: "array", minItems: 1, items: jobCitation },
        supportedKeywords: { type: "array", minItems: 1, items: jsonString }
      },
      required: ["applicantEvidence", "jobEvidence", "supportedKeywords"]
    }
  };
  if (!refs.applicant.length || !refs.job.length) factualMatches.maxItems = 0;
  const requirementGaps: Record<string, unknown> = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        requirement: jsonString,
        jobRequirement: gapCitation,
        missingKeywords: { type: "array", minItems: 1, items: jsonString }
      },
      required: ["requirement", "jobRequirement", "missingKeywords"]
    }
  };
  if (!refs.gap.length) requirementGaps.maxItems = 0;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contractVersion: { type: "string", enum: ["3"] },
      overallFitScore: jsonScore,
      resumeKeywordScore: jsonScore,
      skillsMatchScore: jsonScore,
      experienceMatchScore: jsonScore,
      careerGoalScore: jsonScore,
      locationWorkStyleScore: jsonScore,
      compensationScore: { type: ["number", "null"], minimum: 0, maximum: 100 },
      confidenceScore: jsonScore,
      confidenceBasis: jsonString,
      factualMatches,
      requirementGaps,
      advice: {
        type: "object",
        additionalProperties: false,
        properties: {
          keywordsToEmphasize: { type: "array", items: jsonString },
          resumeAngle: jsonString,
          coverLetterAngle: jsonString
        },
        required: ["keywordsToEmphasize", "resumeAngle", "coverLetterAngle"]
      },
      recommendation: { type: "string", enum: ["apply now", "consider", "skip"] }
    },
    required: [
      "contractVersion", "overallFitScore", "resumeKeywordScore", "skillsMatchScore",
      "experienceMatchScore", "careerGoalScore", "locationWorkStyleScore",
      "compensationScore", "confidenceScore", "confidenceBasis", "factualMatches",
      "requirementGaps", "advice", "recommendation"
    ]
  };
}

export function buildJobMatchSystemPrompt(input: MatchInput) {
  const refs = getJobMatchEvidenceReferences(input);
  return `${jobMatchPrompt.trim()}\n\n` +
    `Allowed applicant evidence references (exact strings only): ${JSON.stringify(refs.applicant)}\n` +
    `Allowed job evidence references (exact strings only): ${JSON.stringify(refs.job)}\n` +
    `Allowed requirement-gap references (exact strings only): ${JSON.stringify(refs.gap)}\n` +
    "Never append child paths to any listed reference. If an allowlist is empty, return no item that requires it.";
}

type ResolvedEvidence = { found: true; value: unknown } | { found: false };

function indexedValue(ref: string, prefix: string, values: unknown[] | undefined): ResolvedEvidence {
  const match = ref.match(new RegExp(`^${prefix.replace(".", "\\.")}\\[(\\d+)\\]$`));
  if (!match || !values) return { found: false };
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) return { found: false };
  const value = values[index];
  return referenceValueIsPresent(value) ? { found: true, value } : { found: false };
}

function exactValue(ref: string, values: Record<string, unknown>): ResolvedEvidence {
  return Object.prototype.hasOwnProperty.call(values, ref) && referenceValueIsPresent(values[ref])
    ? { found: true, value: values[ref] }
    : { found: false };
}

function resolveApplicantEvidence(input: MatchInput, ref: string): ResolvedEvidence {
  const exact = exactValue(ref, {
    "resume.summary": input.resume?.summary,
    "resume.rawText": input.resume?.rawText
  });
  if (exact.found) return exact;

  const indexed = [
    indexedValue(ref, "resume.skills", input.resume?.skills),
    indexedValue(ref, "resume.achievements", input.resume?.achievements),
    indexedValue(
      ref,
      "resume.workHistory",
      Array.isArray(input.resume?.workHistory) ? input.resume.workHistory : undefined
    ),
    indexedValue(ref, "resume.projects", Array.isArray(input.resume?.projects) ? input.resume.projects : undefined),
    indexedValue(ref, "resume.education", Array.isArray(input.resume?.education) ? input.resume.education : undefined),
    indexedValue(
      ref,
      "resume.certifications",
      Array.isArray(input.resume?.certifications) ? input.resume.certifications : undefined
    )
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

const sourceContentKeys = ["text", "value", "content", "excerpt", "sourceText"] as const;
const sourceMetadataKeys = new Set([
  "$schema", "schema", "start", "end", "localstart", "localend",
  "startindex", "endindex", "startoffset", "endoffset"
]);

function sourceKey(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z$]/g, "");
}

function stripLocalSourceEnvelope(value: string) {
  const match = value.match(
    /^\s*(?:(?:<<<|\[\[|---)\s*)?LOCAL[\s_-]+START(?:\s*(?:>>>|\]\]|---))?\s*([\s\S]*?)\s*(?:(?:<<<|\[\[|---)\s*)?LOCAL[\s_-]+END(?:\s*(?:>>>|\]\]|---))?\s*$/iu
  );
  return match?.[1]?.trim() || value.trim();
}

function readableSourceLeaves(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value === "string") {
    const text = stripLocalSourceEnvelope(value);
    if (!text) return [];
    if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== text) {
          const parsedLeaves = readableSourceLeaves(parsed, depth + 1);
          if (parsedLeaves.length) return parsedLeaves;
        }
      } catch {
        // This is ordinary source text, not a complete JSON envelope.
      }
    }
    return [text];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => readableSourceLeaves(entry, depth + 1));
  }
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  for (const key of sourceContentKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const preferred = readableSourceLeaves(record[key], depth + 1);
    if (preferred.length) return preferred;
  }

  return Object.entries(record).flatMap(([key, entry]) => {
    const normalizedKey = sourceKey(key);
    if (sourceMetadataKeys.has(normalizedKey)) return [];
    return readableSourceLeaves(entry, depth + 1);
  });
}

function readableEvidenceExcerpt(value: unknown) {
  const leaves = uniqueStrings(readableSourceLeaves(value));
  return leaves.join(" · ");
}

export function jobMatchSourceDisplayText(value: unknown) {
  return readableEvidenceExcerpt(value);
}

function hasSourceMetadataSyntax(value: string) {
  return /["'](?:\$?schema|local|local[_-]?(?:start|end)|(?:start|end)(?:index|offset)?)["']\s*:/iu.test(value)
    || /["'](?:text|value|content|excerpt|sourceText)["']\s*:/iu.test(value)
    || /LOCAL[\s_-]+(?:START|END)/iu.test(value);
}

function citationForDisplay(
  citation: JobMatchEvidenceCitation,
  resolver: (ref: string) => ResolvedEvidence
): JobMatchEvidenceCitation {
  const excerpt = jobMatchSourceDisplayText(citation.excerpt);
  if (excerpt && !hasSourceMetadataSyntax(excerpt)) return { ...citation, excerpt };
  const resolved = resolver(citation.ref);
  const fallback = resolved.found ? jobMatchSourceDisplayText(resolved.value) : "";
  if (fallback && !hasSourceMetadataSyntax(fallback)) return { ...citation, excerpt: fallback };
  return excerpt ? { ...citation, excerpt } : citation;
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
    input.resume?.projects,
    input.resume?.education,
    input.resume?.certifications,
    ...(input.resume?.skills ?? []),
    ...(input.resume?.achievements ?? [])
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
      applicantEvidence: match.applicantEvidence.map((citation) =>
        citationForDisplay(citation, (ref) => resolveApplicantEvidence(input, ref))),
      jobEvidence: match.jobEvidence.map((citation) =>
        citationForDisplay(citation, (ref) => resolveJobEvidence(input, ref))),
      supportedKeywords,
      claim: `Submitted applicant evidence matches job evidence for ${supportedKeywords.join(", ")}.`
    };
  });
  const requirementGaps = output.requirementGaps.map((gap) => {
    const jobRequirement = citationForDisplay(gap.jobRequirement, (ref) => resolveJobEvidence(input, ref));
    return {
      ...gap,
      requirement: jobRequirement.excerpt,
      jobRequirement
    };
  });
  return {
    ...output,
    factualMatches,
    requirementGaps,
    compensationScore: compensation.score,
    compensationAssessment: compensation,
    confidenceAssessment: {
      score: output.confidenceScore,
      label: "Uncalibrated model self-assessment",
      basis: output.confidenceBasis
    },
    whyGoodMatch: factualMatches.map((match) => match.claim),
    concerns: requirementGaps.map((gap) => gap.requirement),
    missingKeywords: uniqueStrings(requirementGaps.flatMap((gap) => gap.missingKeywords)),
    supportedKeywords: uniqueStrings(factualMatches.flatMap((match) => match.supportedKeywords)),
    keywordsToEmphasize: uniqueStrings(output.advice.keywordsToEmphasize),
    suggestedResumeAngle: output.advice.resumeAngle,
    suggestedCoverLetterAngle: output.advice.coverLetterAngle
  };
}

export function validateAndNormalizeJobMatchOutput(input: MatchInput, value: unknown) {
  const parsed = jobMatchModelOutputSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path
      .filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number")
      .map(String)
      .join(".") || null;
    throw new JobMatchOutputValidationError(
      "schema",
      path,
      "jobMatchPrompt returned JSON that did not match the expected schema."
    );
  }
  try {
    return { modelOutput: parsed.data, normalized: normalizeJobMatchOutput(input, parsed.data) };
  } catch (error) {
    throw new JobMatchOutputValidationError(
      "semantic",
      null,
      error instanceof Error ? error.message : undefined
    );
  }
}

function usageCost(usage: GeminiUsage) {
  return estimateAiCostMicros({
    model: JOB_MATCH_MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens
  });
}

export async function scoreJobMatch(
  input: MatchInput,
  userId?: string,
  options: AiInvocationOptions = {}
) {
  const systemPrompt = buildJobMatchSystemPrompt(input);
  const responseJsonSchema = buildJobMatchResponseJsonSchema(input);
  // The provider may count structured-output schema tokens as request input, so
  // include the dynamic schema in the same preflight ceiling and reservation.
  const { policy } = assertAiInputWithinLimits("JOB_MATCH", systemPrompt, {
    matchInput: input,
    responseJsonSchema
  });
  const inputHash = hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, input);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (getAiRuntimeMode(JOB_MATCH_PROVIDER) !== JOB_MATCH_PROVIDER || !apiKey) {
    throw new LocalAiUnavailableError();
  }
  if (!userId) {
    throw new PublicApiError("JOB_MATCH requires an authenticated budget owner.", 503, {
      code: "AI_BUDGET_OWNER_REQUIRED"
    });
  }
  if (getModelPricing(JOB_MATCH_MODEL).provider !== JOB_MATCH_PROVIDER) {
    throw new PublicApiError("JOB_MATCH requires registered Gemini pricing.", 503, {
      code: "AI_MODEL_PRICING_UNKNOWN"
    });
  }

  const financial = getAiFinancialPolicy();
  const maximumCostMicros = estimateAiCostMicros({
    model: JOB_MATCH_MODEL,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens
  });
  if (maximumCostMicros > financial.maximumRequestCents * 10_000) {
    throw new PublicApiError("This request exceeds the configured per-request AI limit.", 429, {
      code: "AI_REQUEST_COST_LIMIT",
      maximumCostMicros
    });
  }

  const cached = await findCachedAiResponse({
    userId,
    provider: JOB_MATCH_PROVIDER,
    model: JOB_MATCH_MODEL,
    promptName: "jobMatchPrompt",
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    requestHash: inputHash
  });
  if (cached) {
    const { normalized } = validateAndNormalizeJobMatchOutput(input, cached.output);
    return {
      ...normalized,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      inputHash,
      usage: {
        provider: JOB_MATCH_PROVIDER,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION,
        requestHash: inputHash,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 0,
        mocked: false
      }
    };
  }

  if (
    !options.automation &&
    maximumCostMicros > financial.confirmationThresholdCents * 10_000 &&
    !options.highCostConfirmed
  ) {
    throw new PublicApiError("Confirm this AI request's maximum cost before continuing.", 428, {
      code: "AI_COST_CONFIRMATION_REQUIRED",
      maximumCostMicros
    });
  }

  const reservation = await reserveAiBudget({
    userId,
    provider: JOB_MATCH_PROVIDER,
    model: JOB_MATCH_MODEL,
    feature: "JOB_MATCH",
    promptName: "jobMatchPrompt",
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    requestHash: inputHash,
    maximumCostMicros,
    automation: options.automation ?? false
  });
  let usage: GeminiUsage | null = null;
  let actualCostMicros: number | undefined;
  let requestDispatched = false;
  let reconciled = false;

  try {
    requestDispatched = true;
    const response = await callGeminiJsonProvider({
      apiKey,
      model: JOB_MATCH_MODEL,
      systemPrompt,
      payload: input,
      responseJsonSchema,
      maxOutputTokens: policy.maxOutputTokens,
      thinkingLevel: JOB_MATCH_THINKING_LEVEL
    });
    usage = response.usage;
    actualCostMicros = usageCost(usage);
    if (
      usage.inputTokens > policy.maxInputTokens ||
      usage.outputTokens > policy.maxOutputTokens ||
      actualCostMicros > reservation.maximumCostMicros
    ) {
      throw new GeminiProviderError("Gemini usage exceeded the reserved JOB_MATCH bounds.", {
        providerResponded: true,
        usage
      });
    }
    // Both structural and evidence validation complete before this paid result is
    // cached or marked successful.
    const { modelOutput, normalized } = validateAndNormalizeJobMatchOutput(input, response.value);
    await reconcileAiReservation({
      reservationId: reservation.id,
      status: "SUCCEEDED",
      actualCostMicros,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheOutput: modelOutput
    });
    reconciled = true;
    return {
      ...normalized,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      inputHash,
      usage: {
        provider: JOB_MATCH_PROVIDER,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION,
        requestHash: inputHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        estimatedCostMicros: actualCostMicros,
        mocked: false
      }
    };
  } catch (error) {
    if (!reconciled) {
      const providerUsage = error instanceof GeminiProviderError ? error.usage : usage;
      const knownCost = providerUsage ? usageCost(providerUsage) : undefined;
      const billingDisposition = error instanceof GeminiProviderError
        ? error.billingDisposition
        : providerUsage ? "known" : "uncertain";
      const uncertain = requestDispatched && (
        billingDisposition === "uncertain" ||
        (knownCost !== undefined && knownCost > reservation.maximumCostMicros)
      );
      const reconciledCost = billingDisposition === "not_charged"
        ? 0
        : uncertain ? undefined : knownCost;
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: uncertain ? "UNCERTAIN" : "FAILED",
        actualCostMicros: reconciledCost,
        inputTokens: providerUsage?.inputTokens,
        outputTokens: providerUsage?.outputTokens,
        cachedInputTokens: providerUsage?.cachedInputTokens,
        errorCode: error instanceof Error ? error.name : "UnknownError"
      }).catch(() => undefined);
    }
    throw error;
  }
}
