import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationStatus } from "@prisma/client";

import { SELF_REPORTED_EFFORT_METADATA_KEY, buildSelfReportedEffort } from "@/lib/applications/self-reported-effort";
import { SENT_DOCUMENTS_METADATA_KEY, SENT_DOCUMENTS_SCHEMA } from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import {
  SMALL_SAMPLE_SIZE,
  WEEKLY_METRIC_DEFINITIONS,
  computeWeeklyMetrics,
  statusFromEventTitle,
  type WeeklyMetricsReport,
  type WeeklyMetricsRows
} from "@/lib/metrics/weekly-metrics";
import { buildMetricWeeks } from "@/lib/metrics/weeks";

const USER = "user-a";
const OTHER = "user-b";
// Wednesday 2026-11-04 12:00 PST. Weeks: 2026-10-19, 2026-10-26 (169 h, clock change), 2026-11-02.
const NOW = new Date("2026-11-04T20:00:00Z");
const WEEKS = buildMetricWeeks({ now: NOW, count: 3 });
const W1 = "2026-10-19";
const W2 = "2026-10-26";
const W3 = "2026-11-02";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;
const at = (value: string) => new Date(value);

function rows(overrides: Partial<WeeklyMetricsRows> = {}): WeeklyMetricsRows {
  return {
    account: { userId: USER, createdAt: at("2026-10-01T00:00:00Z") },
    jobs: [],
    applications: [],
    statusEvents: [],
    appliedEvents: [],
    tailoredDocuments: [],
    interviews: [],
    aiUsage: [],
    ...overrides
  };
}

function job(firstDiscoveredAt: string, userId = USER) {
  return { id: nextId("job"), userId, firstDiscoveredAt: at(firstDiscoveredAt) };
}

function application(input: {
  jobPostingId?: string;
  status?: ApplicationStatus;
  createdAt?: string;
  dateApplied?: string | null;
  userId?: string;
}) {
  return {
    id: nextId("app"),
    userId: input.userId ?? USER,
    jobPostingId: input.jobPostingId ?? nextId("job"),
    status: input.status ?? "SAVED",
    createdAt: at(input.createdAt ?? "2026-10-20T12:00:00Z"),
    dateApplied: input.dateApplied ? at(input.dateApplied) : null
  };
}

function statusEvent(applicationId: string, title: string, occurredAt: string, userId = USER) {
  return { id: nextId("event"), userId, applicationId, type: "STATUS_CHANGED", title, occurredAt: at(occurredAt) };
}

function sentDocument(kind: "RESUME" | "COVER_LETTER", content: string) {
  return {
    kind,
    documentId: nextId("doc"),
    title: `${kind} title`,
    versionNumber: 1,
    contentHash: documentContentHash(content),
    content,
    readinessState: "EVIDENCE_CURRENT",
    evidenceSnapshotId: "snapshot-1",
    documentCreatedAt: "2026-10-20T00:00:00.000Z",
    resumeFormat: kind === "RESUME"
      ? { template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 }
      : null
  };
}

function sentEvent(
  applicationId: string,
  occurredAt: string,
  sent: { resume?: boolean; coverLetter?: boolean },
  userId = USER
) {
  return {
    id: nextId("event"),
    userId,
    applicationId,
    occurredAt: at(occurredAt),
    metadata: {
      resumeVersionId: null,
      coverLetterVersionId: null,
      [SENT_DOCUMENTS_METADATA_KEY]: {
        schema: SENT_DOCUMENTS_SCHEMA,
        recordedAt: at(occurredAt).toISOString(),
        resume: sent.resume ? sentDocument("RESUME", "Tailored resume text") : null,
        coverLetter: sent.coverLetter ? sentDocument("COVER_LETTER", "Tailored letter text") : null
      }
    }
  };
}

// Minutes from the Apply Kit's "I applied" step; in real data they share the APPLIED event with
// the sent snapshot, which `withMinutes` reproduces.
function effortEvent(applicationId: string, occurredAt: string, minutes: number, userId = USER) {
  return withMinutes({ id: nextId("event"), userId, applicationId, occurredAt: at(occurredAt), metadata: {} }, minutes);
}

