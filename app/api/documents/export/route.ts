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
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  isEvidenceBindingCurrent,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";
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
  evidenceSnapshotId?: string | null;
  jobPosting?: ExportJobEvidence | null;
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
  evidenceSnapshotId?: string | null;
  jobPosting?: ExportJobEvidence | null;
};

type ExportJobEvidence = {
  currentEvidenceSnapshotId: string | null;
  evidenceSnapshotGeneration: number;
  currentEvidenceSnapshot: {
    id: string;
    resumeId: string;
    sourceResumeUpdatedAt: Date;
    snapshotHash: string;
    reviewPayload: unknown;
  } | null;
  user: { resumes: Array<{ id: string; updatedAt: Date }> };
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
        const source = document ?? resumeVersion;
        const currentEvidence = source?.jobPosting
          ? resolveCurrentReviewedEvidence(source.jobPosting, source.jobPosting.user.resumes[0] ?? null)
          : null;
        if (source?.jobPosting && !isEvidenceBindingCurrent({
          currentEvidenceSnapshotId: source.jobPosting.currentEvidenceSnapshotId,
          currentEvidenceSourceValid: currentEvidence?.currentEvidenceSourceValid ?? false,
          artifactEvidenceSnapshotId: source.evidenceSnapshotId ?? null
        })) {
          throw new PublicApiError("Regenerate this document from the current reviewed evidence before exporting it.", 409, {
            code: "APPLICATION_DOCUMENT_EVIDENCE_STALE"
          });
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

const exportJobEvidenceSelect = {
  currentEvidenceSnapshotId: true,
  evidenceSnapshotGeneration: true,
  currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
  user: {
    select: {
      resumes: {
        where: { isMaster: true },
        orderBy: { updatedAt: "desc" as const },
        take: 1,
        select: { id: true, updatedAt: true }
      }
    }
  }
} as const;

const handlers = createDocumentExportRouteHandlers({
  requireUserId,
  checkRateLimit,
  findGeneratedDocument: async ({ id, userId }) => {
    const initial = await prisma.generatedDocument.findFirst({
      where: { id, userId },
      select: { jobPostingId: true }
    });
    if (!initial) return null;
    return prisma.$transaction(async (tx) => {
      if (initial.jobPostingId) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "JobPosting"
          WHERE "id" = ${initial.jobPostingId} AND "userId" = ${userId}
          FOR SHARE
        `;
        if (locked.length !== 1) return null;
      }
      return tx.generatedDocument.findFirst({
        where: { id, userId, jobPostingId: initial.jobPostingId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      });
    });
  },
  findResumeVersion: async ({ id, userId }) => {
    const initial = await prisma.resumeVersion.findFirst({
      where: { id, userId },
      select: { jobPostingId: true }
    });
    if (!initial) return null;
    return prisma.$transaction(async (tx) => {
      if (initial.jobPostingId) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "JobPosting"
          WHERE "id" = ${initial.jobPostingId} AND "userId" = ${userId}
          FOR SHARE
        `;
        if (locked.length !== 1) return null;
      }
      return tx.resumeVersion.findFirst({
        where: { id, userId, jobPostingId: initial.jobPostingId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      });
    });
  }
});

export const POST = handlers.POST;
