import type {
  ParsedResumeV7,
  ParsedResumeV8,
  ParsedResumeV9,
  ResumeParseProviderV7,
  ResumeParseProviderV8,
  ResumeParseProviderV9,
  ResumeSourceSection
} from "@/lib/ai/resume";
import {
  buildResumeSourceCatalog,
  buildResumeSourceCatalogV9,
  type ResumeSourceCatalog,
  type ResumeSourceCatalogRecord,
  type ResumeSourceSectionName
} from "@/lib/ai/resume-source-catalog";
import { PublicApiError } from "@/lib/api-errors";

const structuralSections = [
  "workHistory",
  "projects",
  "education",
  "certifications"
] as const satisfies readonly ResumeSourceSectionName[];

type StructuralSection = typeof structuralSections[number];
type RecordProjection = { recordId: string };

function fail(
  message: string,
  code: "RESUME_PARSE_INCOMPLETE" | "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
  section: ResumeSourceSectionName,
  fieldPath: string,
  structureReason: string
): never {
  throw new PublicApiError(`${message} No master resume was changed.`, 422, {
    code,
    section,
    fieldPath,
    structureReason,
    retryable: false
  });
}

function recordsFor(catalog: ResumeSourceCatalog, section: StructuralSection) {
  return catalog.sections
    .filter((item) => item.section === section)
    .flatMap((item) => item.records);
}

function assertExactRecordReferences(
  section: StructuralSection,
  expected: ResumeSourceCatalogRecord[],
  actual: RecordProjection[]
) {
  if (actual.length !== expected.length) {
    fail(
      `Resume parsing returned ${actual.length} ${section} records for ${expected.length} server-owned blocks.`,
      actual.length < expected.length
        ? "RESUME_PARSE_INCOMPLETE"
        : "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      section,
      section,
      actual.length < expected.length ? "record_projection_omitted" : "record_projection_invented"
    );
  }
  actual.forEach((record, index) => {
    const expectedId = expected[index]!.id;
    if (record.recordId !== expectedId) {
      fail(
        "Resume parsing returned an unknown, duplicated, or reordered server-owned record reference.",
        "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
        section,
        `${section}[${index}].recordId`,
        expected.some((item) => item.id === record.recordId)
          ? "record_reference_reordered"
          : "record_reference_unknown"
      );
    }
  });
}

function sourceSections(catalog: ResumeSourceCatalog): ResumeSourceSection[] {
  return catalog.sections.map((section) => ({
    section: section.section,
    heading: section.heading,
    sourceText: section.sourceText,
    recordBlocks: section.recordBlocks
  }));
}

function sourceRecord<T extends RecordProjection>(
  record: T,
  source: ResumeSourceCatalogRecord
) {
  const projection: Partial<T> = { ...record };
  delete projection.recordId;
  return { sourceText: source.sourceText, ...projection } as
    { sourceText: string } & Omit<T, "recordId">;
}

export function assembleParsedResumeFromRecords(
  rawSource: string,
  output: ResumeParseProviderV7
): ParsedResumeV7 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const expected = {
    workHistory: recordsFor(catalog, "workHistory"),
    projects: recordsFor(catalog, "projects"),
    education: recordsFor(catalog, "education"),
    certifications: recordsFor(catalog, "certifications")
  };

  for (const section of structuralSections) {
    assertExactRecordReferences(section, expected[section], output[section]);
  }

  const contactSections = catalog.sections.filter((section) => section.section === "contactInfo");
  if (contactSections.length !== 1) {
    fail(
      "Resume parsing could not bind one complete contact/header block.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      "contactInfo",
      "contactInfo.sourceText",
      "contact_block_cardinality"
    );
  }

  return {
    contractVersion: "7",
    sourceSections: sourceSections(catalog),
    contactInfo: {
      sourceText: contactSections[0]!.sourceText,
      ...output.contactInfo
    },
    summary: output.summary,
    skills: output.skills,
    workHistory: output.workHistory.map((record, index) =>
      sourceRecord(record, expected.workHistory[index]!)),
    projects: output.projects.map((record, index) =>
      sourceRecord(record, expected.projects[index]!)),
    education: output.education.map((record, index) =>
      sourceRecord(record, expected.education[index]!)),
    certifications: output.certifications.map((record, index) =>
      sourceRecord(record, expected.certifications[index]!)),
    achievements: output.achievements,
    sectionStatus: output.sectionStatus,
    warnings: output.warnings
  };
}