function withMinutes<T extends { occurredAt: Date; metadata: object }>(event: T, minutes: number): T {
  const record = buildSelfReportedEffort({ minutes, recordedAt: event.occurredAt });
  return { ...event, metadata: { ...event.metadata, [SELF_REPORTED_EFFORT_METADATA_KEY]: record } };
}

function interview(input: {
  applicationId?: string | null;
  jobPostingId?: string | null;
  createdAt: string;
  scheduledAt?: string | null;
  userId?: string;
}) {
  return {
    id: nextId("interview"),
    userId: input.userId ?? USER,
    applicationId: input.applicationId ?? null,
    jobPostingId: input.jobPostingId ?? null,
    createdAt: at(input.createdAt),
    scheduledAt: input.scheduledAt ? at(input.scheduledAt) : null
  };
}

function compute(input: WeeklyMetricsRows, userId = USER) {
  return computeWeeklyMetrics({ userId, weeks: WEEKS, now: NOW, rows: input });
}

function week(report: WeeklyMetricsReport, label: string) {
  const found = report.weeks.find((entry) => entry.label === label);
  assert.ok(found, `week ${label} must be shown`);
  return found;
}

test("an empty account shows its first week with zero counts and no misleading ratios", () => {
  const report = compute(rows({ account: { userId: USER, createdAt: at("2026-11-03T18:00:00Z") } }));

  assert.deepEqual(report.weeks.map((entry) => entry.label), [W3]);
  assert.equal(report.hiddenWeeks, 2);
  const current = week(report, W3);
  assert.equal(current.isCurrent, true);
  assert.deepEqual(current.funnel, { jobsAdded: 0, jobsSaved: 0, kitsPrepared: 0, applied: 0, interviews: 0 });
  assert.deepEqual(current.aiSpend, { micros: 0, requests: 0, unknownCostRequests: 0 });
  for (const key of ["tailoredShare", "completeTracking", "interviewRate", "feedSaveRate", "aiCostPerApplication"] as const) {
    assert.equal(current.metrics[key].kind, "not_enough_data", key);
  }
  assert.equal(current.metrics.interviewsPerApplicantHour.kind, "not_enough_data");
  assert.equal(current.metrics.effortMinutesPerApplication.kind, "not_enough_data");
  assert.deepEqual(report.dataNotes, []);
});

test("jobs added to the feed count in the Pacific week of their discovery, Monday 00:00 inclusive", () => {
  const report = compute(rows({
    jobs: [
      job("2026-10-26T06:59:59Z"), // Sunday 23:59:59 PDT: still week 1
      job("2026-10-26T07:00:00Z"), // Monday 00:00 PDT: week 2
      job("2026-11-02T07:59:59Z"), // Sunday 23:59:59 PST: still week 2
      job("2026-11-02T08:00:00Z") // Monday 00:00 PST: week 3
    ]
  }));

  assert.equal(week(report, W1).funnel.jobsAdded, 1);
  assert.equal(week(report, W2).funnel.jobsAdded, 2);
  assert.equal(week(report, W3).funnel.jobsAdded, 1);
  assert.equal(report.total.funnel.jobsAdded, 4);
});

test("jobs saved count tracker records in the week they were created", () => {
  const report = compute(rows({
    applications: [
      application({ createdAt: "2026-10-20T12:00:00Z" }),
      application({ createdAt: "2026-10-28T12:00:00Z", status: "APPLIED", dateApplied: "2026-10-28T12:00:00Z" }),
      application({ createdAt: "2026-10-29T12:00:00Z" })
    ]
  }));

  assert.equal(week(report, W1).funnel.jobsSaved, 1);
  assert.equal(week(report, W2).funnel.jobsSaved, 2);
  assert.equal(week(report, W3).funnel.jobsSaved, 0);
});

