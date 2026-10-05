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
  records: ResumeSourceCatalogRecord[];
};

export type ResumeSourceCatalogRecord = {
  id: string;
  sourceText: string;
  startOffset: number;
  endOffset: number;
  lines: ResumeSourceCatalogLine[];
};

export type ResumeSourceCatalog = {
  normalizedSource: string;
  sections: ResumeSourceCatalogSection[];
};

export type ResumeSourceCatalogVersion = "8" | "9";

export type ResumeProviderSourceInput = {
  sections: Array<{
    sectionId: string;
    section: ResumeSourceSectionName;
    heading: string | null;
    records: Array<{
      recordId: string;
      lines: Array<{ lineId: string; text: string }>;
    }>;
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

const structuralSections = new Set<ResumeSourceSectionName>([
  "workHistory",
  "projects",
  "education",
  "certifications"
]);

const listEntryPattern = /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u;
const structuralMetadataPattern = /^(?:location|technologies?(?: used)?|tools|methods|platforms?|credential id|details?)\s*:/i;
const labelledWorkTitlePattern = /^(?:title|role|position)\s*:/i;
const labelledWorkOrganizationPattern = /^(?:company|employer|organization)\s*:/i;
const structuralDatePattern = /(?:(?:19|20)\d{2}|present|current|ongoing|now)/i;
const structuralDateLinePattern = /^(?:(?:issued|expires?|expiration|completed|graduated|expected|anticipated)[:\s]+)?[^|\n]*(?:(?:19|20)\d{2}|present|current|ongoing|now)[^|\n]*$/i;
const educationCredentialPattern = /(?:associate|bachelor|master|doctor|ph\.?d|b\.?\s*[as]\.?|m\.?\s*[as]\.?|mba|degree|diploma|certificate|certification|license|licence|credential)/iu;

const resumeEnglishRegionNames = (() => {
  const names = new Set<string>();
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = displayNames.of(code);
      if (name && name !== code) names.add(name.toLowerCase());
    }
  }
  return names;
})();

export function isStandaloneResumeLocation(line: string) {
  const normalized = line.trim().toLowerCase();
  return /^(?:remote|hybrid|on[- ]?site|in[- ]person|usa|uk)$/i.test(normalized) ||
    resumeEnglishRegionNames.has(normalized);
}

