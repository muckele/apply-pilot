import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationStatus } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { normalizeApplicationPatch } from "@/lib/applications/status";
import { resolveInterviewJobPostingId } from "@/lib/interviews/linking";

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
