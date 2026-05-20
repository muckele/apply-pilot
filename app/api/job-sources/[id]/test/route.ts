import { NextRequest, NextResponse } from "next/server";

import { markJobSourceTestResult, testJobSource } from "@/lib/job-sources/source-management";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { jobSourceSyncSchema } from "@/lib/validators";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  let ownedSourceId: string | null = null;

  try {
    const userId = await requireUserId();
    checkRateLimit(`job-sources:test:${userId}`, 20, 60_000);
    const input = jobSourceSyncSchema.parse(await request.json().catch(() => ({})));
    const source = await prisma.jobSource.findFirstOrThrow({ where: { id, userId } });
    ownedSourceId = source.id;
    const result = await testJobSource(source, input);

    await markJobSourceTestResult(source.id);
    await writeAuditLog({
      userId,
      action: "job.source.test",
      resource: "JobSource",
      resourceId: source.id,
      metadata: { rawCount: result.rawCount }
    });

    return NextResponse.json(result);
  } catch (error) {
    if (ownedSourceId) {
      await markJobSourceTestResult(ownedSourceId, error);
    }

    return apiErrorResponse(error);
  }
}
