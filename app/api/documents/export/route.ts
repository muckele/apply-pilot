import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const exportSchema = z.object({
  documentId: z.string().optional(),
  resumeVersionId: z.string().optional(),
  format: z.enum(["markdown", "docx", "pdf"]).default("markdown")
});

function createPdfBuffer(title: string, text: string) {
  const lines = [title, "", ...text.split(/\n/)].slice(0, 48);
  const content = [
    "BT",
    "/F1 11 Tf",
    "72 760 Td",
    ...lines.map((line, index) => {
      const escaped = line.replace(/[()\\]/g, "\\$&").slice(0, 92);
      return `${index === 0 ? "" : "0 -16 Td "}(${escaped}) Tj`;
    }),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
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

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
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
      throw new Error("Document not found.");
    }

    if (input.format === "docx") {
      const doc = new Document({
        sections: [
          {
            children: content.split(/\n+/).map(
              (line) =>
                new Paragraph({
                  children: [new TextRun(line)]
                })
            )
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
      return new NextResponse(new Uint8Array(createPdfBuffer(title, content)), {
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
