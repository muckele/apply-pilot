import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationDocumentClaimEvidence, ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { applicationDocumentPriorityOpportunities } from "@/lib/ai/application-document-priorities";
import { applicationDocumentFactStartsWithAction } from "@/lib/ai/application-document-facts";

function comparable(value: string) { return value.trim().replace(/^[-*•▪◦–—]\s+/u, "").replace(/\s+/gu, " ").toLocaleLowerCase(); }
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
function revision(fieldPath: string, message: string): never {
  throw new PublicApiError(message, 422, { code: "APPLICATION_DOCUMENT_QUALITY_REQUIRED", fieldPath, retryable: false });
}

export function validateResumePriorityOrder(payload: ApplicationDocumentPayload, text: string, evidence: ApplicationDocumentClaimEvidence[]) {
  const lines = text.split(/\r?\n/u).map(comparable);
  const sourceBullets = (["workHistory", "projects"] as const).flatMap(field => {
    const records = payload.resume?.[field];
    return Array.isArray(records) ? records.flatMap((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const bullets = (value as Record<string, unknown>).bullets;
      return Array.isArray(bullets) ? bullets.filter((bullet): bullet is string => typeof bullet === "string")
        .map(excerpt => ({ ref: `resume.${field}[${index}]`, excerpt })) : [];
    }) : [];
  });
  const recordHeaders = (["workHistory", "projects"] as const).flatMap(field => {
    const values = payload.resume?.[field];
    return Array.isArray(values) ? values.flatMap((value, index) => value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).sourceText === "string"
      ? [{ ref: `resume.${field}[${index}]`, header: ((value as Record<string, unknown>).sourceText as string).split(/\r?\n/u)[0] }] : []) : [];
  });
  const matchesHeader = (line: string, record: { ref: string; header: string }) =>
    line === comparable(record.header) || evidence.some(entry => comparable(entry.claim) === line &&
      entry.citations.some(citation => citation.ref === record.ref && comparable(citation.excerpt) === comparable(record.header)));
  for (const opportunity of applicationDocumentPriorityOpportunities(payload)) {
    const starts = lines.flatMap((line, index) => matchesHeader(line, opportunity) ? [index] : []);
    if (starts.length !== 1) revision(opportunity.ref, "Retain exactly one owning record header for this source record.");
    const start = starts[0] + 1;
    const next = lines.findIndex((line, index) => index >= start &&
      (recordHeaders.some(record => matchesHeader(line, record)) || /^(?:summary|profile|skills|experience|work experience|projects|education|certifications|achievements|additional information)$/u.test(line)));
    const block = lines.slice(start, next < 0 ? undefined : next);
    const foreignBullet = evidence.some(entry => block.includes(comparable(entry.claim)) && entry.citations.some(citation =>
      citation.ref !== opportunity.ref && sourceBullets.some(bullet => bullet.ref === citation.ref && bullet.excerpt === citation.excerpt)));
    if (foreignBullet) revision(opportunity.ref, "Do not attribute another source record's bullet to this employer or project.");
    const emitted = opportunity.bullets.flatMap(fact => {
      const claims = evidence.filter(entry => entry.citations.some(citation => citation.ref === opportunity.ref && citation.excerpt === fact.excerpt));
      const positions = block.flatMap((line, index) => claims.some(entry => comparable(entry.claim) === line) ? [index] : []);
      return positions.length === 1 ? [{ ...fact, position: positions[0] }] : [];
    }).sort((a, b) => a.position - b.position);
    if (emitted.length !== opportunity.bullets.length) {
      revision(opportunity.ref, "Keep each complete source bullet once inside its owning record before prioritizing it.");
    }
    if (!opportunity.leadingFactIds.includes(emitted[0].factId!)) {
      revision(opportunity.ref, "Lead this record with an available fact addressing the target job priority; retain every other fact and its ownership.");
    }
  }
}

export function validateCoverLetterWriting(paragraphs: string[], evidence: ApplicationDocumentClaimEvidence[]) {
  const segments = paragraphs.map(paragraph => [...sentences.segment(paragraph)].map(({ segment }) => comparable(segment)));
  const contextCount = segments.flat().filter(sentence => /^(?:your posting highlights|the role calls for)\b/u.test(sentence)).length;
  if (contextCount > 1) revision("coverLetter", "Replace repeated requirement lead-ins with applicant evidence in connected paragraphs.");
  const selectedFacts = new Set<string>();
  for (const [index, entry] of evidence.entries()) {
    const occurrences = segments.flat().filter(sentence => sentence === comparable(entry.claim)).length;
    const source = entry.citations.map(citation => `${citation.ref}\n${comparable(citation.excerpt)}`).join("\n");
    if (occurrences > 1 || selectedFacts.has(source)) revision(`claimsUsed[${index}]`, "Do not repeat an applicant fact to fill the letter.");
    selectedFacts.add(source);
    if (entry.citations.some(citation => applicationDocumentFactStartsWithAction(citation.excerpt)) &&
      !/^i\s+/iu.test(entry.claim)) {
      revision(`claimsUsed[${index}].claim`, "Render the supported action as a complete first-person sentence, preserving its source words.");
    }
  }
  const actionEvidence = evidence.filter(entry => /^i\s+/iu.test(entry.claim) &&
    entry.citations.some(citation => !citation.ref.startsWith("reviewedEvidence.") && applicationDocumentFactStartsWithAction(citation.excerpt)));
  if (actionEvidence.length >= 4) {
    const connected = segments.filter(paragraph => actionEvidence.filter(entry => paragraph.includes(comparable(entry.claim))).length >= 2);
    if (connected.length < 2) revision("coverLetter", "Group related complete evidence sentences into connected substantive paragraphs.");
  }
}
