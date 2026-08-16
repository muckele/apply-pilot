import { z } from "zod";

import { applicationPlanPrompt } from "@/prompts/applicationPlanPrompt";
import { generateJson, type AiInvocationOptions } from "@/lib/ai/client";
import { uniqueStrings } from "@/lib/normalize";

export const APPLICATION_PLAN_PROMPT_VERSION = "1";

export type EvidenceSourceType =
  | "SUMMARY"
  | "SKILL"
  | "ACHIEVEMENT"
  | "WORK_HISTORY"
  | "PROJECT"
  | "EDUCATION"
  | "CERTIFICATION"
  | "PROFILE";

export type EvidenceCatalogEntry = {
  id: string;
  sourceType: EvidenceSourceType;
  text: string;
};

export type JobRequirementEntry = {
  id: string;
  kind: "REQUIREMENT" | "PREFERRED" | "TECH";
  text: string;
};

// Caller-facing input. Extra properties (rawText, contactInfo, file paths, answer-vault
// or EEO data, browser/session state) are never forwarded: buildApplicationPlanPayload
// constructs a new allowlisted object and reads only the fields declared here.
export type ApplicationPlanInput = {
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
    skillsToEmphasize?: string[];
    skillsNotToExaggerate?: string[];
  } | null;
};

// The immutable planner payload snapshot. Evidence IDs are deterministic, position-based,
// and local to this snapshot; the same catalog design is intended for reuse by later
// ApplicationRunAnswer and browser-field provenance.
export type ApplicationPlanPayload = {
  job: {
    title: string;
    company: string;
    location: string | null;
    remoteStatus: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    descriptionDigest: string;
    jobRequirements: JobRequirementEntry[];
  };
  evidenceCatalog: EvidenceCatalogEntry[];
  preferences: {
    careerGoals: string | null;
    preferredRoles: string[];
    preferredLocations: string[];
    remotePreference: string | null;
    salaryTargetMin: number | null;
  } | null;
  doNotExaggerate: string[];
};

// Hard bounds keep the payload inside the 12,000-token APPLICATION_PLAN policy.
// Sized so an adversarial-maximum payload (every field at cap, all arrays full,
// ~28 KB ≈ 11k estimated tokens) stays under the policy with margin.
// Never raise the policy instead.
const BOUNDS = {
  descriptionChars: 2_000,
  requirementTextChars: 200,
  requirements: 12,
  preferred: 6,
  tech: 12,
  techTextChars: 40,
  summaryChars: 1_000,
  shortTextChars: 200,
  educationTextChars: 120,
  certificationChars: 120,
  skillTextChars: 50,
  listTextChars: 60,
  listItemChars: 80,
  skills: 30,
  achievements: 5,
  detailChars: 200,
  workRoles: 4,
  workHighlights: 3,
  projects: 3,
  projectTechnologies: 8,
  projectHighlights: 2,
  projectHeadingChars: 300,
  education: 3,
  certifications: 10,
  careerGoalsChars: 600,
  preferredRoles: 6,
  preferredLocations: 6,
  skillsToEmphasize: 12,
  doNotExaggerate: 12
} as const;

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const text = boundedText(item, maxChars);
    if (text) items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type CondensedEntry = { heading: string; highlights: string[] };

// Defensively reads the Json work-history field, keeping only title/company/dates and
// bounded highlights. Contact-like and unlisted fields are dropped by omission.
function condenseWorkHistory(value: unknown): CondensedEntry[] {
  if (!Array.isArray(value)) return [];
  const roles: CondensedEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const title = boundedText(record.title ?? record.role ?? record.position, BOUNDS.shortTextChars);
    const company = boundedText(record.company ?? record.organization ?? record.employer, BOUNDS.shortTextChars);
    const start = boundedText(record.startDate ?? record.start, 40);
    const end = boundedText(record.endDate ?? record.end, 40);
    const heading = [
      [title, company].filter(Boolean).join(" at "),
      start || end ? [start, end ?? "present"].filter(Boolean).join(" – ") : ""
    ]
      .filter(Boolean)
      .join(", ")
      .slice(0, BOUNDS.detailChars);
    if (!heading) continue;
    const highlightSource = record.highlights ?? record.achievements ?? record.bullets ?? record.responsibilities;
    roles.push({
      heading,
      highlights: boundedStringArray(highlightSource, BOUNDS.workHighlights, BOUNDS.detailChars)
    });
    if (roles.length >= BOUNDS.workRoles) break;
  }
  return roles;
}

