import { NextRequest, NextResponse } from "next/server";

import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import { upsertNormalizedJob, runJobMatch } from "@/lib/jobs";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { manualJobImportSchema } from "@/lib/validators";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`job-import:${userId}`, 20, 60_000);

    const input = manualJobImportSchema.parse(await request.json());
    const provider = new ManualJobImportProvider();
    const normalizedJob = provider.normalizeJob(input);
    const job = await upsertNormalizedJob({ userId, job: normalizedJob });

    const application = await prisma.application.upsert({
      where: { userId_jobPostingId: { userId, jobPostingId: job.id } },
      create: {
        userId,
        jobPostingId: job.id,
        status: "SAVED",
        nextAction: "Review fit analysis and decide whether to apply."
      },
      update: {}
    });

    let match = null;
    if (input.runMatch) {
      match = await runJobMatch(userId, job.id);
    }

    await writeAuditLog({
      userId,
      action: "job.import.manual",
      resource: "JobPosting",
      resourceId: job.id
    });

    return NextResponse.json({ job, application, match });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