function looksLikeCompactHeader(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140 || listEntryPattern.test(trimmed)) return false;
  if (structuralMetadataPattern.test(trimmed) || structuralDateLinePattern.test(trimmed)) return false;
  if (/[,;:]\s+[a-z]/u.test(trimmed)) return false;
  const words = trimmed
    .replace(/[|,:.!?()&/+\-]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  const connectors = new Set(["and", "of", "the", "for", "in", "at", "to"]);
  return words.every((word, index) =>
    connectors.has(word.toLowerCase()) ||
    /^[A-Z0-9][\p{L}\p{N}'’.-]*$/u.test(word) ||
    (index > 0 && /^[A-Z]{2,}$/u.test(word))
  );
}

function isCompleteNarrative(line: string) {
  return /[.!?…]$/u.test(line.trim());
}

function isStructuralContinuation(line: string) {
  const trimmed = line.trim();
  return listEntryPattern.test(trimmed) ||
    structuralMetadataPattern.test(trimmed) ||
    isCompleteNarrative(trimmed);
}

function hasExplicitPipeRecordHeader(
  section: ResumeSourceSectionName,
  pipeParts: string[],
  catalogVersion: ResumeSourceCatalogVersion
) {
  if (section === "workHistory") return pipeParts.length >= 2;
  if (section === "projects") {
    return pipeParts.length >= 3 && structuralDatePattern.test(pipeParts.at(-1) ?? "");
  }
  if (catalogVersion === "9" && section === "education") {
    return pipeParts.length >= 3 && structuralDatePattern.test(pipeParts.at(-1) ?? "");
  }
  if (section === "certifications") return pipeParts.length >= 2;
  return false;
}

function isRecordStartAt(
  section: ResumeSourceSectionName,
  lines: ResumeSourceCatalogLine[],
  start: number,
  end: number,
  catalogVersion: ResumeSourceCatalogVersion
) {
  const first = lines[start]?.sourceText.trim() ?? "";
  if (
    !first ||
    listEntryPattern.test(first) ||
    structuralMetadataPattern.test(first) ||
    structuralDateLinePattern.test(first)
  ) return false;
  const following = lines
    .slice(start + 1, end + 1)
    .map((line) => line.sourceText.trim())
    .filter(Boolean);
  const second = following[0] ?? "";
  const third = following[1] ?? "";
  const fourth = following[2] ?? "";
  const pipeParts = first.split("|").map((part) => part.trim()).filter(Boolean);

  if (hasExplicitPipeRecordHeader(section, pipeParts, catalogVersion)) return true;

  if (section === "workHistory") {
    if (isStandaloneResumeLocation(first)) return false;
    if (labelledWorkTitlePattern.test(first) && labelledWorkOrganizationPattern.test(second)) {
      return true;
    }
    if (!looksLikeCompactHeader(first) || !looksLikeCompactHeader(second)) return false;
    return following.length === 1 ||
      structuralDateLinePattern.test(third) ||
      /^location\s*:/i.test(third) ||
      listEntryPattern.test(third) ||
      isCompleteNarrative(third) ||
      structuralDateLinePattern.test(fourth);
  }
  if (section === "projects") {
    return looksLikeCompactHeader(first) && (
      structuralDateLinePattern.test(second) ||
      /^(?:technologies?(?: used)?|tools|methods|platforms?)\s*:/i.test(second)
    );
  }
  if (section === "education") {
    return Boolean(second) &&
      !listEntryPattern.test(second) &&
      (catalogVersion !== "9" ||
        educationCredentialPattern.test(first) ||
        educationCredentialPattern.test(second)) && (
      structuralDateLinePattern.test(third) || structuralDateLinePattern.test(fourth)
    );
  }
  if (section === "certifications") {
    return looksLikeCompactHeader(first) && Boolean(second) && (
      structuralDateLinePattern.test(second) ||
      structuralDateLinePattern.test(third) ||
      /^credential id\s*:/i.test(second)
    );
  }
  return false;
}

function isExplicitRecordStartAt(
  section: ResumeSourceSectionName,
  lines: ResumeSourceCatalogLine[],
  start: number,
  end: number,
  catalogVersion: ResumeSourceCatalogVersion
) {
  const first = lines[start]?.sourceText.trim() ?? "";
  const following = lines
    .slice(start + 1, end + 1)
    .map((line) => line.sourceText.trim())
    .filter(Boolean);
  const pipeParts = first.split("|").map((part) => part.trim()).filter(Boolean);
  // V8 treated certification pipe headers as ordinary record candidates. Keep
  // that historical boundary behavior frozen so stored V8 projections decode
  // against the same catalog that originally accepted them.
  if (
    hasExplicitPipeRecordHeader(section, pipeParts, catalogVersion) &&
    (catalogVersion === "9" || section !== "certifications")
  ) return true;
  if (section === "workHistory") {
    return labelledWorkTitlePattern.test(first) &&
      labelledWorkOrganizationPattern.test(following[0] ?? "");
  }
  return false;
}

export function isDeterministicResumeRecordBoundary(
  section: ResumeSourceSectionName,
  previousRecord: string,
  nextRecord: string,
  catalogVersion: ResumeSourceCatalogVersion = "8"
) {
  const candidateLines = nextRecord.split(/\r?\n/u).map((sourceText, index) => ({
    id: `candidate-line-${index + 1}`,
    sourceText,
    startOffset: 0,
    endOffset: sourceText.length
  }));
  const lastPreviousLine = previousRecord
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
  const boundaryBefore = isStructuralContinuation(lastPreviousLine) ||
    structuralDateLinePattern.test(lastPreviousLine) ||
    (section === "workHistory" && isStandaloneResumeLocation(lastPreviousLine));
  return (
    boundaryBefore ||
    isExplicitRecordStartAt(
      section,
      candidateLines,
      0,
      candidateLines.length - 1,
      catalogVersion
    )
  ) && isRecordStartAt(
    section,
    candidateLines,
    0,
    candidateLines.length - 1,
    catalogVersion
  );
}

type LineRange = { start: number; end: number };

function nonemptyParagraphs(lines: ResumeSourceCatalogLine[]) {
  const nonempty = lines.flatMap((line, index) => line.sourceText.trim() ? [index] : []);
  if (nonempty.length === 0) return [];
  const gaps = nonempty.slice(1).map((index, position) =>
    index - nonempty[position]! - 1);
  const hasAdjacentLines = gaps.some((gap) => gap === 0);
  const positiveGaps = gaps.filter((gap) => gap > 0);
  const layoutGap = hasAdjacentLines || positiveGaps.length === 0
    ? 0
    : Math.min(...positiveGaps);
  const ranges: LineRange[] = [];
  let start = nonempty[0]!;
  nonempty.slice(1).forEach((index, position) => {
    const gap = index - nonempty[position]! - 1;
    if (gap > layoutGap) {
      ranges.push({ start, end: nonempty[position]! });
      start = index;
    }
  });
  ranges.push({ start, end: nonempty.at(-1)! });
  return ranges;
}

function previousNonemptyIndex(lines: ResumeSourceCatalogLine[], before: number, floor: number) {
  for (let index = before; index >= floor; index -= 1) {
    if (lines[index]!.sourceText.trim()) return index;
  }
  return null;
}

function isV9AdjacentDatedRecordStart(
  section: ResumeSourceSectionName,
  lines: ResumeSourceCatalogLine[],
  segmentStart: number,
  start: number,
  end: number,
  catalogVersion: ResumeSourceCatalogVersion
) {
  if (catalogVersion !== "9") return false;
  const currentSegment = lines
    .slice(segmentStart, start)
    .map((line) => line.sourceText.trim())
    .filter(Boolean);
  const currentSegmentHasDate = currentSegment.some((text) => {
    if (structuralDateLinePattern.test(text)) return true;
    const pipeParts = text.split("|").map((part) => part.trim()).filter(Boolean);
    return hasExplicitPipeRecordHeader(section, pipeParts, catalogVersion) &&
      structuralDatePattern.test(pipeParts.at(-1) ?? "");
  });
  // One line can still be the first half of a compact header (for example a
  // project name followed by its subtitle/date), so it is not an established
  // preceding record. Two source lines, or explicit date evidence, are enough
  // to recognize a later strong dated header without model-owned merging.
  if (!currentSegmentHasDate && currentSegment.length < 2) return false;
  const candidate = lines
    .slice(start, end + 1)
    .map((line) => line.sourceText.trim())
    .filter(Boolean);
  const [first, second, third, fourth] = candidate;
  if (section === "workHistory") {
    if (!looksLikeCompactHeader(first ?? "") || !looksLikeCompactHeader(second ?? "")) {
      return false;
    }
    if (isStandaloneResumeLocation(second ?? "")) return false;
    return candidate.length === 2 ||
      structuralDateLinePattern.test(third ?? "") ||
      /^location\s*:/iu.test(third ?? "") ||
      listEntryPattern.test(third ?? "") ||
      isCompleteNarrative(third ?? "") || (
      (isStandaloneResumeLocation(third ?? "") || /^location\s*:/iu.test(third ?? "")) &&
      structuralDateLinePattern.test(fourth ?? "")
    );
  }
  if (section === "projects") {
    return looksLikeCompactHeader(first ?? "") && (
      structuralDateLinePattern.test(second ?? "") ||
      /^(?:technologies?(?: used)?|tools|methods|platforms?)\s*:/iu.test(second ?? "")
    );
  }
  if (section === "education") {
    return looksLikeCompactHeader(first ?? "") &&
      (educationCredentialPattern.test(first ?? "") ||
        educationCredentialPattern.test(second ?? "")) &&
      (structuralDateLinePattern.test(third ?? "") || structuralDateLinePattern.test(fourth ?? ""));
  }
  if (section === "certifications") {
    return looksLikeCompactHeader(first ?? "") && Boolean(second) && (
      structuralDateLinePattern.test(second ?? "") ||
      structuralDateLinePattern.test(third ?? "") ||
      /^credential id\s*:/iu.test(second ?? "")
    );
  }
  return false;
}

function splitInlineRecordStarts(
  section: ResumeSourceSectionName,
  lines: ResumeSourceCatalogLine[],
  range: LineRange,
  catalogVersion: ResumeSourceCatalogVersion
) {
  const starts = [range.start];
  for (let index = range.start + 1; index <= range.end; index += 1) {
    if (!lines[index]!.sourceText.trim()) continue;
    const previousIndex = previousNonemptyIndex(lines, index - 1, range.start);
    if (previousIndex === null) continue;
    const previous = lines[previousIndex]!.sourceText.trim();
    const boundaryBefore = isStructuralContinuation(previous) ||
      structuralDateLinePattern.test(previous) ||
      (section === "workHistory" && isStandaloneResumeLocation(previous));
    const recordStart = isRecordStartAt(
      section,
      lines,
      index,
      range.end,
      catalogVersion
    );
    if (
      (boundaryBefore || isExplicitRecordStartAt(
        section,
        lines,
        index,
        range.end,
        catalogVersion
      ) || isV9AdjacentDatedRecordStart(
        section,
        lines,
        starts.at(-1)!,
        index,
        range.end,
        catalogVersion
      )) &&
      recordStart
    ) starts.push(index);
  }
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] === undefined
      ? range.end
      : previousNonemptyIndex(lines, starts[index + 1]! - 1, start)!
  }));
}

