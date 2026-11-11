import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { PublicApiError } from "@/lib/api-errors";
import { reviewedEvidenceFromSnapshot, type EvidenceSnapshotSaveInput } from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { prisma } from "@/lib/prisma";

// The save rebuilds the review on the server from the job row, so answers to requirements the
// analysis never checked are validated against the same list the job page showed. The real
// transaction is covered by tests/postgres/evidence-snapshot-service.test.ts (guarded runner).

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const JOB_ONLY = { reuseScope: "JOB_ONLY" as const, masterProfileOptIn: false as const };
const requirement = "Bachelor's degree in business or equivalent experience";
const unchecked = "Write clear technical documentation for partner teams";

const job = {
  id: "job-1",
  userId: "user-1",
  title: "Synthetic solutions operator",
  company: "Synthetic Example",
  location: "Remote",
  remoteStatus: null,
  salaryMin: null,
  salaryMax: null,
  description: "Synthetic role requiring business education.",
  requirements: [requirement, "What You'll Do", unchecked],
  preferredQualifications: [],
  detectedTechStack: [],
  currentEvidenceSnapshotId: null,
  evidenceSnapshotGeneration: 0,
  currentEvidenceSnapshot: null
};

const resume = {
  id: "resume-1",
  userId: "user-1",
  isMaster: true,
  updatedAt: new Date("2026-11-01T10:00:00.000Z"),
  rawText: "Bachelor of Arts in Business Administration",
  summary: "Customer-facing technical operator.",
  skills: ["Discovery"],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: []
};

const analysis = {
  id: "analysis-1",
  inputHash: currentJobMatchInputHash(buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence: null })),
  model: JOB_MATCH_MODEL,
  promptVersion: JOB_MATCH_PROMPT_VERSION,
  evidenceSnapshotId: null,
  output: {
    contractVersion: "3",
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    requirementGaps: [{ requirement, jobRequirement: { ref: "job.requirements[0]", excerpt: requirement }, missingKeywords: ["business"] }]
  }
};

function installTransaction(t: TestContext) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: job.id }],
    jobPosting: { findUniqueOrThrow: async () => job, update: async () => ({}) },
    evidenceSnapshot: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "snapshot-1", snapshotHash: data.snapshotHash, createdAt: new Date("2026-11-09T12:00:00.000Z") };
      }
    },
    resume: { findFirst: async () => resume },
    userProfile: { findUnique: async () => null },
    aIAnalysis: { findFirst: async () => analysis },
    application: { findUnique: async () => null }
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  return created;
}

function request(gapId: string): EvidenceSnapshotSaveInput {
  return {
    schema: "apply-pilot/evidence-snapshot-save/v2",
    requestId: `unchecked-${gapId.replace(":", "-")}`,
    resumeId: resume.id,
    resumeUpdatedAt: resume.updatedAt.toISOString(),
    reviewedAnalysis: { id: analysis.id, inputHash: analysis.inputHash, model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION },
    decisions: [
      { gapId: "gap:0", kind: "UNRESOLVED", ...JOB_ONLY },
      { gapId, kind: "OWNER_ATTESTATION", attestedFact: "Synthetic owner wrote the partner integration guide.", ownerAttested: true, ...JOB_ONLY }
    ],
    acceptedFactActions: []
  };
}

test("the save accepts an answer to a listed requirement the analysis never checked and stores it as an owner fact", async (t) => {
  const created = installTransaction(t);
  const result = await saveEvidenceSnapshot("user-1", job.id, request("requirement:2"));
  assert.equal(result.snapshot.isCurrent, true);
  assert.equal(created.length, 1);
  const reviewed = reviewedEvidenceFromSnapshot({ id: "snapshot-1", snapshotHash: String(created[0]!.snapshotHash), reviewPayload: created[0]!.reviewPayload });
  assert.deepEqual(reviewed.facts, [{
    gapId: "requirement:2", fact: "Synthetic owner wrote the partner integration guide.", provenance: "OWNER_ATTESTED", sourceRef: null
  }]);
  assert.deepEqual(reviewed.unresolvedGapIds, ["gap:0"]);
});

test("the save refuses an answer to a stored heading and writes nothing", async (t) => {
  const created = installTransaction(t);
  await assert.rejects(
    saveEvidenceSnapshot("user-1", job.id, request("requirement:1")),
    (error: unknown) => error instanceof PublicApiError && error.status === 422 && error.details?.code === "EVIDENCE_REVIEW_INVALID"
  );
  assert.equal(created.length, 0);
});

test("the save refuses a new 201-character owner answer and writes nothing", async (t) => {
  const created = installTransaction(t);
  const input = request("requirement:2");
  const long = `${"a".repeat(200)}.`;
  (input.decisions[1] as { attestedFact: string }).attestedFact = long;
  assert.equal(long.length, 201);
  await assert.rejects(
    saveEvidenceSnapshot("user-1", job.id, input),
    (error: unknown) => error instanceof PublicApiError && error.status === 422 && error.details?.code === "OWNER_FACT_TOO_LONG"
  );
  assert.equal(created.length, 0);
});

test("the save refuses a new 201-character owner answer to a flagged gap and writes nothing", async (t) => {
  const created = installTransaction(t);
  const input = request("requirement:2");
  input.decisions[0] = { gapId: "gap:0", kind: "OWNER_ATTESTATION", attestedFact: `${"a".repeat(200)}.`, ownerAttested: true, ...JOB_ONLY };
  await assert.rejects(
    saveEvidenceSnapshot("user-1", job.id, input),
    (error: unknown) => error instanceof PublicApiError && error.status === 422 && error.details?.code === "OWNER_FACT_TOO_LONG"
  );
  assert.equal(created.length, 0);
});