export function assembleParsedResumeV8FromRecords(
  rawSource: string,
  output: ResumeParseProviderV8
): ParsedResumeV8 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const expected = {
    workHistory: recordsFor(catalog, "workHistory"),
    projects: recordsFor(catalog, "projects"),
    education: recordsFor(catalog, "education"),
    certifications: recordsFor(catalog, "certifications")
  };

  for (const section of structuralSections) {
    assertExactRecordReferences(section, expected[section], output[section]);
  }

  const contactSections = catalog.sections.filter((section) => section.section === "contactInfo");
  if (contactSections.length !== 1) {
    fail(
      "Resume parsing could not bind one complete contact/header block.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      "contactInfo",
      "contactInfo.sourceText",
      "contact_block_cardinality"
    );
  }

  const hasSection = (section: ResumeSourceSectionName) =>
    catalog.sections.some((item) => item.section === section);
  const status = (section: "summary" | "skills" | StructuralSection | "achievements") =>
    hasSection(section) ? "present" as const : "absent" as const;

  return {
    contractVersion: "8",
    sourceSections: sourceSections(catalog),
    contactInfo: {
      sourceText: contactSections[0]!.sourceText,
      ...output.contactInfo
    },
    summary: catalog.sections
      .filter((section) => section.section === "summary")
      .map((section) => section.sourceText)
      .join("\n"),
    skills: output.skills,
    workHistory: output.workHistory.map((record, index) =>
      sourceRecord(record, expected.workHistory[index]!)),
    projects: output.projects.map((record, index) =>
      sourceRecord(record, expected.projects[index]!)),
    education: output.education.map((record, index) =>
      sourceRecord(record, expected.education[index]!)),
    certifications: output.certifications.map((record, index) =>
      sourceRecord(record, expected.certifications[index]!)),
    achievements: catalog.sections
      .filter((section) => section.section === "achievements")
      .flatMap((section) => section.recordBlocks),
    sectionStatus: {
      summary: status("summary"),
      skills: status("skills"),
      workHistory: status("workHistory"),
      projects: status("projects"),
      education: status("education"),
      certifications: status("certifications"),
      achievements: status("achievements")
    },
    warnings: output.warnings
  };
}

export function assembleParsedResumeV9FromRecords(
  rawSource: string,
  output: ResumeParseProviderV9
): ParsedResumeV9 {
  const catalog = buildResumeSourceCatalogV9(rawSource);
  const expected = {
    workHistory: recordsFor(catalog, "workHistory"),
    projects: recordsFor(catalog, "projects"),
    education: recordsFor(catalog, "education"),
    certifications: recordsFor(catalog, "certifications")
  };

  for (const section of structuralSections) {
    assertExactRecordReferences(section, expected[section], output[section]);
  }

  const contactSections = catalog.sections.filter((section) => section.section === "contactInfo");
  if (contactSections.length !== 1) {
    fail(
      "Resume parsing could not bind one complete contact/header block.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      "contactInfo",
      "contactInfo.sourceText",
      "contact_block_cardinality"
    );
  }

  const hasSection = (section: ResumeSourceSectionName) =>
    catalog.sections.some((item) => item.section === section);
  const status = (section: "summary" | "skills" | StructuralSection | "achievements") =>
    hasSection(section) ? "present" as const : "absent" as const;

  return {
    contractVersion: "9",
    sourceSections: sourceSections(catalog),
    contactInfo: {
      sourceText: contactSections[0]!.sourceText,
      ...output.contactInfo
    },
    summary: catalog.sections
      .filter((section) => section.section === "summary")
      .map((section) => section.sourceText)
      .join("\n"),
    skills: output.skills,
    workHistory: output.workHistory.map((record, index) =>
      sourceRecord(record, expected.workHistory[index]!)),
    projects: output.projects.map((record, index) =>
      sourceRecord(record, expected.projects[index]!)),
    education: output.education.map((record, index) =>
      sourceRecord(record, expected.education[index]!)),
    certifications: output.certifications.map((record, index) =>
      sourceRecord(record, expected.certifications[index]!)),
    achievements: catalog.sections
      .filter((section) => section.section === "achievements")
      .flatMap((section) => section.recordBlocks),
    sectionStatus: {
      summary: status("summary"),
      skills: status("skills"),
      workHistory: status("workHistory"),
      projects: status("projects"),
      education: status("education"),
      certifications: status("certifications"),
      achievements: status("achievements")
    },
    warnings: output.warnings
  };
}
