import assert from "node:assert/strict";
import { test } from "node:test";

import * as applicationRunContracts from "@/lib/application-runs/contracts";
import {
  applicationRunAnswerPathSchema,
  applicationRunExecutionTokenPathSchema,
  applicationRunPathSchema,
  createApplicationRunBodySchema,
  resolveApplicationRunReviewBodySchema,
  reviewApplicationRunAnswerBodySchema,
  strictEmptyBodySchema
} from "@/lib/application-runs/contracts";

const CUID = "clz8w7m9a0000qwer1234tyui";
const ANSWER_CUID = "clz8w7m9a0001qwer1234tyui";
const TOKEN_CUID = "clz8w7m9a0002qwer1234tyui";
const PACKET_HASH = "a".repeat(64);
const FILL_ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const FILL_FIELD_KEY = "b".repeat(64);
const FILL_STEP_KEY = `fill:${FILL_ATTEMPT_ID}:${FILL_FIELD_KEY}`;

type RuntimeSchema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
};

function contractSchema(name: string): RuntimeSchema {
  const schema = (applicationRunContracts as Record<string, unknown>)[name];
  assert.ok(schema, `expected ${name} to be exported`);
  return schema as RuntimeSchema;
}

test("application-run path identifiers require a runtime-valid CUID", () => {
  assert.equal(applicationRunPathSchema.safeParse({ id: CUID }).success, true);
  for (const id of [undefined, "", "run-1", "not a cuid", null]) {
    assert.equal(applicationRunPathSchema.safeParse({ id }).success, false);
  }
});

test("answer review paths require both runtime-valid CUIDs and reject extra keys", () => {
  assert.deepEqual(applicationRunAnswerPathSchema.parse({ id: CUID, answerId: ANSWER_CUID }), {
    id: CUID,
    answerId: ANSWER_CUID
  });
  assert.equal(applicationRunAnswerPathSchema.safeParse({ id: CUID, answerId: "answer-1" }).success, false);
  assert.equal(applicationRunAnswerPathSchema.safeParse({ id: "run-1", answerId: ANSWER_CUID }).success, false);
  assert.equal(
    applicationRunAnswerPathSchema.safeParse({ id: CUID, answerId: ANSWER_CUID, userId: "user-1" }).success,
    false
  );
});

test("run-bound execution-token paths require both runtime-valid CUIDs and reject extra keys", () => {
  assert.deepEqual(applicationRunExecutionTokenPathSchema.parse({ id: CUID, tokenId: TOKEN_CUID }), {
    id: CUID,
    tokenId: TOKEN_CUID
  });
  assert.equal(applicationRunExecutionTokenPathSchema.safeParse({ id: CUID, tokenId: "token-1" }).success, false);
  assert.equal(applicationRunExecutionTokenPathSchema.safeParse({ id: "run-1", tokenId: TOKEN_CUID }).success, false);
  assert.equal(
    applicationRunExecutionTokenPathSchema.safeParse({ id: CUID, tokenId: TOKEN_CUID, userId: "user-1" }).success,
    false
  );
});

test("create-run input accepts only applicationId and idempotencyKey", () => {
  const valid = { applicationId: CUID, idempotencyKey: "request-12345678" };
  assert.deepEqual(createApplicationRunBodySchema.parse(valid), valid);

  for (const field of [
    "userId",
    "jobPostingId",
    "applyHost",
    "applyUrlSnapshot",
    "state",
    "stateVersion",
    "activeRunKey",
    "policy",
    "provider",
    "clock",
    "scope"
  ]) {
    assert.equal(
      createApplicationRunBodySchema.safeParse({ ...valid, [field]: "smuggled" }).success,
      false,
      `expected ${field} to be rejected`
    );
  }
});

test("create-run input rejects malformed IDs and idempotency keys", () => {
  assert.equal(
    createApplicationRunBodySchema.safeParse({ applicationId: "application-1", idempotencyKey: "request-12345678" }).success,
    false
  );
  for (const idempotencyKey of ["short", "contains spaces", "x".repeat(129), "request/invalid"]) {
    assert.equal(createApplicationRunBodySchema.safeParse({ applicationId: CUID, idempotencyKey }).success, false);
  }
});

