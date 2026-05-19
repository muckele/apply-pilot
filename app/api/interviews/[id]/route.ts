import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
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
    const { id } = await params;
    const input = interviewUpdateSchema.parse(await request.json());
    const existing = await prisma.interview.findFirstOrThrow({ where: { id, userId } });
    const interview = await prisma.interview.update({
      where: { id: existing.id },
      data: input
    });

    if (input.notes) {
      await prisma.interviewNote.create({
        data: {
          interviewId: interview.id,
          body: input.notes
        }
      });
    }

    await writeAuditLog({
      userId,
      action: "interview.update",
      resource: "Interview",
      resourceId: interview.id
    });

    return NextResponse.json({ interview });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
