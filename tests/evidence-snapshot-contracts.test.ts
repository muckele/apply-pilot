import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceSnapshotReviewPayloadSchema,
  evidenceSnapshotSaveBodySchema,
  reviewedEvidenceFromSnapshot
} from "@/lib/jobs/evidence-snapshot-contracts";

const sourceDecision = {
  gapId: "gap:0",
  kind: "SOURCE_CORRECTION" as const,
  sourceFactId: "fact:resume.rawText",
  sourceExcerpt: "Bachelor of Arts in Business Administration",
  correctedFact: "Bachelor of Arts in Business Administration",
  reuseScope: "JOB_ONLY" as const,
  masterProfileOptIn: false as const
};

const validRequest = {
  schema: "apply-pilot/evidence-snapshot-save/v1" as const,
  requestId: "evidence-save-12345678",
  resumeId: "resume-1",
  resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
  reviewedAnalysis: {
    id: "analysis-1",
    inputHash: "a".repeat(64),
    model: "gemini-3.8-flash",
    promptVersion: "3.4"
  },
  decisions: [sourceDecision]
};

test("save request accepts only bounded fences and ordered job-only decisions", () => {
  const parsed = evidenceSnapshotSaveBodySchema.parse(validRequest);
  assert.deepEqual(parsed, validRequest);

  for (const extra of [
    { snapshotHash: "b".repeat(64) },
    { sourceProjectionHash: "c".repeat(64) },
    { facts: [{ value: "browser authority" }] },
    { userId: "another-owner" },
    { jobId: "another-job" }
  ]) {
    assert.equal(evidenceSnapshotSaveBodySchema.safeParse({ ...validRequest, ...extra }).success, false);
  }
});

test("durable contract rejects master-profile promotion, missing attestation, and unbounded text", () => {
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...validRequest,
    decisions: [{
      gapId: "gap:0",
      kind: "OWNER_ATTESTATION",
      attestedFact: "Owner-attested synthetic fact.",
      ownerAttested: true,
      reuseScope: "MASTER_PROFILE",
      masterProfileOptIn: true
    }]
  }).success, false);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...validRequest,
    decisions: [{
      gapId: "gap:0",
      kind: "OWNER_ATTESTATION",
      attestedFact: "Owner-attested synthetic fact.",
      ownerAttested: false,
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }]
  }).success, false);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...validRequest,
    decisions: [{ ...sourceDecision, sourceExcerpt: "x".repeat(4_001) }]
  }).success, false);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...validRequest,
    decisions: [{
      ...sourceDecision,
      sourceExcerpt: "No Kubernetes experience",
      correctedFact: "Kubernetes experience"
    }]
  }).success, false);
});

test("v2 save requires bounded explicit actions for current accepted facts", () => {
  const request = {
    ...validRequest,
    schema: "apply-pilot/evidence-snapshot-save/v2" as const,
    acceptedFactActions: [
      { factId: "fact:snapshot-1:0", action: "RETAIN" as const },
      { factId: "fact:snapshot-1:1", action: "REMOVE" as const },
      {
        factId: "fact:snapshot-1:2",
        action: "REPLACE_OWNER_ATTESTATION" as const,
        attestedFact: "Corrected synthetic owner fact.",
        ownerAttested: true as const,
        reuseScope: "JOB_ONLY" as const,
        masterProfileOptIn: false as const
      }
    ]
  };
  assert.deepEqual(evidenceSnapshotSaveBodySchema.parse(request), request);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...request,
    acceptedFactActions: [{ ...request.acceptedFactActions[2], ownerAttested: false }]
  }).success, false);
});

