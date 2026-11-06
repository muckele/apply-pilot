import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";

// PDF text extraction can glue a bullet glyph to its text ("•Started in sales"). Every résumé check
// recognizes a list marker only when a space follows, so a glued glyph made each bullet a second,
// required source line beside the parsed bullet (live case 2026-11-06). Lines starting with •, ▪ or
// ◦ get that space back; nothing else changes, and "-" or "*" without a space are left alone.
export function spaceGluedBulletMarkers(value: string) {
  return value.replace(/^([ \t]*[•▪◦]+)(?=[^\s•▪◦])/gmu, "$1 ");
}

function spaceGluedBulletsDeep<T>(value: T): T {
  if (typeof value === "string") return spaceGluedBulletMarkers(value) as T;
  if (Array.isArray(value)) return value.map(spaceGluedBulletsDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, spaceGluedBulletsDeep(item)])) as T;
  }
  return value;
}

export function buildApplicationDocumentPayload(
  job: unknown,
  resume: unknown,
  profile: unknown,
  reviewedEvidence: unknown = null,
  protectedEvidence: unknown = null
): ApplicationDocumentPayload {
  const pick = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(keys.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []));
  };
  const strings = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const pickRecords = (value: unknown, keys: string[], arrayKeys: string[]) => Array.isArray(value)
    ? value.flatMap((item) => {
        const projected = pick(item, keys);
        if (!projected) return [];
        for (const key of keys) {
          if (arrayKeys.includes(key)) projected[key] = strings(projected[key]);
          else if (projected[key] !== null && typeof projected[key] !== "string") delete projected[key];
        }
        return [projected];
      })
    : [];

  const projectedResume = pick(resume, [
    "rawText", "summary", "skills", "achievements"
  ]);
  if (projectedResume) {
    const source = resume as Record<string, unknown>;
    projectedResume.skills = strings(projectedResume.skills);
    projectedResume.achievements = strings(projectedResume.achievements);
    if (projectedResume.rawText !== null && typeof projectedResume.rawText !== "string") delete projectedResume.rawText;
    if (projectedResume.summary !== null && typeof projectedResume.summary !== "string") delete projectedResume.summary;
    projectedResume.workHistory = pickRecords(source.workHistory, [
      "sourceText", "company", "title", "location", "startDate", "endDate", "bullets"
    ], ["bullets"]);
    projectedResume.projects = pickRecords(source.projects, [
      "sourceText", "name", "description", "date", "technologies", "bullets"
    ], ["technologies", "bullets"]);
    projectedResume.education = pickRecords(source.education, [
      "sourceText", "institution", "credential", "fieldOfStudy", "startDate", "endDate", "details"
    ], ["details"]);
    projectedResume.certifications = pickRecords(source.certifications, [
      "sourceText", "name", "issuer", "date", "expirationDate", "details"
    ], ["details"]);
  }

  const projectedEvidence = pick(reviewedEvidence, ["schema", "snapshotId", "snapshotHash", "unresolvedGapIds"]);
  if (projectedEvidence) {
    const source = reviewedEvidence as Record<string, unknown>;
    projectedEvidence.unresolvedGapIds = strings(projectedEvidence.unresolvedGapIds);
    projectedEvidence.facts = pickRecords(source.facts, [
      "gapId", "fact", "provenance", "sourceRef"
    ], []);
  }

  const payload: ApplicationDocumentPayload = {
    job: pick(job, [
      "title", "company", "location", "remoteStatus", "salaryMin", "salaryMax",
      "description", "requirements", "preferredQualifications", "detectedTechStack"
    ]),
    resume: projectedResume ? spaceGluedBulletsDeep(projectedResume) : projectedResume,
    profile: pick(profile, [
      "careerGoals", "preferredRoles", "preferredLocations", "remotePreference",
      "salaryTargetMin", "salaryTargetMax", "skillsToEmphasize", "skillsNotToExaggerate"
    ]),
    reviewedEvidence: projectedEvidence
  };
  // Only tailoring passes match protection; other documents keep their previous payload shape.
  const protectedCitations = pick(protectedEvidence, ["citations"]);
  if (protectedCitations) {
    payload.protectedEvidence = {
      citations: protectedResumeCitations(protectedCitations.citations)
        .map((citation) => ({ ...citation, excerpt: spaceGluedBulletMarkers(citation.excerpt) }))
    };
  }
  return payload;
}

// Résumé items cited as applicant evidence by the job match. Owner-attested facts and job
// references are never protected: they stay optional for tailoring.
export function protectedResumeCitations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { ref, excerpt } = item as Record<string, unknown>;
    if (typeof ref !== "string" || typeof excerpt !== "string" || !ref.startsWith("resume.") || !excerpt.trim()) return [];
    const key = `${ref}\u0000${excerpt}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ref, excerpt }];
  });
}

// Compatibility name for callers that have not yet moved to the shared
// application-document projection.
export const buildResumeTailoringPayload = buildApplicationDocumentPayload;