function deterministicStructuralRecordBlocks(
  section: ResumeSourceSectionName,
  lines: ResumeSourceCatalogLine[],
  normalizedSource: string,
  fieldPath: string,
  catalogVersion: ResumeSourceCatalogVersion
) {
  const paragraphs = nonemptyParagraphs(lines);
  if (paragraphs.length === 0) return [];
  const ranges: LineRange[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const segments = splitInlineRecordStarts(section, lines, paragraph, catalogVersion);
    segments.forEach((segment, segmentIndex) => {
      const first = lines[segment.start]!.sourceText;
      const recordStart = isRecordStartAt(
        section,
        lines,
        segment.start,
        segment.end,
        catalogVersion
      );
      if (ranges.length === 0) {
        if (!recordStart && (paragraphs.length > 1 || segments.length > 1)) {
          throw new PublicApiError(
            `Resume ${section} structure is not deterministic enough to send to an AI provider. No master resume was changed.`,
            422,
            {
              code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
              section,
              fieldPath,
              structureReason: "unsupported_record_start",
              retryable: false
            }
          );
        }
        ranges.push(segment);
        return;
      }
      if (recordStart) {
        ranges.push(segment);
        return;
      }
      if (segmentIndex === 0 && isStructuralContinuation(first)) {
        ranges[ranges.length - 1]!.end = segment.end;
        return;
      }
      throw new PublicApiError(
        `Resume ${section} contains an ambiguous record boundary that cannot be sent safely. No master resume was changed.`,
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          section,
          fieldPath,
          structureReason: paragraphIndex > 0
            ? "unsupported_record_boundary"
            : "unsupported_inline_record_boundary",
          retryable: false
        }
      );
    });
  });

  return ranges.map((range) => {
    const startOffset = lines[range.start]!.startOffset;
    const endOffset = lines[range.end]!.endOffset;
    return normalizedSource.slice(startOffset, endOffset);
  });
}