test("strict empty bodies reject authoritative-looking properties", () => {
  assert.deepEqual(strictEmptyBodySchema.parse({}), {});
  assert.equal(strictEmptyBodySchema.safeParse({ scope: "APPLICATION_FILL" }).success, false);
  assert.equal(strictEmptyBodySchema.safeParse({ state: "READY" }).success, false);
});

test("review resolution requires packet fences correlated to legacy or packet-backed review", () => {
  const valid = {
    stateVersion: 7,
    acknowledgedReviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"],
    answerPacketVersion: 3,
    packetHash: PACKET_HASH
  } as const;
  assert.deepEqual(resolveApplicationRunReviewBodySchema.parse(valid), valid);
  assert.deepEqual(
    resolveApplicationRunReviewBodySchema.parse({
      stateVersion: 0,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 0,
      packetHash: null
    }),
    { stateVersion: 0, acknowledgedReviewReasons: [], answerPacketVersion: 0, packetHash: null }
  );

  for (const invalid of [
    { ...valid, stateVersion: -1 },
    { ...valid, stateVersion: 1.5 },
    { stateVersion: 7, acknowledgedReviewReasons: valid.acknowledgedReviewReasons, packetHash: PACKET_HASH },
    { stateVersion: 7, acknowledgedReviewReasons: valid.acknowledgedReviewReasons, answerPacketVersion: 3 },
    { ...valid, answerPacketVersion: -1 },
    { ...valid, answerPacketVersion: 1.5 },
    { ...valid, answerPacketVersion: "3" },
    { ...valid, answerPacketVersion: 0 },
    { ...valid, packetHash: null },
    { ...valid, packetHash: "A".repeat(64) },
    { ...valid, packetHash: "a".repeat(63) },
    { ...valid, packetHash: "g".repeat(64) },
    { ...valid, acknowledgedReviewReasons: ["unknown_reason"] },
    { ...valid, acknowledgedReviewReasons: ["evidence_gaps_present", "evidence_gaps_present"] },
    { ...valid, state: "READY" },
    { ...valid, userId: "user-1" }
  ]) {
    assert.equal(resolveApplicationRunReviewBodySchema.safeParse(invalid).success, false);
  }
});

test("answer review requires an explicit nonnegative integer packet version and rejects caller authority", () => {
  assert.deepEqual(reviewApplicationRunAnswerBodySchema.parse({ status: "APPROVED", answerPacketVersion: 0 }), {
    status: "APPROVED",
    answerPacketVersion: 0
  });
  assert.deepEqual(reviewApplicationRunAnswerBodySchema.parse({ status: "REJECTED", answerPacketVersion: 3 }), {
    status: "REJECTED",
    answerPacketVersion: 3
  });
  for (const invalid of [
    { status: "PENDING" },
    { status: "APPROVED" },
    { status: "APPROVED", answerPacketVersion: -1 },
    { status: "APPROVED", answerPacketVersion: 1.5 },
    { status: "APPROVED", answerPacketVersion: "0" },
    { status: "APPROVED", answerPacketVersion: 0, userId: "user-1" },
    { status: "APPROVED", answerPacketVersion: 0, runId: CUID },
    { status: "APPROVED", answerPacketVersion: 0, answerPacketId: "packet-1" },
    { status: "APPROVED", answerPacketVersion: 0, proposal: { kind: "SCALAR", value: "secret" } },
    { status: "APPROVED", answerPacketVersion: 0, proposedValue: "secret" },
    { status: "APPROVED", answerPacketVersion: 0, finalValueHash: "attacker" },
    { status: "APPROVED", answerPacketVersion: 0, reviewHashVersion: "CANONICAL_PROPOSAL_V1" },
    { status: "APPROVED", answerPacketVersion: 0, sourceIds: ["source-1"] },
    { status: "APPROVED", answerPacketVersion: 0, sourceFingerprint: "fingerprint" },
    { status: "APPROVED", answerPacketVersion: 0, fieldFingerprint: "fingerprint" },
    { status: "APPROVED", answerPacketVersion: 0, classification: "AVAILABILITY" },
    { status: "APPROVED", answerPacketVersion: 0, disposition: "PROPOSABLE" }
  ]) {
    assert.equal(reviewApplicationRunAnswerBodySchema.safeParse(invalid).success, false);
  }
});

