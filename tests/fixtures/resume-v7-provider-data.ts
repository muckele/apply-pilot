import type { ParsedResumeV5, ResumeParseProviderV7 } from "@/lib/ai/resume";
import {
  buildResumeSourceCatalog,
  type ResumeSourceSectionName
} from "@/lib/ai/resume-source-catalog";

const structuralSections = [
  "workHistory",
  "projects",
  "education",
  "certifications"
] as const satisfies readonly ResumeSourceSectionName[];

export function providerV7FromCanonical(
  rawSource: string,
  parsed: ParsedResumeV5
): ResumeParseProviderV7 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const recordIds = new Map(structuralSections.map((section) => [
    section,
    catalog.sections
      .filter((item) => item.section === section)
      .flatMap((item) => item.records.map((record) => record.id))
  ]));
  const nextId = (section: typeof structuralSections[number]) => {
    const ids = recordIds.get(section) ?? [];
    let cursor = 0;
    return () => ids[cursor++]!;
  };
  const workId = nextId("workHistory");
  const projectId = nextId("projects");
  const educationId = nextId("education");
  const certificationId = nextId("certifications");
  const project = <T extends { sourceText: string }>(record: T, recordId: string) => {
    const fields: Partial<T> = { ...record };
    delete fields.sourceText;
    return { recordId, ...fields } as { recordId: string } & Omit<T, "sourceText">;
  };

  return {
    contractVersion: "7",
    contactInfo: {
      name: parsed.contactInfo.name,
      headline: parsed.contactInfo.headline,
      email: parsed.contactInfo.email,
      phone: parsed.contactInfo.phone,
      location: parsed.contactInfo.location,
      linkedin: parsed.contactInfo.linkedin,
      github: parsed.contactInfo.github,
      portfolio: parsed.contactInfo.portfolio
    },
    summary: parsed.summary,
    skills: parsed.skills,
    workHistory: parsed.workHistory.map((record) => project(record, workId())),
    projects: parsed.projects.map((record) => project(record, projectId())),
    education: parsed.education.map((record) => project(record, educationId())),
    certifications: parsed.certifications.map((record) => project(record, certificationId())),
    achievements: parsed.achievements,
    sectionStatus: parsed.sectionStatus,
    warnings: parsed.warnings
  };
}