function deterministicRecordBlocks(
  section: ResumeSourceSectionName,
  sourceText: string,
  lines: ResumeSourceCatalogLine[],
  normalizedSource: string,
  fieldPath: string,
  catalogVersion: ResumeSourceCatalogVersion
) {
  if (section === "contactInfo" || section === "summary") return [sourceText];
  if (section === "skills" || section === "achievements" || section === "additional") {
    return sourceText.split("\n").filter((line) => line.trim().length > 0);
  }
  if (structuralSections.has(section)) {
    return deterministicStructuralRecordBlocks(
      section,
      lines,
      normalizedSource,
      fieldPath,
      catalogVersion
    );
  }
  return [];
}

function catalogRecords(
  normalizedSource: string,
  sectionId: string,
  sectionStartOffset: number,
  lines: ResumeSourceCatalogLine[],
  recordBlocks: string[]
) {
  let cursor = sectionStartOffset;
  return recordBlocks.map((sourceText, index): ResumeSourceCatalogRecord => {
    const startOffset = normalizedSource.indexOf(sourceText, cursor);
    if (startOffset < 0) {
      throw new PublicApiError(
        "Resume record structure could not be bound to exact source offsets. No master resume was changed.",
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          fieldPath: `sourceSections[${Number(sectionId.slice("section-".length)) - 1}].recordBlocks[${index}]`,
          structureReason: "record_offset_binding_failed",
          retryable: false
        }
      );
    }
    const endOffset = startOffset + sourceText.length;
    cursor = endOffset;
    return {
      id: `${sectionId}-record-${index + 1}`,
      sourceText,
      startOffset,
      endOffset,
      lines: lines.filter((line) =>
        line.endOffset > startOffset && line.startOffset < endOffset)
    };
  });
}

