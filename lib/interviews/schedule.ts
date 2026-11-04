import type { Prisma } from "@prisma/client";

type InterviewScheduleQuery = {
  where: Prisma.InterviewWhereInput;
  orderBy: Prisma.InterviewOrderByWithRelationInput[];
};

// "Upcoming" matches the dashboard count (scheduledAt >= now). Interviews with no date
// yet have not happened, so they list as upcoming, after the dated ones.
export function interviewScheduleQuery(userId: string, when: "upcoming" | "past", now: Date): InterviewScheduleQuery {
  if (when === "upcoming") {
    return {
      where: { userId, OR: [{ scheduledAt: { gte: now } }, { scheduledAt: null }] },
      orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]
    };
  }

  return {
    where: { userId, scheduledAt: { lt: now } },
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }]
  };
}
