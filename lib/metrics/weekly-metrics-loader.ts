import type { PrismaClient } from "@prisma/client";

import { SELF_REPORTED_EFFORT_METADATA_KEY, SELF_REPORTED_EFFORT_SCHEMA } from "@/lib/applications/self-reported-effort";
import { SENT_DOCUMENTS_METADATA_KEY, SENT_DOCUMENTS_SCHEMA } from "@/lib/apply-kit/sent-documents";
import { computeWeeklyMetrics, type WeeklyMetricsReport } from "@/lib/metrics/weekly-metrics";
import { METRICS_TIME_ZONE, buildMetricWeeks } from "@/lib/metrics/weeks";

export type WeeklyMetricsDb = Pick<
  PrismaClient,
  "user" | "jobPosting" | "application" | "applicationEvent" | "resumeVersion" | "generatedDocument" | "interview" | "aIUsageEvent"
>;

export type LoadedWeeklyMetrics = WeeklyMetricsReport & { timeZone: string };

const STATUS_EVENT_TYPES = ["CREATED", "STATUS_CHANGED"] as const;

/**
 * Reads one user's rows for the measurement page and hands them to the pure counter. Every
 * query filters by `userId`. Feed jobs and AI usage are bounded to the shown weeks; tracker rows
 * are read whole because an application's first interview or first tailored document can come
 * before the range, and one person's tracker is small. Only applications applied inside the range
 * have their APPLIED events read (the frozen "what I sent" record and self-reported minutes),
 * because the snapshots carry full document text.
 */
export async function loadWeeklyMetrics(db: WeeklyMetricsDb, input: {
  userId: string;
  now: Date;
  weekCount: number;
  timeZone?: string;
}): Promise<LoadedWeeklyMetrics> {
  const { userId, now } = input;
  const timeZone = input.timeZone ?? METRICS_TIME_ZONE;
  const weeks = buildMetricWeeks({ now, count: input.weekCount, timeZone });
  const range = { gte: weeks[0].start, lt: weeks[weeks.length - 1].end };

  const [user, jobs, applications, statusEvents, resumeVersions, generatedDocuments, interviews, aiUsage] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, createdAt: true } }),
    db.jobPosting.findMany({
      where: { userId, firstDiscoveredAt: range },
      select: { id: true, userId: true, firstDiscoveredAt: true }
    }),
    db.application.findMany({
      where: { userId },
      select: { id: true, userId: true, jobPostingId: true, status: true, createdAt: true, dateApplied: true }
    }),
    db.applicationEvent.findMany({
      where: { userId, type: { in: [...STATUS_EVENT_TYPES] } },
      select: { id: true, userId: true, applicationId: true, type: true, title: true, occurredAt: true }
    }),
    db.resumeVersion.findMany({
      where: { userId, jobPostingId: { not: null } },
      select: { userId: true, jobPostingId: true, createdAt: true }
    }),
    db.generatedDocument.findMany({
      where: { userId, jobPostingId: { not: null }, type: { in: ["TAILORED_RESUME", "COVER_LETTER"] } },
      select: { userId: true, jobPostingId: true, createdAt: true }
    }),
    db.interview.findMany({
      where: { userId },
      select: { id: true, userId: true, applicationId: true, jobPostingId: true, createdAt: true, scheduledAt: true }
    }),
    db.aIUsageEvent.findMany({
      where: { userId, createdAt: range },
      select: { userId: true, createdAt: true, estimatedCostMicros: true }
    })
  ]);
  if (!user) throw new Error("The signed-in user record was not found.");

  const appliedInRangeIds = applications
    .filter((application) =>
      application.userId === userId &&
      application.dateApplied !== null &&
      application.dateApplied.getTime() >= range.gte.getTime() &&
      application.dateApplied.getTime() < range.lt.getTime())
    .map((application) => application.id);
  // One read for the APPLIED events of in-range applications: their "what I sent" snapshot and
  // self-reported minutes share the event, so reading them together avoids loading it twice.
  const appliedEvents = appliedInRangeIds.length
    ? await db.applicationEvent.findMany({
        where: {
          userId,
          applicationId: { in: appliedInRangeIds },
          OR: [
            { metadata: { path: [SENT_DOCUMENTS_METADATA_KEY, "schema"], equals: SENT_DOCUMENTS_SCHEMA } },
            { metadata: { path: [SELF_REPORTED_EFFORT_METADATA_KEY, "schema"], equals: SELF_REPORTED_EFFORT_SCHEMA } }
          ]
        },
        select: { id: true, userId: true, applicationId: true, occurredAt: true, metadata: true }
      })
    : [];

  const report = computeWeeklyMetrics({
    userId,
    weeks,
    now,
    rows: {
      account: { userId: user.id, createdAt: user.createdAt },
      jobs,
      applications,
      statusEvents,
      appliedEvents,
      tailoredDocuments: [...resumeVersions, ...generatedDocuments],
      interviews,
      aiUsage
    }
  });
  return { ...report, timeZone };
}
