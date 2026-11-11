import assert from "node:assert/strict";
import test from "node:test";

import { loadApplicationSummaryProgress } from "@/lib/apply-page/application-summary-progress";
import { deriveApplyProgress } from "@/lib/apply-page/apply-progress";
import type { JobDetail } from "@/lib/jobs/job-detail";

// Synthetic ids only.
const USER = "user-synthetic-alex-rivera";
const JOB = "job-synthetic-1";
const PROGRESS = deriveApplyProgress({
  hasMasterResume: true, hasCurrentMatch: true, reviewSaved: false, resumeAttached: false, coverAttached: false,
  coverRequired: true, automationAvailable: true, run: null, applied: false
});
const DETAIL = { view: { id: JOB } } as unknown as JobDetail;

function dependencies(overrides: Partial<Parameters<typeof loadApplicationSummaryProgress>[2]> = {}) {
  const captured: Array<{ error: unknown; context: Record<string, unknown> | undefined }> = [];
  return {
    captured,
    deps: {
      loadJobDetail: async () => DETAIL,
      loadApplyProgress: async () => PROGRESS,
      captureException: (error: unknown, context?: Record<string, unknown>) => { captured.push({ error, context }); },
      ...overrides
    }
  };
}

test("the application page's summary progress is the Apply page's progress", async () => {
  const { deps, captured } = dependencies();
  assert.equal(await loadApplicationSummaryProgress(USER, JOB, deps), PROGRESS);
  assert.deepEqual(captured, []);
});

test("a job that isn't found gives no summary, and nothing is logged", async () => {
  const { deps, captured } = dependencies({ loadJobDetail: async () => null });
  assert.equal(await loadApplicationSummaryProgress(USER, JOB, deps), null);
  assert.deepEqual(captured, []);
});

test("a failure while loading hides the summary card instead of breaking the page, and is logged", async () => {
  for (const failing of ["loadJobDetail", "loadApplyProgress"] as const) {
    const failure = new Error(`${failing} failed`);
    const { deps, captured } = dependencies({ [failing]: async () => { throw failure; } });
    assert.equal(await loadApplicationSummaryProgress(USER, JOB, deps), null, failing);
    assert.equal(captured.length, 1, failing);
    assert.equal(captured[0]!.error, failure);
    assert.deepEqual(captured[0]!.context, { source: "application-page.apply-summary", userId: USER, resourceId: JOB });
  }
});
