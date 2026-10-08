import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { draftCoverLetter } from "@/lib/ai/documents";
import { hashAiInput } from "@/lib/ai/input-hash";
import { aiInvocationFromRequest } from "@/lib/ai/http";
import { PublicApiError } from "@/lib/api-errors";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`cover-letter:${userId}`, 12, 60_000);
    const { id } = await params;
    const sources = await readApplicationDocumentEvidence(prisma, userId, id);
    const drafted = await draftCoverLetter(
      sources.payload,
      userId,
      aiInvocationFromRequest(request)
    );
    let document;
    try {
      document = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "JobPosting" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const fresh = await readApplicationDocumentEvidence(tx, userId, id);
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

    await writeAuditLog({
      userId,
      action: "cover-letter.generate",
      resource: "GeneratedDocument",
      resourceId: document.id
    });

    return NextResponse.json({ document, drafted });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
