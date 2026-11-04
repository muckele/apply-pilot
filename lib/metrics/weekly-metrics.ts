import type { ApplicationStatus } from "@prisma/client";

import { applicationStatusOptions } from "@/lib/applications/pipeline";
import { latestSentDocumentsEvent } from "@/lib/apply-kit/sent-documents";
import type { MetricWeek } from "@/lib/metrics/weeks";
import { ONBOARDING_APPLIED_STATUSES } from "@/lib/onboarding";

// Weekly job-search numbers for one user (MVP Bible WP1.9 and §11). Pure: the loader reads the
// rows, this module only counts them. Every row is checked against `userId` again here, so a
// loader mistake can never let another user's data into the numbers. A metric that cannot be
// computed honestly says so ("not measured" or "not enough data") instead of showing 0.

export const SMALL_SAMPLE_SIZE = 5;

export const INTERVIEW_STAGE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  "RECRUITER_SCREEN",
  "HIRING_MANAGER_SCREEN",
  "TECHNICAL_INTERVIEW",
  "FINAL_INTERVIEW",
  "OFFER"
]);

export const WEEKLY_METRIC_DEFINITIONS = {
  jobsAdded: {
    label: "Jobs added to your feed",
    howComputed:
      "Jobs that arrived in your feed, from a source sync or a job you imported, counted on the day Apply Pilot first found them. Apply Pilot doesn't record which jobs you opened, so this is jobs added, not jobs viewed."
  },
  jobsSaved: {
    label: "Saved to tracker",
    howComputed: "Jobs you added to your tracker, counted on the day the tracker record was created, whatever its status is now."
  },
  kitsPrepared: {
    label: "Apply Kits prepared",
    howComputed:
      "Jobs that got their first tailored résumé or cover letter. A job counts once, in the week its first tailored document was made; later versions and edits don't count again."
  },
  applied: {
    label: "Applied",
    howComputed:
      "Applications whose applied date falls in the week. The applied date is set when you click \"I applied\" or move a card to Applied, and you can change it."
  },
  interviews: {
    label: "Interviews",
    howComputed:
      "Applications that reached an interview for the first time. Each counts once, at its earliest interview signal: an interview you added for it (its date, or the day you added it if that is earlier) or a move to a screen, interview or offer stage. An interview not linked to a tracked application counts on its own."
  },
  interviewsPerApplicantHour: {
    label: "Interviews per applicant-hour",
    howComputed:
      "Interviews divided by hours of active job-search effort. Apply Pilot doesn't record time spent applying yet, so there is no denominator; the interview count is shown on its own."
  },
  effortMinutesPerApplication: {
    label: "Minutes of effort per application",
    howComputed:
      "Minutes of active effort divided by applications. Not recorded yet: Apply Pilot doesn't log when you start working on an application or how long you spend on the form."
  },
  tailoredShare: {
    label: "Sent with tailored documents",
    howComputed:
      "Of the week's applications that have a \"what I sent\" record, the share whose record includes a tailored résumé or cover letter. Applications with no record (applied before the record existed, or moved straight past Applied) are left out."
  },
  aiCostPerApplication: {
    label: "AI cost per application",
    howComputed:
      "All AI spend recorded in the week, across every feature, divided by the week's applications. It includes AI work on jobs you didn't apply to."
  },
  completeTracking: {
    label: "Complete tracking",
    howComputed:
      "Of the week's applications, the share whose \"what I sent\" record names at least one document and whose status is at or past Applied (not archived). Whether the status is up to date is not judged."
  },
  interviewRate: {
    label: "Interview rate so far",
    howComputed:
      "Of the week's applications, the share that has reached an interview since. Recent weeks are still maturing, so this can rise later."
  },
  feedSaveRate: {
    label: "Feed jobs saved",
    howComputed: "Of the jobs added to your feed in the week, the share you have saved to the tracker since."
  },
  aiSpend: {
    label: "AI spend",
    howComputed:
      "The settled cost of every AI request in the week, from the budget ledger's usage records. Requests with no recorded cost are counted separately and left out of the sum."
  }
} as const satisfies Record<string, { label: string; howComputed: string }>;

export type WeeklyMetricKey = keyof typeof WEEKLY_METRIC_DEFINITIONS;

