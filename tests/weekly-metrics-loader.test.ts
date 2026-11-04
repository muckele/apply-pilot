import assert from "node:assert/strict";
import test from "node:test";

import {
  SELF_REPORTED_EFFORT_METADATA_KEY,
  SELF_REPORTED_EFFORT_SCHEMA,
  buildSelfReportedEffort
} from "@/lib/applications/self-reported-effort";
import { SENT_DOCUMENTS_METADATA_KEY, SENT_DOCUMENTS_SCHEMA } from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import { loadWeeklyMetrics, type WeeklyMetricsDb } from "@/lib/metrics/weekly-metrics-loader";
import { METRICS_TIME_ZONE, buildMetricWeeks } from "@/lib/metrics/weeks";

const USER = "user-a";
const OTHER = "user-b";
const NOW = new Date("2026-11-04T20:00:00Z");
const WEEKS = buildMetricWeeks({ now: NOW, count: 2 });
const RANGE = { gte: WEEKS[0].start, lt: WEEKS[1].end };

type Call = { model: string; method: string; args: { where: Record<string, unknown> } };

const minutes = (metadata: object, value: number) => ({
  ...metadata,
  [SELF_REPORTED_EFFORT_METADATA_KEY]: buildSelfReportedEffort({ minutes: value, recordedAt: new Date("2026-11-03T18:00:00Z") })
});

const sentMetadata = {
  [SENT_DOCUMENTS_METADATA_KEY]: {
    schema: SENT_DOCUMENTS_SCHEMA,
    recordedAt: "2026-11-03T18:00:00.000Z",
    resume: {
      kind: "RESUME",
      documentId: "resume-1",
      title: "Tailored resume",
      versionNumber: 1,
      contentHash: documentContentHash("Resume"),
      content: "Resume",
      readinessState: "EVIDENCE_CURRENT",
      evidenceSnapshotId: null,
      documentCreatedAt: "2026-11-03T17:00:00.000Z",
      resumeFormat: { template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 }
    },
    coverLetter: null
  }
};

// The fake ignores every filter and returns both users' rows, so the test proves the numbers
// stay owner-only even if a query were ever written without its userId filter.
function fakeDb(options: { appliedInRange?: boolean } = {}) {
  const calls: Call[] = [];
  const appliedInRange = options.appliedInRange ?? true;
  const record = (model: string, method: string, rows: unknown) => async (args: Call["args"]) => {
    calls.push({ model, method, args });
    return rows;
  };
  const db = {
    user: {
      findUnique: record("user", "findUnique", { id: USER, createdAt: new Date("2026-10-01T00:00:00Z") })
    },
    jobPosting: {
      findMany: record("jobPosting", "findMany", [
        { id: "job-a", userId: USER, firstDiscoveredAt: new Date("2026-11-03T10:00:00Z") },
        { id: "job-b", userId: OTHER, firstDiscoveredAt: new Date("2026-11-03T10:00:00Z") }
      ])
    },
    application: {
      findMany: record("application", "findMany", [
        {
          id: "app-a",
          userId: USER,
          jobPostingId: "job-a",
          status: "APPLIED",
          createdAt: new Date("2026-11-03T11:00:00Z"),
          dateApplied: appliedInRange ? new Date("2026-11-03T18:00:00Z") : new Date("2026-09-03T18:00:00Z")
        },
        {
          id: "app-b",
          userId: OTHER,
          jobPostingId: "job-b",
          status: "OFFER",
          createdAt: new Date("2026-11-03T11:00:00Z"),
          dateApplied: new Date("2026-11-03T18:00:00Z")
        }
      ])
    },
    applicationEvent: {
      findMany: async (args: Call["args"]) => {
        calls.push({ model: "applicationEvent", method: "findMany", args });
        if ("applicationId" in args.where) {
          return [
            { id: "sent-a", userId: USER, applicationId: "app-a", occurredAt: new Date("2026-11-03T18:00:00Z"), metadata: minutes(sentMetadata, 30) },
            { id: "sent-b", userId: OTHER, applicationId: "app-b", occurredAt: new Date("2026-11-03T18:00:00Z"), metadata: minutes(sentMetadata, 600) },
            { id: "effort-b", userId: OTHER, applicationId: "app-a", occurredAt: new Date("2026-11-04T18:00:00Z"), metadata: minutes({}, 600) }
          ];
        }
        return [
          { id: "status-b", userId: OTHER, applicationId: "app-b", type: "STATUS_CHANGED", title: "Status changed to Offer", occurredAt: new Date("2026-11-04T10:00:00Z") }
        ];
      }
    },
    resumeVersion: {
      findMany: record("resumeVersion", "findMany", [
        { userId: USER, jobPostingId: "job-a", createdAt: new Date("2026-11-03T12:00:00Z") },
        { userId: OTHER, jobPostingId: "job-b", createdAt: new Date("2026-11-03T12:00:00Z") }
      ])
    },
    generatedDocument: {
      findMany: record("generatedDocument", "findMany", [
        { userId: OTHER, jobPostingId: "job-c", createdAt: new Date("2026-11-03T12:00:00Z") }
      ])
    },
    interview: {
      findMany: record("interview", "findMany", [
        { id: "interview-b", userId: OTHER, applicationId: "app-b", jobPostingId: "job-b", createdAt: new Date("2026-11-04T10:00:00Z"), scheduledAt: null }
      ])
    },
    aIUsageEvent: {
      findMany: record("aIUsageEvent", "findMany", [
        { userId: USER, createdAt: new Date("2026-11-03T12:00:00Z"), estimatedCostMicros: 20_000 },
        { userId: OTHER, createdAt: new Date("2026-11-03T12:00:00Z"), estimatedCostMicros: 900_000 }
      ])
    }
  };
  return { db: db as unknown as WeeklyMetricsDb, calls };
}

