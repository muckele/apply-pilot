export function buildResumeTailoringPayload(
  job: unknown,
  resume: unknown,
  profile: unknown
) {
  const pick = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(keys.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []));
  };

  return {
    job: pick(job, [
      "title", "company", "location", "remoteStatus", "salaryMin", "salaryMax",
      "description", "requirements", "preferredQualifications", "detectedTechStack"
    ]),
    resume: pick(resume, [
      "rawText", "summary", "skills", "achievements", "workHistory", "projects",
      "education", "certifications"
    ]),
    profile: pick(profile, [
      "careerGoals", "preferredRoles", "preferredLocations", "remotePreference",
      "salaryTargetMin", "salaryTargetMax", "skillsToEmphasize", "skillsNotToExaggerate"
    ])
  };
}