// Projects keep name, a bounded technology list, and bounded highlights only.
function condenseProjects(value: unknown): CondensedEntry[] {
  if (!Array.isArray(value)) return [];
  const projects: CondensedEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const name = boundedText(record.name ?? record.title, BOUNDS.shortTextChars);
    if (!name) continue;
    const technologies = boundedStringArray(
      record.technologies ?? record.tech ?? record.stack,
      BOUNDS.projectTechnologies,
      BOUNDS.listTextChars
    );
    const heading = (technologies.length ? `${name} (${technologies.join(", ")})` : name).slice(0, BOUNDS.projectHeadingChars);
    const highlights = Array.isArray(record.highlights)
      ? boundedStringArray(record.highlights, BOUNDS.projectHighlights, BOUNDS.detailChars)
      : boundedStringArray([record.description], BOUNDS.projectHighlights, BOUNDS.detailChars);
    projects.push({ heading, highlights });
    if (projects.length >= BOUNDS.projects) break;
  }
  return projects;
}

// Education keeps credential + field only; institution names, addresses, and any
// personal details are deliberately omitted.
function condenseEducation(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const credential = boundedText(record.credential ?? record.degree, BOUNDS.educationTextChars);
    const field = boundedText(record.field ?? record.areaOfStudy ?? record.major, BOUNDS.educationTextChars);
    const text = [credential, field].filter(Boolean).join(" — ");
    if (text) entries.push(text);
    if (entries.length >= BOUNDS.education) break;
  }
  return entries;
}

// Certifications keep the credential name only.
function condenseCertifications(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const text = typeof item === "string"
      ? boundedText(item, BOUNDS.certificationChars)
      : boundedText(record?.name ?? record?.title ?? record?.certification, BOUNDS.certificationChars);
    if (text) entries.push(text);
    if (entries.length >= BOUNDS.certifications) break;
  }
  return entries;
}


