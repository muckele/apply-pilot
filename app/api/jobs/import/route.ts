import { NextRequest, NextResponse } from "next/server";

import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import { upsertNormalizedJob, runJobMatch } from "@/lib/jobs";
import { LocalAiUnavailableError } from "@/lib/ai/client";
import { captureException } from "@/lib/monitoring/logger";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { manualJobImportSchema } from "@/lib/validators";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`job-import:${userId}`, 20, 60_000);

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

    try {
      await writeAuditLog({
        userId,
        action: "job.import.manual",
        resource: "JobPosting",
        resourceId: job.id
      });
    } catch (error) {
      // The persisted import remains successful even if its audit write fails.
      captureException(error, { source: "job.import.manual.audit", userId, jobPostingId: job.id });
    }

    if (!input.runMatch) {
      return NextResponse.json({ job, application, match: null, scoring: { status: "not_requested" } });
    }

    try {
      const match = await runJobMatch(userId, job.id);
      return NextResponse.json({ job: match.job, application, match, scoring: { status: "scored" } });
    } catch (error) {
      if (error instanceof LocalAiUnavailableError) {
        return NextResponse.json({ job, application, match: null, scoring: { status: "unavailable" } });
      }
      captureException(error, { source: "job.import.manual.scoring", userId, jobPostingId: job.id });
      return NextResponse.json({ job, application, match: null, scoring: { status: "failed" } });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
