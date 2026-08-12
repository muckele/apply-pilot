export const resumeTemplates = ["CLASSIC", "MODERN", "COMPACT"] as const;
export const resumePageSizes = ["LETTER", "A4"] as const;
export const resumeFontFamilies = ["ARIAL", "CALIBRI", "GEORGIA"] as const;

export type ResumeTemplate = (typeof resumeTemplates)[number];
export type ResumePageSize = (typeof resumePageSizes)[number];
export type ResumeFontFamily = (typeof resumeFontFamilies)[number];

export type ResumeFormat = {
  template: ResumeTemplate;
  pageSize: ResumePageSize;
  fontFamily: ResumeFontFamily;
  accentColor: string;
  fontSize: number;
  lineSpacing: number;
};

export const defaultResumeFormat: ResumeFormat = {
  template: "CLASSIC",
  pageSize: "LETTER",
  fontFamily: "ARIAL",
  accentColor: "#0F766E",
  fontSize: 10,
  lineSpacing: 115
};

export function normalizeHexColor(value: string) {
  return /^#[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : defaultResumeFormat.accentColor;
}

export function isResumeHeading(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 60) return false;
  return /^(SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|TECHNICAL SKILLS)$/i.test(
    trimmed.replace(/:$/, "")
  );
}

export function isResumeBullet(line: string) {
  return /^\s*(?:[-*]|\u2022)\s+/.test(line);
}

export function stripResumeBullet(line: string) {
  return line.replace(/^\s*(?:[-*]|\u2022)\s+/, "").trim();
}

export function wrapResumeLine(line: string, maxCharacters: number) {
  const clean = line.replace(/\t/g, "    ").trimEnd();
  if (!clean) return [""];

  const output: string[] = [];
  let current = "";

  for (const word of clean.split(/\s+/)) {
    if (word.length > maxCharacters) {
      if (current) output.push(current);
      current = "";
      for (let index = 0; index < word.length; index += maxCharacters) {
        output.push(word.slice(index, index + maxCharacters));
      }
    } else if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= maxCharacters) {
      current = `${current} ${word}`;
    } else {
      output.push(current);
      current = word;
    }
  }

  if (current) output.push(current);
  return output;
}

export function getResumePageMetrics(format: ResumeFormat) {
  const widthInches = format.pageSize === "A4" ? 8.27 : 8.5;
  const heightInches = format.pageSize === "A4" ? 11.69 : 11;
  const marginInches = format.template === "COMPACT" ? 0.5 : 0.65;
  const lineHeightPoints = format.fontSize * (format.lineSpacing / 100);
  const usableHeightPoints = (heightInches - marginInches * 2) * 72;
  const linesPerPage = Math.max(28, Math.floor(usableHeightPoints / lineHeightPoints));
  const usableWidthPoints = (widthInches - marginInches * 2) * 72;
  const averageCharacterWidth = format.fontSize * 0.51;
  const charactersPerLine = Math.max(62, Math.floor(usableWidthPoints / averageCharacterWidth));

  return {
    widthInches,
    heightInches,
    marginInches,
    linesPerPage,
    charactersPerLine
  };
}

export function paginateResumeText(text: string, format: ResumeFormat) {
  const metrics = getResumePageMetrics(format);
  const visualLines = text.split(/\r?\n/).flatMap((line) => {
    const bullet = isResumeBullet(line);
    const wrapped = wrapResumeLine(stripResumeBullet(line), metrics.charactersPerLine - (bullet ? 4 : 0));
    const rendered = bullet
      ? wrapped.map((part, index) => `${index === 0 ? "\u2022 " : "  "}${part}`)
      : wrapped;
    return [...(isResumeHeading(line) ? [""] : []), ...rendered];
  });
  const pages: string[][] = [];

  for (let index = 0; index < visualLines.length; index += metrics.linesPerPage) {
    pages.push(visualLines.slice(index, index + metrics.linesPerPage));
  }

  return pages.length ? pages : [[""]];
}
