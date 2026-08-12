import { NextRequest, NextResponse } from "next/server";
import { BorderStyle, Document, Packer, Paragraph, TextRun } from "docx";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  defaultResumeFormat,
  getResumePageMetrics,
  isResumeBullet,
  isResumeHeading,
  normalizeHexColor,
  stripResumeBullet,
  type ResumeFormat
} from "@/lib/documents/resume-format";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const exportSchema = z.object({
  documentId: z.string().optional(),
  resumeVersionId: z.string().optional(),
  format: z.enum(["markdown", "docx", "pdf"]).default("markdown")
});

function createPdfBuffer(text: string, format: ResumeFormat) {
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

function escapePdfText(value: string) {
  return value
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
    .replace(/[()\\]/g, "\\$&");
}

function wrapPdfLine(line: string, maxCharacters = 90) {
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

function paginateLines(lines: string[], perPage: number) {
  const pages: string[][] = [];

  for (let index = 0; index < lines.length; index += perPage) {
    pages.push(lines.slice(index, index + perPage));
  }

  return pages.length ? pages : [[""]];
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`documents:export:${userId}`, 30, 60_000);
    const input = exportSchema.parse(await request.json());

    const document = input.documentId
      ? await prisma.generatedDocument.findFirst({ where: { id: input.documentId, userId } })
      : null;
    const resumeVersion = input.resumeVersionId
      ? await prisma.resumeVersion.findFirst({ where: { id: input.resumeVersionId, userId } })
      : null;

    const title = document?.title ?? resumeVersion?.title ?? "JobMatch CRM document";
    const content = document?.content ?? resumeVersion?.fullText;

    if (!content) {
      throw new PublicApiError("Document not found.", 404);
    }

    const resumeFormat: ResumeFormat = resumeVersion
      ? {
          template: resumeVersion.template as ResumeFormat["template"],
          pageSize: resumeVersion.pageSize as ResumeFormat["pageSize"],
          fontFamily: resumeVersion.fontFamily as ResumeFormat["fontFamily"],
          accentColor: normalizeHexColor(resumeVersion.accentColor),
          fontSize: resumeVersion.fontSize,
          lineSpacing: resumeVersion.lineSpacing
        }
      : defaultResumeFormat;
    const contentWithTitle = document ? `${title}\n\n${content}` : content;

    if (input.format === "docx") {
      const metrics = getResumePageMetrics(resumeFormat);
      const fontFamily = resumeFormat.fontFamily === "CALIBRI"
        ? "Calibri"
        : resumeFormat.fontFamily === "GEORGIA"
          ? "Georgia"
          : "Arial";
      const pageWidth = Math.round(metrics.widthInches * 1440);
      const pageHeight = Math.round(metrics.heightInches * 1440);
      const margin = Math.round(metrics.marginInches * 1440);
      const lineSpacing = Math.round(resumeFormat.fontSize * 2 * (resumeFormat.lineSpacing / 100) * 10);
      const accentColor = resumeFormat.accentColor.replace("#", "");
      const doc = new Document({
        styles: {
          default: {
            document: {
              run: { font: fontFamily, size: resumeFormat.fontSize * 2 },
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
            children: contentWithTitle.split(/\r?\n/).map((line) => {
              if (isResumeHeading(line)) {
                return new Paragraph({
                  children: [new TextRun({ text: line.replace(/:$/, "").toUpperCase(), bold: true, color: accentColor })],
                  border: resumeFormat.template === "MODERN"
                    ? { left: { style: BorderStyle.SINGLE, size: 12, color: accentColor, space: 6 } }
                    : { bottom: { style: BorderStyle.SINGLE, size: 4, color: accentColor } },
                  spacing: {
                    before: resumeFormat.template === "COMPACT" ? 80 : 140,
                    after: resumeFormat.template === "COMPACT" ? 30 : 60,
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
      const buffer = await Packer.toBuffer(doc);

      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": `attachment; filename="${title.replace(/[^a-zA-Z0-9._-]/g, "_")}.docx"`
        }
      });
    }

    if (input.format === "pdf") {
      return new NextResponse(new Uint8Array(createPdfBuffer(contentWithTitle, resumeFormat)), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${title.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf"`
        }
      });
    }

    return new NextResponse(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${title.replace(/[^a-zA-Z0-9._-]/g, "_")}.md"`
      }
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