test("an Apply Kit counts once per job, in the week its first tailored resume or letter was made", () => {
  const report = compute(rows({
    tailoredDocuments: [
      { userId: USER, jobPostingId: "job-a", createdAt: at("2026-10-20T10:00:00Z") },
      { userId: USER, jobPostingId: "job-a", createdAt: at("2026-10-28T10:00:00Z") },
      { userId: USER, jobPostingId: "job-b", createdAt: at("2026-10-29T10:00:00Z") },
      { userId: USER, jobPostingId: "job-b", createdAt: at("2026-10-27T10:00:00Z") },
      { userId: USER, jobPostingId: "job-c", createdAt: at("2026-11-03T10:00:00Z") },
      { userId: USER, jobPostingId: null, createdAt: at("2026-11-03T10:00:00Z") }
    ]
  }));

  assert.equal(week(report, W1).funnel.kitsPrepared, 1);
  assert.equal(week(report, W2).funnel.kitsPrepared, 1);
  assert.equal(week(report, W3).funnel.kitsPrepared, 1);
  assert.equal(report.total.funnel.kitsPrepared, 3);
});

test("applications count in the week of their applied date, and a future applied date counts nowhere", () => {
  const report = compute(rows({
    applications: [
      application({ status: "APPLIED", dateApplied: "2026-10-21T17:00:00Z" }),
      application({ status: "REJECTED", dateApplied: "2026-10-30T17:00:00Z" }),
      application({ status: "APPLIED", dateApplied: "2026-11-03T17:00:00Z" }),
      application({ status: "APPLIED", dateApplied: "2026-11-06T17:00:00Z" })
    ]
  }));

  assert.equal(week(report, W1).funnel.applied, 1);
  assert.equal(week(report, W2).funnel.applied, 1);
  assert.equal(week(report, W3).funnel.applied, 1);
  assert.equal(report.total.funnel.applied, 3);
});

test("status titles parse from both the readable label and the older raw enum", () => {
  assert.equal(statusFromEventTitle("Status changed to Recruiter screen"), "RECRUITER_SCREEN");
  assert.equal(statusFromEventTitle("Status changed to HIRING_MANAGER_SCREEN"), "HIRING_MANAGER_SCREEN");
  assert.equal(statusFromEventTitle("Created as Technical interview"), "TECHNICAL_INTERVIEW");
  assert.equal(statusFromEventTitle("Saved to CRM"), null);
  assert.equal(statusFromEventTitle("Status changed to Something else"), null);
});

test("an application counts as one interview, in the week of its first interview signal", () => {
  const screened = application({ status: "TECHNICAL_INTERVIEW", dateApplied: "2026-10-19T17:00:00Z" });
  const linkedByJob = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-20T17:00:00Z" });
  const report = compute(rows({
    applications: [screened, linkedByJob],
    statusEvents: [
      statusEvent(screened.id, "Status changed to RECRUITER_SCREEN", "2026-10-22T17:00:00Z"),
      statusEvent(screened.id, "Status changed to Technical interview", "2026-10-29T17:00:00Z")
    ],
    interviews: [
      // A later round of the same application never counts again.
      interview({ applicationId: screened.id, createdAt: "2026-10-29T18:00:00Z", scheduledAt: "2026-11-05T18:00:00Z" }),
      // Linked only through the job; it was added late but took place in week 2.
      interview({ jobPostingId: linkedByJob.jobPostingId, createdAt: "2026-11-03T18:00:00Z", scheduledAt: "2026-10-30T18:00:00Z" }),
      // Not linked to any tracked application: counts on its own.
      interview({ createdAt: "2026-11-03T19:00:00Z", scheduledAt: "2026-11-12T18:00:00Z" })
    ]
  }));

  assert.equal(week(report, W1).funnel.interviews, 1);
  assert.equal(week(report, W2).funnel.interviews, 1);
  assert.equal(week(report, W3).funnel.interviews, 1);
  assert.equal(report.total.funnel.interviews, 3);
});

test("effort minutes average the self-reported minutes of the period's applications that have them", () => {
  const quick = application({ status: "APPLIED", dateApplied: "2026-10-27T17:00:00Z" });
  const long = application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" });
  const dragged = application({ status: "APPLIED", dateApplied: "2026-10-29T17:00:00Z" });
  const report = compute(rows({
    applications: [quick, long, dragged],
    appliedEvents: [
      withMinutes(sentEvent(quick.id, "2026-10-27T17:00:00Z", { resume: true }), 30),
      // Re-entering Applied later records a new answer; the latest one counts.
      effortEvent(long.id, "2026-10-21T17:00:00Z", 10),
      effortEvent(long.id, "2026-10-28T17:00:00Z", 60)
    ]
  }));

  assert.deepEqual(week(report, W2).metrics.effortMinutesPerApplication, {
    kind: "minutes_per_item",
    totalMinutes: 90,
    reported: 2,
    applications: 3,
    valueMinutes: 45,
    smallSample: true
  });
  assert.equal(week(report, W1).metrics.effortMinutesPerApplication.kind, "not_enough_data");
});