test("form-inspection publication requires the exact safe versioned envelope", () => {
  const schema = contractSchema("publishApplicationRunFormInspectionBodySchema");
  const report = { schemaVersion: 1, forms: [] };
  const valid = {
    expectedStateVersion: 7,
    expectedFormInspectionVersion: 3,
    expectedAnswerPacketVersion: 4,
    observedUrl: "https://jobs.example.com/apply/123",
    inspectionReport: report
  };

  assert.deepEqual(schema.parse(valid), valid);
  for (const field of [
    "expectedStateVersion",
    "expectedFormInspectionVersion",
    "expectedAnswerPacketVersion"
  ]) {
    for (const invalid of [undefined, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const candidate = { ...valid, [field]: invalid };
      if (invalid === undefined) delete candidate[field as keyof typeof candidate];
      assert.equal(schema.safeParse(candidate).success, false, `${field}:${String(invalid)}`);
    }
  }

  assert.equal(schema.safeParse({ ...valid, observedUrl: "x".repeat(2_049) }).success, false);
  assert.equal(schema.safeParse({ ...valid, inspectionReport: null }).success, true);
  assert.equal(schema.safeParse({ ...valid, inspectionReport: "deferred-to-F1" }).success, true);

  const missingReport = { ...valid } as Record<string, unknown>;
  delete missingReport.inspectionReport;
  assert.equal(schema.safeParse(missingReport).success, false);

  for (const field of [
    "userId",
    "runId",
    "state",
    "applyHost",
    "packetHash",
    "proposal",
    "sourceIds",
    "documentId",
    "contentHash",
    "scope",
    "token"
  ]) {
    assert.equal(schema.safeParse({ ...valid, [field]: "smuggled" }).success, false, field);
  }
});

test("answer-packet rebuild accepts only the three required safe version counters", () => {
  const schema = contractSchema("rebuildApplicationRunAnswerPacketBodySchema");
  const valid = {
    expectedStateVersion: 7,
    expectedFormInspectionVersion: 3,
    expectedAnswerPacketVersion: 4
  };

  assert.deepEqual(schema.parse(valid), valid);
  for (const field of Object.keys(valid)) {
    for (const invalid of [undefined, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const candidate = { ...valid, [field]: invalid };
      if (invalid === undefined) delete candidate[field as keyof typeof candidate];
      assert.equal(schema.safeParse(candidate).success, false, `${field}:${String(invalid)}`);
    }
  }

  for (const field of [
    "observedUrl",
    "inspectionReport",
    "sourceValue",
    "sourceIds",
    "documentId",
    "proposal",
    "packetHash",
    "policy",
    "scope",
    "token",
    "userId",
    "runId"
  ]) {
    assert.equal(schema.safeParse({ ...valid, [field]: "smuggled" }).success, false, field);
  }
});

test("fill acquisition accepts only one required nonnegative safe state version", () => {
  const schema = contractSchema("acquireApplicationRunFillAttemptBodySchema");
  assert.deepEqual(schema.parse({ expectedStateVersion: 0 }), { expectedStateVersion: 0 });
  assert.deepEqual(schema.parse({ expectedStateVersion: Number.MAX_SAFE_INTEGER }), {
    expectedStateVersion: Number.MAX_SAFE_INTEGER
  });

  for (const expectedStateVersion of [undefined, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const candidate: Record<string, unknown> = { expectedStateVersion };
    if (expectedStateVersion === undefined) delete candidate.expectedStateVersion;
    assert.equal(schema.safeParse(candidate).success, false, String(expectedStateVersion));
  }

  for (const field of [
    "runId",
    "userId",
    "host",
    "policy",
    "proposal",
    "token",
    "scope",
    "fillAttemptId",
    "state",
    "submit"
  ]) {
    assert.equal(schema.safeParse({ expectedStateVersion: 0, [field]: "smuggled" }).success, false, field);
  }
});

test("fill FINALIZE and RECOVER_EXPIRED requests form one strict closed action contract", () => {
  const schema = contractSchema("applicationRunFillAttemptPatchBodySchema");
  const completed = {
    action: "FINALIZE",
    fillAttemptId: FILL_ATTEMPT_ID,
    expectedStateVersion: 12,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{ stepKey: FILL_STEP_KEY, result: "FILLED", errorCode: null }]
  } as const;
  assert.deepEqual(schema.parse(completed), completed);

  for (const errorCode of [
    "FILL_POLICY_DENIED",
    "FILL_TARGET_TRUST_LOST",
    "FILL_UNEXPECTED_MUTATION",
    "FILL_WRITE_FAILED",
    "FILL_INTERNAL"
  ]) {
    const stopped = {
      ...completed,
      outcome: "STOPPED_EARLY",
      errorCode,
      steps: [{ stepKey: FILL_STEP_KEY, result: "FAILED", errorCode }]
    };
    assert.equal(schema.safeParse(stopped).success, true, errorCode);
  }

  const recovery = {
    action: "RECOVER_EXPIRED",
    fillAttemptId: FILL_ATTEMPT_ID,
    expectedStateVersion: 12
  } as const;
  assert.deepEqual(schema.parse(recovery), recovery);

  for (const invalid of [
    { ...completed, fillAttemptId: "attempt-1" },
    { ...completed, expectedStateVersion: -1 },
    { ...completed, expectedStateVersion: 1.5 },
    { ...completed, expectedStateVersion: "12" },
    { ...completed, expectedStateVersion: Number.NaN },
    { ...completed, expectedStateVersion: Number.POSITIVE_INFINITY },
    { ...completed, expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...completed, outcome: "UNKNOWN" },
    { ...completed, outcome: "COMPLETED", errorCode: "FILL_WRITE_FAILED" },
    { ...completed, outcome: "STOPPED_EARLY", errorCode: null },
    { ...completed, outcome: "STOPPED_EARLY", errorCode: "FILL_REVIEW_REQUIRED" },
    { ...completed, outcome: "STOPPED_EARLY", errorCode: "FILL_ALREADY_IN_PROGRESS" },
    { ...completed, outcome: "STOPPED_EARLY", errorCode: "FILL_NO_ELIGIBLE_FIELDS" },
    { ...completed, outcome: "STOPPED_EARLY", errorCode: "FILL_STALE" },
    { ...completed, steps: [{ stepKey: FILL_STEP_KEY, result: "UNKNOWN", errorCode: null }] },
    { ...completed, steps: [{ stepKey: FILL_STEP_KEY, result: "FAILED", errorCode: "FREE_FORM" }] },
    { ...completed, steps: [{ stepKey: "unbounded-or-foreign", result: "FILLED", errorCode: null }] },
    { ...completed, steps: [] },
    { ...completed, steps: Array.from({ length: 201 }, (_, index) => ({
      stepKey: `fill:${FILL_ATTEMPT_ID}:${index.toString(16).padStart(64, "0")}`,
      result: "FILLED",
      errorCode: null
    })) },
    { ...completed, steps: [completed.steps[0], completed.steps[0]] },
    { ...completed, unknownField: true },
    { ...completed, steps: [{ ...completed.steps[0], selector: "#secret" }] },
    { ...recovery, steps: completed.steps },
    { ...recovery, outcome: "RECOVERED_AFTER_LOSS" },
    { ...recovery, errorCode: "FILL_STALE" },
    { ...recovery, proposal: { kind: "SCALAR", value: "secret" } },
    { ...recovery, token: "secret" },
    { ...recovery, renew: true },
    { ...recovery, submit: true },
    { ...recovery, completionAttestation: "USER_PERSONALLY_SUBMITTED_ON_EMPLOYER_SITE" },
    { action: "COMPLETE", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 12 },
    { action: "RETRY", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 12 },
    { action: "RENEW", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 12 },
    { action: "SUBMIT", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 12 }
  ]) {
    assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});
