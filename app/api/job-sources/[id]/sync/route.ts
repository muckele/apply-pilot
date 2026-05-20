import { NextRequest, NextResponse } from "next/server";

import { runJobSourceSync } from "@/lib/job-sources/source-management";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { jobSourceSyncSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    checkRateLimit(`job-sources:sync:${userId}`, 10, 60_000);
    const input = jobSourceSyncSchema.parse(await request.json().catch(() => ({})));
    const source = await prisma.jobSource.findFirstOrThrow({ where: { id, userId } });
    const result = await runJobSourceSync({ userId, source, options: input });

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
