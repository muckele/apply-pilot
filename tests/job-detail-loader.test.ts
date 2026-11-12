import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { buildCurrentJobMatchContext, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { loadJobDetail } from "@/lib/jobs/job-detail";

const userId = "user-synthetic-alex-rivera";

const resumeUpdatedAt = new Date("2026-10-30T00:00:00.000Z");
const resumeRow = {
  id: "resume-1", updatedAt: resumeUpdatedAt, rawText: "Alex Rivera. Built TypeScript services at Example Corp.",
  summary: "Engineer.", skills: ["TypeScript"], achievements: [], workHistory: [], projects: [], education: [], certifications: []
};
const jobRow = {
  id: "job-1", userId, title: "Engineer", company: "Example Corp", location: "Remote", remoteStatus: "REMOTE",
  salaryMin: null, salaryMax: null, datePosted: null, firstDiscoveredAt: new Date("2026-11-01T00:00:00.000Z"),
  sourceType: "GREENHOUSE", description: "Build things.", requirements: ["TypeScript"], preferredQualifications: [],
  currentEvidenceSnapshotId: "snap-1", evidenceSnapshotGeneration: 1,
  currentEvidenceSnapshot: {
    id: "snap-1", resumeId: "resume-1", sourceResumeUpdatedAt: resumeUpdatedAt, snapshotHash: "a".repeat(64),
    reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v2", facts: [], unresolvedGapIds: [] },
    reviewedAnalysisId: null
  }
};

function currentHash() {
  return currentJobMatchInputHash(buildCurrentJobMatchContext({ job: jobRow as never, resume: resumeRow as never, profile: null }).matchInput);
}

function analysisRow(confidenceScore: unknown, inputHash: string) {
  return {
    id: "analysis-1", inputHash, model: "m", promptVersion: "p", evidenceSnapshotId: "snap-1",
    output: { overallFitScore: 80, confidenceScore }, createdAt: new Date("2026-11-02T00:00:00.000Z")
  };
}

function stubPrisma(options: { job: boolean; analysis?: unknown; application?: unknown }) {
  const p = prisma as unknown as Record<string, Record<string, unknown>>;
  const originals: Array<[Record<string, unknown>, string, unknown]> = [];
  const stub = (model: string, method: string, value: unknown) => {
    originals.push([p[model], method, p[model][method]]);
    p[model][method] = async () => value;
  };
  stub("jobPosting", "findFirst", options.job ? jobRow : null);
  stub("resume", "findFirst", resumeRow);
  stub("userProfile", "findUnique", null);
  stub("resumeVersion", "findMany", []);
  stub("generatedDocument", "findMany", []);
  stub("application", "findUnique", options.application ?? null);
  stub("applicationEvent", "findFirst", null);
  stub("contact", "findMany", []);
  stub("aIAnalysis", "findFirst", options.analysis ?? null);
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
    assert.equal(detail.draftUserKey, createHash("sha256").update(userId).digest("hex").slice(0, 16));
    const other = await loadJobDetail("user-synthetic-sam-lee", "job-1");
    assert.notEqual(other?.draftUserKey, detail.draftUserKey);
  } finally { restore(); }
});

test("confidence is null without a current match", async () => {
  const restore = stubPrisma({ job: true });
  try {
    const detail = await loadJobDetail(userId, "job-1");
    assert.equal(detail?.currentConfidenceScore, null);
  } finally { restore(); }
});

async function confidenceFor(analysis: unknown) {
  const restore = stubPrisma({ job: true, analysis });
  try {
    return (await loadJobDetail(userId, "job-1"))?.currentConfidenceScore;
  } finally { restore(); }
}

test("a current analysis supplies its confidence score", async () => {
  assert.equal(await confidenceFor(analysisRow(87, currentHash())), 87);
});

test("a current analysis with an invalid confidence yields null", async () => {
  for (const bad of [101, -1, Number.NaN, Number.POSITIVE_INFINITY, "87", null, undefined]) {
    assert.equal(await confidenceFor(analysisRow(bad, currentHash())), null, String(bad));
  }
});

test("a non-current analysis with a score yields null", async () => {
  assert.equal(await confidenceFor(analysisRow(87, "stale-hash")), null);
});

test("the application carries the documents actually attached to it", async () => {
  const restore = stubPrisma({
    job: true,
    application: { id: "application-1", status: "INTERESTED", resumeVersionId: "resume-version-2", coverLetterVersionId: null }
  });
  try {
    const detail = await loadJobDetail(userId, "job-1");
    assert.deepEqual(detail?.application, {
      id: "application-1", statusLabel: "Interested", resumeVersionId: "resume-version-2", coverLetterVersionId: null
    });
  } finally { restore(); }
});