test("v2 save bounds the combined facts that retain, replace, and resolve can persist", () => {
  const action = (index: number) => ({ factId: `fact:retained-${index}`, action: "RETAIN" as const });
  const decision = (index: number) => ({
    gapId: `gap:${index}`,
    kind: "OWNER_ATTESTATION" as const,
    attestedFact: `Synthetic accepted fact ${index}.`,
    ownerAttested: true as const,
    reuseScope: "JOB_ONLY" as const,
    masterProfileOptIn: false as const
  });
  const request = {
    ...validRequest,
    schema: "apply-pilot/evidence-snapshot-save/v2" as const,
    decisions: Array.from({ length: 50 }, (_, index) => decision(index)),
    acceptedFactActions: Array.from({ length: 50 }, (_, index) => action(index))
  };
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse(request).success, true);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...request,
    decisions: Array.from({ length: 51 }, (_, index) => decision(index))
  }).success, false);
  assert.equal(evidenceSnapshotSaveBodySchema.safeParse({
    ...request,
    decisions: Array.from({ length: 100 }, (_, index) => ({
      gapId: `gap:${index}`,
      kind: "UNRESOLVED" as const,
      reuseScope: "JOB_ONLY" as const,
      masterProfileOptIn: false as const
    }))
  }).success, true);
});

test("v2 payload projects carried facts independently of positional gap identifiers", () => {
  const payload = evidenceSnapshotReviewPayloadSchema.parse({
    schema: "apply-pilot/evidence-snapshot-payload/v2",
    facts: [{
      factId: "fact:stable-owner-fact",
      originGapId: null,
      fact: "Synthetic owner has business operations experience.",
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }],
    unresolvedGapIds: []
  });
  const projection = reviewedEvidenceFromSnapshot({
    id: "snapshot-2",
    snapshotHash: "e".repeat(64),
    reviewPayload: payload
  });
  assert.equal(projection.facts[0].gapId, "fact:stable-owner-fact");
  assert.equal(projection.facts[0].fact, "Synthetic owner has business operations experience.");
});

test("persisted decisions project explicit submitted-source versus owner-attested provenance", () => {
  assert.equal(evidenceSnapshotReviewPayloadSchema.safeParse({
    schema: "apply-pilot/evidence-snapshot-payload/v1",
    decisions: [{
      gapId: "gap:0",
      status: "RESOLVED",
      fact: "Kubernetes experience",
      provenance: {
        kind: "EXISTING_SOURCE",
        sourceFactId: "fact:resume.rawText",
        sourceRef: "resume.rawText",
        sourceExcerpt: "No Kubernetes experience"
      },
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }]
  }).success, false);
  const payload = evidenceSnapshotReviewPayloadSchema.parse({
    schema: "apply-pilot/evidence-snapshot-payload/v1",
    decisions: [
      {
        gapId: "gap:0",
        status: "RESOLVED",
        fact: "Bachelor of Arts in Business Administration",
        provenance: {
          kind: "EXISTING_SOURCE",
          sourceFactId: "fact:resume.rawText",
          sourceRef: "resume.rawText",
          sourceExcerpt: "Bachelor of Arts in Business Administration"
        },
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      },
      {
        gapId: "gap:1",
        status: "RESOLVED",
        fact: "Led a synthetic migration review.",
        provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      },
      {
        gapId: "gap:2",
        status: "UNRESOLVED",
        fact: null,
        provenance: { kind: "NONE" },
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      }
    ]
  });
  const projection = reviewedEvidenceFromSnapshot({
    id: "snapshot-1",
    snapshotHash: "f".repeat(64),
    reviewPayload: payload
  });

  assert.deepEqual(projection, {
    schema: "apply-pilot/job-match-reviewed-evidence/v1",
    snapshotId: "snapshot-1",
    snapshotHash: "f".repeat(64),
    facts: [
      {
        gapId: "gap:0",
        fact: "Bachelor of Arts in Business Administration",
        provenance: "SUBMITTED_RESUME",
        sourceRef: "resume.rawText"
      },
      {
        gapId: "gap:1",
        fact: "Led a synthetic migration review.",
        provenance: "OWNER_ATTESTED",
        sourceRef: null
      }
    ],
    unresolvedGapIds: ["gap:2"]
  });
});
