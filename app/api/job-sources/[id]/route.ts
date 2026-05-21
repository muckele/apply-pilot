import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { jobSourcePatchSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    checkRateLimit(`job-sources:update:${userId}`, 40, 60_000);
    const input = jobSourcePatchSchema.parse(await request.json());
    const existing = await prisma.jobSource.findFirstOrThrow({ where: { id, userId } });
    const resetsSyncHealth = "type" in input || "baseUrl" in input || "boardToken" in input;

    const source = await prisma.jobSource.update({
      where: { id: existing.id },
      data: {
        ...input,
        lastSyncStatus: resetsSyncHealth ? "NEEDS_TEST" : existing.lastSyncStatus,
        lastSyncError: resetsSyncHealth ? null : existing.lastSyncError
      }
    });

    await writeAuditLog({
      userId,
      action: "job.source.update",
      resource: "JobSource",
      resourceId: source.id
    });

    return NextResponse.json({ source });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    checkRateLimit(`job-sources:delete:${userId}`, 20, 60_000);
    const existing = await prisma.jobSource.findFirstOrThrow({
      where: { id, userId },
      include: {
        _count: {
          select: { jobPostings: true }
        }
      }
    });

    const confirmation = _request.nextUrl.searchParams.get("confirm");
    if (confirmation !== existing.id) {
      return NextResponse.json(
        {
          error: "Deletion requires explicit confirmation.",
          confirmationRequired: true,
          sourceId: existing.id,
          jobPostings: existing._count.jobPostings
        },
        { status: 400 }
      );
    }

    await prisma.jobSource.delete({ where: { id: existing.id } });

    await writeAuditLog({
      userId,
      action: "job.source.delete",
      resource: "JobSource",
      resourceId: existing.id
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
