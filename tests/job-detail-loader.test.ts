import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { loadJobDetail } from "@/lib/jobs/job-detail";

const userId = "user-synthetic-alex-rivera";

function stubPrisma(options: { job: boolean }) {
  const p = prisma as unknown as Record<string, Record<string, unknown>>;
  const originals: Array<[Record<string, unknown>, string, unknown]> = [];
  const stub = (model: string, method: string, value: unknown) => {
    originals.push([p[model], method, p[model][method]]);
    p[model][method] = async () => value;
  };
  stub("jobPosting", "findFirst", options.job
    ? {
        id: "job-1", userId, title: "Engineer", company: "Example Corp", location: "Remote", remoteStatus: "REMOTE",
        salaryMin: null, salaryMax: null, datePosted: null, firstDiscoveredAt: new Date("2026-11-01T00:00:00.000Z"),
        sourceType: "GREENHOUSE", description: "Build things.", requirements: ["TypeScript"], preferredQualifications: [],
        currentEvidenceSnapshotId: null, evidenceSnapshotGeneration: 0, currentEvidenceSnapshot: null
      }
    : null);
  stub("resume", "findFirst", null);
  stub("userProfile", "findUnique", null);
  stub("resumeVersion", "findMany", []);
  stub("generatedDocument", "findMany", []);
  stub("application", "findUnique", null);
  stub("contact", "findMany", []);
  stub("aIAnalysis", "findFirst", null);
  return () => { for (const [target, method, value] of originals) target[method] = value; };
}

test("the loader returns null for a job that is not found", async () => {
  const restore = stubPrisma({ job: false });
  try {
    assert.equal(await loadJobDetail(userId, "missing"), null);
  } finally { restore(); }
});

test("draft user key is 16 hex chars and never the raw id", async () => {
  const restore = stubPrisma({ job: true });
  try {
    const detail = await loadJobDetail(userId, "job-1");
    assert.ok(detail);
    assert.match(detail.draftUserKey, /^[0-9a-f]{16}$/);
    assert.notEqual(detail.draftUserKey, userId);
    assert.equal(detail.draftUserKey, (await loadJobDetail(userId, "job-1"))?.draftUserKey);
  } finally { restore(); }
});

test("confidence is null without a current match", async () => {
  const restore = stubPrisma({ job: true });
  try {
    const detail = await loadJobDetail(userId, "job-1");
    assert.equal(detail?.currentConfidenceScore, null);
  } finally { restore(); }
});
