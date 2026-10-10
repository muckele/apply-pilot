import { isResumeBullet, stripResumeBullet } from "@/lib/documents/resume-format";

export const CANONICAL_APPLICATION_DOCUMENT_PROFILE_V2 = Object.freeze({
  profileVersion: 2,
  pageSize: "LETTER",
  pageWidth: 612,
  pageHeight: 792,
  margin: 42,
  bodyFont: "Helvetica",
  boldFont: "Helvetica-Bold",
  accentColor: "#0F766E",
  textColor: "#172033",
  secondaryColor: "#475569"
} as const);

export type ApplicationDocumentArtifactType = "RESUME" | "COVER_LETTER";
export type ApplicationDocumentBlockRole =
  | "candidate_name"
  | "contact"
  | "headline"
  | "section_heading"
  | "record_heading"
  | "bullet"
  | "body"
  | "salutation"
  | "signoff";

export type ApplicationDocumentLayoutBlock = Readonly<{
  role: ApplicationDocumentBlockRole;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  bold: boolean;
  color: string;
}>;

export type ApplicationDocumentLayoutPage = Readonly<{
  number: number;
  blocks: readonly ApplicationDocumentLayoutBlock[];
}>;

export type CanonicalApplicationDocumentLayoutV2 = Readonly<{
  profileVersion: 2;
  variant: "resume" | "cover_letter";
  pageWidth: number;
  pageHeight: number;
  margin: number;
  pages: readonly ApplicationDocumentLayoutPage[];
}>;

type MutablePage = { number: number; blocks: ApplicationDocumentLayoutBlock[] };

const profile = CANONICAL_APPLICATION_DOCUMENT_PROFILE_V2;
const contentWidth = profile.pageWidth - profile.margin * 2;
const resumeSectionHeading = /^(?:SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL(?: INFORMATION)?)$/iu;

function wrapLine(text: string, width: number, fontSize: number) {
  const maxCharacters = Math.max(24, Math.floor(width / (fontSize * 0.52)));
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxCharacters) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function resumeRole(line: string, contentIndex: number) {
  if (contentIndex === 0) {
    return { role: "candidate_name" as const, fontSize: 18, bold: true, color: profile.textColor, indent: 0, before: 0, after: 2 };
  }
  if (contentIndex === 1) {
    return { role: "contact" as const, fontSize: 9, bold: false, color: profile.secondaryColor, indent: 0, before: 0, after: 2 };
  }
  if (contentIndex === 2 && !resumeSectionHeading.test(line)) {
    return { role: "headline" as const, fontSize: 11, bold: true, color: profile.secondaryColor, indent: 0, before: 0, after: 8 };
  }
  if (resumeSectionHeading.test(line)) {
    return { role: "section_heading" as const, fontSize: 10.5, bold: true, color: profile.accentColor, indent: 0, before: 10, after: 5 };
  }
  if (isResumeBullet(line)) {
    return { role: "bullet" as const, fontSize: 9.5, bold: false, color: profile.textColor, indent: 14, before: 1, after: 2 };
  }
  if (line.includes("|") && !/@/u.test(line)) {
    return { role: "record_heading" as const, fontSize: 10, bold: true, color: profile.textColor, indent: 0, before: 5, after: 2 };
  }
  return { role: "body" as const, fontSize: 9.5, bold: false, color: profile.textColor, indent: 0, before: 1, after: 3 };
}

function buildResumeLayout(content: string): MutablePage[] {
  const pages: MutablePage[] = [{ number: 1, blocks: [] }];
  let page = pages[0]!;
  let y = profile.margin;
  let contentIndex = 0;
  const newPage = () => {
    page = { number: pages.length + 1, blocks: [] };
    pages.push(page);
    y = profile.margin;
  };

  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      y += 4;
      continue;
    }
    const style = resumeRole(trimmed, contentIndex);
    const text = style.role === "bullet" ? stripResumeBullet(trimmed) : trimmed.replace(/:$/u, "");
    const width = contentWidth - style.indent;
    const wrapped = wrapLine(text, width - (style.role === "bullet" ? 10 : 0), style.fontSize);
    const lineHeight = Math.ceil(style.fontSize * 1.28);
    const requiredHeight = style.before + wrapped.length * lineHeight + style.after;
    const keepWithNext = style.role === "section_heading" ? 24 : 0;
    if (y + requiredHeight + keepWithNext > profile.pageHeight - profile.margin && page.blocks.length) newPage();
    y += style.before;
    wrapped.forEach((part, index) => {
      const prefix = style.role === "bullet" && index === 0 ? "• " : "";
      page.blocks.push(Object.freeze({
        role: style.role,
        text: `${prefix}${part}`,
        x: profile.margin + style.indent,
        y,
        width,
        height: lineHeight,
        fontSize: style.fontSize,
        bold: style.bold,
        color: style.color
      }));
      y += lineHeight;
    });
    y += style.after;
    contentIndex += 1;
  }
  return pages;
}

