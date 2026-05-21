import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { applicationUpdateSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
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
      input.coverLetterVersionId
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
    const application = await prisma.application.update({
      where: { id: existing.id },
      data: input
    });

    await prisma.applicationEvent.create({
      data: {
        userId,
        applicationId: application.id,
        type: input.status && input.status !== existing.status ? "STATUS_CHANGED" : "NOTE_ADDED",
        title:
          input.status && input.status !== existing.status
            ? `Status changed to ${input.status}`
            : "Application updated",
        body: input.notes
      }
    });

    await writeAuditLog({
      userId,
      action: "application.update",
      resource: "Application",
      resourceId: application.id
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
