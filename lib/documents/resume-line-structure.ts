import { resumeSectionForHeading, resumeSourceSectionForHeading } from "@/lib/ai/resume-section-headings";
import { wrapStyledRuns, type MeasureText, type TextStyle } from "@/lib/documents/document-typography";

// Layout-only reading of résumé lines. Every function returns exact substrings of its input, so
// renderers can restyle and reposition text without adding, dropping or reordering characters.
// The one exception is `withoutDatedRecordSeparator`, which states the separator mark a renderer
// leaves out before right-aligned dates.

export type ResumeBulletParts = Readonly<{ marker: string; separator: string; body: string }>;
export type DatedRecordHeadingParts = Readonly<{
  organization: string;
  // Parenthetical description or location after the organization, including its leading space.
  aside: string;
  // Exact source text between the lead and the dates: whitespace, optionally around one separator
  // mark (", ", " – ", " - ", ": ").
  separator: string;
  dates: string;
}>;
export type GroupedSkillParts = Readonly<{ label: string; items: string }>;

// The standard headings in any case (as before), plus every heading the résumé parser recognizes
// (KEY ACHIEVEMENTS, TECHNICAL PROJECTS, LICENSES, VOLUNTEER EXPERIENCE...) when the line is written
// in capitals, as a heading line is. A capitalized name ("NASA") or a sentence that merely starts
// with a heading word stays ordinary text.
const standardSectionHeading = /^(?:SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL(?: INFORMATION)?):?$/iu;

export function isResumeSectionHeadingLine(line: string) {
  const trimmed = line.trim();
  if (standardSectionHeading.test(trimmed)) return true;
  return trimmed === trimmed.toLocaleUpperCase() && /\p{Lu}/u.test(trimmed) && resumeSourceSectionForHeading(trimmed) !== null;
}

export function isSkillsSectionHeadingLine(line: string) {
  return resumeSectionForHeading(line) === "skills";
}

// Same markers as `isResumeBullet` when whitespace follows. Résumé text extracted from PDFs often
// drops that space ("•Founded"); the unambiguous bullet glyphs need none, and "-" or "*" count when
// a capitalized word follows directly ("-Founded"), so "-20%", "*nix" or "**Bold**" stay text.
const spacedBullet = /^([-*•▪◦–—])(\s+)(?=\S)/u;
const tightBullet = /^(?:[•▪◦](?=\S)|[-*](?=\p{Lu}))/u;

export function parseResumeBullet(line: string): ResumeBulletParts | null {
  const spaced = spacedBullet.exec(line);
  if (spaced) return Object.freeze({ marker: spaced[1]!, separator: spaced[2]!, body: line.slice(spaced[0].length) });
  const tight = tightBullet.exec(line);
  if (!tight) return null;
  return Object.freeze({ marker: tight[0], separator: "", body: line.slice(tight[0].length) });
}

// The glyph a renderer draws for a bullet. A marker followed by whitespace becomes the canonical
// "•" (export verification already treats those markers as equivalent). A marker written without
// a space keeps its own glyph, so "•Founded" or "-Founded" keep their exact text, unless the target
// cannot draw it (PDF WinAnsi has no "▪" or "◦"); the gap is then layout, not an added character.
export function resumeBulletGlyph(bullet: ResumeBulletParts, canDraw: (character: string) => boolean) {
  return bullet.separator || !canDraw(bullet.marker) ? "•" : bullet.marker;
}

// The résumé parser's trailing date-range idea (lib/ai/resume-source-catalog.ts), extended with
// "02/2022" months. The lead must be a short capitalized header, ignoring parenthetical asides.
const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const datePoint = `(?:${month}\\s+|\\d{1,2}/)?(?:19|20)\\d{2}`;
// The separator may carry one punctuation mark ("Example Academy, Oct 2019 – Feb 2020"); the lazy
// lead then stops before it, so a renderer can leave the mark out once the dates move to the margin.
const trailingDateRange = new RegExp(`^(.*?\\S)(\\s*[,;:–—-]\\s+|\\s+)(${datePoint}\\s*[–—-]\\s*(?:${datePoint}|present|current|now))$`, "iu");
const headerConnectors = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to"]);

