import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

const jobStatusSchema = z.object({
  status: z.enum(["ACTIVE", "EXPIRED", "ARCHIVED"])
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`job-status:${userId}`, 40, 60_000);
    const { id } = await params;
    const input = jobStatusSchema.parse(await request.json());
    const existing = await prisma.jobPosting.findFirstOrThrow({ where: { id, userId } });
    const job = await prisma.jobPosting.update({
      where: { id: existing.id },
      data: { status: input.status }
    });

    await writeAuditLog({
      userId,
      action: "job.status.update",
      resource: "JobPosting",
      resourceId: job.id,
      metadata: { from: existing.status, to: input.status }
    });

    return NextResponse.json({ job });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
