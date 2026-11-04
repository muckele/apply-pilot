import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";
import {
  defaultResumeFormat,
  normalizeHexColor,
  type ResumeFormat
} from "@/lib/documents/resume-format";
import { documentReadinessError, resolveDocumentReadiness } from "@/lib/documents/document-review";
import { resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

import { pdfFonts } from "@/lib/documents/pdf-font";

const exportSchema = z.object({
  documentId: z.string().optional(),
  resumeVersionId: z.string().optional(),
  format: z.enum(["markdown", "docx", "pdf"]).default("markdown"),
  pdfFont: z.enum(pdfFonts).optional()
});

type GeneratedDocumentExportRow = {
  title: string;
  content: string;
  evidenceSnapshotId?: string | null;
  metadata?: unknown;
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
  metadata?: unknown;
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

export type DocumentExportRouteDependencies = {
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
        if (source?.jobPosting) {
          // D031: an exactly generated document exports while its evidence is current; an edited
          // or legacy document exports only once its review covers these exact current bytes.
          const currentEvidence = resolveCurrentReviewedEvidence(source.jobPosting, source.jobPosting.user.resumes[0] ?? null);
          const readiness = resolveDocumentReadiness({
            jobBound: true,
            currentEvidenceSnapshotId: source.jobPosting.currentEvidenceSnapshotId,
            currentEvidenceSourceValid: currentEvidence.currentEvidenceSourceValid,
            artifact: { evidenceSnapshotId: source.evidenceSnapshotId ?? null, content, metadata: source.metadata ?? null }
          });
          if (!readiness.exportReady) throw documentReadinessError(readiness.state, "export");
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
        // Titles label versions and filenames; the employer-facing body is the stored document text.
        const artifactType = document ? "COVER_LETTER" as const : "RESUME" as const;

        if (input.format === "docx") {
          const buffer = await renderProductDocument({
            content,
            artifactType,
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
          const buffer = await renderProductDocument({
            content,
            artifactType,
            format: "pdf",
            pdfFont: input.pdfFont,
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