// Builds the immutable, privacy-minimized planner payload with deterministic,
// position-based catalog IDs. Never forwards a raw database object or unlisted fields.
export function buildApplicationPlanPayload(input: ApplicationPlanInput): ApplicationPlanPayload {
  const jobRequirements: JobRequirementEntry[] = [];
  boundedStringArray(input.job.requirements, BOUNDS.requirements, BOUNDS.requirementTextChars)
    .forEach((text, index) => jobRequirements.push({ id: `req-${index + 1}`, kind: "REQUIREMENT", text }));
  boundedStringArray(input.job.preferredQualifications, BOUNDS.preferred, BOUNDS.requirementTextChars)
    .forEach((text, index) => jobRequirements.push({ id: `pref-${index + 1}`, kind: "PREFERRED", text }));
  boundedStringArray(input.job.detectedTechStack, BOUNDS.tech, BOUNDS.techTextChars)
    .forEach((text, index) => jobRequirements.push({ id: `tech-${index + 1}`, kind: "TECH", text }));

  const evidenceCatalog: EvidenceCatalogEntry[] = [];
  const addEvidence = (id: string, sourceType: EvidenceSourceType, text: string | null) => {
    if (text) evidenceCatalog.push({ id, sourceType, text });
  };

  const resume = input.resume ?? null;
  if (resume) {
    addEvidence("summary-1", "SUMMARY", boundedText(resume.summary, BOUNDS.summaryChars));
    boundedStringArray(resume.skills, BOUNDS.skills, BOUNDS.skillTextChars)
      .forEach((text, index) => addEvidence(`skill-${index + 1}`, "SKILL", text));
    boundedStringArray(resume.achievements, BOUNDS.achievements, BOUNDS.detailChars)
      .forEach((text, index) => addEvidence(`achievement-${index + 1}`, "ACHIEVEMENT", text));
    condenseWorkHistory(resume.workHistory).forEach((role, roleIndex) => {
      const roleId = `work-${roleIndex + 1}`;
      addEvidence(roleId, "WORK_HISTORY", role.heading);
      role.highlights.forEach((highlight, highlightIndex) =>
        addEvidence(`${roleId}-highlight-${highlightIndex + 1}`, "WORK_HISTORY", highlight));
    });
    condenseProjects(resume.projects).forEach((project, projectIndex) => {
      const projectId = `project-${projectIndex + 1}`;
      addEvidence(projectId, "PROJECT", project.heading);
      project.highlights.forEach((highlight, highlightIndex) =>
        addEvidence(`${projectId}-highlight-${highlightIndex + 1}`, "PROJECT", highlight));
    });
    condenseEducation(resume.education)
      .forEach((text, index) => addEvidence(`education-${index + 1}`, "EDUCATION", text));
    condenseCertifications(resume.certifications)
      .forEach((text, index) => addEvidence(`certification-${index + 1}`, "CERTIFICATION", text));
  }

  const profile = input.profile ?? null;
  if (profile) {
    addEvidence("profile-goals-1", "PROFILE", boundedText(profile.careerGoals, BOUNDS.careerGoalsChars));
    boundedStringArray(profile.skillsToEmphasize, BOUNDS.skillsToEmphasize, BOUNDS.skillTextChars)
      .forEach((text, index) => addEvidence(`profile-skill-${index + 1}`, "PROFILE", text));
  }

  return {
    job: {
      title: boundedText(input.job.title, BOUNDS.shortTextChars) ?? "",
      company: boundedText(input.job.company, BOUNDS.shortTextChars) ?? "",
      location: boundedText(input.job.location, BOUNDS.shortTextChars),
      remoteStatus: boundedText(input.job.remoteStatus, 100),
      salaryMin: boundedNumber(input.job.salaryMin),
      salaryMax: boundedNumber(input.job.salaryMax),
      descriptionDigest: boundedText(input.job.description, BOUNDS.descriptionChars) ?? "",
      jobRequirements
    },
    evidenceCatalog,
    preferences: profile
      ? {
          careerGoals: boundedText(profile.careerGoals, BOUNDS.careerGoalsChars),
          preferredRoles: boundedStringArray(profile.preferredRoles, BOUNDS.preferredRoles, BOUNDS.listItemChars),
          preferredLocations: boundedStringArray(profile.preferredLocations, BOUNDS.preferredLocations, BOUNDS.listItemChars),
          remotePreference: boundedText(profile.remotePreference, 50),
          salaryTargetMin: boundedNumber(profile.salaryTargetMin)
        }
      : null,
    doNotExaggerate: boundedStringArray(profile?.skillsNotToExaggerate, BOUNDS.doNotExaggerate, BOUNDS.listTextChars)
  };
}

// The provider output references catalogs by ID only. It never establishes provenance
// by generating its own evidence text.
export type ApplicationPlanOutput = {
  targetRoleSummary: string;
  evidenceMap: Array<{
    requirementId: string;
    evidenceIds: string[];
    gap: boolean;
  }>;
  resumeStrategy: string[];
  coverLetterAngle: string;
  riskFlags: string[];
  recommendedNextActions: string[];
  confidenceScore: number;
};

export const applicationPlanSchema: z.ZodType<ApplicationPlanOutput, z.ZodTypeDef, unknown> = z.object({
  targetRoleSummary: z.string().max(2_000),
  evidenceMap: z
    .array(
      z.object({
        requirementId: z.string().min(1).max(64),
        evidenceIds: z.array(z.string().min(1).max(64)).max(8),
        gap: z.boolean()
      })
    )
    .max(25),
  resumeStrategy: z.array(z.string().max(500)).max(10),
  coverLetterAngle: z.string().max(1_000),
  riskFlags: z.array(z.string().max(500)).max(15),
  recommendedNextActions: z.array(z.string().max(300)).max(10),
  confidenceScore: z.coerce.number().min(0).max(100).transform((value) => Math.round(value))
});

