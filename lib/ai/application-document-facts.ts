import { PublicApiError } from "@/lib/api-errors";
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

export type TailoredResumeProviderOutput = {
  professionalSummary: string;
  professionalSummaryFactId: string;
  skillsSection: Array<{ text: string; factId: string }>;
  bulletRewrites: Array<{ factId: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: Array<{ text: string; factId: string }>;
  resumeTextClaims: Array<{ claim: string; factId: string }>;
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

function isResumeSectionHeading(value: string) {
  return /^(?:summary|profile|skills|experience|work experience|projects|education|certifications|achievements|additional(?: information)?)$/iu
    .test(value.trim());
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
  entries: Array<{ claim: string; fact: ApplicationDocumentFact }>
): ApplicationDocumentClaimEvidence[] {
  const claims = new Map<string, ApplicationDocumentClaimEvidence>();
  for (const { claim, fact } of entries) {
    const key = `${comparable(claim)}\u0000${fact.factId}`;
    if (!key) continue;
    const citation = { ref: fact.ref, excerpt: fact.excerpt };
    const existing = claims.get(key);
    if (!existing) {
      claims.set(key, { claim, citations: [citation] });
      continue;
    }
    if (!existing.citations.some((value) => value.ref === citation.ref && value.excerpt === citation.excerpt)) {
      existing.citations.push(citation);
    }
  }
  return [...claims.values()];
}

export function assembleTailoredResumeProviderOutput(
  payload: ApplicationDocumentPayload,
  wire: TailoredResumeProviderOutput
): AssembledTailoredResumeOutput {
  const resolve = factResolver(payload);
  const evidence: Array<{ claim: string; fact: ApplicationDocumentFact }> = [];
  const summary = wire.professionalSummary.trim();
  if (summary) {
    if (wire.professionalSummaryFactId === NO_APPLICATION_DOCUMENT_FACT_ID) {
      throw new PublicApiError("Application document summary is missing an applicant fact ID.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath: "professionalSummaryFactId",
        retryable: false
      });
    }
    evidence.push({
      claim: wire.professionalSummary,
      fact: resolve(wire.professionalSummaryFactId, "professionalSummaryFactId")
    });
  } else if (wire.professionalSummaryFactId !== NO_APPLICATION_DOCUMENT_FACT_ID) {
    throw new PublicApiError("Empty application document summary must not select an applicant fact.", 422, {
      code: "APPLICATION_DOCUMENT_UNUSED_FACT_ID",
      fieldPath: "professionalSummaryFactId",
      retryable: false
    });
  }

  const skillsSection = wire.skillsSection.map((item, index) => {
    evidence.push({ claim: item.text, fact: resolve(item.factId, `skillsSection[${index}].factId`) });
    return item.text;
  });
  const bulletRewrites = wire.bulletRewrites.map((item, index) => {
    const fact = resolve(item.factId, `bulletRewrites[${index}].factId`);
    evidence.push({ claim: item.rewrite, fact });
    return { original: fact.excerpt, rewrite: item.rewrite, reason: item.reason };
  });
  const rolesOrProjectsToEmphasize = wire.rolesOrProjectsToEmphasize.map((item, index) => {
    evidence.push({
      claim: item.text,
      fact: resolve(item.factId, `rolesOrProjectsToEmphasize[${index}].factId`)
    });
    return item.text;
  });
  const resumeLines = new Set(wire.resumeText.split(/\r?\n/)
    .map((line) => comparable(normalizeApplicationDocumentSourceLine(line)))
    .filter(Boolean));
  wire.resumeTextClaims.forEach((item, index) => {
    if (!resumeLines.has(comparable(item.claim))) {
      throw new PublicApiError("Resume-text evidence describes text absent from the generated resume.", 422, {
        code: "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
        fieldPath: `resumeTextClaims[${index}].claim`,
        retryable: false
      });
    }
    evidence.push({
      claim: item.claim,
      fact: resolve(item.factId, `resumeTextClaims[${index}].factId`)
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
    professionalSummary: wire.professionalSummary,
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
      fact: resolve(entry.factId, `claimsUsed[${index}].factId`)
    })))
  };
}
