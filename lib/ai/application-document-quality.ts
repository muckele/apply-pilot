import { PublicApiError } from "@/lib/api-errors";
import { validateCoverLetterWriting, validateResumePriorityOrder } from "@/lib/ai/application-document-writing-quality";
import {
  buildApplicationDocumentFactCatalog,
  isApplicationDocumentSectionHeading
} from "@/lib/ai/application-document-facts";
import {
  assertTailoredResumeKeepRule,
  carryTailoredResumeReversions,
  completeSplitFactParts,
  completeTailoredResume,
  containsComparableText as containsComparable,
  revertUnverifiedResumeLines
} from "@/lib/ai/tailored-resume-keep-rule";
import {
  coverLetterRemovals,
  repairCoverLetterEvidence,
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  withCoverLetterRemovals,
  type ApplicationDocumentClaimEvidence,
  type ApplicationDocumentPayload,
  type TailoredResumeClaimsOutput
} from "@/lib/ai/application-document-claims";
import { arrangeCoverLetterByRecord } from "@/lib/ai/cover-letter-arrangement";
import { leadLineOccurrences, placeLeadLines } from "@/lib/ai/cover-letter-lead-lines";

type ResumeQualityOutput = {
  resumeText: string;
  claimEvidence: ApplicationDocumentClaimEvidence[];
};

type CoverLetterQualityOutput = {
  coverLetter: string;
  claimsUsed: ApplicationDocumentClaimEvidence[];
};


function comparable(value: string) {
  return value.trim().replace(/^[-*•▪◦–—]\s+/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
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
    if (isApplicationDocumentSectionHeading(line)) break;
    if (line) lines.push(line);
  }
  return lines.slice(0, 3);
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

// Applies the owner-approved keep rule (lib/ai/tailored-resume-keep-rule.ts): omitted required,
// match-protected or below-floor items are restored verbatim from the master résumé (with exact
// claim evidence that passes the unchanged truth checks) instead of rejecting a paid result.
// Trimmed skills, achievements, projects, bullets and owner-attested facts are accepted. Returns
// the same object when nothing needed restoring.
// The whole tailored-résumé check, as tailorResume runs it: lines whose wording fails the truth
// check are reverted to source wording, then the unchanged truth checks, the keep rule and the
// truth checks again run on the completed résumé before it is cached or saved.
export function finalizeTailoredResume<T extends TailoredResumeClaimsOutput>(
  payload: ApplicationDocumentPayload,
  output: T
): T {
  const reverted = completeSplitFactParts(payload, revertUnverifiedResumeLines(payload, output));
  const final = validateTailoredResumeClaims(
    payload,
    validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, reverted))
  );
  return carryTailoredResumeReversions(reverted, final);
}

export function validateTailoredResumeQuality<T extends ResumeQualityOutput>(
  payload: ApplicationDocumentPayload,
  output: T
) {
  const completed = completeTailoredResume(payload, output);
  assertTailoredResumeKeepRule(payload, completed);
  validateResumePriorityOrder(payload, completed.resumeText, completed.claimEvidence);
  return completed;
}

function referenceFamily(ref: string) {
  return ref.replace(/\[\d+\](?:\.fact)?$/u, "");
}

export { coverLetterRemovals, type CoverLetterRemoval } from "@/lib/ai/application-document-claims";

// The whole cover-letter check, as draftCoverLetter runs it: unsupported or unverified sentences
// are removed (repairCoverLetterEvidence), the evidence is grouped by employer
// (arrangeCoverLetterByRecord, which only reorders sentences), each paragraph whose evidence all
// cites one work record opens with that record's lead line (D033; placeLeadLines), then the truth
// and structure checks run on the result before it is cached or saved. When the grouped letter
// fails a check, the letter in Gemini's order is checked instead, so grouping never costs a
// letter that would otherwise pass.
export function finalizeCoverLetter<T extends CoverLetterQualityOutput>(
  payload: ApplicationDocumentPayload,
  output: T
): T {
  const value = repairCoverLetterEvidence(payload, output);
  const arranged = arrangeCoverLetterByRecord(payload, value);
  const candidates = arranged === value ? [value] : [arranged, value];
  for (const [index, candidate] of candidates.entries()) {
    const coverLetter = placeLeadLines(payload, candidate.coverLetter, candidate.claimsUsed);
    const placed = coverLetter === candidate.coverLetter ? candidate : { ...candidate, coverLetter };
    try {
      const checked = validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, placed));
      // A lead line Gemini wrote that no longer stands anywhere (grouping or placement took it out).
      const kept = leadLineOccurrences(payload, checked.coverLetter);
      const removed = leadLineOccurrences(payload, value.coverLetter).filter((line) => {
        const at = kept.indexOf(line);
        if (at < 0) return true;
        kept.splice(at, 1);
        return false;
      });
      return withCoverLetterRemovals(checked, [
        ...coverLetterRemovals(value),
        ...removed.map((text) => ({ text, reason: "misplaced_lead_line" }))
      ]);
    } catch (error) {
      if (!(error instanceof PublicApiError) || index === candidates.length - 1) throw error;
    }
  }
  throw new Error("unreachable");
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
  validateCoverLetterWriting(substantiveParagraphs, substantiveClaims);
  return output;
}
