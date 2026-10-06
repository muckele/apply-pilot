import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";

export function buildApplicationDocumentPayload(
  job: unknown,
  resume: unknown,
  profile: unknown
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

  return {
    job: pick(job, [
      "title", "company", "location", "remoteStatus", "salaryMin", "salaryMax",
      "description", "requirements", "preferredQualifications", "detectedTechStack"
    ]),
    resume: projectedResume,
    profile: pick(profile, [
      "careerGoals", "preferredRoles", "preferredLocations", "remotePreference",
      "salaryTargetMin", "salaryTargetMax", "skillsToEmphasize", "skillsNotToExaggerate"
    ])
  };
}

// Compatibility name for callers that have not yet moved to the shared
// application-document projection.
export const buildResumeTailoringPayload = buildApplicationDocumentPayload;
