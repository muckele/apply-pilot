import { NextRequest, NextResponse } from "next/server";

import { resolvePostingStatusForApplicationStatus } from "@/lib/applications/pipeline";
import { normalizeApplicationPatch } from "@/lib/applications/status";
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
    const existing = await prisma.application.findFirstOrThrow({ where: { id, userId } });
    await Promise.all([
      input.resumeVersionId
        ? prisma.resumeVersion.findFirstOrThrow({
            where: { id: input.resumeVersionId, userId, jobPostingId: existing.jobPostingId }
          })
        : null,
      typeof input.coverLetterVersionId === "string"
        ? prisma.generatedDocument.findFirstOrThrow({
            where: {
              id: input.coverLetterVersionId,
              userId,
              jobPostingId: existing.jobPostingId,
              type: "COVER_LETTER"
            }
          })
        : null
    ]);
    const { nextStatus, data: updateData } = normalizeApplicationPatch(input, existing);

    const postingStatus = resolvePostingStatusForApplicationStatus(nextStatus);
    const statusChanged = nextStatus !== existing.status;
    const application = await prisma.$transaction(async (tx) => {
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
