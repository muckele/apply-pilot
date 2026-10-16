import { NextRequest, NextResponse } from "next/server";

import { resolvePostingStatusForApplicationStatus } from "@/lib/applications/pipeline";
import {
  assertApplicationDocumentEvidenceCurrent,
  resolveEffectiveApplicationDocumentIds
} from "@/lib/applications/document-currentness";
import { PublicApiError } from "@/lib/api-errors";
import { normalizeApplicationPatch } from "@/lib/applications/status";
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { applicationUpdateSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`applications:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const application = await prisma.application.findFirstOrThrow({
      where: { id, userId },
      include: {
        jobPosting: true,
        events: { orderBy: { occurredAt: "desc" } },
        contacts: true,
        emails: { orderBy: { receivedAt: "desc" } },
        interviews: { orderBy: { scheduledAt: "asc" } }
      }
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const input = applicationUpdateSchema.parse(await request.json());
    const initial = await prisma.application.findFirstOrThrow({
      where: { id, userId },
      select: { jobPostingId: true }
    });
    const application = await prisma.$transaction(async (tx) => {
      const lockedJobs = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "JobPosting"
        WHERE "id" = ${initial.jobPostingId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (lockedJobs.length !== 1) throw new PublicApiError("Job posting not found.", 404);
      const [job, existing, masterResume] = await Promise.all([
        tx.jobPosting.findUniqueOrThrow({
          where: { id: initial.jobPostingId },
          include: { currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } }
        }),
        tx.application.findFirstOrThrow({ where: { id, userId, jobPostingId: initial.jobPostingId } }),
        tx.resume.findFirst({
          where: { userId, isMaster: true },
          orderBy: { updatedAt: "desc" },
          select: { id: true, updatedAt: true }
        })
      ]);
      const effective = resolveEffectiveApplicationDocumentIds(input, existing);
      const [resumeVersion, coverLetterVersion] = await Promise.all([
        effective.resumeVersionId
          ? tx.resumeVersion.findFirstOrThrow({
              where: { id: effective.resumeVersionId, userId, jobPostingId: existing.jobPostingId }
            })
          : null,
        effective.coverLetterVersionId
          ? tx.generatedDocument.findFirstOrThrow({
              where: {
                id: effective.coverLetterVersionId,
                userId,
                jobPostingId: existing.jobPostingId,
                type: "COVER_LETTER"
              }
            })
          : null
      ]);
      const evidence = resolveCurrentReviewedEvidence(job, masterResume);
      assertApplicationDocumentEvidenceCurrent({
        currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
        currentEvidenceSourceValid: evidence.currentEvidenceSourceValid,
        resumeVersion,
        coverLetterVersion
      });
      const { nextStatus, data: updateData } = normalizeApplicationPatch(input, existing);
      const postingStatus = resolvePostingStatusForApplicationStatus(nextStatus);
      const statusChanged = nextStatus !== existing.status;
      const savedApplication = await tx.application.update({
        where: { id: existing.id },
        data: updateData
      });

      if (postingStatus) {
        await tx.jobPosting.update({
          where: { id: existing.jobPostingId },
          data: { status: postingStatus }
        });
      }

      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: savedApplication.id,
          type: statusChanged ? "STATUS_CHANGED" : "NOTE_ADDED",
          title: statusChanged ? `Status changed to ${nextStatus}` : "Application updated",
          body: input.notes
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "application.update",
          resource: "Application",
          resourceId: savedApplication.id,
          metadata: {}
        }
      });

      return savedApplication;
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
