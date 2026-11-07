import type { Prisma, PrismaClient } from "@prisma/client";

import { APPLY_RETURN_METADATA_KEY, resolveApplyReturn, type ApplyReturnEvent } from "@/lib/applications/apply-return";

// Dashboard reminder for "Did you apply?": the owner's applications whose employer application they
// opened and have not yet answered. Read-only and owner-scoped; every row is re-checked before use.

export type ApplyReturnReminderDb = Pick<PrismaClient, "application">;

export type ApplyReturnReminderItem = {
  applicationId: string;
  jobId: string;
  title: string;
  company: string;
  openedAt: string;
  href: string;
};

export type ApplyReturnReminders = { count: number; items: ApplyReturnReminderItem[] };

// Enough candidates to sort by the most recent opening; the reminder shows only the first few.
const CANDIDATE_LIMIT = 50;

export async function loadApplyReturnReminders(db: ApplyReturnReminderDb, input: { userId: string; limit?: number }): Promise<ApplyReturnReminders> {
  const { userId } = input;
  const limit = input.limit ?? 5;
  const openedEvent = { userId, metadata: { path: [APPLY_RETURN_METADATA_KEY, "kind"], equals: "OPENED" } } satisfies Prisma.ApplicationEventWhereInput;
  const where = {
    userId,
    status: { in: ["SAVED", "INTERESTED"] },
    events: { some: openedEvent }
  } satisfies Prisma.ApplicationWhereInput;
  const [count, rows] = await Promise.all([
    db.application.count({ where }),
    db.application.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: CANDIDATE_LIMIT,
      select: {
        id: true,
        userId: true,
        status: true,
        jobPosting: { select: { id: true, userId: true, title: true, company: true } },
        events: {
          where: openedEvent,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true, userId: true, type: true, occurredAt: true, metadata: true }
        }
      }
    })
  ]);
  const items = rows.flatMap((row): ApplyReturnReminderItem[] => {
    if (row.userId !== userId || row.jobPosting.userId !== userId) return [];
    const { pending } = resolveApplyReturn({ userId, status: row.status, events: row.events as ApplyReturnEvent[] });
    if (!pending) return [];
    return [{
      applicationId: row.id,
      jobId: row.jobPosting.id,
      title: row.jobPosting.title,
      company: row.jobPosting.company,
      openedAt: pending.openedAt,
      href: `/jobs/${row.jobPosting.id}/apply`
    }];
  });
  items.sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  return { count, items: items.slice(0, limit) };
}
