import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { renderGenericDocument } from "@/lib/documents/export-renderer";
import {
  defaultResumeFormat,
  normalizeHexColor,
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

type GeneratedDocumentExportRow = {
  title: string;
  content: string;
};

type ResumeVersionExportRow = {
  title: string;
  fullText: string;
  template: string;
  pageSize: string;
  fontFamily: string;
  accentColor: string;
  fontSize: number;
  lineSpacing: number;
};

type DocumentExportRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  findGeneratedDocument: (input: { id: string; userId: string }) => Promise<GeneratedDocumentExportRow | null>;
  findResumeVersion: (input: { id: string; userId: string }) => Promise<ResumeVersionExportRow | null>;
};

export function createDocumentExportRouteHandlers(dependencies: DocumentExportRouteDependencies) {
  return {
    async POST(request: NextRequest) {
      try {
        const userId = await dependencies.requireUserId();
        await dependencies.checkRateLimit(`documents:export:${userId}`, 30, 60_000);
        const input = exportSchema.parse(await request.json());

        const document = input.documentId
          ? await dependencies.findGeneratedDocument({ id: input.documentId, userId })
          : null;
        const resumeVersion = input.resumeVersionId
          ? await dependencies.findResumeVersion({ id: input.resumeVersionId, userId })
          : null;

        const title = document?.title ?? resumeVersion?.title ?? "Apply Pilot document";
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
          const buffer = await renderGenericDocument({
            content: contentWithTitle,
            format: "docx",
            resumeFormat
          });

          return new NextResponse(new Uint8Array(buffer), {
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "content-disposition": `attachment; filename="${title.replace(/[^a-zA-Z0-9._-]/g, "_")}.docx"`
            }
          });
        }

        if (input.format === "pdf") {
          const buffer = await renderGenericDocument({
            content: contentWithTitle,
            format: "pdf",
            resumeFormat
          });
          return new NextResponse(new Uint8Array(buffer), {
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
  };
}

const handlers = createDocumentExportRouteHandlers({
  requireUserId,
  checkRateLimit,
  findGeneratedDocument: ({ id, userId }) =>
    prisma.generatedDocument.findFirst({ where: { id, userId } }),
  findResumeVersion: ({ id, userId }) =>
    prisma.resumeVersion.findFirst({ where: { id, userId } })
});

export const POST = handlers.POST;