test("every query is scoped to the signed-in user, and range-bounded tables use the shown weeks", async () => {
  const { db, calls } = fakeDb();

  const report = await loadWeeklyMetrics(db, { userId: USER, now: NOW, weekCount: 2 });

  assert.equal(report.timeZone, METRICS_TIME_ZONE);
  assert.deepEqual(calls.find((call) => call.model === "user")?.args.where, { id: USER });
  const findManyCalls = calls.filter((call) => call.method === "findMany");
  assert.equal(findManyCalls.length, 8);
  for (const call of findManyCalls) {
    assert.equal(call.args.where.userId, USER, `${call.model} must filter by userId`);
  }
  const where = (model: string) => calls.find((call) => call.model === model)!.args.where;
  assert.deepEqual(where("jobPosting").firstDiscoveredAt, RANGE);
  assert.deepEqual(where("aIUsageEvent").createdAt, RANGE);
  assert.deepEqual(where("resumeVersion").jobPostingId, { not: null });
  assert.deepEqual(where("generatedDocument").type, { in: ["TAILORED_RESUME", "COVER_LETTER"] });
});

test("sent records and reported minutes are read in one query, only for applications applied in the shown weeks", async () => {
  const { db, calls } = fakeDb();

  await loadWeeklyMetrics(db, { userId: USER, now: NOW, weekCount: 2 });

  const appliedQuery = calls.find((call) => call.model === "applicationEvent" && "applicationId" in call.args.where);
  assert.ok(appliedQuery);
  assert.deepEqual(appliedQuery.args.where, {
    userId: USER,
    applicationId: { in: ["app-a"] },
    OR: [
      { metadata: { path: [SENT_DOCUMENTS_METADATA_KEY, "schema"], equals: SENT_DOCUMENTS_SCHEMA } },
      { metadata: { path: [SELF_REPORTED_EFFORT_METADATA_KEY, "schema"], equals: SELF_REPORTED_EFFORT_SCHEMA } }
    ]
  });
});

test("no applied-event query runs when nothing was applied in the shown weeks", async () => {
  const { db, calls } = fakeDb({ appliedInRange: false });

  await loadWeeklyMetrics(db, { userId: USER, now: NOW, weekCount: 2 });

  assert.equal(calls.some((call) => call.model === "applicationEvent" && "applicationId" in call.args.where), false);
});

test("rows from another user never reach the numbers even if a query returned them", async () => {
  const { db } = fakeDb();

  const report = await loadWeeklyMetrics(db, { userId: USER, now: NOW, weekCount: 2 });

  assert.deepEqual(report.total.funnel, { jobsAdded: 1, jobsSaved: 1, kitsPrepared: 1, applied: 1, interviews: 0 });
  assert.deepEqual(report.total.aiSpend, { micros: 20_000, requests: 1, unknownCostRequests: 0 });
  const tailored = report.total.metrics.tailoredShare;
  assert.equal(tailored.kind, "ratio");
  assert.equal(tailored.numerator, 1);
  assert.equal(tailored.denominator, 1);
  const effort = report.total.metrics.effortMinutesPerApplication;
  assert.equal(effort.kind, "minutes_per_item");
  assert.deepEqual([effort.totalMinutes, effort.reported], [30, 1], "another user's minutes, even on this user's application, never count");
});

test("a missing user record is an error, not an empty report", async () => {
  const { db } = fakeDb();
  (db.user as unknown as { findUnique: () => Promise<null> }).findUnique = async () => null;

  await assert.rejects(loadWeeklyMetrics(db, { userId: USER, now: NOW, weekCount: 2 }), /user/i);
});