export type WeeklyMetricsRows = {
  account: { userId: string; createdAt: Date };
  jobs: Array<{ id: string; userId: string; firstDiscoveredAt: Date }>;
  applications: Array<{
    id: string;
    userId: string;
    jobPostingId: string;
    status: ApplicationStatus;
    createdAt: Date;
    dateApplied: Date | null;
  }>;
  statusEvents: Array<{ id: string; userId: string; applicationId: string; type: string; title: string; occurredAt: Date }>;
  sentDocumentEvents: Array<{ id: string; userId: string; applicationId: string; occurredAt: Date; metadata: unknown }>;
  tailoredDocuments: Array<{ userId: string; jobPostingId: string | null; createdAt: Date }>;
  interviews: Array<{
    id: string;
    userId: string;
    applicationId: string | null;
    jobPostingId: string | null;
    createdAt: Date;
    scheduledAt: Date | null;
  }>;
  aiUsage: Array<{ userId: string; createdAt: Date; estimatedCostMicros: number | null }>;
};

export type NotEnoughData = { kind: "not_enough_data"; reason: string };
export type NotMeasured = { kind: "not_measured"; reason: string };
export type RatioMetric = { kind: "ratio"; numerator: number; denominator: number; value: number; smallSample: boolean };
export type MoneyPerItemMetric = {
  kind: "money_per_item";
  totalMicros: number;
  items: number;
  valueMicros: number;
  smallSample: boolean;
};

export type PeriodMetrics = {
  label: string;
  start: Date;
  end: Date;
  isCurrent: boolean;
  funnel: { jobsAdded: number; jobsSaved: number; kitsPrepared: number; applied: number; interviews: number };
  aiSpend: { micros: number; requests: number; unknownCostRequests: number };
  metrics: {
    interviewsPerApplicantHour: NotMeasured;
    effortMinutesPerApplication: NotMeasured;
    tailoredShare: RatioMetric | NotEnoughData;
    aiCostPerApplication: MoneyPerItemMetric | NotEnoughData;
    completeTracking: RatioMetric | NotEnoughData;
    interviewRate: RatioMetric | NotEnoughData;
    feedSaveRate: RatioMetric | NotEnoughData;
  };
};

export type WeeklyMetricsReport = {
  /** Oldest first; weeks before the user's first recorded activity are left out. */
  weeks: PeriodMetrics[];
  total: PeriodMetrics;
  hiddenWeeks: number;
  dataNotes: string[];
};

const NOT_RECORDED_TIME: NotMeasured = {
  kind: "not_measured",
  reason: "Apply Pilot doesn't record the time you spend applying."
};
const NO_APPLICATIONS: NotEnoughData = {
  kind: "not_enough_data",
  reason: "No applications recorded as applied in this period."
};
const NO_FEED_JOBS: NotEnoughData = {
  kind: "not_enough_data",
  reason: "No jobs were added to your feed in this period."
};

const EVENT_TITLE_STATUS = /^(?:Status changed to|Created as) (.+)$/u;
// Timeline titles are written by the applications API from formatApplicationStatus; events
// stored before that change carry the raw enum name instead, so both spellings are accepted.
const STATUS_BY_TITLE_TEXT = new Map<string, ApplicationStatus>(
  applicationStatusOptions.flatMap((option) => [[option.value, option.value], [option.label, option.value]] as const)
);
const appliedStatuses = new Set(ONBOARDING_APPLIED_STATUSES);
const interviewStages = new Set(INTERVIEW_STAGE_STATUSES);

export function statusFromEventTitle(title: string): ApplicationStatus | null {
  const match = EVENT_TITLE_STATUS.exec(title.trim());
  return match ? STATUS_BY_TITLE_TEXT.get(match[1]) ?? null : null;
}

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function ratio(numerator: number, denominator: number): RatioMetric {
  return {
    kind: "ratio",
    numerator,
    denominator,
    value: numerator / denominator,
    smallSample: denominator < SMALL_SAMPLE_SIZE
  };
}

function earliest(dates: Iterable<Date>) {
  let result: Date | null = null;
  for (const date of dates) {
    if (!result || date.getTime() < result.getTime()) result = date;
  }
  return result;
}

function keepEarliest(map: Map<string, Date>, key: string, date: Date) {
  const current = map.get(key);
  if (!current || date.getTime() < current.getTime()) map.set(key, date);
}

