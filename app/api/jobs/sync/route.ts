import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getJobSourceProvider } from "@/lib/job-sources";
import { upsertNormalizedJob } from "@/lib/jobs";
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
    const provider = getJobSourceProvider(source.type);
    const rawJobs = await provider.searchJobs({
      company: source.boardToken ?? source.name,
      boardToken: source.boardToken ?? undefined,
      url: source.baseUrl ?? undefined,
      limit: input.limit
    });

    const jobs = [];
    for (const rawJob of rawJobs) {
      const normalized = provider.normalizeJob(rawJob);
      const job = await upsertNormalizedJob({
        userId,
        jobSourceId: source.id,
        job: {
          ...normalized,
          company: normalized.company || source.name
        }
      });
      jobs.push(job);
    }

    await prisma.jobSource.update({
      where: { id: source.id },
      data: { lastSyncedAt: new Date() }
    });

    await writeAuditLog({
      userId,
      action: "job.source.sync",
      resource: "JobSource",
      resourceId: source.id,
      metadata: { imported: jobs.length }
    });

    return NextResponse.json({ imported: jobs.length, jobs });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
