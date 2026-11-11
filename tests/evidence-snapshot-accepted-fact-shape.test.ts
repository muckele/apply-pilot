import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { PublicApiError } from "@/lib/api-errors";
import { reviewedEvidenceFromSnapshot, type EvidenceSnapshotSaveInput } from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { prisma } from "@/lib/prisma";

// A job that already has an accepted owner fact. New or changed lines must be one sentence of up
// to 200 characters; a RETAINED earlier line is never re-checked. Same stubbed-transaction harness
// as evidence-snapshot-unchecked-save.test.ts.

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const JOB_ONLY = { reuseScope: "JOB_ONLY" as const, masterProfileOptIn: false as const };
const requirement = "Bachelor's degree in business or equivalent experience";
const resumeUpdatedAt = new Date("2026-11-01T10:00:00.000Z");
const oldFact = `${"Synthetic owner ran partner onboarding for example accounts and wrote the runbook ".repeat(4)}end.`;
const oldFactTwoSentences = "Synthetic owner ran onboarding. Synthetic owner wrote the runbook.";

const resume = {
  id: "resume-1", userId: "user-1", isMaster: true, updatedAt: resumeUpdatedAt,
  rawText: "Bachelor of Arts in Business Administration", summary: "Customer-facing technical operator.",
  skills: ["Discovery"], achievements: [], workHistory: [], projects: [], education: [], certifications: []
};

function fixture(priorFact: string) {
  const reviewPayload = {
    schema: "apply-pilot/evidence-snapshot-payload/v2",
    facts: [{
      factId: "fact:prior-1", originGapId: null, fact: priorFact,
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true }, ...JOB_ONLY
    }],
    unresolvedGapIds: ["gap:0"]
  };
  const currentEvidenceSnapshot = { id: "snapshot-0", resumeId: resume.id, sourceResumeUpdatedAt: resumeUpdatedAt, snapshotHash: "a".repeat(64), reviewPayload };
  const job = {
    id: "job-1", userId: "user-1", title: "Synthetic solutions operator", company: "Synthetic Example", location: "Remote",
    remoteStatus: null, salaryMin: null, salaryMax: null, description: "Synthetic role requiring business education.",
    requirements: [requirement], preferredQualifications: [], detectedTechStack: [],
    currentEvidenceSnapshotId: "snapshot-0", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot
  };
  const reviewedEvidence = reviewedEvidenceFromSnapshot(currentEvidenceSnapshot);
  const analysis = {
    id: "analysis-1",
    inputHash: currentJobMatchInputHash(buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence, evidenceSnapshotGeneration: 1 })),
    model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION, evidenceSnapshotId: "snapshot-0",
    output: {
      contractVersion: "3", promptVersion: JOB_MATCH_PROMPT_VERSION,
      requirementGaps: [{ requirement, jobRequirement: { ref: "job.requirements[0]", excerpt: requirement }, missingKeywords: ["business"] }]
    }
  };
  return { job, analysis };
}

function install(t: TestContext, priorFact: string) {
  const { job, analysis } = fixture(priorFact);
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
  return { created, analysis };
}

function request(analysis: { id: string; inputHash: string }, action: Extract<EvidenceSnapshotSaveInput, { schema: "apply-pilot/evidence-snapshot-save/v2" }>["acceptedFactActions"][number]): EvidenceSnapshotSaveInput {
  return {
    schema: "apply-pilot/evidence-snapshot-save/v2",
    requestId: "accepted-fact-shape",
    resumeId: resume.id,
    resumeUpdatedAt: resumeUpdatedAt.toISOString(),
    reviewedAnalysis: { id: analysis.id, inputHash: analysis.inputHash, model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION },
    decisions: [{ gapId: "gap:0", kind: "UNRESOLVED", ...JOB_ONLY }],
    acceptedFactActions: [action]
  };
}

const replace = (attestedFact: string) => ({
  factId: "fact:prior-1", action: "REPLACE_OWNER_ATTESTATION" as const, attestedFact, ownerAttested: true as const, ...JOB_ONLY
});
const tooLong = (error: unknown) => error instanceof PublicApiError && error.status === 422 && error.details?.code === "OWNER_FACT_TOO_LONG";

test("RETAIN keeps an earlier 300-character owner line and an earlier two-sentence line", async (t) => {
  for (const prior of [oldFact, oldFactTwoSentences]) {
    const { created, analysis } = install(t, prior);
    assert.ok(prior.length > 200 || prior === oldFactTwoSentences);
    await saveEvidenceSnapshot("user-1", "job-1", request(analysis, { factId: "fact:prior-1", action: "RETAIN" }));
    const payload = created.pop()!.reviewPayload as { facts: Array<{ fact: string }> };
    assert.equal(payload.facts[0]!.fact, prior);
  }
});

test("REPLACE refuses a 201-character line and a two-sentence line and writes nothing", async (t) => {
  for (const attestedFact of [`${"a".repeat(200)}.`, "Led demos for IT buyers. Ran trials."]) {
    const { created, analysis } = install(t, "Synthetic owner ran onboarding.");
    await assert.rejects(saveEvidenceSnapshot("user-1", "job-1", request(analysis, replace(attestedFact))), tooLong);
    assert.equal(created.length, 0);
  }
});

test("REPLACE accepts one short sentence", async (t) => {
  const { created, analysis } = install(t, oldFact);
  await saveEvidenceSnapshot("user-1", "job-1", request(analysis, replace("Synthetic owner ran partner onboarding.")));
  assert.equal(created.length, 1);
});
