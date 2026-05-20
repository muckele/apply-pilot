import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { importJobsFromSource } from "@/lib/job-sources/discovery";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { prisma } from "@/lib/prisma";

const syncSchema = z.object({
  jobSourceId: z.string(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`job-sync:${userId}`, 6, 60_000);
    const input = syncSchema.parse(await request.json());
    const source = await prisma.jobSource.findFirstOrThrow({
      where: { id: input.jobSourceId, userId }
    });
    const profile = await prisma.userProfile.findUnique({ where: { userId } });
    const result = await importJobsFromSource({
      userId,
      source,
      criteria: {
        company: source.boardToken ?? source.name,
        boardToken: source.boardToken ?? undefined,
        url: source.baseUrl ?? undefined,
        limit: input.limit
      },
      profile
    });

    await prisma.jobSource.update({
      where: { id: source.id },
      data: { lastSyncedAt: new Date() }
    });

    await writeAuditLog({
      userId,
      action: "job.source.sync",
      resource: "JobSource",
      resourceId: source.id,
      metadata: { imported: result.imported.length, skipped: result.skipped }
    });

    return NextResponse.json({
      imported: result.imported.length,
      skipped: result.skipped,
      bestRelevanceScore: result.bestRelevanceScore,
      jobs: result.imported
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