function buildVersionedResumeSourceCatalog(
  rawSource: string,
  catalogVersion: ResumeSourceCatalogVersion,
  options: { requireStructuralRecords?: boolean } = {}
): ResumeSourceCatalog {
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
      const lines = catalogLines(
        normalizedSource,
        id,
        section.startOffset,
        section.endOffset
      );
      const recordBlocks = structuralSections.has(section.section) &&
        options.requireStructuralRecords === false
        ? []
        : deterministicRecordBlocks(
            section.section,
            sourceText,
            lines,
            normalizedSource,
            `sourceSections[${index}].recordBlocks`,
            catalogVersion
          );
      return {
        id,
        section: section.section,
        heading: section.heading,
        sourceText,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        lines,
        recordBlocks,
        records: catalogRecords(
          normalizedSource,
          id,
          section.startOffset,
          lines,
          recordBlocks
        )
      };
    })
  };
}

export function buildResumeSourceCatalogV8(
  rawSource: string,
  options: { requireStructuralRecords?: boolean } = {}
) {
  return buildVersionedResumeSourceCatalog(rawSource, "8", options);
}

export function buildResumeSourceCatalogV9(
  rawSource: string,
  options: { requireStructuralRecords?: boolean } = {}
) {
  return buildVersionedResumeSourceCatalog(rawSource, "9", options);
}

/** Historical default retained for V8 and earlier callers. */
export const buildResumeSourceCatalog = buildResumeSourceCatalogV8;

export function buildResumeProviderSourceInput(rawSource: string): ResumeProviderSourceInput {
  return buildResumeProviderSourceInputV8(rawSource);
}

function providerSourceInput(catalog: ResumeSourceCatalog): ResumeProviderSourceInput {
  return {
    sections: catalog.sections.map((section) => ({
      sectionId: section.id,
      section: section.section,
      heading: section.heading,
      records: section.records.map((record) => ({
        recordId: record.id,
        lines: record.lines.map((line) => ({ lineId: line.id, text: line.sourceText }))
      }))
    }))
  };
}

export function buildResumeProviderSourceInputV8(rawSource: string): ResumeProviderSourceInput {
  return providerSourceInput(buildResumeSourceCatalogV8(rawSource));
}

export function buildResumeProviderSourceInputV9(rawSource: string): ResumeProviderSourceInput {
  return providerSourceInput(buildResumeSourceCatalogV9(rawSource));
}

/**
 * Historical one-call diagnostic format retained only to reproduce and classify
 * the already-consumed v6 proof request. Production parsing uses server-owned
 * records through buildResumeProviderSourceInput.
 */
export function buildResumeProviderSourceInputV6(rawSource: string) {
  const catalog = buildResumeSourceCatalogV8(rawSource, { requireStructuralRecords: false });
  return {
    sections: catalog.sections.map((section) => ({
      sectionId: section.id,
      section: section.section,
      heading: section.heading,
      lines: section.lines.map((line) => ({ lineId: line.id, text: line.sourceText }))
    }))
  };
}