function coverRole(line: string, contentIndex: number) {
  if (contentIndex === 0) return { role: "candidate_name" as const, fontSize: 16, bold: true, color: profile.textColor };
  if (contentIndex === 1) return { role: "contact" as const, fontSize: 9, bold: false, color: profile.secondaryColor };
  if (/^Dear\b/iu.test(line)) return { role: "salutation" as const, fontSize: 10.5, bold: true, color: profile.textColor };
  if (/^(?:Sincerely|Best|Best regards|Regards|Thank you),?$/iu.test(line)) {
    return { role: "signoff" as const, fontSize: 10.5, bold: false, color: profile.textColor };
  }
  return { role: "body" as const, fontSize: 10.5, bold: false, color: profile.textColor };
}

function buildCoverLetterLayout(content: string): MutablePage[] {
  const pages: MutablePage[] = [{ number: 1, blocks: [] }];
  let page = pages[0]!;
  let y = profile.margin;
  let contentIndex = 0;
  let previousBlank = false;
  const newPage = () => {
    page = { number: pages.length + 1, blocks: [] };
    pages.push(page);
    y = profile.margin;
  };
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      if (!previousBlank) y += 10;
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    const style = coverRole(line, contentIndex);
    const wrapped = wrapLine(line, contentWidth, style.fontSize);
    const lineHeight = Math.ceil(style.fontSize * 1.45);
    const requiredHeight = wrapped.length * lineHeight + 4;
    if (y + requiredHeight > profile.pageHeight - profile.margin && page.blocks.length) newPage();
    for (const part of wrapped) {
      page.blocks.push(Object.freeze({
        role: style.role,
        text: part,
        x: profile.margin,
        y,
        width: contentWidth,
        height: lineHeight,
        fontSize: style.fontSize,
        bold: style.bold,
        color: style.color
      }));
      y += lineHeight;
    }
    y += 4;
    contentIndex += 1;
  }
  return pages;
}

export function buildCanonicalApplicationDocumentLayoutV2(input: {
  artifactType: ApplicationDocumentArtifactType;
  content: string;
}): CanonicalApplicationDocumentLayoutV2 {
  const variant = input.artifactType === "RESUME" ? "resume" : "cover_letter";
  const pages = variant === "resume" ? buildResumeLayout(input.content) : buildCoverLetterLayout(input.content);
  return Object.freeze({
    profileVersion: 2 as const,
    variant,
    pageWidth: profile.pageWidth,
    pageHeight: profile.pageHeight,
    margin: profile.margin,
    pages: Object.freeze(pages.map((page) => Object.freeze({
      number: page.number,
      blocks: Object.freeze([...page.blocks])
    })))
  });
}

export function normalizeApplicationDocumentPdfText(value: string) {
  return value
    .replaceAll("•", "-")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replaceAll("…", "...")
    .replaceAll("\u00A0", " ")
    .replace(/[^\x20-\x7E]/gu, "?");
}

function escapePdfText(value: string) {
  return normalizeApplicationDocumentPdfText(value)
    .replace(/[()\\]/gu, "\\$&");
}

function rgb(hex: string) {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16) / 255)
    .map((value) => value.toFixed(3)).join(" ");
}

export function renderCanonicalApplicationDocumentPdfV2(input: {
  artifactType: ApplicationDocumentArtifactType;
  content: string;
}) {
  const layout = buildCanonicalApplicationDocumentLayoutV2(input);
  const pageIds = layout.pages.map((_, index) => 5 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${layout.pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
  ];
  for (const [index, page] of layout.pages.entries()) {
    const pageObjectId = 5 + index * 2;
    const contentObjectId = pageObjectId + 1;
    const commands = page.blocks.flatMap((block) => {
      const baseline = layout.pageHeight - block.y - block.fontSize;
      const textCommands = [
        "BT",
        `${rgb(block.color)} rg`,
        `/${block.bold ? "F2" : "F1"} ${block.fontSize} Tf`,
        `${block.x.toFixed(2)} ${baseline.toFixed(2)} Td`,
        `(${escapePdfText(block.text)}) Tj`,
        "ET"
      ];
      if (block.role !== "section_heading") return textCommands;
      const lineY = layout.pageHeight - block.y - block.height - 1;
      return [
        ...textCommands,
        `${rgb(profile.accentColor)} RG`,
        "0.7 w",
        `${block.x.toFixed(2)} ${lineY.toFixed(2)} m`,
        `${(layout.pageWidth - layout.margin).toFixed(2)} ${lineY.toFixed(2)} l`,
        "S"
      ];
    });
    const stream = commands.join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${layout.pageWidth} ${layout.pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
