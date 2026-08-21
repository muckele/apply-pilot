import assert from "node:assert/strict";
import { test } from "node:test";

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

test("review resolution requires a version and unique known reasons with no extra authority", () => {
  const valid = {
    stateVersion: 7,
    acknowledgedReviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"]
  } as const;
  assert.deepEqual(resolveApplicationRunReviewBodySchema.parse(valid), valid);
  assert.deepEqual(
    resolveApplicationRunReviewBodySchema.parse({ stateVersion: 0, acknowledgedReviewReasons: [] }),
    { stateVersion: 0, acknowledgedReviewReasons: [] }
  );

  for (const invalid of [
    { ...valid, stateVersion: -1 },
    { ...valid, stateVersion: 1.5 },
    { ...valid, acknowledgedReviewReasons: ["unknown_reason"] },
    { ...valid, acknowledgedReviewReasons: ["evidence_gaps_present", "evidence_gaps_present"] },
    { ...valid, state: "READY" },
    { ...valid, userId: "user-1" }
  ]) {
    assert.equal(resolveApplicationRunReviewBodySchema.safeParse(invalid).success, false);
  }
});

test("answer review accepts only APPROVED or REJECTED and rejects content/lifecycle fields", () => {
  assert.deepEqual(reviewApplicationRunAnswerBodySchema.parse({ status: "APPROVED" }), { status: "APPROVED" });
  assert.deepEqual(reviewApplicationRunAnswerBodySchema.parse({ status: "REJECTED" }), { status: "REJECTED" });
  for (const invalid of [
    { status: "PENDING" },
    { status: "APPROVED", userId: "user-1" },
    { status: "APPROVED", runId: CUID },
    { status: "APPROVED", proposedValue: "secret" },
    { status: "APPROVED", finalValueHash: "attacker" }
  ]) {
    assert.equal(reviewApplicationRunAnswerBodySchema.safeParse(invalid).success, false);
  }
});