type OwnedData = ReturnType<typeof ownedData>;

function ownedData(userId: string, rows: WeeklyMetricsRows) {
  const applications = rows.applications.filter((row) => row.userId === userId);
  const applicationIds = new Set(applications.map((row) => row.id));
  const applicationIdByJob = new Map(applications.map((row) => [row.jobPostingId, row.id] as const));
  const ownsApplication = (row: { userId: string; applicationId: string }) =>
    row.userId === userId && applicationIds.has(row.applicationId);

  const jobs = rows.jobs.filter((row) => row.userId === userId);
  const statusEvents = rows.statusEvents.filter(ownsApplication);
  const aiUsage = rows.aiUsage.filter((row) => row.userId === userId);

  const sentDocumentEvents = rows.sentDocumentEvents.filter(ownsApplication);
  const latestSent = new Map(applications.flatMap((application) => {
    const latest = latestSentDocumentsEvent(sentDocumentEvents.filter((event) => event.applicationId === application.id));
    return latest ? [[application.id, latest.snapshot] as const] : [];
  }));

  const firstTailoredDocumentByJob = new Map<string, Date>();
  for (const document of rows.tailoredDocuments) {
    if (document.userId === userId && document.jobPostingId) {
      keepEarliest(firstTailoredDocumentByJob, document.jobPostingId, document.createdAt);
    }
  }

  // Earliest interview signal per application (or per unlinked interview).
  const firstInterviewSignal = new Map<string, Date>();
  for (const event of statusEvents) {
    const status = statusFromEventTitle(event.title);
    if (status && interviewStages.has(status)) keepEarliest(firstInterviewSignal, event.applicationId, event.occurredAt);
  }
  for (const interview of rows.interviews) {
    if (interview.userId !== userId) continue;
    const linkedApplicationId =
      (interview.applicationId && applicationIds.has(interview.applicationId) ? interview.applicationId : null) ??
      (interview.jobPostingId ? applicationIdByJob.get(interview.jobPostingId) : undefined);
    const signalAt = earliest([interview.createdAt, interview.scheduledAt ?? interview.createdAt])!;
    keepEarliest(firstInterviewSignal, linkedApplicationId ?? `interview:${interview.id}`, signalAt);
  }

  const firstActivityAt = earliest([
    rows.account.createdAt,
    ...jobs.map((row) => row.firstDiscoveredAt),
    ...applications.flatMap((row) => (row.dateApplied ? [row.createdAt, row.dateApplied] : [row.createdAt])),
    ...statusEvents.map((row) => row.occurredAt),
    ...sentDocumentEvents.map((row) => row.occurredAt),
    ...firstTailoredDocumentByJob.values(),
    ...firstInterviewSignal.values(),
    ...aiUsage.map((row) => row.createdAt)
  ])!;

  return { applications, jobs, aiUsage, latestSent, firstTailoredDocumentByJob, firstInterviewSignal, firstActivityAt };
}

