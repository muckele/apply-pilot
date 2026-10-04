import { PublicApiError } from "@/lib/api-errors";

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

export type ResumeSourceCatalogLine = {
  id: string;
  sourceText: string;
  startOffset: number;
  endOffset: number;
};

export type ResumeSourceCatalogSection = {
  id: string;
  section: ResumeSourceSectionName;
  heading: string | null;
  sourceText: string;
  startOffset: number;
  endOffset: number;
  lines: ResumeSourceCatalogLine[];
  recordBlocks: string[];
};

export type ResumeSourceCatalog = {
  normalizedSource: string;
  sections: ResumeSourceCatalogSection[];
};

export type ResumeProviderSourceInput = {
  sections: Array<{
    sectionId: string;
    section: ResumeSourceSectionName;
    heading: string | null;
    lines: Array<{ lineId: string; text: string }>;
  }>;
};

export const resumeSectionHeadings: Record<ResumeTypedSectionName, RegExp> = {
  summary: /^(?:(?:PROFESSIONAL\s+|CAREER\s+)?(?:SUMMARY|PROFILE)|OBJECTIVE|ABOUT\s+ME)$/i,
  skills: /^(?:(?:(?:TECHNICAL|KEY|CORE)\s+)?SKILLS(?:\s+(?:AND|&)\s+TOOLS)?|CORE\s+COMPETENCIES)$/i,
  workHistory: /^(?:WORK|PROFESSIONAL|EMPLOYMENT|CAREER)?\s*(?:EXPERIENCE|HISTORY)$/i,
  projects: /^(?:(?:SELECTED(?:\s+TECHNICAL)?|PROFESSIONAL)\s+)?PROJECTS?$/i,
  education: /^(?:EDUCATION|ACADEMIC\s+(?:BACKGROUND|HISTORY))$/i,
  certifications: /^(?:CERTIFICATIONS?|LICENSES?|CERTIFICATIONS?\s+(?:AND|&)\s+LICENSES?)$/i,
  achievements: /^(?:ACHIEVEMENTS?|ACCOMPLISHMENTS?|AWARDS?|HONORS?)$/i
};

const otherSectionHeading = /^(?:CONTACT|LANGUAGES?|INTERESTS?|VOLUNTEER(?:ING|\s+EXPERIENCE)?|COMMUNITY\s+(?:INVOLVEMENT|SERVICE)|LEADERSHIP|PROFESSIONAL\s+(?:DEVELOPMENT|AFFILIATIONS?|MEMBERSHIPS?)|TRAINING|COURSES?|COURSEWORK|ACTIVITIES|PUBLICATIONS?|PATENTS?|PRESENTATIONS?|CONFERENCES?|REFERENCES?|ADDITIONAL\s+(?:EXPERIENCE|INFORMATION)|OTHER)$/i;

export function normalizeResumeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

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

export function hasResumeSectionHeading(source: string, section: ResumeTypedSectionName) {
  return normalizeResumeLineEndings(source)
    .split("\n")
    .some((line) => resumeSectionHeadings[section].test(line.trim().replace(/:$/, "")));
}

type IndexedLine = {
  sourceText: string;
  startOffset: number;
  endOffset: number;
};

function indexedLines(source: string): IndexedLine[] {
  let cursor = 0;
  return source.split("\n").map((sourceText) => {
    const line = {
      sourceText,
      startOffset: cursor,
      endOffset: cursor + sourceText.length
    };
    cursor = line.endOffset + 1;
    return line;
  });
}

function exactTrimmedRange(source: string, startOffset: number, endOffset: number) {
  const raw = source.slice(startOffset, endOffset);
  const sourceText = raw.trim();
  if (!sourceText) return null;
  const relativeStart = raw.indexOf(sourceText);
  return {
    sourceText,
    startOffset: startOffset + relativeStart,
    endOffset: startOffset + relativeStart + sourceText.length
  };
}

function catalogLines(
  normalizedSource: string,
  sectionId: string,
  startOffset: number,
  endOffset: number
) {
  return indexedLines(normalizedSource.slice(startOffset, endOffset)).map((line, index) => ({
    id: `${sectionId}-line-${index + 1}`,
    sourceText: line.sourceText,
    startOffset: startOffset + line.startOffset,
    endOffset: startOffset + line.endOffset
  }));
}

function deterministicRecordBlocks(section: ResumeSourceSectionName, sourceText: string) {
  if (section === "contactInfo" || section === "summary") return [sourceText];
  if (section === "skills" || section === "achievements" || section === "additional") {
    return sourceText.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return [];
}

export function buildResumeSourceCatalog(rawSource: string): ResumeSourceCatalog {
  const normalizedSource = normalizeResumeLineEndings(rawSource);
  const lines = indexedLines(normalizedSource);
  const headings = lines.flatMap((line, index) => {
    const section = resumeSourceSectionForHeading(line.sourceText);
    return section ? [{ index, section, heading: line.sourceText.trim() }] : [];
  });
  if (!headings.some((item) => item.section !== "additional")) {
    throw new PublicApiError(
      "Resume structure could not be validated because no supported section headings were found. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", retryable: false }
    );
  }

  const pending: Array<{
    section: ResumeSourceSectionName;
    heading: string | null;
    startOffset: number;
    endOffset: number;
  }> = [];
  const firstHeadingIndex = headings[0]?.index ?? lines.length;
  const preambleStart = lines[0]?.startOffset ?? 0;
  const preambleEnd = lines[firstHeadingIndex]?.startOffset ?? normalizedSource.length;
  const preambleRange = exactTrimmedRange(normalizedSource, preambleStart, preambleEnd);
  if (preambleRange) {
    pending.push({
      section: "contactInfo",
      heading: null,
      startOffset: preambleRange.startOffset,
      endOffset: preambleRange.endOffset
    });
  }

  headings.forEach((item, index) => {
    const bodyStart = lines[item.index]!.endOffset +
      (lines[item.index]!.endOffset < normalizedSource.length ? 1 : 0);
    const nextHeading = headings[index + 1];
    const bodyEnd = nextHeading
      ? lines[nextHeading.index]!.startOffset
      : normalizedSource.length;
    const bodyRange = exactTrimmedRange(normalizedSource, bodyStart, bodyEnd);
    if (!bodyRange) {
      throw new PublicApiError(
        `Resume parsing is incomplete for ${item.section}. No master resume was changed.`,
        422,
        {
          code: "RESUME_PARSE_INCOMPLETE",
          section: item.section,
          fieldPath: `sourceSections[${pending.length}].sourceText`,
          retryable: false
        }
      );
    }
    pending.push({
      section: item.section,
      heading: item.heading,
      startOffset: bodyRange.startOffset,
      endOffset: bodyRange.endOffset
    });
  });

  return {
    normalizedSource,
    sections: pending.map((section, index) => {
      const id = `section-${index + 1}`;
      const sourceText = normalizedSource.slice(section.startOffset, section.endOffset);
      return {
        id,
        section: section.section,
        heading: section.heading,
        sourceText,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        lines: catalogLines(
          normalizedSource,
          id,
          section.startOffset,
          section.endOffset
        ),
        recordBlocks: deterministicRecordBlocks(section.section, sourceText)
      };
    })
  };
}

export function buildResumeProviderSourceInput(rawSource: string): ResumeProviderSourceInput {
  const catalog = buildResumeSourceCatalog(rawSource);
  return {
    sections: catalog.sections.map((section) => ({
      sectionId: section.id,
      section: section.section,
      heading: section.heading,
      lines: section.lines.map((line) => ({ lineId: line.id, text: line.sourceText }))
    }))
  };
}