test("interviews per applicant-hour follows the applications with minutes to the interviews they reached", () => {
  const interviewed = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-27T17:00:00Z" });
  const waiting = application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" });
  // Interviewed, but its time is unknown: it is left out of both sides.
  const unreported = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-28T18:00:00Z" });
  const report = compute(rows({
    applications: [interviewed, waiting, unreported],
    statusEvents: [
      statusEvent(interviewed.id, "Status changed to Recruiter screen", "2026-11-03T17:00:00Z"),
      statusEvent(unreported.id, "Status changed to Recruiter screen", "2026-11-03T18:00:00Z")
    ],
    appliedEvents: [effortEvent(interviewed.id, "2026-10-27T17:00:00Z", 45), effortEvent(waiting.id, "2026-10-28T17:00:00Z", 75)]
  }));

  assert.deepEqual(week(report, W2).metrics.interviewsPerApplicantHour, {
    kind: "interviews_per_hour",
    interviews: 1,
    totalMinutes: 120,
    reported: 2,
    applications: 3,
    value: 0.5,
    smallSample: true
  });
  assert.deepEqual(report.total.metrics.interviewsPerApplicantHour, week(report, W2).metrics.interviewsPerApplicantHour);
});

test("without reported minutes the effort metrics say not enough data and why, never zero", () => {
  const report = compute(rows({ applications: [application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" })] }));
  const metrics = week(report, W2).metrics;

  for (const key of ["interviewsPerApplicantHour", "effortMinutesPerApplication"] as const) {
    const result = metrics[key];
    assert.equal(result.kind, "not_enough_data", key);
    assert.match(result.reason, /1 application has no self-reported minutes/u, key);
  }
  const empty = week(report, W1).metrics.interviewsPerApplicantHour;
  assert.equal(empty.kind, "not_enough_data");
  assert.match(empty.reason, /No applications recorded as applied/u);
});

test("tailored share counts applications whose frozen 'what I sent' record holds a tailored document", () => {
  const withResume = application({ status: "APPLIED", dateApplied: "2026-10-27T17:00:00Z" });
  const withLetter = application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" });
  const withNothing = application({ status: "APPLIED", dateApplied: "2026-10-29T17:00:00Z" });
  const noRecord = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-30T17:00:00Z" });
  const report = compute(rows({
    applications: [withResume, withLetter, withNothing, noRecord],
    appliedEvents: [
      sentEvent(withResume.id, "2026-10-27T17:00:00Z", { resume: true }),
      sentEvent(withLetter.id, "2026-10-28T17:00:00Z", { coverLetter: true }),
      sentEvent(withNothing.id, "2026-10-29T17:00:00Z", {})
    ]
  }));
  const share = week(report, W2).metrics.tailoredShare;

  assert.equal(share.kind, "ratio");
  assert.equal(share.numerator, 2);
  assert.equal(share.denominator, 3);
  assert.equal(share.value, 2 / 3);
  assert.equal(share.smallSample, true);
  const empty = week(report, W3).metrics.tailoredShare;
  assert.equal(empty.kind, "not_enough_data");
});

test("tailored share has not enough data when none of the period's applications has a sent record", () => {
  const report = compute(rows({ applications: [application({ status: "APPLIED", dateApplied: "2026-10-27T17:00:00Z" })] }));
  const share = week(report, W2).metrics.tailoredShare;

  assert.equal(share.kind, "not_enough_data");
  assert.match(share.reason, /record of what was sent/);
});

test("complete tracking needs a sent record naming a document and a status at or past Applied", () => {
  const complete = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-27T17:00:00Z" });
  const archived = application({ status: "ARCHIVED", dateApplied: "2026-10-27T18:00:00Z" });
  const noDocuments = application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" });
  const noRecord = application({ status: "APPLIED", dateApplied: "2026-10-28T18:00:00Z" });
  const report = compute(rows({
    applications: [complete, archived, noDocuments, noRecord],
    appliedEvents: [
      sentEvent(complete.id, "2026-10-27T17:00:00Z", { resume: true, coverLetter: true }),
      sentEvent(archived.id, "2026-10-27T18:00:00Z", { resume: true }),
      sentEvent(noDocuments.id, "2026-10-28T17:00:00Z", {})
    ]
  }));
  const tracking = week(report, W2).metrics.completeTracking;

  assert.equal(tracking.kind, "ratio");
  assert.equal(tracking.numerator, 1);
  assert.equal(tracking.denominator, 4);
});

test("the latest sent record of an application is the one that counts", () => {
  const reapplied = application({ status: "APPLIED", dateApplied: "2026-10-27T17:00:00Z" });
  const report = compute(rows({
    applications: [reapplied],
    appliedEvents: [
      sentEvent(reapplied.id, "2026-10-27T17:00:00Z", { resume: true }),
      sentEvent(reapplied.id, "2026-10-29T17:00:00Z", {})
    ]
  }));

  const share = week(report, W2).metrics.tailoredShare;
  assert.equal(share.kind, "ratio");
  assert.equal(share.numerator, 0);
  assert.equal(share.denominator, 1);
});

test("AI cost per application divides the period's recorded AI spend by its applications", () => {
  const report = compute(rows({
    applications: [
      application({ status: "APPLIED", dateApplied: "2026-10-27T17:00:00Z" }),
      application({ status: "APPLIED", dateApplied: "2026-10-28T17:00:00Z" })
    ],
    aiUsage: [
      { userId: USER, createdAt: at("2026-10-27T10:00:00Z"), estimatedCostMicros: 30_000 },
      { userId: USER, createdAt: at("2026-10-30T10:00:00Z"), estimatedCostMicros: 15_000 },
      { userId: USER, createdAt: at("2026-10-30T11:00:00Z"), estimatedCostMicros: null },
      { userId: USER, createdAt: at("2026-11-03T10:00:00Z"), estimatedCostMicros: 9_000 }
    ]
  }));
  const second = week(report, W2);

  assert.deepEqual(second.aiSpend, { micros: 45_000, requests: 3, unknownCostRequests: 1 });
  assert.deepEqual(second.metrics.aiCostPerApplication, {
    kind: "money_per_item",
    totalMicros: 45_000,
    items: 2,
    valueMicros: 22_500,
    smallSample: true
  });
  const third = week(report, W3);
  assert.deepEqual(third.aiSpend, { micros: 9_000, requests: 1, unknownCostRequests: 0 });
  assert.equal(third.metrics.aiCostPerApplication.kind, "not_enough_data");
  assert.ok(report.dataNotes.some((note) => /1 AI request has no recorded cost/.test(note)), report.dataNotes.join("\n"));
});

test("interview rate follows each week's applications to any interview reached since", () => {
  const interviewed = application({ status: "RECRUITER_SCREEN", dateApplied: "2026-10-20T17:00:00Z" });
  const waiting = application({ status: "APPLIED", dateApplied: "2026-10-21T17:00:00Z" });
  const report = compute(rows({
    applications: [interviewed, waiting],
    statusEvents: [statusEvent(interviewed.id, "Status changed to Recruiter screen", "2026-11-03T17:00:00Z")]
  }));
  const rate = week(report, W1).metrics.interviewRate;

  assert.equal(rate.kind, "ratio");
  assert.equal(rate.numerator, 1);
  assert.equal(rate.denominator, 2);
  assert.equal(week(report, W2).metrics.interviewRate.kind, "not_enough_data");
});

test("feed save rate follows each week's new feed jobs to whether they were saved since", () => {
  const saved = job("2026-10-27T10:00:00Z");
  const ignored = job("2026-10-27T11:00:00Z");
  const alsoSaved = job("2026-10-28T11:00:00Z");
  const report = compute(rows({
    jobs: [saved, ignored, alsoSaved],
    applications: [
      application({ jobPostingId: saved.id, createdAt: "2026-11-03T10:00:00Z" }),
      application({ jobPostingId: alsoSaved.id, createdAt: "2026-10-28T12:00:00Z" })
    ]
  }));
  const rate = week(report, W2).metrics.feedSaveRate;

  assert.equal(rate.kind, "ratio");
  assert.equal(rate.numerator, 2);
  assert.equal(rate.denominator, 3);
  assert.equal(week(report, W1).metrics.feedSaveRate.kind, "not_enough_data");
});

test("ratios at or above the small-sample size are not flagged", () => {
  const applications = Array.from({ length: SMALL_SAMPLE_SIZE }, (_, index) =>
    application({ status: "APPLIED", dateApplied: `2026-10-2${7 + (index % 3)}T17:00:00Z` }));
  const report = compute(rows({
    applications,
    appliedEvents: applications.map((entry) => effortEvent(entry.id, entry.dateApplied!.toISOString(), 30))
  }));
  const tracking = week(report, W2).metrics.completeTracking;

  assert.equal(tracking.kind, "ratio");
  assert.equal(tracking.denominator, SMALL_SAMPLE_SIZE);
  assert.equal(tracking.smallSample, false);
  const effort = week(report, W2).metrics;
  assert.equal(effort.effortMinutesPerApplication.kind === "minutes_per_item" && effort.effortMinutesPerApplication.smallSample, false);
  assert.equal(effort.interviewsPerApplicantHour.kind === "interviews_per_hour" && effort.interviewsPerApplicantHour.smallSample, false);
});

test("another user's rows never count, even when they point at this user's records", () => {
  const ownJob = job("2026-10-27T10:00:00Z");
  const own = application({ jobPostingId: ownJob.id, status: "RECRUITER_SCREEN", createdAt: "2026-10-27T11:00:00Z", dateApplied: "2026-10-27T12:00:00Z" });
  const ownRows = rows({
    jobs: [ownJob],
    applications: [own],
    statusEvents: [statusEvent(own.id, "Status changed to Recruiter screen", "2026-10-29T12:00:00Z")],
    appliedEvents: [withMinutes(sentEvent(own.id, "2026-10-27T12:00:00Z", { resume: true }), 40)],
    tailoredDocuments: [{ userId: USER, jobPostingId: ownJob.id, createdAt: at("2026-10-27T11:30:00Z") }],
    interviews: [interview({ applicationId: own.id, createdAt: "2026-10-29T12:00:00Z" })],
    aiUsage: [{ userId: USER, createdAt: at("2026-10-27T11:00:00Z"), estimatedCostMicros: 10_000 }]
  });
  const baseline = compute(ownRows);

  const otherJob = job("2026-10-27T10:00:00Z", OTHER);
  const other = application({ jobPostingId: otherJob.id, status: "OFFER", createdAt: "2026-10-27T11:00:00Z", dateApplied: "2026-10-27T12:00:00Z", userId: OTHER });
  const mixed = compute({
    account: ownRows.account,
    jobs: [...ownRows.jobs, otherJob, job("2026-11-03T10:00:00Z", OTHER)],
    applications: [...ownRows.applications, other],
    statusEvents: [
      ...ownRows.statusEvents,
      statusEvent(other.id, "Status changed to Offer", "2026-10-28T12:00:00Z", OTHER),
      // Foreign event aimed at this user's application.
      statusEvent(own.id, "Status changed to Offer", "2026-10-19T12:00:00Z", OTHER)
    ],
    appliedEvents: [
      ...ownRows.appliedEvents,
      sentEvent(own.id, "2026-10-30T12:00:00Z", {}, OTHER),
      sentEvent(other.id, "2026-10-27T12:00:00Z", { resume: true }, OTHER),
      // Foreign minutes aimed at this user's application, and on the other user's own one.
      effortEvent(own.id, "2026-10-31T12:00:00Z", 600, OTHER),
      effortEvent(other.id, "2026-10-27T12:00:00Z", 5, OTHER)
    ],
    tailoredDocuments: [
      ...ownRows.tailoredDocuments,
      { userId: OTHER, jobPostingId: ownJob.id, createdAt: at("2026-10-20T11:30:00Z") },
      { userId: OTHER, jobPostingId: otherJob.id, createdAt: at("2026-10-27T11:30:00Z") }
    ],
    interviews: [
      ...ownRows.interviews,
      interview({ applicationId: other.id, createdAt: "2026-10-28T12:00:00Z", userId: OTHER }),
      interview({ createdAt: "2026-11-03T12:00:00Z", userId: OTHER }),
      interview({ jobPostingId: ownJob.id, createdAt: "2026-10-20T12:00:00Z", userId: OTHER })
    ],
    aiUsage: [
      ...ownRows.aiUsage,
      { userId: OTHER, createdAt: at("2026-10-27T11:00:00Z"), estimatedCostMicros: 990_000 },
      { userId: OTHER, createdAt: at("2026-10-27T11:00:00Z"), estimatedCostMicros: null }
    ]
  });

  assert.deepEqual(mixed, baseline);
  assert.deepEqual(week(baseline, W2).funnel, { jobsAdded: 1, jobsSaved: 1, kitsPrepared: 1, applied: 1, interviews: 1 });
  const effort = week(baseline, W2).metrics.effortMinutesPerApplication;
  assert.equal(effort.kind === "minutes_per_item" && effort.totalMinutes, 40);
});

test("an account record belonging to someone else is refused", () => {
  assert.throws(
    () => compute(rows({ account: { userId: OTHER, createdAt: at("2026-10-01T00:00:00Z") } })),
    /account/i
  );
});

test("weeks before the first activity are hidden, and backdated activity reveals its week", () => {
  const recent = compute(rows({ account: { userId: USER, createdAt: at("2026-10-28T00:00:00Z") } }));
  assert.deepEqual(recent.weeks.map((entry) => entry.label), [W2, W3]);
  assert.equal(recent.hiddenWeeks, 1);

  const backdated = compute(rows({
    account: { userId: USER, createdAt: at("2026-11-03T00:00:00Z") },
    applications: [application({ status: "APPLIED", createdAt: "2026-11-03T10:00:00Z", dateApplied: "2026-10-21T17:00:00Z" })]
  }));
  assert.deepEqual(backdated.weeks.map((entry) => entry.label), [W1, W2, W3]);
  assert.equal(week(backdated, W1).funnel.applied, 1);
});

test("the total covers exactly the shown weeks", () => {
  const report = compute(rows({
    account: { userId: USER, createdAt: at("2026-10-28T00:00:00Z") },
    jobs: [job("2026-10-28T10:00:00Z"), job("2026-11-03T10:00:00Z")]
  }));

  assert.equal(report.total.start.toISOString(), WEEKS[1].start.toISOString());
  assert.equal(report.total.end.toISOString(), WEEKS[2].end.toISOString());
  assert.equal(report.total.label, "Last 2 weeks");
  assert.equal(report.total.isCurrent, false);
  assert.equal(report.total.funnel.jobsAdded, 2);
});

test("data notes flag applications the weekly counts cannot place", () => {
  const report = compute(rows({
    applications: [
      application({ status: "RECRUITER_SCREEN", dateApplied: null }),
      application({ status: "GHOSTED", dateApplied: null }),
      application({ status: "SAVED", dateApplied: null })
    ]
  }));

  assert.ok(report.dataNotes.some((note) => /2 applications are past Applied but have no applied date/.test(note)), report.dataNotes.join("\n"));
  assert.ok(report.dataNotes.some((note) => /1 application is at an interview stage with no dated interview record/.test(note)), report.dataNotes.join("\n"));
});

test("every reported metric has a label and a plain statement of how it is computed", () => {
  const keys = [
    "jobsAdded", "jobsSaved", "kitsPrepared", "applied", "interviews",
    "interviewsPerApplicantHour", "effortMinutesPerApplication", "tailoredShare",
    "aiCostPerApplication", "completeTracking", "interviewRate", "feedSaveRate", "aiSpend"
  ];
  assert.deepEqual(Object.keys(WEEKLY_METRIC_DEFINITIONS).sort(), [...keys].sort());
  for (const key of keys) {
    const definition = WEEKLY_METRIC_DEFINITIONS[key as keyof typeof WEEKLY_METRIC_DEFINITIONS];
    assert.ok(definition.label.length > 0, key);
    assert.ok(definition.howComputed.length > 20, key);
  }
});
