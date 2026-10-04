import type {
  ParsedResumeV6,
  ResumeParseProviderV6,
  ResumeParseRecordSpanV6,
  ResumeSourceSection
} from "@/lib/ai/resume";
import {
  buildResumeSourceCatalog,
  type ResumeSourceCatalog,
  type ResumeSourceCatalogSection,
  type ResumeSourceSectionName
} from "@/lib/ai/resume-source-catalog";
import { PublicApiError } from "@/lib/api-errors";

const structuralSections = new Set<ResumeSourceSectionName>([
  "workHistory",
  "projects",
  "education",
  "certifications"
]);

type ResolvedSpan = {
  section: ResumeSourceCatalogSection;
  sectionIndex: number;
  startLineIndex: number;
  endLineIndex: number;
  sourceText: string;
};

function fail(
  message: string,
  code: "RESUME_PARSE_INCOMPLETE" | "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
  fieldPath: string,
  section?: ResumeSourceSectionName
): never {
  throw new PublicApiError(`${message} No master resume was changed.`, 422, {
    code,
    ...(section ? { section } : {}),
    fieldPath,
    retryable: false
  });
}

function resolveSpan(
  catalog: ResumeSourceCatalog,
  span: ResumeParseRecordSpanV6,
  spanIndex: number
): ResolvedSpan {
  const fieldPath = `recordSpans[${spanIndex}]`;
  const sectionIndex = catalog.sections.findIndex((section) => section.id === span.sectionId);
  const section = catalog.sections[sectionIndex];
  if (!section || !structuralSections.has(section.section)) {
    fail("Resume parsing referenced an unknown or non-structural source section.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath);
  }
  const startLineIndex = section.lines.findIndex((line) => line.id === span.startLineId);
  const endLineIndex = section.lines.findIndex((line) => line.id === span.endLineId);
  if (startLineIndex < 0 || endLineIndex < 0) {
    fail("Resume parsing referenced an unknown or cross-section source line.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath, section.section);
  }
  if (startLineIndex > endLineIndex) {
    fail("Resume parsing returned a reversed source span.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath, section.section);
  }
  if (
    !section.lines[startLineIndex]!.sourceText.trim() ||
    !section.lines[endLineIndex]!.sourceText.trim()
  ) {
    fail("Resume parsing used a blank line as a structural span boundary.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath, section.section);
  }
  const startOffset = section.lines[startLineIndex]!.startOffset;
  const endOffset = section.lines[endLineIndex]!.endOffset;
  return {
    section,
    sectionIndex,
    startLineIndex,
    endLineIndex,
    sourceText: catalog.normalizedSource.slice(startOffset, endOffset)
  };
}

function compareSpanPosition(left: ResolvedSpan, right: ResolvedSpan) {
  return left.sectionIndex - right.sectionIndex ||
    left.startLineIndex - right.startLineIndex ||
    left.endLineIndex - right.endLineIndex;
}

function assertOrderedExactCoverage(catalog: ResumeSourceCatalog, spans: ResolvedSpan[]) {
  spans.forEach((span, index) => {
    const previous = spans[index - 1];
    if (previous && compareSpanPosition(previous, span) >= 0) {
      fail("Resume parsing reordered or duplicated structural source spans.",
        "RESUME_PARSE_STRUCTURE_AMBIGUOUS", `recordSpans[${index}]`, span.section.section);
    }
    if (
      previous &&
      previous.section.id === span.section.id &&
      span.startLineIndex <= previous.endLineIndex
    ) {
      fail("Resume parsing returned overlapping structural source spans.",
        "RESUME_PARSE_STRUCTURE_AMBIGUOUS", `recordSpans[${index}]`, span.section.section);
    }
  });

  for (const section of catalog.sections.filter((item) => structuralSections.has(item.section))) {
    const coverage = section.lines.map(() => false);
    spans.filter((span) => span.section.id === section.id).forEach((span) => {
      for (let index = span.startLineIndex; index <= span.endLineIndex; index += 1) {
        if (coverage[index]) {
          fail("Resume parsing returned overlapping structural source spans.",
            "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "recordSpans", section.section);
        }
        coverage[index] = true;
      }
    });
    const uncovered = section.lines.findIndex((line, index) =>
      Boolean(line.sourceText.trim()) && !coverage[index]
    );
    if (uncovered >= 0) {
      fail("Resume parsing omitted a structural source line.",
        "RESUME_PARSE_INCOMPLETE", `${section.id}.lines[${uncovered}]`, section.section);
    }
  }
}

type StructuralRecord = { spanIndex: number };

function assertSpanCardinality(output: ResumeParseProviderV6, spans: ResolvedSpan[]) {
  const groups: Array<[ResumeSourceSectionName, StructuralRecord[]]> = [
    ["workHistory", output.workHistory],
    ["projects", output.projects],
    ["education", output.education],
    ["certifications", output.certifications]
  ];
  const used = new Set<number>();
  for (const [section, records] of groups) {
    let previousSpanIndex = -1;
    for (const [recordIndex, record] of records.entries()) {
      const fieldPath = `${section}[${recordIndex}].spanIndex`;
      const span = spans[record.spanIndex];
      if (!span || span.section.section !== section) {
        fail("Resume parsing linked a typed record to the wrong source span.",
          "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath, section);
      }
      if (used.has(record.spanIndex) || record.spanIndex <= previousSpanIndex) {
        fail("Resume parsing duplicated or reordered a typed source span.",
          "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath, section);
      }
      used.add(record.spanIndex);
      previousSpanIndex = record.spanIndex;
    }
  }
  if (used.size !== spans.length) {
    fail("Resume parsing omitted or invented a structural typed record.",
      "RESUME_PARSE_INCOMPLETE", "recordSpans");
  }
}

function sourceSections(catalog: ResumeSourceCatalog, spans: ResolvedSpan[]): ResumeSourceSection[] {
  return catalog.sections.map((section) => ({
    section: section.section,
    heading: section.heading,
    sourceText: section.sourceText,
    recordBlocks: structuralSections.has(section.section)
      ? spans.filter((span) => span.section.id === section.id).map((span) => span.sourceText)
      : section.recordBlocks
  }));
}

function sourceForSpan(spans: ResolvedSpan[], spanIndex: number) {
  const span = spans[spanIndex];
  if (!span) {
    fail("Resume parsing referenced a missing structural source span.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "spanIndex");
  }
  return span.sourceText;
}

export function assembleParsedResumeFromSpans(
  rawSource: string,
  output: ResumeParseProviderV6
): ParsedResumeV6 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const spans = output.recordSpans.map((span, index) => resolveSpan(catalog, span, index));
  assertOrderedExactCoverage(catalog, spans);
  assertSpanCardinality(output, spans);
  const contactSections = catalog.sections.filter((section) => section.section === "contactInfo");
  if (contactSections.length !== 1) {
    fail("Resume parsing could not bind one complete contact/header block.",
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "contactInfo.sourceText", "contactInfo");
  }

  return {
    contractVersion: "6",
    sourceSections: sourceSections(catalog, spans),
    contactInfo: {
      sourceText: contactSections[0]!.sourceText,
      ...output.contactInfo
    },
    summary: output.summary,
    skills: output.skills,
    workHistory: output.workHistory.map(({ spanIndex, ...record }) => ({
      sourceText: sourceForSpan(spans, spanIndex),
      ...record
    })),
    projects: output.projects.map(({ spanIndex, ...record }) => ({
      sourceText: sourceForSpan(spans, spanIndex),
      ...record
    })),
    education: output.education.map(({ spanIndex, ...record }) => ({
      sourceText: sourceForSpan(spans, spanIndex),
      ...record
    })),
    certifications: output.certifications.map(({ spanIndex, ...record }) => ({
      sourceText: sourceForSpan(spans, spanIndex),
      ...record
    })),
    achievements: output.achievements,
    sectionStatus: output.sectionStatus,
    warnings: output.warnings
  };
}
