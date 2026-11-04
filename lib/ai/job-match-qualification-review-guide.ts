import { z } from "zod";

import { getJobMatchEvidenceReferences, type MatchInput } from "@/lib/ai/job-match";
import type { QualificationPreparation } from "@/lib/ai/job-match-qualification";

export const QUALIFICATION_REVIEW_GUIDE_VERSION = "2" as const;

const dispositionSchema = z.enum(["supported", "confirmed_gap", "unknown", "not_material"]);
const materialitySchema = z.enum(["must_have", "important", "preferred"]);
const reviewGuideDraftSchema = z.object({
  caseId: z.string().trim().min(1),
  requirements: z.array(z.object({
    jobRef: z.string().trim().min(1),
    disposition: dispositionSchema,
    materiality: materialitySchema,
    applicantRefs: z.array(z.string().trim().min(1)),
    rationale: z.string().trim().min(1).max(2_000)
  }).strict()),
  clarifications: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    question: z.string().trim().min(1).max(1_000),
    whyItMatters: z.string().trim().min(1).max(1_000),
    decisionChanging: z.literal(true),
    jobRefs: z.array(z.string().trim().min(1)).min(1)
  }).strict())
}).strict();
const reviewGuideSchema = reviewGuideDraftSchema.extend({
  version: z.literal(QUALIFICATION_REVIEW_GUIDE_VERSION),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  jobProjectionHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export type QualificationReviewGuideDraft = Readonly<z.infer<typeof reviewGuideDraftSchema>>;

export type QualificationReviewGuide = Readonly<{
  version: typeof QUALIFICATION_REVIEW_GUIDE_VERSION;
  caseId: string;
  inputHash: string;
  jobProjectionHash: string;
  requirements: readonly Readonly<{
    jobRef: string;
    disposition: "supported" | "confirmed_gap" | "unknown" | "not_material";
    materiality: "must_have" | "important" | "preferred";
    applicantRefs: readonly string[];
    rationale: string;
  }>[];
  clarifications: readonly Readonly<{
    id: string;
    title: string;
    question: string;
    whyItMatters: string;
    decisionChanging: true;
    jobRefs: readonly string[];
  }>[];
}>;

export type QualificationEvidenceCandidateSet = Readonly<{
  category: "education" | "certification" | "technical" | "experience" | "communication" | "authorization" | "general";
  applicantRefs: readonly string[];
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "both", "for", "from", "have", "in", "including", "into",
  "is", "of", "on", "or", "s", "such", "that", "the", "their", "this", "to", "with", "you", "your"
]);
const EDUCATION_WRAPPER_WORDS = new Set(["must", "possess", "required"]);

function normalizedText(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9+#.]+/gu, " ").trim();
}

function sourceText(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(sourceText);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(sourceText);
  return [];
}

function indexedSourceValue(ref: string, prefix: string, value: unknown) {
  const match = ref.match(new RegExp(`^${prefix.replaceAll(".", "\\.")}\\[(\\d+)\\]$`, "u"));
  return match && Array.isArray(value) ? value[Number(match[1])] : undefined;
}

function applicantSourceValue(input: MatchInput, ref: string): unknown {
  if (ref === "resume.summary") return input.resume?.summary;
  return [
    indexedSourceValue(ref, "resume.skills", input.resume?.skills),
    indexedSourceValue(ref, "resume.achievements", input.resume?.achievements),
    indexedSourceValue(ref, "resume.workHistory", input.resume?.workHistory),
    indexedSourceValue(ref, "resume.projects", input.resume?.projects),
    indexedSourceValue(ref, "resume.education", input.resume?.education),
    indexedSourceValue(ref, "resume.certifications", input.resume?.certifications)
  ].find((value) => value !== undefined);
}

function jobRequirementValue(input: MatchInput, jobRef: string) {
  return indexedSourceValue(jobRef, "job.requirements", input.job.requirements)
    ?? indexedSourceValue(jobRef, "job.preferredQualifications", input.job.preferredQualifications);
}

function requirementCategory(requirement: string): QualificationEvidenceCandidateSet["category"] {
  const text = normalizedText(requirement);
  if (/\b(?:authorized|authorization|sponsor|sponsorship|citizenship)\b/u.test(text)) return "authorization";
  if (/\b(?:bachelor|master|doctorate|phd|degree|diploma|education)\b/u.test(text)) return "education";
  if (/\b(?:certification|certified|certificate|license|licensed)\b/u.test(text)) return "certification";
  if (/\b(?:communicat|presentation|presenting|writing|written|verbal|teach|webinar|demo)\w*/u.test(text)) return "communication";
  if (/\b(?:software|database|sql|javascript|typescript|python|java|react|node|sdk|api|framework|network|postman|xml|json|excel|superset|technology|technical|coding|programming)\w*/u.test(text)) return "technical";
  if (/\b(?:experience|customer|client|project|problem|relationship|support|success|operations|workflow|solution)\w*/u.test(text)) return "experience";
  return "general";
}

function categoryPrefixes(category: QualificationEvidenceCandidateSet["category"]) {
  if (category === "authorization") return [];
  if (category === "education") return ["resume.education["];
  if (category === "certification") return ["resume.certifications["];
  if (category === "technical") {
    return ["resume.skills[", "resume.workHistory[", "resume.projects[", "resume.certifications["];
  }
  if (category === "communication") {
    return ["resume.workHistory[", "resume.projects[", "resume.achievements[", "resume.skills["];
  }
  if (category === "experience") {
    return ["resume.workHistory[", "resume.projects[", "resume.achievements[", "resume.skills["];
  }
  return [
    "resume.summary", "resume.skills[", "resume.achievements[", "resume.workHistory[", "resume.projects[",
    "resume.education[", "resume.certifications["
  ];
}

function significantTokens(value: string) {
  return normalizedText(value).split(/\s+/u).filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function namedSkillTokens(requirementText: string) {
  let core = requirementText
    .replace(/^(?:must\s+(?:have|possess)\s+|required\s+)/u, "")
    .replace(/^(?:hands\s+on\s+)?(?:experience|expertise|familiarity|knowledge|proficiency)\s+(?:with|in|of|using)\s+/u, "")
    .replace(/^working\s+(?:with|in|on)\s+/u, "")
    .replace(/^ability\s+to\s+(?:use|work\s+with)\s+/u, "");
  core = core.replace(/\s+(?:required|skill|skills)$/u, "");
  return significantTokens(core);
}

function directlySupports(requirement: string, category: QualificationEvidenceCandidateSet["category"], ref: string, value: unknown) {
  const requirementText = normalizedText(requirement);
  const evidenceText = normalizedText(sourceText(value).join(" "));
  if (!evidenceText) return false;
  if (category === "education") {
    const coreRequirement = requirementText.split(/\b(?:preferably|or equivalent)\b/u)[0] ?? requirementText;
    const degreeLevels = [
      new Set(["associate"]),
      new Set(["bachelor"]),
      new Set(["master"]),
      new Set(["doctorate", "phd"])
    ];
    const genericDegreeTerms = new Set(["degree", "diploma"]);
    const degreeTerms = new Set([
      ...degreeLevels.flatMap((level) => [...level]),
      ...genericDegreeTerms
    ]);
    const requirementTokens = significantTokens(coreRequirement);
    const evidenceTokens = new Set(significantTokens(evidenceText));
    const namedRequirementLevels = degreeLevels.filter((level) =>
      [...level].some((token) => requirementTokens.includes(token))
    );
    const requiresDegree = requirementTokens.includes("degree");
    const requiresDiploma = requirementTokens.includes("diploma");
    const evidenceHasNamedDegree = degreeLevels.some((level) =>
      [...level].some((token) => evidenceTokens.has(token))
    );
    const hasDegreeLevel = namedRequirementLevels.length > 0
      ? namedRequirementLevels.some((level) => [...level].some((token) => evidenceTokens.has(token)))
      : requiresDegree && requiresDiploma
        ? evidenceHasNamedDegree || evidenceTokens.has("degree") || evidenceTokens.has("diploma")
        : requiresDegree
          ? evidenceHasNamedDegree || evidenceTokens.has("degree")
          : requiresDiploma && evidenceTokens.has("diploma");
    const qualifiers = requirementTokens.filter((token) =>
      !degreeTerms.has(token) && !EDUCATION_WRAPPER_WORDS.has(token)
    );
    return hasDegreeLevel && qualifiers.every((token) => evidenceTokens.has(token));
  }
  if (category === "certification") {
    return false;
  }
  if (ref.startsWith("resume.skills[")) {
    const skill = normalizedText(sourceText(value)[0] ?? "");
    if (skill.length <= 1) return false;
    const skillTokens = significantTokens(skill);
    const requirementTokens = namedSkillTokens(requirementText);
    return skillTokens.length === requirementTokens.length
      && skillTokens.every((token, index) => token === requirementTokens[index]);
  }
  return false;
}

function isDecisionGate(requirement: string) {
  const text = normalizedText(requirement);
  if (
    /\bno\s+(?:visa\s+)?sponsorship\b/u.test(text)
    || /\b(?:visa\s+)?sponsorship\b.{0,40}\bnot\b.{0,20}\b(?:available|offered|provided)\b/u.test(text)
  ) return true;
  if (
    /\bno\b.{0,80}\brequired\b/u.test(text)
    || /\bnot\s+required\b/u.test(text)
    || /\b(?:visa\s+)?sponsorship\b.{0,80}\b(?:available|offered|provided)\b/u.test(text)
  ) return false;
  return /\b(?:must|required|authorized|authorization|sponsor|sponsorship)\b/u.test(text)
    || /\b\d+\s*\+?\s*(?:years?|yrs?)\b/u.test(text)
    || /\b\d+\s*(?:-|to)\s*\d+\s*(?:years?|yrs?)\b/u.test(text);
}

export function getQualificationEvidenceCandidates(
  input: MatchInput,
  jobRef: string
): QualificationEvidenceCandidateSet {
  const requirement = sourceText(jobRequirementValue(input, jobRef))[0] ?? "";
  const category = requirementCategory(requirement);
  const prefixes = categoryPrefixes(category);
  const applicantRefs = getJobMatchEvidenceReferences(input).applicant.filter((ref) =>
    ref.startsWith("resume.")
    && ref !== "resume.rawText"
    && prefixes.some((prefix) => ref === prefix || ref.startsWith(prefix))
  );
  return deepFreeze({ category, applicantRefs });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

export function validatedQualificationReviewGuide(
  preparation: QualificationPreparation,
  guideValue: QualificationReviewGuide
) {
  const guide = reviewGuideSchema.parse(guideValue);
  const prepared = preparation.privateInputs.find((entry) => entry.caseId === guide.caseId);
  if (
    !prepared
    || guide.version !== QUALIFICATION_REVIEW_GUIDE_VERSION
    || guide.inputHash !== prepared.inputHash
    || guide.jobProjectionHash !== prepared.jobProjectionHash
  ) {
    throw new Error("Qualification review guide is not bound to the exact case input and job projection.");
  }
  const refs = getJobMatchEvidenceReferences(prepared.input);
  if (
    guide.requirements.length !== refs.gap.length
    || guide.requirements.some((entry, index) => entry.jobRef !== refs.gap[index])
  ) {
    throw new Error("Qualification review guide must cover every requirement exactly once in source order.");
  }
  const allowedApplicantRefs = new Set(refs.applicant);
  const requirementByRef = new Map(guide.requirements.map((entry) => [entry.jobRef, entry]));
  for (const requirement of guide.requirements) {
    const applicantRefs = new Set(requirement.applicantRefs);
    if (
      applicantRefs.size !== requirement.applicantRefs.length
      || requirement.applicantRefs.some((ref) => !allowedApplicantRefs.has(ref))
    ) {
      throw new Error("Qualification review guide evidence must use submitted resume facts.");
    }
    if ((requirement.disposition === "supported") !== (requirement.applicantRefs.length > 0)) {
      throw new Error("Qualification review guide support must be backed by applicant evidence.");
    }
  }
  const questionIds = new Set<string>();
  const questionedJobRefs = new Set<string>();
  for (const question of guide.clarifications) {
    if (questionIds.has(question.id)) {
      throw new Error("Qualification review guide contains a duplicate clarification ID.");
    }
    questionIds.add(question.id);
    for (const jobRef of question.jobRefs) {
      const requirement = requirementByRef.get(jobRef);
      if (
        questionedJobRefs.has(jobRef)
        || !requirement
        || requirement.disposition !== "unknown"
      ) {
        throw new Error("Each decision-changing question must target unresolved material requirements exactly once.");
      }
      questionedJobRefs.add(jobRef);
    }
  }
  return deepFreeze(guide) as QualificationReviewGuide;
}

export function createQualificationReviewGuide({
  preparation,
  draft: draftValue
}: {
  preparation: QualificationPreparation;
  draft: unknown;
}) {
  const draft = reviewGuideDraftSchema.parse(draftValue);
  const prepared = preparation.privateInputs.find((entry) => entry.caseId === draft.caseId);
  if (!prepared) throw new Error("Qualification review guide referenced an unknown frozen case.");
  return deepFreeze(validatedQualificationReviewGuide(preparation, {
    version: QUALIFICATION_REVIEW_GUIDE_VERSION,
    caseId: prepared.caseId,
    inputHash: prepared.inputHash,
    jobProjectionHash: prepared.jobProjectionHash,
    requirements: draft.requirements,
    clarifications: draft.clarifications
  }));
}

export function buildConservativeQualificationReviewGuides(
  preparation: QualificationPreparation
): readonly QualificationReviewGuide[] {
  return deepFreeze(preparation.privateInputs.map((prepared) => {
    const refs = getJobMatchEvidenceReferences(prepared.input);
    const clarifications: Array<QualificationReviewGuide["clarifications"][number]> = [];
    const requirements = refs.gap.map((jobRef, index) => {
      const requirement = sourceText(jobRequirementValue(prepared.input, jobRef))[0] ?? "";
      const candidates = getQualificationEvidenceCandidates(prepared.input, jobRef);
      const applicantRefs = candidates.applicantRefs.filter((ref) =>
        directlySupports(requirement, candidates.category, ref, applicantSourceValue(prepared.input, ref))
      );
      const supported = applicantRefs.length > 0;
      const preferred = jobRef.startsWith("job.preferredQualifications[");
      const explicitGate = !preferred && isDecisionGate(requirement);
      const decisionGate = explicitGate && !supported;
      if (decisionGate) {
        clarifications.push({
          id: `source-gap-${index + 1}`,
          title: "Unresolved required qualification",
          question: `Can you truthfully confirm this requirement: ${requirement}`,
          whyItMatters: "The local source review found no direct supporting fact, and the posting presents this as a decision-changing requirement.",
          decisionChanging: true,
          jobRefs: [jobRef]
        });
      }
      return {
        jobRef,
        disposition: supported ? "supported" as const : "unknown" as const,
        materiality: preferred
          ? "preferred" as const
          : explicitGate
            ? "must_have" as const
            : "important" as const,
        applicantRefs,
        rationale: supported
          ? candidates.category === "education"
            ? "Direct source evidence contains the stated degree credential."
            : "Direct source evidence contains the named qualification."
          : `No direct source-backed match was found by the local ${candidates.category} evidence rule.`
      };
    });
    return {
      version: QUALIFICATION_REVIEW_GUIDE_VERSION,
      caseId: prepared.caseId,
      inputHash: prepared.inputHash,
      jobProjectionHash: prepared.jobProjectionHash,
      requirements,
      clarifications
    };
  }));
}
