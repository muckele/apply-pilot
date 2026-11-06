// The résumé parser's section-heading vocabulary. It lives apart from the source catalog so the
// product document layout (also drawn by the in-browser preview) can share it without loading the
// whole parser.

export type ResumeSourceSectionName =
  | "contactInfo"
  | "summary"
  | "skills"
  | "workHistory"
  | "projects"
  | "education"
  | "certifications"
  | "achievements"
  | "additional";

export type ResumeTypedSectionName = Exclude<
  ResumeSourceSectionName,
  "contactInfo" | "additional"
>;

export const resumeSectionHeadings: Record<ResumeTypedSectionName, RegExp> = {
  summary: /^(?:(?:PROFESSIONAL\s+|CAREER\s+)?(?:SUMMARY|PROFILE)|OBJECTIVE|ABOUT\s+ME)$/i,
  skills: /^(?:(?:(?:TECHNICAL|KEY|CORE)\s+)?SKILLS(?:\s+(?:AND|&)\s+TOOLS)?|CORE\s+COMPETENCIES)$/i,
  workHistory: /^(?:WORK|PROFESSIONAL|EMPLOYMENT|CAREER)?\s*(?:EXPERIENCE|HISTORY)$/i,
  projects: /^(?:(?:SELECTED|PROFESSIONAL|TECHNICAL|PERSONAL|SIDE|KEY|INDEPENDENT|ACADEMIC|RELEVANT)(?:\s+TECHNICAL)?\s+)?PROJECTS?$/i,
  education: /^(?:EDUCATION|ACADEMIC\s+(?:BACKGROUND|HISTORY))$/i,
  certifications: /^(?:CERTIFICATIONS?|LICENSES?|CERTIFICATIONS?\s+(?:AND|&)\s+LICENSES?)$/i,
  achievements: /^(?:(?:KEY|SELECTED|CAREER|NOTABLE|PROFESSIONAL)\s+)?(?:ACHIEVEMENTS?|ACCOMPLISHMENTS?|HIGHLIGHTS|AWARDS?|HONORS?)$/i
};

const otherSectionHeading = /^(?:CONTACT|LANGUAGES?|INTERESTS?|VOLUNTEER(?:ING|\s+EXPERIENCE)?|COMMUNITY\s+(?:INVOLVEMENT|SERVICE)|LEADERSHIP|PROFESSIONAL\s+(?:DEVELOPMENT|AFFILIATIONS?|MEMBERSHIPS?)|TRAINING|COURSES?|COURSEWORK|ACTIVITIES|PUBLICATIONS?|PATENTS?|PRESENTATIONS?|CONFERENCES?|REFERENCES?|ADDITIONAL\s+(?:EXPERIENCE|INFORMATION)|OTHER)$/i;

export function resumeSectionForHeading(line: string): ResumeTypedSectionName | null {
  const heading = line.trim().replace(/:$/, "");
  for (const [section, pattern] of Object.entries(resumeSectionHeadings)) {
    if (pattern.test(heading)) return section as ResumeTypedSectionName;
  }
  return null;
}

export function resumeSourceSectionForHeading(line: string): ResumeSourceSectionName | null {
  const recognized = resumeSectionForHeading(line);
  if (recognized) return recognized;
  const heading = line.trim().replace(/:$/, "");
  if (/^CONTACT$/i.test(heading)) return "contactInfo";
  return otherSectionHeading.test(heading) ? "additional" : null;
}
