import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { draftCoverLetter } from "@/lib/ai/documents";
import { aiInvocationFromRequest } from "@/lib/ai/http";
import { hashAiInput } from "@/lib/ai/input-hash";
import { tailorResume } from "@/lib/ai/resume";
import { PublicApiError } from "@/lib/api-errors";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

type SharedRouteDependencies = Readonly<{
  prismaClient: typeof prisma;
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  readApplicationDocumentEvidence: typeof readApplicationDocumentEvidence;
  writeAuditLog: typeof writeAuditLog;
}>;

type TailoredResumeRouteDependencies = SharedRouteDependencies & Readonly<{
  tailorResume: typeof tailorResume;
}>;

type CoverLetterRouteDependencies = SharedRouteDependencies & Readonly<{
  draftCoverLetter: typeof draftCoverLetter;
}>;

export function createTailoredResumeRouteHandler(dependencies: TailoredResumeRouteDependencies) {
  return async function POST(request: NextRequest, { params }: Params) {
    try {
      const userId = await dependencies.requireUserId();
      await dependencies.checkRateLimit(`tailor-resume:${userId}`, 12, 60_000);
      const { id } = await params;
      const sources = await dependencies.readApplicationDocumentEvidence(dependencies.prismaClient, userId, id);

      const tailored = await dependencies.tailorResume(
        sources.payload,
        sources.resume?.rawText ?? "",
        userId,
        aiInvocationFromRequest(request)
      );
      let version;
      try {
        version = await dependencies.prismaClient.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "JobPosting" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
          const fresh = await dependencies.readApplicationDocumentEvidence(tx, userId, id);
          if (hashAiInput("resumeTailorPrompt", tailored.promptVersion, fresh.payload) !== tailored.inputHash) {
            throw new PublicApiError("Evidence changed while the resume was being generated. Generate it again.", 409, {
              code: "APPLICATION_DOCUMENT_INPUT_STALE"
            });
          }
          const created = await tx.resumeVersion.create({
            data: {
              userId,
              resumeId: fresh.resume?.id,
              jobPostingId: fresh.job.id,
              evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId,
              title: `${fresh.job.company} - ${fresh.job.title} tailored resume`,
              summary: tailored.professionalSummary,
              skills: tailored.skillsSection,
              bullets: tailored.bulletRewrites,
              fullText: tailored.resumeText,
              changeNotes: tailored.rolesOrProjectsToEmphasize.join("; "),
              atsCompatibility: null,
              jobFitScore: null
            }
          });
          await tx.aIAnalysis.create({
            data: {
              userId,
              jobPostingId: fresh.job.id,
              evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId,
              type: "RESUME_TAILOR",
              model: tailored.model,
              promptName: "resumeTailorPrompt",
              promptVersion: tailored.promptVersion,
              inputHash: tailored.inputHash,
              input: { jobId: fresh.job.id, resumeId: fresh.resume?.id, evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId },
              output: tailored,
              confidence: null
            }
          });
          return created;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new PublicApiError("Evidence changed while the resume was being generated. Generate it again.", 409, {
            code: "APPLICATION_DOCUMENT_INPUT_STALE"
          });
        }
        throw error;
      }

      await dependencies.writeAuditLog({
        userId,
        action: "resume.tailor",
        resource: "ResumeVersion",
        resourceId: version.id
      });

      return NextResponse.json({ version, tailored });
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}

export function createCoverLetterRouteHandler(dependencies: CoverLetterRouteDependencies) {
  return async function POST(request: NextRequest, { params }: Params) {
    try {
      const userId = await dependencies.requireUserId();
      await dependencies.checkRateLimit(`cover-letter:${userId}`, 12, 60_000);
      const { id } = await params;
      const sources = await dependencies.readApplicationDocumentEvidence(dependencies.prismaClient, userId, id);
      const drafted = await dependencies.draftCoverLetter(
        sources.payload,
        userId,
        aiInvocationFromRequest(request)
      );
      let document;
      try {
        document = await dependencies.prismaClient.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "JobPosting" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
          const fresh = await dependencies.readApplicationDocumentEvidence(tx, userId, id);
          if (hashAiInput("coverLetterPrompt", drafted.promptVersion, fresh.payload) !== drafted.inputHash) {
            throw new PublicApiError("Evidence changed while the cover letter was being generated. Generate it again.", 409, {
              code: "APPLICATION_DOCUMENT_INPUT_STALE"
            });
          }
          const created = await tx.generatedDocument.create({
            data: {
              userId,
              jobPostingId: fresh.job.id,
              evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId,
              type: "COVER_LETTER",
              title: drafted.title,
              content: drafted.coverLetter,
              metadata: { angle: drafted.angle, claimsUsed: drafted.claimsUsed }
            }
          });
          await tx.aIAnalysis.create({
            data: {
              userId,
              jobPostingId: fresh.job.id,
              evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId,
              type: "COVER_LETTER",
              model: drafted.model,
              promptName: "coverLetterPrompt",
              promptVersion: drafted.promptVersion,
              inputHash: drafted.inputHash,
              input: { jobId: fresh.job.id, resumeId: fresh.resume?.id, evidenceSnapshotId: fresh.job.currentEvidenceSnapshotId },
              output: drafted,
              confidence: null
            }
          });
          return created;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new PublicApiError("Evidence changed while the cover letter was being generated. Generate it again.", 409, {
            code: "APPLICATION_DOCUMENT_INPUT_STALE"
          });
        }
        throw error;
      }

      await dependencies.writeAuditLog({
        userId,
        action: "cover-letter.generate",
        resource: "GeneratedDocument",
        resourceId: document.id
      });

      return NextResponse.json({ document, drafted });
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}
