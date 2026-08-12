import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { runJobSourceSync } from "@/lib/job-sources/source-management";
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
    await checkRateLimit(`job-sync:${userId}`, 6, 60_000);
    const input = syncSchema.parse(await request.json());
    const source = await prisma.jobSource.findFirstOrThrow({
      where: { id: input.jobSourceId, userId }
    });
    const result = await runJobSourceSync({
      userId,
      source,
      options: {
        limit: input.limit
      }
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