function looksLikeHeaderLead(lead: string) {
  const plain = lead.replace(/\s*\([^()]*\)\s*/gu, " ").trim();
  if (!plain || plain.length > 140 || plain.includes("|")) return false;
  if (/[,;:]\s+\p{Ll}/u.test(plain) || /\b(?:19|20)\d{2}\b/u.test(plain) || /[.!?]$/u.test(plain)) return false;
  const words = plain.replace(/[,:.!?()&/+\-–—]/gu, " ").split(/\s+/u).filter(Boolean);
  return words.length > 0 && words.length <= 12 && words.every((word) =>
    headerConnectors.has(word.toLowerCase()) || /^[\p{Lu}\p{N}]/u.test(word) || /^\p{Ll}+\p{Lu}/u.test(word));
}

export function parseDatedRecordHeading(line: string): DatedRecordHeadingParts | null {
  if (line.includes("|") || parseResumeBullet(line)) return null;
  const match = trailingDateRange.exec(line);
  // The lead is judged with its separator mark attached, exactly as before the mark was split off.
  if (!match || !looksLikeHeaderLead(`${match[1]}${match[2]}`.trimEnd())) return null;
  const lead = match[1]!;
  const asideStart = lead.search(/\s\(/u);
  const organization = asideStart > 0 ? lead.slice(0, asideStart) : lead;
  return Object.freeze({ organization, aside: lead.slice(organization.length), separator: match[2]!, dates: match[3]! });
}

// What a renderer keeps between a dated heading's lead and its right-aligned dates: the trailing
// whitespace of the separator. Once the dates sit at the margin, a separator mark would dangle
// ("Example Academy,"), so it is left out.
export function datedRecordGap(parts: DatedRecordHeadingParts) {
  return /\s+$/u.exec(parts.separator)![0];
}

// A dated heading line as the export draws it: the source line without its separator mark.
export function withoutDatedRecordSeparator(line: string) {
  const parts = parseDatedRecordHeading(line);
  return parts ? `${parts.organization}${parts.aside}${datedRecordGap(parts)}${parts.dates}` : line;
}

// The line right after a dated organization line, when it reads as a job or degree title.
export function looksLikeRecordTitle(line: string) {
  return line.length <= 110 && !/[.!?;:]$/u.test(line) && line.split(/\s+/u).length <= 14 &&
    !line.includes("|") && !parseResumeBullet(line) && !parseDatedRecordHeading(line);
}

// "Category: a, b, c". The label stays attached to its colon; the items keep their leading space.
// Under a skills heading every line is a category, so a label may run to six words ("Account
// management and customer success:"); elsewhere only a short label before a comma list counts.
export function parseGroupedSkillLine(line: string, inSkillsSection: boolean): GroupedSkillParts | null {
  const match = /^(\p{Lu}[^:|]*:)(\s+\S.*)$/u.exec(line);
  const [maxWords, maxLength] = inSkillsSection ? [6, 60] : [4, 40];
  if (!match || match[1]!.length > maxLength || match[1]!.split(/\s+/u).length > maxWords) return null;
  if (!inSkillsSection && !match[2]!.includes(",")) return null;
  return Object.freeze({ label: match[1]!, items: match[2]! });
}

// Splits a header line at " | " (or " · ", " • ") separators. Each segment keeps its trailing
// separator and whitespace, so a wrapped line ends with the separator and never starts with one.
export function splitSeparatedSegments(line: string) {
  const segments: string[] = [];
  let start = 0;
  for (const match of line.matchAll(/\s+[|·•]\s+/gu)) {
    const end = match.index! + match[0].length;
    segments.push(line.slice(start, end));
    start = end;
  }
  segments.push(line.slice(start));
  return segments.filter(Boolean);
}

// Header lines separated by " | " break only after a separator; a single oversized segment still
// wraps by words so nothing overflows. Offsets mark where each later line starts in `line`.
export function wrapSeparatedHeaderLine(line: string, style: TextStyle, width: number, measure: MeasureText) {
  const groups: string[][] = [];
  for (const segment of splitSeparatedSegments(line)) {
    const current = groups.at(-1);
    if (current && measure([...current, segment].join("").trim().replace(/\s+/gu, " "), style) <= width) current.push(segment);
    else groups.push([segment]);
  }
  const lineBreakOffsets: number[] = [];
  let offset = 0;
  groups.forEach((group, index) => {
    if (index > 0) lineBreakOffsets.push(offset);
    offset += group.join("").length;
  });
  return {
    lines: groups.flatMap((group) => wrapStyledRuns([{ text: group.join(""), style }], width, measure)),
    lineBreakOffsets: groups.length > 1 ? lineBreakOffsets : undefined
  };
}
