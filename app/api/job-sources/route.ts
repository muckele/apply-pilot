import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { jobSourceWriteSchema } from "@/lib/validators";

export async function GET() {
  try {
    const userId = await requireUserId();
    const sources = await prisma.jobSource.findMany({
      where: { userId },
      include: {
        _count: {
          select: { jobPostings: true }
        }
      },
      orderBy: [{ syncEnabled: "desc" }, { type: "asc" }, { name: "asc" }]
    });

    return NextResponse.json({ sources });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`job-sources:create:${userId}`, 20, 60_000);
    const input = jobSourceWriteSchema.parse(await request.json());

    const source = await prisma.jobSource.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        boardToken: input.boardToken,
        syncEnabled: input.syncEnabled,
        allowlisted: input.allowlisted,
        notes: input.notes,
        lastSyncStatus: "NEVER_SYNCED"
      }
    });

    await writeAuditLog({
      userId,
      action: "job.source.create",
      resource: "JobSource",
      resourceId: source.id
    });

    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
