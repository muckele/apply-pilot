import { PublicApiError } from "@/lib/api-errors";
import { resumeSectionHeadings } from "@/lib/ai/resume-source-catalog";
import type {
  ApplicationDocumentClaimEvidence,
  ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";

export const NO_APPLICATION_DOCUMENT_FACT_ID = "__NO_APPLICANT_FACT__" as const;

export type ApplicationDocumentFact = Readonly<{
  factId: string;
  ref: string;
  excerpt: string;
  provenance: Readonly<{
    kind: "resume" | "profile" | "reviewed_evidence";
    detail: string | null;
  }>;
}>;

export type ApplicationDocumentClaimOrigin = Readonly<{ factId: string; originFieldPath: string }>;

// Ephemeral sidecar: neither persisted evidence nor its JSON serialization gains provider metadata.
const claimOrigins = new WeakMap<readonly ApplicationDocumentClaimEvidence[], readonly ApplicationDocumentClaimOrigin[]>();
const assemblyFailureOrigins = new WeakMap<PublicApiError, ApplicationDocumentClaimOrigin>();
export function getApplicationDocumentClaimOrigins(evidence: readonly ApplicationDocumentClaimEvidence[]) {
  return claimOrigins.get(evidence) ?? [];
}

export function getApplicationDocumentAssemblyFailureOrigin(error: unknown) {
  return error instanceof PublicApiError ? assemblyFailureOrigins.get(error) : undefined;
}

export type TailoredResumeProviderOutput = {
  professionalSummary: string;
  professionalSummaryFactId: string;
  skillsSection: Array<{ text: string; factId: string }>;
  bulletRewrites: Array<{ factId: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: Array<{ text: string; factId: string }>;
  // A résumé line cites every fact it uses (factIds); the legacy single factId is still accepted.
  resumeTextClaims: Array<{ claim: string; factIds?: string[]; factId?: string }>;
  unsupportedKeywords: string[];
  formattingWarnings: string[];
  resumeText: string;
};

export type AssembledTailoredResumeOutput = {
  professionalSummary: string;
  skillsSection: string[];
  bulletRewrites: Array<{ original: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: string[];
  unsupportedKeywords: string[];
  formattingWarnings: string[];
  resumeText: string;
  claimEvidence: ApplicationDocumentClaimEvidence[];
};

export type CoverLetterProviderOutput = {
  title: string;
  coverLetter: string;
  angle: string;
  claimsUsed: Array<{ claim: string; factId: string }>;
};

export type AssembledCoverLetterOutput = {
  title: string;
  coverLetter: string;
  angle: string;
  claimsUsed: ApplicationDocumentClaimEvidence[];
};

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const actionWords = [
  "accelerated", "achieved", "architected", "automated", "built", "collaborated", "consolidated",
  "coordinated", "created", "decreased", "delivered", "designed", "developed", "engineered", "enhanced",
  "established", "executed", "expanded", "generated", "grew", "implemented", "improved", "increased",
  "launched", "led", "maintained", "managed", "mentored", "migrated", "modernized", "optimized",
  "orchestrated", "partnered", "produced", "reduced", "resolved", "scaled", "streamlined", "strengthened",
  "supported", "transformed", "used", "utilized"
] as const;
export function applicationDocumentFactStartsWithAction(value: string) {
  const first = value.trim().replace(/^i\s+(?:have\s+)?/iu, "").split(/\s+/u)[0].toLocaleLowerCase();
  return (actionWords as readonly string[]).includes(first) ||
    ["directed", "prepared", "coached", "completed", "received", "recognized", "hold"].includes(first);
}
const actionClauseBoundary = new RegExp(
  `\\s*;\\s*|\\s*,\\s*(?:but|while|then)\\s+|\\s*,\\s*and\\s+(?=(?:${actionWords.join("|")})\\b)|\\s+(?:and|but|while|then)\\s+(?=(?:${actionWords.join("|")})\\b)`,
  "i"
);

function comparable(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeApplicationDocumentSourceLine(value: string) {
  return value.trim().replace(/^[-*•▪◦–—]\s+/u, "");
}

export type ApplicationDocumentSection =
  | "SUMMARY" | "SKILLS" | "EXPERIENCE" | "PROJECTS" | "EDUCATION" | "CERTIFICATIONS" | "ACHIEVEMENTS"
  | "ADDITIONAL INFORMATION";

const standardHeading =
  /^(?:summary|profile|skills|experience|work experience|projects|education|certifications|achievements|additional(?: information)?)$/iu;
const typedSection: Record<keyof typeof resumeSectionHeadings, ApplicationDocumentSection> = {
  summary: "SUMMARY",
  skills: "SKILLS",
  workHistory: "EXPERIENCE",
  projects: "PROJECTS",
  education: "EDUCATION",
  certifications: "CERTIFICATIONS",
  achievements: "ACHIEVEMENTS"
};

// One heading vocabulary for application documents. The standard headings are recognized in any
// case; the parser's other typed headings (LICENSES, PROFESSIONAL EXPERIENCE, CORE COMPETENCIES...)
// are recognized when written as an all-caps heading line, so a tailored résumé can keep the
// source's own heading instead of renaming it.
export function applicationDocumentSectionOf(value: string): ApplicationDocumentSection | null {
  const line = value.trim();
  if (!line) return null;
  if (standardHeading.test(line)) {
    const upper = line.toLocaleUpperCase();
    if (upper === "PROFILE") return "SUMMARY";
    if (upper === "WORK EXPERIENCE") return "EXPERIENCE";
    if (upper === "ADDITIONAL") return "ADDITIONAL INFORMATION";
    return upper as ApplicationDocumentSection;
  }
  if (line !== line.toLocaleUpperCase() || !/\p{Lu}/u.test(line)) return null;
  if (/^ADDITIONAL\s+INFORMATION$/u.test(line)) return "ADDITIONAL INFORMATION";
  for (const [section, pattern] of Object.entries(resumeSectionHeadings) as Array<[keyof typeof resumeSectionHeadings, RegExp]>) {
    if (pattern.test(line)) return typedSection[section];
  }
  return null;
}

export function isApplicationDocumentSectionHeading(value: string) {
  return applicationDocumentSectionOf(value) !== null;
}

function isResumeSectionHeading(value: string) {
  return isApplicationDocumentSectionHeading(value);
}

// The same atomic split the catalog uses, so a source line maps to exactly its catalog facts.
export function applicationDocumentAtomicStrings(value: unknown): string[] {
  return atomicStrings(value);
}

function atomicStrings(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).split(/\r?\n/)
      .flatMap((line) => [...sentenceSegmenter.segment(line)]
        .flatMap(({ segment }) => segment.split(actionClauseBoundary)))
      .map(normalizeApplicationDocumentSourceLine)
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(atomicStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(atomicStrings);
  return [];
}

type CatalogCandidate = Omit<ApplicationDocumentFact, "factId">;

function candidatesForIndexedField(
  root: "resume" | "profile",
  record: Record<string, unknown> | null | undefined,
  field: string,
  provenance: ApplicationDocumentFact["provenance"]
) {
  const values = record?.[field];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value, index): CatalogCandidate[] => atomicStrings(value).map((excerpt) => ({
    ref: `${root}.${field}[${index}]`,
    excerpt,
    provenance
  })));
}

export function buildApplicationDocumentFactCatalog(
  payload: ApplicationDocumentPayload
): readonly ApplicationDocumentFact[] {
  const resumeProvenance = { kind: "resume", detail: null } as const;
  const profileProvenance = { kind: "profile", detail: null } as const;
  const candidates: CatalogCandidate[] = [];

  if (typeof payload.resume?.summary === "string") {
    candidates.push(...atomicStrings(payload.resume.summary).map((excerpt) => ({
      ref: "resume.summary",
      excerpt,
      provenance: resumeProvenance
    })));
  }
  for (const field of [
    "skills", "achievements", "workHistory", "projects", "education", "certifications"
  ]) {
    candidates.push(...candidatesForIndexedField("resume", payload.resume, field, resumeProvenance));
  }
  candidates.push(...candidatesForIndexedField(
    "profile",
    payload.profile,
    "skillsToEmphasize",
    profileProvenance
  ));
  const reviewedFacts = payload.reviewedEvidence?.facts;
  if (Array.isArray(reviewedFacts)) {
    reviewedFacts.forEach((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      if (typeof record.fact !== "string") return;
      const detail = typeof record.provenance === "string" && record.provenance.trim()
        ? record.provenance.trim()
        : null;
      candidates.push(...atomicStrings(record.fact).map((excerpt) => ({
        ref: `reviewedEvidence.facts[${index}].fact`,
        excerpt,
        provenance: { kind: "reviewed_evidence" as const, detail }
      })));
    });
  }
  if (typeof payload.resume?.rawText === "string") {
    candidates.push(...atomicStrings(payload.resume.rawText).filter((excerpt) => !isResumeSectionHeading(excerpt)).map((excerpt) => ({
      ref: "resume.rawText",
      excerpt,
      provenance: resumeProvenance
    })));
  }

  const seen = new Set<string>();
  const unique = candidates.filter(({ excerpt }) => {
    const key = comparable(excerpt);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Object.freeze(unique.map((candidate, index) => Object.freeze({
    factId: `fact:${String(index).padStart(4, "0")}`,
    ...candidate,
    provenance: Object.freeze({ ...candidate.provenance })
  })));
}

export function buildApplicationDocumentFactIdJsonSchema(payload: ApplicationDocumentPayload) {
  const facts = buildApplicationDocumentFactCatalog(payload);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      factId: {
        type: "string",
        enum: facts.length ? facts.map((fact) => fact.factId) : [NO_APPLICATION_DOCUMENT_FACT_ID]
      }
    },
    required: ["factId"]
  } as const;
}

function factResolver(payload: ApplicationDocumentPayload) {
  const facts = buildApplicationDocumentFactCatalog(payload);
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  return (factId: string, fieldPath: string) => {
    const fact = byId.get(factId);
    if (!fact) {
      throw new PublicApiError("Application document returned an unknown applicant fact ID.", 422, {
        code: "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID",
        fieldPath,
        retryable: false
      });
    }
    return fact;
  };
}

function assembleEvidence(
  entries: Array<{ claim: string; facts: readonly ApplicationDocumentFact[]; originFieldPath: string }>
): ApplicationDocumentClaimEvidence[] {
  const claims = new Map<string, ApplicationDocumentClaimEvidence & { origin: ApplicationDocumentClaimOrigin; multi: boolean }>();
  for (const { claim, facts, originFieldPath } of entries) {
    if (!facts.length) continue;
    const key = `${comparable(claim)}\u0000${[...new Set(facts.map((fact) => fact.factId))].sort().join(",")}`;
    const citations = facts.map((fact) => ({ ref: fact.ref, excerpt: fact.excerpt }));
    const existing = claims.get(key);
    if (!existing) {
      claims.set(key, {
        claim,
        citations: citations.filter((citation, index) => citations.findIndex((value) =>
          value.ref === citation.ref && value.excerpt === citation.excerpt) === index),
        origin: Object.freeze({ factId: facts[0]!.factId, originFieldPath }),
        multi: new Set(facts.map((fact) => fact.factId)).size > 1
      });
    }
  }
  // A line citing several facts absorbs single-fact selections of the same text, so the line is
  // validated once against every fact it claims (each must be expressed). Single-fact entries of
  // other text stay separate, so a correct duplicate cannot mask a wrong per-item fact selection.
  const merged: Array<ApplicationDocumentClaimEvidence & { origin: ApplicationDocumentClaimOrigin }> = [];
  const multiByClaim = new Map<string, ApplicationDocumentClaimEvidence & { origin: ApplicationDocumentClaimOrigin }>();
  for (const entry of claims.values()) {
    if (!entry.multi) continue;
    const claimKey = comparable(entry.claim);
    const target = multiByClaim.get(claimKey);
    if (target) {
      for (const citation of entry.citations) {
        if (!target.citations.some((value) => value.ref === citation.ref && value.excerpt === citation.excerpt)) target.citations.push(citation);
      }
      continue;
    }
    const copy = { claim: entry.claim, citations: [...entry.citations], origin: entry.origin };
    multiByClaim.set(claimKey, copy);
  }
  for (const entry of claims.values()) {
    const target = multiByClaim.get(comparable(entry.claim));
    if (!target) {
      merged.push({ claim: entry.claim, citations: entry.citations, origin: entry.origin });
      continue;
    }
    if (!merged.includes(target)) merged.push(target);
    for (const citation of entry.citations) {
      if (!target.citations.some((value) => value.ref === citation.ref && value.excerpt === citation.excerpt)) target.citations.push(citation);
    }
  }
  const evidence = merged.map(({ claim, citations }) => ({ claim, citations }));
  claimOrigins.set(evidence, Object.freeze(merged.map((entry) => entry.origin)));
  return evidence;
}

export function assembleTailoredResumeProviderOutput(
  payload: ApplicationDocumentPayload,
  wire: TailoredResumeProviderOutput
): AssembledTailoredResumeOutput {
  const resolve = factResolver(payload);
  const evidence: Array<{ claim: string; facts: readonly ApplicationDocumentFact[]; originFieldPath: string }> = [];
  // Typed projections and evidence use the same single-marker convention as
  // resumeText line association. The rendered resume itself is preserved.
  const summary = normalizeApplicationDocumentSourceLine(wire.professionalSummary);
  if (summary) {
    if (wire.professionalSummaryFactId === NO_APPLICATION_DOCUMENT_FACT_ID) {
      throw new PublicApiError("Application document summary is missing an applicant fact ID.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath: "professionalSummaryFactId",
        retryable: false
      });
    }
    evidence.push({
      claim: summary,
      originFieldPath: "professionalSummary",
      facts: [resolve(wire.professionalSummaryFactId, "professionalSummaryFactId")]
    });
  } else if (wire.professionalSummaryFactId !== NO_APPLICATION_DOCUMENT_FACT_ID) {
    throw new PublicApiError("Empty application document summary must not select an applicant fact.", 422, {
      code: "APPLICATION_DOCUMENT_UNUSED_FACT_ID",
      fieldPath: "professionalSummaryFactId",
      retryable: false
    });
  }

  const skillsSection = wire.skillsSection.map((item, index) => {
    const text = normalizeApplicationDocumentSourceLine(item.text);
    evidence.push({ claim: text, facts: [resolve(item.factId, `skillsSection[${index}].factId`)], originFieldPath: `skillsSection[${index}].text` });
    return text;
  });
  const bulletRewrites = wire.bulletRewrites.map((item, index) => {
    const fact = resolve(item.factId, `bulletRewrites[${index}].factId`);
    const rewrite = normalizeApplicationDocumentSourceLine(item.rewrite);
    evidence.push({ claim: rewrite, facts: [fact], originFieldPath: `bulletRewrites[${index}].rewrite` });
    return { original: fact.excerpt, rewrite, reason: item.reason };
  });
  const rolesOrProjectsToEmphasize = wire.rolesOrProjectsToEmphasize.map((item, index) => {
    const text = normalizeApplicationDocumentSourceLine(item.text);
    evidence.push({
      claim: text,
      originFieldPath: `rolesOrProjectsToEmphasize[${index}].text`,
      facts: [resolve(item.factId, `rolesOrProjectsToEmphasize[${index}].factId`)]
    });
    return text;
  });
  const resumeLines = new Set(wire.resumeText.split(/\r?\n/)
    .map((line) => comparable(normalizeApplicationDocumentSourceLine(line)))
    .filter(Boolean));
  wire.resumeTextClaims.forEach((item, index) => {
    const ids = item.factIds?.length ? item.factIds : item.factId ? [item.factId] : [];
    const facts = ids.map((id, idIndex) => resolve(id, item.factIds?.length
      ? `resumeTextClaims[${index}].factIds[${idIndex}]`
      : `resumeTextClaims[${index}].factId`));
    if (!facts.length) resolve("", `resumeTextClaims[${index}].factIds`);
    const fact = facts[0]!;
    const origin = Object.freeze({ factId: fact.factId, originFieldPath: `resumeTextClaims[${index}].claim` });
    // The prompt permits the exact rendered bullet line. Both sides use the same
    // existing single-marker normalization; factual words and resumeText stay intact.
    const claim = normalizeApplicationDocumentSourceLine(item.claim);
    if (!resumeLines.has(comparable(claim))) {
      const error = new PublicApiError("Resume-text evidence describes text absent from the generated resume.", 422, {
        code: "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
        fieldPath: origin.originFieldPath,
        retryable: false
      });
      assemblyFailureOrigins.set(error, origin);
      throw error;
    }
    evidence.push({
      claim,
      originFieldPath: origin.originFieldPath,
      facts
    });
  });

  const associatedClaims = new Set(evidence.map(({ claim }) => comparable(claim)));
  for (const [lineIndex, rawLine] of wire.resumeText.split(/\r?\n/).entries()) {
    const line = normalizeApplicationDocumentSourceLine(rawLine);
    if (!line || isResumeSectionHeading(line)) continue;
    if (!associatedClaims.has(comparable(line))) {
      throw new PublicApiError("Application document is missing source evidence for generated claim.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath: `resumeText.line[${lineIndex}]`,
        retryable: false
      });
    }
  }

  return {
    professionalSummary: summary,
    skillsSection,
    bulletRewrites,
    rolesOrProjectsToEmphasize,
    unsupportedKeywords: wire.unsupportedKeywords,
    formattingWarnings: wire.formattingWarnings,
    resumeText: wire.resumeText,
    claimEvidence: assembleEvidence(evidence)
  };
}

export function assembleCoverLetterProviderOutput(
  payload: ApplicationDocumentPayload,
  wire: CoverLetterProviderOutput
): AssembledCoverLetterOutput {
  const resolve = factResolver(payload);
  return {
    title: wire.title,
    coverLetter: wire.coverLetter,
    angle: wire.angle,
    claimsUsed: assembleEvidence(wire.claimsUsed.map((entry, index) => ({
      claim: entry.claim,
      originFieldPath: `claimsUsed[${index}].claim`,
      facts: [resolve(entry.factId, `claimsUsed[${index}].factId`)]
    })))
  };
}
