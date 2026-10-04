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
  | "RAW_SOURCE"
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

// Caller-facing input. Extra properties (contactInfo, file paths, answer-vault or EEO
// data, browser/session state) are never forwarded: buildApplicationPlanPayload
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
    rawText?: string | null;
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
  projectionOmissions: ProjectionOmission[];
};

export type ProjectionOmission = {
  sourcePath: string;
  omittedIds: string[];
  omittedCount: number;
  truncatedIds: string[];
};

// Hard bounds keep the payload inside the 12,000-token APPLICATION_PLAN policy.
// Sized so an adversarial-maximum payload (every field at cap, all arrays full,
// ~28 KB ≈ 11k estimated tokens) stays under the policy with margin.
// Never raise the policy instead.
const BOUNDS = {
  descriptionChars: 1_000,
  requirementTextChars: 150,
  requirements: 12,
  preferred: 6,
  tech: 12,
  techTextChars: 40,
  summaryChars: 600,
  shortTextChars: 120,
  educationTextChars: 80,
  certificationChars: 80,
  skillTextChars: 40,
  listTextChars: 40,
  listItemChars: 60,
  skills: 30,
  achievements: 5,
  detailChars: 100,
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
  doNotExaggerate: 12,
  rawSourceChars: 2_500
} as const;

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

function recordProjectionOmission(
  omissions: ProjectionOmission[],
  sourcePath: string,
  omittedIds: string[] = [],
  truncatedIds: string[] = []
) {
  if (!omittedIds.length && !truncatedIds.length) return;
  const existing = omissions.find((entry) => entry.sourcePath === sourcePath);
  if (existing) {
    existing.omittedIds.push(...omittedIds.filter((id) => !existing.omittedIds.includes(id)));
    existing.omittedCount = existing.omittedIds.length;
    existing.truncatedIds.push(...truncatedIds.filter((id) => !existing.truncatedIds.includes(id)));
    return;
  }
  omissions.push({ sourcePath, omittedIds, omittedCount: omittedIds.length, truncatedIds });
}

function boundedProjectedText(
  value: unknown,
  maxChars: number,
  id: string,
  sourcePath: string,
  omissions: ProjectionOmission[]
) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxChars) recordProjectionOmission(omissions, sourcePath, [], [id]);
  return trimmed.slice(0, maxChars);
}

function recordArrayBound(
  value: unknown,
  maxItems: number,
  idPrefix: string,
  sourcePath: string,
  omissions: ProjectionOmission[]
) {
  if (!Array.isArray(value) || value.length <= maxItems) return;
  recordProjectionOmission(
    omissions,
    sourcePath,
    value.slice(maxItems).map((_, index) => `${idPrefix}-${maxItems + index + 1}`)
  );
}

function projectedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
  idPrefix: string,
  sourcePath: string,
  omissions: ProjectionOmission[]
) {
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  const omittedIds: string[] = [];
  const truncatedIds: string[] = [];
  value.forEach((item, index) => {
    const id = `${idPrefix}-${index + 1}`;
    if (selected.length >= maxItems) {
      if (typeof item === "string" && item.trim()) omittedIds.push(id);
      return;
    }
    if (typeof item !== "string" || !item.trim()) return;
    const trimmed = item.trim();
    if (trimmed.length > maxChars) truncatedIds.push(id);
    selected.push(trimmed.slice(0, maxChars));
  });
  recordProjectionOmission(omissions, sourcePath, omittedIds, truncatedIds);
  return selected;
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
type CondensedTextEntry = { id: string; text: string };

// Defensively reads the Json work-history field, keeping only title/company/dates and
// bounded highlights. Contact-like and unlisted fields are dropped by omission.
function condenseWorkHistory(value: unknown, omissions: ProjectionOmission[]): CondensedEntry[] {
  if (!Array.isArray(value)) return [];
  recordArrayBound(value, BOUNDS.workRoles, "work", "resume.workHistory", omissions);
  const roles: CondensedEntry[] = [];
  for (const [sourceIndex, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) continue;
    const id = `work-${sourceIndex + 1}`;
    const basePath = `resume.workHistory[${sourceIndex}]`;
    const title = boundedProjectedText(record.title ?? record.role ?? record.position, BOUNDS.shortTextChars, id, basePath, omissions);
    const company = boundedProjectedText(record.company ?? record.organization ?? record.employer, BOUNDS.shortTextChars, id, basePath, omissions);
    const start = boundedProjectedText(record.startDate ?? record.start, 40, id, basePath, omissions);
    const end = boundedProjectedText(record.endDate ?? record.end, 40, id, basePath, omissions);
    const unboundedHeading = [
      [title, company].filter(Boolean).join(" at "),
      start || end ? [start, end ?? "present"].filter(Boolean).join(" – ") : ""
    ]
      .filter(Boolean)
      .join(", ");
    if (unboundedHeading.length > BOUNDS.detailChars) {
      recordProjectionOmission(omissions, basePath, [], [id]);
    }
    const heading = unboundedHeading.slice(0, BOUNDS.detailChars);
    if (!heading) continue;
    const highlightSource = record.highlights ?? record.achievements ?? record.bullets ?? record.responsibilities;
    roles.push({
      heading,
      highlights: projectedStringArray(
        highlightSource,
        BOUNDS.workHighlights,
        BOUNDS.detailChars,
        `work-${sourceIndex + 1}-highlight`,
        `resume.workHistory[${sourceIndex}].highlights`,
        omissions
      )
    });
    if (roles.length >= BOUNDS.workRoles) break;
  }
  return roles;
}

// Projects keep name, subtitle, date, technologies, and source bullets.
function condenseProjects(value: unknown, omissions: ProjectionOmission[]): CondensedEntry[] {
  if (!Array.isArray(value)) return [];
  recordArrayBound(value, BOUNDS.projects, "project", "resume.projects", omissions);
  const projects: CondensedEntry[] = [];
  for (const [sourceIndex, item] of value.entries()) {
    const record = asRecord(item);
    if (!record) continue;
    const id = `project-${sourceIndex + 1}`;
    const basePath = `resume.projects[${sourceIndex}]`;
    const name = boundedProjectedText(record.name ?? record.title, BOUNDS.shortTextChars, id, basePath, omissions);
    if (!name) continue;
    const description = boundedProjectedText(record.description ?? record.subtitle, BOUNDS.detailChars, id, basePath, omissions);
    const date = boundedProjectedText(record.date ?? record.year, 40, id, basePath, omissions);
    const technologies = projectedStringArray(
      record.technologies ?? record.tech ?? record.stack,
      BOUNDS.projectTechnologies,
      BOUNDS.listTextChars,
      `project-${sourceIndex + 1}-technology`,
      `resume.projects[${sourceIndex}].technologies`,
      omissions
    );
    const namedProject = description ? `${name} — ${description}` : name;
    const datedName = date ? `${namedProject}, ${date}` : namedProject;
    const unboundedHeading = technologies.length ? `${datedName} (${technologies.join(", ")})` : datedName;
    if (unboundedHeading.length > BOUNDS.projectHeadingChars) {
      recordProjectionOmission(omissions, basePath, [], [id]);
    }
    const heading = unboundedHeading.slice(0, BOUNDS.projectHeadingChars);
    const highlightSource = record.bullets ?? record.highlights ?? record.achievements ?? [];
    const highlights = projectedStringArray(
      highlightSource,
      BOUNDS.projectHighlights,
      BOUNDS.detailChars,
      `project-${sourceIndex + 1}-highlight`,
      `resume.projects[${sourceIndex}].highlights`,
      omissions
    );
    projects.push({ heading, highlights });
    if (projects.length >= BOUNDS.projects) break;
  }
  return projects;
}

// Education keeps credential + field only; institution names, addresses, and any
// personal details are deliberately omitted.
function condenseEducation(value: unknown, omissions: ProjectionOmission[]): CondensedTextEntry[] {
  if (!Array.isArray(value)) return [];
  recordArrayBound(value, BOUNDS.education, "education", "resume.education", omissions);
  const entries: CondensedTextEntry[] = [];
  for (const [sourceIndex, item] of value.slice(0, BOUNDS.education).entries()) {
    const record = asRecord(item);
    const id = `education-${sourceIndex + 1}`;
    const basePath = `resume.education[${sourceIndex}]`;
    if (!record) {
      recordProjectionOmission(omissions, basePath, [id]);
      continue;
    }
    const credential = boundedProjectedText(record.credential ?? record.degree, BOUNDS.educationTextChars, id, basePath, omissions);
    const field = boundedProjectedText(
      record.fieldOfStudy ?? record.field ?? record.areaOfStudy ?? record.major,
      BOUNDS.educationTextChars,
      id,
      basePath,
      omissions
    );
    const text = [credential, field].filter(Boolean).join(" — ");
    if (text) entries.push({ id, text });
    else recordProjectionOmission(omissions, basePath, [id]);
  }
  return entries;
}

function condenseCertifications(value: unknown, omissions: ProjectionOmission[]): CondensedEntry[] {
  if (!Array.isArray(value)) return [];
  recordArrayBound(value, BOUNDS.certifications, "certification", "resume.certifications", omissions);
  const entries: CondensedEntry[] = [];
  for (const [sourceIndex, item] of value.entries()) {
    const record = asRecord(item);
    const id = `certification-${sourceIndex + 1}`;
    const text = typeof item === "string"
      ? boundedProjectedText(item, BOUNDS.certificationChars, id, `resume.certifications[${sourceIndex}]`, omissions)
      : boundedProjectedText(
          record?.name ?? record?.title ?? record?.certification,
          BOUNDS.certificationChars,
          id,
          `resume.certifications[${sourceIndex}]`,
          omissions
        );
    if (text) entries.push({
      heading: text,
      highlights: projectedStringArray(
        record?.details,
        BOUNDS.projectHighlights,
        BOUNDS.detailChars,
        `certification-${sourceIndex + 1}-detail`,
        `resume.certifications[${sourceIndex}].details`,
        omissions
      )
    });
    if (entries.length >= BOUNDS.certifications) break;
  }
  return entries;
}


// Builds the immutable, privacy-minimized planner payload with deterministic,
// position-based catalog IDs. Never forwards a raw database object or unlisted fields.
export function buildApplicationPlanPayload(input: ApplicationPlanInput): ApplicationPlanPayload {
  const projectionOmissions: ProjectionOmission[] = [];
  const jobRequirements: JobRequirementEntry[] = [];
  projectedStringArray(
    input.job.requirements,
    BOUNDS.requirements,
    BOUNDS.requirementTextChars,
    "req",
    "job.requirements",
    projectionOmissions
  )
    .forEach((text, index) => jobRequirements.push({ id: `req-${index + 1}`, kind: "REQUIREMENT", text }));
  projectedStringArray(
    input.job.preferredQualifications,
    BOUNDS.preferred,
    BOUNDS.requirementTextChars,
    "pref",
    "job.preferredQualifications",
    projectionOmissions
  )
    .forEach((text, index) => jobRequirements.push({ id: `pref-${index + 1}`, kind: "PREFERRED", text }));
  projectedStringArray(
    input.job.detectedTechStack,
    BOUNDS.tech,
    BOUNDS.techTextChars,
    "tech",
    "job.detectedTechStack",
    projectionOmissions
  )
    .forEach((text, index) => jobRequirements.push({ id: `tech-${index + 1}`, kind: "TECH", text }));

  const evidenceCatalog: EvidenceCatalogEntry[] = [];
  const addEvidence = (id: string, sourceType: EvidenceSourceType, text: string | null) => {
    if (text) evidenceCatalog.push({ id, sourceType, text });
  };

  const resume = input.resume ?? null;
  if (resume) {
    addEvidence("summary-1", "SUMMARY", boundedProjectedText(
      resume.summary,
      BOUNDS.summaryChars,
      "summary-1",
      "resume.summary",
      projectionOmissions
    ));
    projectedStringArray(
      resume.skills,
      BOUNDS.skills,
      BOUNDS.skillTextChars,
      "skill",
      "resume.skills",
      projectionOmissions
    )
      .forEach((text, index) => addEvidence(`skill-${index + 1}`, "SKILL", text));
    projectedStringArray(
      resume.achievements,
      BOUNDS.achievements,
      BOUNDS.detailChars,
      "achievement",
      "resume.achievements",
      projectionOmissions
    )
      .forEach((text, index) => addEvidence(`achievement-${index + 1}`, "ACHIEVEMENT", text));
    condenseWorkHistory(resume.workHistory, projectionOmissions).forEach((role, roleIndex) => {
      const roleId = `work-${roleIndex + 1}`;
      addEvidence(roleId, "WORK_HISTORY", role.heading);
      role.highlights.forEach((highlight, highlightIndex) =>
        addEvidence(`${roleId}-highlight-${highlightIndex + 1}`, "WORK_HISTORY", highlight));
    });
    condenseProjects(resume.projects, projectionOmissions).forEach((project, projectIndex) => {
      const projectId = `project-${projectIndex + 1}`;
      addEvidence(projectId, "PROJECT", project.heading);
      project.highlights.forEach((highlight, highlightIndex) =>
        addEvidence(`${projectId}-highlight-${highlightIndex + 1}`, "PROJECT", highlight));
    });
    condenseEducation(resume.education, projectionOmissions)
      .forEach((entry) => addEvidence(entry.id, "EDUCATION", entry.text));
    condenseCertifications(resume.certifications, projectionOmissions).forEach((certification, index) => {
      const certificationId = `certification-${index + 1}`;
      addEvidence(certificationId, "CERTIFICATION", certification.heading);
      certification.highlights.forEach((detail, detailIndex) =>
        addEvidence(`${certificationId}-detail-${detailIndex + 1}`, "CERTIFICATION", detail));
    });
    const rawText = boundedText(resume.rawText, BOUNDS.rawSourceChars);
    addEvidence("raw-source-1", "RAW_SOURCE", rawText);
    if (typeof resume.rawText === "string" && resume.rawText.trim().length > BOUNDS.rawSourceChars) {
      recordProjectionOmission(projectionOmissions, "resume.rawText", [], ["raw-source-1"]);
    }
  }

  const profile = input.profile ?? null;
  if (profile) {
    addEvidence("profile-goals-1", "PROFILE", boundedProjectedText(
      profile.careerGoals,
      BOUNDS.careerGoalsChars,
      "profile-goals-1",
      "profile.careerGoals",
      projectionOmissions
    ));
    projectedStringArray(
      profile.skillsToEmphasize,
      BOUNDS.skillsToEmphasize,
      BOUNDS.skillTextChars,
      "profile-skill",
      "profile.skillsToEmphasize",
      projectionOmissions
    )
      .forEach((text, index) => addEvidence(`profile-skill-${index + 1}`, "PROFILE", text));
  }

  const preferredRoles = projectedStringArray(
    profile?.preferredRoles,
    BOUNDS.preferredRoles,
    BOUNDS.listItemChars,
    "profile-role",
    "profile.preferredRoles",
    projectionOmissions
  );
  const preferredLocations = projectedStringArray(
    profile?.preferredLocations,
    BOUNDS.preferredLocations,
    BOUNDS.listItemChars,
    "profile-location",
    "profile.preferredLocations",
    projectionOmissions
  );
  const doNotExaggerate = projectedStringArray(
    profile?.skillsNotToExaggerate,
    BOUNDS.doNotExaggerate,
    BOUNDS.listTextChars,
    "do-not-exaggerate",
    "profile.skillsNotToExaggerate",
    projectionOmissions
  );

  return {
    job: {
      title: boundedProjectedText(input.job.title, BOUNDS.shortTextChars, "job-title-1", "job.title", projectionOmissions) ?? "",
      company: boundedProjectedText(input.job.company, BOUNDS.shortTextChars, "job-company-1", "job.company", projectionOmissions) ?? "",
      location: boundedProjectedText(input.job.location, BOUNDS.shortTextChars, "job-location-1", "job.location", projectionOmissions),
      remoteStatus: boundedProjectedText(input.job.remoteStatus, 100, "job-remote-status-1", "job.remoteStatus", projectionOmissions),
      salaryMin: boundedNumber(input.job.salaryMin),
      salaryMax: boundedNumber(input.job.salaryMax),
      descriptionDigest: boundedProjectedText(
        input.job.description,
        BOUNDS.descriptionChars,
        "job-description-1",
        "job.description",
        projectionOmissions
      ) ?? "",
      jobRequirements
    },
    evidenceCatalog,
    preferences: profile
      ? {
          careerGoals: boundedProjectedText(
            profile.careerGoals,
            BOUNDS.careerGoalsChars,
            "profile-goals-1",
            "profile.careerGoals",
            projectionOmissions
          ),
          preferredRoles,
          preferredLocations,
          remotePreference: boundedProjectedText(
            profile.remotePreference,
            50,
            "profile-remote-preference-1",
            "profile.remotePreference",
            projectionOmissions
          ),
          salaryTargetMin: boundedNumber(profile.salaryTargetMin)
        }
      : null,
    doNotExaggerate,
    projectionOmissions
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
    projectionOmissions: payload.projectionOmissions,
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