export type HydratedEvidenceEntry = {
  requirementId: string;
  requirement: string;
  evidenceIds: string[];
  evidence: string[];
  gap: boolean;
};

export type EnforcedApplicationPlan = {
  plan: Omit<ApplicationPlanOutput, "evidenceMap"> & { evidenceMap: HydratedEvidenceEntry[] };
  unknownRequirementIds: string[];
  unknownEvidenceIds: string[];
  exaggeratedEvidenceIds: string[];
  inventedNumericClaims: string[];
};

// Local copy of the evaluation numeric-claim detector. The evaluation harness is a
// script entrypoint and must never be imported from library code.
function numbersIn(value: string): Set<string> {
  return new Set(value.match(/(?:\$|\b)\d+(?:\.\d+)?%?/g) ?? []);
}

// Local term matcher mirroring lib/ai/job-match.ts (job-match is outside this slice's
// file scope, so the four-line helper is duplicated rather than imported).
function hasTerm(text: string, term: string) {
  const normalizedTerm = term.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${normalizedTerm}\\b`, "i").test(text);
}

// Pure deterministic enforcement. Human-readable requirement/evidence text in the
// returned plan is hydrated from the payload catalogs — never model-generated.
export function enforceApplicationPlanEvidence(
  output: ApplicationPlanOutput,
  payload: ApplicationPlanPayload
): EnforcedApplicationPlan {
  const requirementIndex = new Map(payload.job.jobRequirements.map((entry) => [entry.id, entry]));
  const evidenceIndex = new Map(payload.evidenceCatalog.map((entry) => [entry.id, entry]));
  const exaggeratedTerms = payload.doNotExaggerate.map((term) => term.toLowerCase());

  const unknownRequirementIds: string[] = [];
  const unknownEvidenceIds: string[] = [];
  const exaggeratedEvidenceIds: string[] = [];
  const evidenceMap: HydratedEvidenceEntry[] = [];

  for (const entry of output.evidenceMap) {
    const requirement = requirementIndex.get(entry.requirementId);
    if (!requirement) {
      unknownRequirementIds.push(entry.requirementId);
      continue;
    }
    const validEvidence: Array<{ id: string; text: string }> = [];
    for (const evidenceId of new Set(entry.evidenceIds)) {
      const evidence = evidenceIndex.get(evidenceId);
      if (!evidence) {
        unknownEvidenceIds.push(evidenceId);
        continue;
      }
      if (exaggeratedTerms.some((term) => term && hasTerm(evidence.text, term))) {
        exaggeratedEvidenceIds.push(evidenceId);
        continue;
      }
      validEvidence.push({ id: evidence.id, text: evidence.text });
    }
    evidenceMap.push({
      requirementId: requirement.id,
      requirement: requirement.text,
      evidenceIds: validEvidence.map((evidence) => evidence.id),
      evidence: validEvidence.map((evidence) => evidence.text),
      gap: validEvidence.length === 0 ? true : entry.gap
    });
  }

  // Numeric honesty: numbers in free-text strategy fields must be grounded in the
  // evidence catalog. Violations are disclosed as risk flags, never silently rewritten.
  const catalogNumbers = new Set(payload.evidenceCatalog.flatMap((entry) => [...numbersIn(entry.text)]));
  const inventedNumericClaims = uniqueStrings(
    [output.targetRoleSummary, ...output.resumeStrategy, output.coverLetterAngle].flatMap((value) =>
      [...numbersIn(value)].filter((claim) => !catalogNumbers.has(claim))
    )
  );

  const riskFlags = [...output.riskFlags];
  if (unknownRequirementIds.length > 0) {
    riskFlags.push(`Discarded unknown requirement IDs referenced by the model: ${uniqueStrings(unknownRequirementIds).join(", ")}.`);
  }
  if (unknownEvidenceIds.length > 0) {
    riskFlags.push(`Discarded unknown evidence IDs referenced by the model: ${uniqueStrings(unknownEvidenceIds).join(", ")}.`);
  }
  if (exaggeratedEvidenceIds.length > 0) {
    riskFlags.push(`Removed evidence citations matching the do-not-exaggerate list: ${uniqueStrings(exaggeratedEvidenceIds).join(", ")}.`);
  }
  if (inventedNumericClaims.length > 0) {
    riskFlags.push(`Numbers in the plan do not appear in the verified evidence catalog: ${inventedNumericClaims.join(", ")}.`);
  }

  return {
    plan: {
      targetRoleSummary: output.targetRoleSummary,
      evidenceMap,
      resumeStrategy: output.resumeStrategy,
      coverLetterAngle: output.coverLetterAngle,
      riskFlags: uniqueStrings(riskFlags),
      recommendedNextActions: output.recommendedNextActions,
      confidenceScore: output.confidenceScore
    },
    unknownRequirementIds: uniqueStrings(unknownRequirementIds),
    unknownEvidenceIds: uniqueStrings(unknownEvidenceIds),
    exaggeratedEvidenceIds: uniqueStrings(exaggeratedEvidenceIds),
    inventedNumericClaims
  };
}


// The deterministic local fallback composes its evidence map directly from the payload
// catalogs, so it is evidence-valid by construction and fabricates nothing.
function heuristicApplicationPlan(payload: ApplicationPlanPayload): ApplicationPlanOutput {
  const citableEvidence = payload.evidenceCatalog.filter(
    (entry) => entry.sourceType === "SKILL" || entry.sourceType === "PROFILE"
  );
  const evidenceMap = payload.job.jobRequirements.map((requirement) => {
    const evidenceIds = citableEvidence
      .filter((entry) => hasTerm(requirement.text, entry.text))
      .map((entry) => entry.id)
      .slice(0, 8);
    return { requirementId: requirement.id, evidenceIds, gap: evidenceIds.length === 0 };
  });

  const supportedCount = evidenceMap.filter((entry) => !entry.gap).length;
  return {
    targetRoleSummary: `${payload.job.company} ${payload.job.title} plan generated locally. Review the evidence map before tailoring any document.`,
    evidenceMap,
    resumeStrategy: [
      "Lead with the skills and achievements cited in the evidence map.",
      "Do not add tools, metrics, or credentials that are absent from the evidence catalog."
    ],
    coverLetterAngle: "Connect the catalogued evidence to the stated requirements without adding new claims.",
    riskFlags: evidenceMap.some((entry) => entry.gap)
      ? ["Some requirements lack catalogued evidence; treat them as honest gaps."]
      : [],
    recommendedNextActions: [
      "Review the evidence map and confirm each citation is accurate.",
      "Generate a tailored resume only after confirming this plan."
    ],
    confidenceScore: Math.round((supportedCount / Math.max(1, evidenceMap.length)) * 100)
  };
}

// Advisory application planning. Output is data only: it never executes code, invokes
// tools, fills forms, sends messages, or submits applications.
export async function planApplication(
  input: ApplicationPlanInput,
  userId?: string,
  options: AiInvocationOptions = {}
) {
  const payload = buildApplicationPlanPayload(input);
  const generated = await generateJson<ApplicationPlanOutput>({
    promptName: "applicationPlanPrompt",
    systemPrompt: applicationPlanPrompt,
    payload,
    fallback: heuristicApplicationPlan(payload),
    schema: applicationPlanSchema,
    context: userId
      ? {
          userId,
          feature: "APPLICATION_PLAN",
          promptVersion: APPLICATION_PLAN_PROMPT_VERSION,
          ...options
        }
      : undefined
  });
  const enforced = enforceApplicationPlanEvidence(generated.data, payload);

  return {
    ...enforced.plan,
    unknownRequirementIds: enforced.unknownRequirementIds,
    unknownEvidenceIds: enforced.unknownEvidenceIds,
    exaggeratedEvidenceIds: enforced.exaggeratedEvidenceIds,
    inventedNumericClaims: enforced.inventedNumericClaims,
    model: generated.meta.model,
    provider: generated.meta.provider,
    promptVersion: generated.meta.promptVersion,
    requestHash: generated.meta.requestHash,
    usage: generated.meta
  };
}


