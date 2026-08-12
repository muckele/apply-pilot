import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { interviewUpdateSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const interview = await prisma.interview.findFirstOrThrow({
      where: { id, userId },
      include: {
        jobPosting: true,
        application: true,
        notesList: { orderBy: { createdAt: "desc" } },
        recordings: { orderBy: { createdAt: "desc" } }
      }
    });

    return NextResponse.json({ interview });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interviews:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = interviewUpdateSchema.parse(await request.json());
    const existing = await prisma.interview.findFirstOrThrow({ where: { id, userId } });
    const interview = await prisma.$transaction(async (tx) => {
      const updated = await tx.interview.update({
        where: { id: existing.id },
        data: input
      });

      if (input.notes) {
        await tx.interviewNote.create({
          data: {
            interviewId: updated.id,
            body: input.notes
          }
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.update",
          resource: "Interview",
          resourceId: updated.id,
          metadata: {}
        }
      });

      return updated;
    });

    return NextResponse.json({ interview });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
