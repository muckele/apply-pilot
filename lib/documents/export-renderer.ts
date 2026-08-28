import { BorderStyle, Document, Packer, Paragraph, TextRun } from "docx";

import {
  getResumePageMetrics,
  isResumeBullet,
  isResumeHeading,
  stripResumeBullet,
  type ResumeFormat
} from "@/lib/documents/resume-format";

export type GenericDocumentRenderInput = Readonly<{
  content: string;
  format: "docx" | "pdf";
  resumeFormat: ResumeFormat;
}>;

export const CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1 = Object.freeze({
  profileVersion: 1,
  template: "CLASSIC",
  pageSize: "LETTER",
  fontFamily: "ARIAL",
  accentColor: "#0F766E",
  fontSize: 10,
  lineSpacing: 115,
  format: "docx",
  includeSourceTitle: false
} as const);

export type CanonicalApplicationDocumentV1Input = Readonly<{
  artifactType: "RESUME" | "COVER_LETTER";
  content: string;
}>;

export async function renderCanonicalApplicationDocumentV1(
  input: CanonicalApplicationDocumentV1Input
): Promise<Buffer> {
  return renderGenericDocument({
    content: input.content,
    format: "docx",
    resumeFormat: {
      template: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.template,
      pageSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.pageSize,
      fontFamily: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontFamily,
      accentColor: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.accentColor,
      fontSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontSize,
      lineSpacing: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.lineSpacing
    }
  });
}

export async function renderGenericDocument(input: GenericDocumentRenderInput): Promise<Buffer> {
  if (input.format === "pdf") {
    return createPdfBuffer(input.content, input.resumeFormat);
  }

  const metrics = getResumePageMetrics(input.resumeFormat);
  const fontFamily = input.resumeFormat.fontFamily === "CALIBRI"
    ? "Calibri"
    : input.resumeFormat.fontFamily === "GEORGIA"
      ? "Georgia"
      : "Arial";
  const pageWidth = Math.round(metrics.widthInches * 1440);
  const pageHeight = Math.round(metrics.heightInches * 1440);
  const margin = Math.round(metrics.marginInches * 1440);
  const lineSpacing = Math.round(
    input.resumeFormat.fontSize * 2 * (input.resumeFormat.lineSpacing / 100) * 10
  );
  const accentColor = input.resumeFormat.accentColor.replace("#", "");
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: fontFamily, size: input.resumeFormat.fontSize * 2 },
          paragraph: { spacing: { line: lineSpacing, after: 40 } }
        }
      }
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: pageWidth, height: pageHeight },
            margin: { top: margin, right: margin, bottom: margin, left: margin }
          }
        },
        children: input.content.split(/\r?\n/).map((line) => {
          if (isResumeHeading(line)) {
            return new Paragraph({
              children: [
                new TextRun({
                  text: line.replace(/:$/, "").toUpperCase(),
                  bold: true,
                  color: accentColor
                })
              ],
              border: input.resumeFormat.template === "MODERN"
                ? { left: { style: BorderStyle.SINGLE, size: 12, color: accentColor, space: 6 } }
                : { bottom: { style: BorderStyle.SINGLE, size: 4, color: accentColor } },
              spacing: {
                before: input.resumeFormat.template === "COMPACT" ? 80 : 140,
                after: input.resumeFormat.template === "COMPACT" ? 30 : 60,
                line: lineSpacing
              }
            });
          }

          if (isResumeBullet(line)) {
            return new Paragraph({
              text: stripResumeBullet(line),
              bullet: { level: 0 },
              spacing: { after: 30, line: lineSpacing }
            });
          }

          return new Paragraph({
            children: [new TextRun(line)],
            spacing: { after: line ? 40 : 80, line: lineSpacing }
          });
        })
      }
    ]
  });

  return Packer.toBuffer(document);
}

function createPdfBuffer(text: string, format: ResumeFormat): Buffer {
  const metrics = getResumePageMetrics(format);
  const lines = text.split(/\r?\n/).flatMap((line) =>
    wrapPdfLine(line, metrics.charactersPerLine)
  );
  const pages = paginateLines(lines.length ? lines : [""], metrics.linesPerPage);
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const pageWidth = format.pageSize === "A4" ? 595 : 612;
  const pageHeight = format.pageSize === "A4" ? 842 : 792;
  const margin = Math.round(metrics.marginInches * 72);
  const fontName = format.fontFamily === "GEORGIA" ? "Times-Roman" : "Helvetica";
  const lineHeight = Math.round(format.fontSize * (format.lineSpacing / 100));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} >>`
  ];

  pages.forEach((pageLines, index) => {
    const pageObjectId = 4 + index * 2;
    const contentObjectId = pageObjectId + 1;
    const content = [
      "BT",
      `/F1 ${format.fontSize} Tf`,
      `${margin} ${pageHeight - margin} Td`,
      `${lineHeight} TL`,
      ...pageLines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, "T*"]),
      "ET"
    ].join("\n");

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
    );
  });

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

function escapePdfText(value: string): string {
  return value
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
    .replace(/[()\\]/g, "\\$&");
}

function wrapPdfLine(line: string, maxCharacters = 90): string[] {
  const clean = line.replace(/\t/g, "    ").replace(/^\s*\u2022\s+/, "- ").trimEnd();
  if (!clean) {
    return [""];
  }

  const output: string[] = [];
  let current = "";

  for (const word of clean.split(/\s+/)) {
    if (word.length > maxCharacters) {
      if (current) {
        output.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += maxCharacters) {
        output.push(word.slice(index, index + maxCharacters));
      }
      continue;
    }

    if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= maxCharacters) {
      current = `${current} ${word}`;
    } else {
      output.push(current);
      current = word;
    }
  }

  if (current) {
    output.push(current);
  }

  return output;
}

function paginateLines(lines: string[], perPage: number): string[][] {
  const pages: string[][] = [];

  for (let index = 0; index < lines.length; index += perPage) {
    pages.push(lines.slice(index, index + perPage));
  }

  return pages.length ? pages : [[""]];
}
