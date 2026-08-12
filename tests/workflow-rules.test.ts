import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationStatus, JobSourceType, PostingStatus } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  defaultFollowUpDueAt,
  getApplicationAttention,
  resolvePostingStatusForApplicationStatus,
  suggestApplicationNextAction
} from "@/lib/applications/pipeline";
import { normalizeApplicationPatch, resolveApplicationPostStatus } from "@/lib/applications/status";
import { resolveInterviewJobPostingId } from "@/lib/interviews/linking";
import { assertSourceCanSync } from "@/lib/job-sources/source-policy";
import { mapJobForReviewQueue, type ReviewableJob } from "@/lib/jobs/review-queue";

const dayMs = 86_400_000;

function daysAgo(days: number) {
  return new Date(Date.now() - days * dayMs);
}

function reviewJob(overrides: Partial<ReviewableJob> = {}): ReviewableJob {
  return {
    id: "job_1",
    title: "Solutions Engineer",
    normalizedTitle: "solutions engineer",
    company: "Example Co",
    normalizedCompany: "example co",
    location: "Los Angeles, CA",
    normalizedLocation: "los angeles ca",
    remoteStatus: "Hybrid",
    salaryMin: 90_000,
    salaryMax: 120_000,
    datePosted: daysAgo(2),
    firstDiscoveredAt: daysAgo(1),
    status: PostingStatus.ACTIVE,
    sourceType: JobSourceType.SERPAPI,
    overallFitScore: 82,
    confidenceScore: 78,
    matchRecommendation: "Apply now",
    keyMatchReason: "Strong customer-facing technical implementation match.",
    missingKeywords: [],
    supportedKeywords: ["API", "Implementation"],
    concerns: [],
    applyUrl: "https://example.com/apply",
    normalizedApplyUrl: "https://example.com/apply",
    sourceUrl: "https://example.com/jobs/1",
    ...overrides
  };
}

test("application patch sets dateApplied when status becomes applied", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");
  const result = normalizeApplicationPatch(
    { status: ApplicationStatus.APPLIED },
    { status: ApplicationStatus.SAVED, dateApplied: null },
    now
  );

  assert.equal(result.nextStatus, ApplicationStatus.APPLIED);
  assert.equal(result.data.dateApplied, now);
});

test("application patch keeps an existing applied date", () => {
  const existingDate = new Date("2026-05-20T12:00:00.000Z");
  const now = new Date("2026-05-24T12:00:00.000Z");
  const result = normalizeApplicationPatch(
    { status: ApplicationStatus.APPLIED },
    { status: ApplicationStatus.APPLIED, dateApplied: existingDate },
    now
  );

  assert.equal(result.data.dateApplied, existingDate);
});

test("application patch assigns next action and follow-up date when status changes", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");
  const result = normalizeApplicationPatch(
    { status: ApplicationStatus.APPLIED },
    { status: ApplicationStatus.INTERESTED, dateApplied: null },
    now
  );

  assert.equal(result.nextStatus, ApplicationStatus.APPLIED);
  assert.equal(result.data.nextAction, suggestApplicationNextAction(ApplicationStatus.APPLIED));
  assert.equal(result.data.followUpDueAt?.toISOString(), defaultFollowUpDueAt(ApplicationStatus.APPLIED, now)?.toISOString());
});

test("application post status preserves an existing applied state for passive saves", () => {
  assert.equal(
    resolveApplicationPostStatus(ApplicationStatus.INTERESTED, { status: ApplicationStatus.APPLIED }),
    ApplicationStatus.APPLIED
  );
  assert.equal(
    resolveApplicationPostStatus(ApplicationStatus.SAVED, { status: ApplicationStatus.REJECTED }),
    ApplicationStatus.REJECTED
  );
});

test("application patch preserves an existing applied state for passive saves", () => {
  const result = normalizeApplicationPatch(
    { status: ApplicationStatus.SAVED },
    { status: ApplicationStatus.APPLIED, dateApplied: new Date("2026-05-20T12:00:00.000Z") }
  );

  assert.equal(result.nextStatus, ApplicationStatus.APPLIED);
  assert.equal(result.data.status, ApplicationStatus.APPLIED);
});

test("application statuses resolve to posting statuses for pipeline sync", () => {
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.SAVED), null);
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.INTERESTED), null);
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.APPLIED), PostingStatus.APPLIED);
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.TECHNICAL_INTERVIEW), PostingStatus.INTERVIEW);
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.OFFER), PostingStatus.OFFER);
  assert.equal(resolvePostingStatusForApplicationStatus(ApplicationStatus.GHOSTED), PostingStatus.ARCHIVED);
});

