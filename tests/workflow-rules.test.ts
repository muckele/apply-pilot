import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationStatus, JobSourceType, PostingStatus } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { normalizeApplicationPatch, resolveApplicationPostStatus } from "@/lib/applications/status";
import { resolveInterviewJobPostingId } from "@/lib/interviews/linking";
import { mapJobForReviewQueue, type ReviewableJob } from "@/lib/jobs/review-queue";

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
    datePosted: new Date("2026-05-20T12:00:00.000Z"),
    firstDiscoveredAt: new Date("2026-05-21T12:00:00.000Z"),
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
