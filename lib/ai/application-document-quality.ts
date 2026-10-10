import { PublicApiError } from "@/lib/api-errors";
import {
  buildApplicationDocumentFactCatalog
} from "@/lib/ai/application-document-facts";
import type {
  ApplicationDocumentClaimEvidence,
  ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";

type ResumeQualityOutput = {
  resumeText: string;
  claimEvidence: ApplicationDocumentClaimEvidence[];
};

type CoverLetterQualityOutput = {
  coverLetter: string;
  claimsUsed: ApplicationDocumentClaimEvidence[];
};

const sectionHeading = /^(SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL(?: INFORMATION)?)$/iu;

function comparable(value: string) {
  return value.trim().replace(/^[-*•▪◦–—]\s+/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsComparable(haystack: string, value: string) {
  const normalizedHaystack = comparable(haystack);
  const normalizedValue = comparable(value);
  if (!normalizedValue) return false;
  const left = /^[\p{L}\p{N}]/u.test(normalizedValue) ? "(?:^|[^\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(normalizedValue) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}${escapeRegularExpression(normalizedValue)}${right}`, "u")
    .test(normalizedHaystack);
}

function incomplete(fieldPath: string, message: string): never {
  throw new PublicApiError(message, 422, {
    code: "APPLICATION_DOCUMENT_INCOMPLETE",
    fieldPath,
    retryable: false
  });
}

function claimRefsPresentInText(text: string, evidence: ApplicationDocumentClaimEvidence[]) {
  return new Set(evidence.flatMap((entry) =>
    containsComparable(text, entry.claim)
      ? entry.citations.map((citation) => citation.ref)
      : []
  ));
}

function factAppearsInTextOrEvidence(
  text: string,
  evidence: ApplicationDocumentClaimEvidence[],
  fact: Readonly<{ ref: string; excerpt: string }>
) {
  if (containsComparable(text, fact.excerpt)) return true;
  return evidence.some((entry) =>
    containsComparable(text, entry.claim) &&
    entry.citations.some((citation) =>
      citation.ref === fact.ref && comparable(citation.excerpt) === comparable(fact.excerpt)
    )
  );
}

function requiredIndexedRefs(payload: ApplicationDocumentPayload, catalogRefs: ReadonlySet<string>) {
  return ["skills", "achievements", "workHistory", "projects", "education", "certifications"]
    .flatMap((field) => {
      const values = payload.resume?.[field];
      return Array.isArray(values)
        ? values.map((_, index) => `resume.${field}[${index}]`).filter((ref) => catalogRefs.has(ref))
        : [];
    });
}

function requiredReviewedRefs(payload: ApplicationDocumentPayload, catalogRefs: ReadonlySet<string>) {
  return Array.isArray(payload.reviewedEvidence?.facts)
    ? payload.reviewedEvidence.facts.flatMap((fact, index) =>
        fact && typeof fact === "object" && !Array.isArray(fact) &&
          typeof (fact as { fact?: unknown }).fact === "string" &&
          (fact as { fact: string }).fact.trim() &&
          catalogRefs.has(`reviewedEvidence.facts[${index}].fact`)
          ? [`reviewedEvidence.facts[${index}].fact`]
          : [])
    : [];
}

function sourceHeaderLines(payload: ApplicationDocumentPayload) {
  if (typeof payload.resume?.rawText !== "string") return [];
  const lines: string[] = [];
  for (const rawLine of payload.resume.rawText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (sectionHeading.test(line)) break;
    if (line) lines.push(line);
  }
  return lines.slice(0, 3);
}

function sourceHeadings(payload: ApplicationDocumentPayload) {
  if (typeof payload.resume?.rawText !== "string") return [];
  return [...new Set(payload.resume.rawText.split(/\r?\n/u)
    .map((line) => line.trim().toLocaleUpperCase())
    .filter((line) => sectionHeading.test(line))
    .map((line) => line === "ADDITIONAL" ? "ADDITIONAL INFORMATION" : line))];
}

function isStructuralCoverParagraph(payload: ApplicationDocumentPayload, paragraph: string) {
  const headerLines = new Set(sourceHeaderLines(payload).map(comparable));
  const lines = paragraph.split(/\r?\n/u).map(comparable).filter(Boolean);
  if (!lines.length) return true;
  if (lines.every((line) => headerLines.has(line))) return true;
  if (/^dear\b/iu.test(lines[0] ?? "")) return true;
  if (/^(?:sincerely|best|best regards|regards|thank you),?$/iu.test(lines[0] ?? "") &&
    lines.slice(1).every((line) => headerLines.has(line))) return true;
  return false;
}

export function validateTailoredResumeQuality<T extends ResumeQualityOutput>(
  payload: ApplicationDocumentPayload,
  output: T
) {
  const text = comparable(output.resumeText);
  const facts = buildApplicationDocumentFactCatalog(payload);
  const catalogRefs = new Set(facts.map((fact) => fact.ref));
  for (const [index, headerLine] of sourceHeaderLines(payload).entries()) {
    if (!text.includes(comparable(headerLine))) {
      incomplete(`resume.rawText.header[${index}]`, "Tailored resume omitted source identity or contact context.");
    }
  }

  const outputHeadings = new Set(output.resumeText.split(/\r?\n/u)
    .map((line) => line.trim().toLocaleUpperCase())
    .filter((line) => sectionHeading.test(line))
    .map((line) => line === "ADDITIONAL" ? "ADDITIONAL INFORMATION" : line));
  for (const heading of sourceHeadings(payload)) {
    const accepted = heading === "SUMMARY"
      ? outputHeadings.has("SUMMARY") || outputHeadings.has("PROFILE")
      : heading === "EXPERIENCE"
        ? outputHeadings.has("EXPERIENCE") || outputHeadings.has("WORK EXPERIENCE")
        : outputHeadings.has(heading);
    if (!accepted) incomplete("resumeText", `Tailored resume omitted the ${heading} source section.`);
  }

  const coveredRefs = claimRefsPresentInText(output.resumeText, output.claimEvidence);
  if (typeof payload.resume?.summary === "string" && payload.resume.summary.trim() &&
    !coveredRefs.has("resume.summary")) {
    incomplete("resume.summary", "Tailored resume omitted the source summary.");
  }
  for (const ref of [...requiredIndexedRefs(payload, catalogRefs), ...requiredReviewedRefs(payload, catalogRefs)]) {
    if (!coveredRefs.has(ref)) {
      incomplete(ref, "Tailored resume omitted an available source record.");
    }
  }
  for (const fact of facts) {
    if (!factAppearsInTextOrEvidence(output.resumeText, output.claimEvidence, fact)) {
      incomplete(fact.ref, "Tailored resume omitted an available source fact.");
    }
  }
  return output;
}

function referenceFamily(ref: string) {
  return ref.replace(/\[\d+\](?:\.fact)?$/u, "");
}

export function validateCoverLetterQuality<T extends CoverLetterQualityOutput>(
  payload: ApplicationDocumentPayload,
  output: T
) {
  const facts = buildApplicationDocumentFactCatalog(payload);
  const paragraphs = output.coverLetter.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean);
  if (paragraphs.length < 4) incomplete("coverLetter", "Cover letter is missing a complete letter structure.");
  const substantiveParagraphs = paragraphs.filter((paragraph) => !isStructuralCoverParagraph(payload, paragraph));
  const substantiveClaims = output.claimsUsed.filter((entry) =>
    substantiveParagraphs.some((paragraph) => containsComparable(paragraph, entry.claim))
  );
  const headerFacts = new Set(sourceHeaderLines(payload).map(comparable));
  const availableSubstantiveFacts = facts.filter((fact) => !headerFacts.has(comparable(fact.excerpt)));
  const requiredClaimCount = Math.min(3, availableSubstantiveFacts.length);
  const distinctClaims = new Set(substantiveClaims.map((entry) => comparable(entry.claim)));
  if (distinctClaims.size < requiredClaimCount) {
    incomplete("claimsUsed", "Cover letter does not use enough distinct available applicant evidence.");
  }

  const coveredRefs = claimRefsPresentInText(output.coverLetter, output.claimsUsed);
  const catalogRefs = new Set(facts.map((fact) => fact.ref));
  for (const ref of requiredReviewedRefs(payload, catalogRefs)) {
    if (!coveredRefs.has(ref)) incomplete(ref, "Cover letter omitted current reviewed evidence.");
  }

  const availableFamilies = new Set(availableSubstantiveFacts.map((fact) => referenceFamily(fact.ref)));
  const usedFamilies = new Set(substantiveClaims.flatMap((entry) =>
    entry.citations.map((citation) => referenceFamily(citation.ref))
  ));
  if (availableFamilies.size >= 2 && usedFamilies.size < 2) {
    incomplete("claimsUsed", "Cover letter evidence is not varied across the available source context.");
  }

  const evidenceParagraphs = substantiveParagraphs.filter((paragraph) =>
    substantiveClaims.some((entry) => containsComparable(paragraph, entry.claim))
  );
  if (evidenceParagraphs.length < Math.min(2, requiredClaimCount)) {
    incomplete("coverLetter", "Cover letter must organize evidence into more than one substantive paragraph.");
  }
  for (const [field, label] of [["company", "company"], ["title", "role"]] as const) {
    const value = payload.job?.[field];
    if (typeof value === "string" && value.trim() && !comparable(output.coverLetter).includes(comparable(value))) {
      incomplete("coverLetter", `Cover letter omitted the target ${label}.`);
    }
  }
  return output;
}