function computePeriod(
  data: OwnedData,
  period: { label: string; start: Date; end: Date; isCurrent: boolean },
  now: Date
): PeriodMetrics {
  const within = (date: Date | null) =>
    date !== null && date.getTime() >= period.start.getTime() && date.getTime() < period.end.getTime() &&
    date.getTime() <= now.getTime();
  const countWithin = (dates: Iterable<Date>) => [...dates].filter(within).length;

  const feedJobs = data.jobs.filter((job) => within(job.firstDiscoveredAt));
  const applied = data.applications.filter((application) => within(application.dateApplied));
  const usage = data.aiUsage.filter((row) => within(row.createdAt));
  const costed = usage.filter((row) => row.estimatedCostMicros !== null);
  const spendMicros = costed.reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0);

  const withSentRecord = applied.filter((application) => data.latestSent.has(application.id));
  const sentTailored = withSentRecord.filter((application) => {
    const snapshot = data.latestSent.get(application.id)!;
    return snapshot.resume !== null || snapshot.coverLetter !== null;
  });
  const completelyTracked = sentTailored.filter((application) => appliedStatuses.has(application.status));
  const reachedInterview = applied.filter((application) => data.firstInterviewSignal.has(application.id));
  const savedApplicationJobs = new Set(data.applications.map((application) => application.jobPostingId));

  return {
    ...period,
    funnel: {
      jobsAdded: feedJobs.length,
      jobsSaved: countWithin(data.applications.map((application) => application.createdAt)),
      kitsPrepared: countWithin(data.firstTailoredDocumentByJob.values()),
      applied: applied.length,
      interviews: countWithin(data.firstInterviewSignal.values())
    },
    aiSpend: { micros: spendMicros, requests: usage.length, unknownCostRequests: usage.length - costed.length },
    metrics: {
      interviewsPerApplicantHour: NOT_RECORDED_TIME,
      effortMinutesPerApplication: NOT_RECORDED_TIME,
      tailoredShare: withSentRecord.length
        ? ratio(sentTailored.length, withSentRecord.length)
        : applied.length
          ? {
              kind: "not_enough_data",
              reason: `None of this period's ${plural(applied.length, "application", "applications")} has a record of what was sent.`
            }
          : NO_APPLICATIONS,
      aiCostPerApplication: applied.length
        ? {
            kind: "money_per_item",
            totalMicros: spendMicros,
            items: applied.length,
            valueMicros: Math.round(spendMicros / applied.length),
            smallSample: applied.length < SMALL_SAMPLE_SIZE
          }
        : NO_APPLICATIONS,
      completeTracking: applied.length ? ratio(completelyTracked.length, applied.length) : NO_APPLICATIONS,
      interviewRate: applied.length ? ratio(reachedInterview.length, applied.length) : NO_APPLICATIONS,
      feedSaveRate: feedJobs.length
        ? ratio(feedJobs.filter((job) => savedApplicationJobs.has(job.id)).length, feedJobs.length)
        : NO_FEED_JOBS
    }
  };
}

function buildDataNotes(data: OwnedData, total: PeriodMetrics) {
  const notes: string[] = [];
  const undated = data.applications.filter((application) => !application.dateApplied && appliedStatuses.has(application.status));
  if (undated.length) {
    notes.push(
      undated.length === 1
        ? "1 application is past Applied but has no applied date, so no week counts it as applied."
        : `${undated.length} applications are past Applied but have no applied date, so no week counts them as applied.`
    );
  }
  const undatedInterviews = data.applications.filter((application) =>
    interviewStages.has(application.status) && !data.firstInterviewSignal.has(application.id));
  if (undatedInterviews.length) {
    notes.push(
      undatedInterviews.length === 1
        ? "1 application is at an interview stage with no dated interview record, so no week counts its interview."
        : `${undatedInterviews.length} applications are at an interview stage with no dated interview record, so no week counts their interviews.`
    );
  }
  const unknownCost = total.aiSpend.unknownCostRequests;
  if (unknownCost) {
    notes.push(
      unknownCost === 1
        ? "1 AI request has no recorded cost, so AI spend leaves it out."
        : `${unknownCost} AI requests have no recorded cost, so AI spend leaves them out.`
    );
  }
  return notes;
}

export function computeWeeklyMetrics(input: {
  userId: string;
  weeks: MetricWeek[];
  now: Date;
  rows: WeeklyMetricsRows;
}): WeeklyMetricsReport {
  const { userId, now, rows } = input;
  if (rows.account.userId !== userId) {
    throw new Error("The metrics account record does not belong to the signed-in user.");
  }
  if (!input.weeks.length) throw new RangeError("At least one week is required.");

  const data = ownedData(userId, rows);
  const activeWeeks = input.weeks.filter((week) => week.end.getTime() > data.firstActivityAt.getTime());
  const shownWeeks = activeWeeks.length ? activeWeeks : input.weeks.slice(-1);
  const weeks = shownWeeks.map((week) =>
    computePeriod(data, { label: week.label, start: week.start, end: week.end, isCurrent: week.isCurrent }, now));
  const total = computePeriod(data, {
    label: `Last ${plural(shownWeeks.length, "week", "weeks")}`,
    start: shownWeeks[0].start,
    end: shownWeeks[shownWeeks.length - 1].end,
    isCurrent: false
  }, now);

  return {
    weeks,
    total,
    hiddenWeeks: input.weeks.length - shownWeeks.length,
    dataNotes: buildDataNotes(data, total)
  };
}