test("source policy blocks unreviewed generic career sources", () => {
  assert.throws(
    () =>
      assertSourceCanSync({
        type: JobSourceType.COMPANY_CAREERS,
        allowlisted: false,
        baseUrl: "https://example.com/careers",
        boardToken: null
      } as never),
    /Review and approve/
  );
});

test("application attention flags overdue follow-ups first", () => {
  const attention = getApplicationAttention(
    {
      status: ApplicationStatus.APPLIED,
      dateSaved: new Date("2026-05-10T12:00:00.000Z"),
      dateApplied: new Date("2026-05-12T12:00:00.000Z"),
      followUpDueAt: new Date("2026-05-20T12:00:00.000Z"),
      updatedAt: new Date("2026-05-12T12:00:00.000Z"),
      emails: [],
      interviews: []
    },
    new Date("2026-05-24T12:00:00.000Z")
  );

  assert.equal(attention?.label, "Follow-up due");
  assert.equal(attention?.level, "high");
});

test("application attention flags applied records with no response after seven days", () => {
  const attention = getApplicationAttention(
    {
      status: ApplicationStatus.APPLIED,
      dateSaved: new Date("2026-05-10T12:00:00.000Z"),
      dateApplied: new Date("2026-05-12T12:00:00.000Z"),
      followUpDueAt: null,
      updatedAt: new Date("2026-05-12T12:00:00.000Z"),
      emails: [],
      interviews: []
    },
    new Date("2026-05-24T12:00:00.000Z")
  );

  assert.equal(attention?.label, "No response yet");
});

test("application attention recommends ghosted after 21 days with no response", () => {
  const attention = getApplicationAttention(
    {
      status: ApplicationStatus.APPLIED,
      dateSaved: new Date("2026-05-01T12:00:00.000Z"),
      dateApplied: new Date("2026-05-01T12:00:00.000Z"),
      followUpDueAt: null,
      updatedAt: new Date("2026-05-01T12:00:00.000Z"),
      emails: [],
      interviews: []
    },
    new Date("2026-05-24T12:00:00.000Z")
  );

  assert.equal(attention?.label, "Consider ghosted");
});

test("interview links derive the job from the application when no job is selected", () => {
  assert.equal(
    resolveInterviewJobPostingId({ requestedJobPostingId: undefined, applicationJobPostingId: "job_123" }),
    "job_123"
  );
});

test("interview links reject mismatched jobs and applications", () => {
  assert.throws(
    () => resolveInterviewJobPostingId({ requestedJobPostingId: "job_a", applicationJobPostingId: "job_b" }),
    PublicApiError
  );
});

test("review queue classifies high-fit jobs as best matches", () => {
  const job = reviewJob();
  const result = mapJobForReviewQueue(job, [job]);

  assert.equal(result.category, "best");
  assert.deepEqual(result.flags, []);
});

test("review queue flags likely duplicate jobs before normal review", () => {
  const first = reviewJob();
  const second = reviewJob({ id: "job_2", sourceUrl: "https://example.com/jobs/2" });
  const result = mapJobForReviewQueue(first, [first, second]);

  assert.equal(result.category, "duplicate");
  assert.ok(result.flags.includes("Likely duplicate"));
});

test("review queue does not flag same-title jobs with different location or apply URL as duplicates", () => {
  const first = reviewJob();
  const second = reviewJob({
    id: "job_2",
    location: "Austin, TX",
    normalizedLocation: "austin tx",
    applyUrl: "https://example.com/apply-austin",
    normalizedApplyUrl: "https://example.com/apply-austin",
    sourceUrl: "https://example.com/jobs/2"
  });
  const result = mapJobForReviewQueue(first, [first, second]);

  assert.equal(result.category, "best");
  assert.equal(result.flags.includes("Likely duplicate"), false);
});

test("review queue keeps unscored jobs in needs review", () => {
  const job = reviewJob({
    overallFitScore: null,
    confidenceScore: null,
    matchRecommendation: null,
    keyMatchReason: null,
    supportedKeywords: [],
    missingKeywords: []
  });
  const result = mapJobForReviewQueue(job, [job]);

  assert.equal(result.category, "needs_review");
  assert.ok(result.flags.includes("Needs fit score"));
});

test("review queue treats zero fit scores as scored weak matches", () => {
  const job = reviewJob({
    overallFitScore: 0,
    confidenceScore: 0,
    matchRecommendation: null,
    keyMatchReason: null,
    supportedKeywords: [],
    missingKeywords: []
  });
  const result = mapJobForReviewQueue(job, [job]);

  assert.equal(result.category, "questionable");
  assert.equal(result.flags.includes("Needs fit score"), false);
});
