import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveTerminalFillAttemptOutcome,
  FILL_ATTEMPT_OUTCOMES,
  FILL_ELIGIBLE_FIELD_TYPES,
  FILL_ERROR_CODES,
  FILL_LEASE_MS,
  FILL_STEP_RESULTS,
  FillAttemptDomainError,
  mapFillStepResultToPersistence,
  projectVerifiedFillCandidates,
  reconcileFillFinalization,
  STOPPED_EARLY_FILL_ERRORS
} from "@/lib/application-runs/fill-attempt-domain";

const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ATTEMPT_ID = "c56a4180-65aa-42ec-a945-5fd21dec0538";

function fieldKey(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function stepKey(index: number, attemptId = ATTEMPT_ID): string {
  return `fill:${attemptId}:${fieldKey(index)}`;
}

const PERSISTED_IDENTITIES = [1, 2, 3, 4].map((index) => ({
  fillAttemptId: ATTEMPT_ID,
  stepKey: stepKey(index)
}));

function assertDomainRejects(operation: () => unknown): void {
  assert.throws(
    operation,
    (error) => error instanceof FillAttemptDomainError && error.code === "FILL_INTERNAL"
  );
}

test("Fill constants expose only the frozen lease, field, result, outcome, and error sets", () => {
  assert.equal(FILL_LEASE_MS, 600_000);
  assert.deepEqual(FILL_ELIGIBLE_FIELD_TYPES, [
    "TEXT",
    "EMAIL",
    "TEL",
    "URL",
    "TEXTAREA",
    "SELECT_ONE",
    "RADIO_GROUP",
    "CHECKBOX_BOOLEAN"
  ]);
  assert.deepEqual(FILL_STEP_RESULTS, [
    "FILLED",
    "PRESERVED_EXISTING",
    "MANUAL",
    "FAILED",
    "NOT_ATTEMPTED"
  ]);
  assert.deepEqual(FILL_ATTEMPT_OUTCOMES, ["COMPLETED", "STOPPED_EARLY", "RECOVERED_AFTER_LOSS"]);
  assert.deepEqual(FILL_ERROR_CODES, [
    "FILL_POLICY_DENIED",
    "FILL_REVIEW_REQUIRED",
    "FILL_ALREADY_IN_PROGRESS",
    "FILL_NO_ELIGIBLE_FIELDS",
    "FILL_STALE",
    "FILL_TARGET_TRUST_LOST",
    "FILL_UNEXPECTED_MUTATION",
    "FILL_WRITE_FAILED",
    "FILL_INTERNAL"
  ]);
  assert.deepEqual(STOPPED_EARLY_FILL_ERRORS, [
    "FILL_POLICY_DENIED",
    "FILL_TARGET_TRUST_LOST",
    "FILL_UNEXPECTED_MUTATION",
    "FILL_WRITE_FAILED",
    "FILL_INTERNAL"
  ]);
});

test("verified candidate projection preserves supplied canonical order and only filters unsupported or proposal-free material", () => {
  const candidates = [
    {
      normalizedFieldKey: fieldKey(4),
      fieldFingerprint: "a".repeat(64),
      fieldType: "URL" as const,
      proposal: { kind: "SCALAR" as const, value: "https://example.test" }
    },
    {
      normalizedFieldKey: fieldKey(1),
      fieldFingerprint: "b".repeat(64),
      fieldType: "NUMBER" as const,
      proposal: { kind: "SCALAR" as const, value: "7" }
    },
    {
      normalizedFieldKey: fieldKey(3),
      fieldFingerprint: "c".repeat(64),
      fieldType: "TEXT" as const,
      proposal: null
    },
    {
      normalizedFieldKey: fieldKey(2),
      fieldFingerprint: "d".repeat(64),
      fieldType: "TEXT" as const,
      proposal: { kind: "SCALAR" as const, value: "Canonical candidate" }
    },
    {
      normalizedFieldKey: fieldKey(6),
      fieldFingerprint: "e".repeat(64),
      fieldType: "FILE_UPLOAD" as const,
      proposal: {
        kind: "DOCUMENT_REFERENCE" as const,
        artifactType: "RESUME" as const,
        documentId: "resume-1",
        contentHash: "f".repeat(64)
      }
    },
    {
      normalizedFieldKey: fieldKey(5),
      fieldFingerprint: "f".repeat(64),
      fieldType: "RADIO_GROUP" as const,
      proposal: { kind: "OPTIONS" as const, optionKeys: ["1".repeat(64)] }
    }
  ];

  assert.deepEqual(projectVerifiedFillCandidates(candidates), [candidates[0], candidates[3], candidates[5]]);
});

test("safe step mapping produces only closed ApplicationRunStep persistence fields", () => {
  assert.deepEqual(mapFillStepResultToPersistence({ result: "FILLED", errorCode: null }), {
    status: "SUCCEEDED",
    redactedValueSummary: "FILLED",
    errorCategory: null
  });
  assert.deepEqual(mapFillStepResultToPersistence({ result: "PRESERVED_EXISTING", errorCode: null }), {
    status: "SKIPPED",
    redactedValueSummary: "PRESERVED_EXISTING",
    errorCategory: null
  });
  assert.deepEqual(mapFillStepResultToPersistence({ result: "MANUAL", errorCode: null }), {
    status: "SKIPPED",
    redactedValueSummary: "MANUAL",
    errorCategory: null
  });
  assert.deepEqual(mapFillStepResultToPersistence({ result: "FAILED", errorCode: "FILL_WRITE_FAILED" }), {
    status: "FAILED",
    redactedValueSummary: "FAILED",
    errorCategory: "FILL_WRITE_FAILED"
  });
  assert.deepEqual(mapFillStepResultToPersistence({ result: "NOT_ATTEMPTED", errorCode: null }), {
    status: "SKIPPED",
    redactedValueSummary: "NOT_ATTEMPTED",
    errorCategory: null
  });

  for (const invalid of [
    { result: "FILLED", errorCode: "FILL_INTERNAL" },
    { result: "PRESERVED_EXISTING", errorCode: "FILL_INTERNAL" },
    { result: "MANUAL", errorCode: "FILL_INTERNAL" },
    { result: "NOT_ATTEMPTED", errorCode: "FILL_INTERNAL" },
    { result: "FAILED", errorCode: null },
    { result: "FAILED", errorCode: "free-form-secret" },
    { result: "UNKNOWN", errorCode: null }
  ]) {
    assertDomainRejects(() => mapFillStepResultToPersistence(invalid));
  }
});

test("normal finalization reconciles exact completed, pre-field-stop, and in-field-stop shapes", () => {
  const completed = reconcileFillFinalization({
    fillAttemptId: ATTEMPT_ID,
    persistedSteps: PERSISTED_IDENTITIES.slice(0, 3),
    assertion: {
      fillAttemptId: ATTEMPT_ID,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [
        { stepKey: stepKey(1), result: "FILLED", errorCode: null },
        { stepKey: stepKey(2), result: "PRESERVED_EXISTING", errorCode: null },
        { stepKey: stepKey(3), result: "MANUAL", errorCode: null }
      ]
    }
  });
  assert.deepEqual(completed, {
    outcome: "COMPLETED",
    errorCategory: null,
    steps: [
      { stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null },
      { stepKey: stepKey(2), status: "SKIPPED", redactedValueSummary: "PRESERVED_EXISTING", errorCategory: null },
      { stepKey: stepKey(3), status: "SKIPPED", redactedValueSummary: "MANUAL", errorCategory: null }
    ]
  });

  const preFieldStop = reconcileFillFinalization({
    fillAttemptId: ATTEMPT_ID,
    persistedSteps: PERSISTED_IDENTITIES,
    assertion: {
      fillAttemptId: ATTEMPT_ID,
      outcome: "STOPPED_EARLY",
      errorCode: "FILL_TARGET_TRUST_LOST",
      steps: [
        { stepKey: stepKey(1), result: "FILLED", errorCode: null },
        { stepKey: stepKey(2), result: "MANUAL", errorCode: null },
        { stepKey: stepKey(3), result: "NOT_ATTEMPTED", errorCode: null },
        { stepKey: stepKey(4), result: "NOT_ATTEMPTED", errorCode: null }
      ]
    }
  });
  assert.equal(preFieldStop.outcome, "STOPPED_EARLY");
  assert.equal(preFieldStop.errorCategory, "FILL_TARGET_TRUST_LOST");
  assert.deepEqual(preFieldStop.steps[2], {
    stepKey: stepKey(3),
    status: "SKIPPED",
    redactedValueSummary: "NOT_ATTEMPTED",
    errorCategory: null
  });

  const inFieldStop = reconcileFillFinalization({
    fillAttemptId: ATTEMPT_ID,
    persistedSteps: PERSISTED_IDENTITIES,
    assertion: {
      fillAttemptId: ATTEMPT_ID,
      outcome: "STOPPED_EARLY",
      errorCode: "FILL_WRITE_FAILED",
      steps: [
        { stepKey: stepKey(1), result: "PRESERVED_EXISTING", errorCode: null },
        { stepKey: stepKey(2), result: "FAILED", errorCode: "FILL_WRITE_FAILED" },
        { stepKey: stepKey(3), result: "NOT_ATTEMPTED", errorCode: null },
        { stepKey: stepKey(4), result: "NOT_ATTEMPTED", errorCode: null }
      ]
    }
  });
  assert.equal(inFieldStop.outcome, "STOPPED_EARLY");
  assert.equal(inFieldStop.errorCategory, "FILL_WRITE_FAILED");
  assert.deepEqual(inFieldStop.steps[1], {
    stepKey: stepKey(2),
    status: "FAILED",
    redactedValueSummary: "FAILED",
    errorCategory: "FILL_WRITE_FAILED"
  });
});

test("normal finalization rejects identity, coverage, order, and deterministic stop-pattern violations", () => {
  const validStopped = {
    fillAttemptId: ATTEMPT_ID,
    outcome: "STOPPED_EARLY",
    errorCode: "FILL_INTERNAL",
    steps: [
      { stepKey: stepKey(1), result: "FILLED", errorCode: null },
      { stepKey: stepKey(2), result: "FAILED", errorCode: "FILL_INTERNAL" },
      { stepKey: stepKey(3), result: "NOT_ATTEMPTED", errorCode: null },
      { stepKey: stepKey(4), result: "NOT_ATTEMPTED", errorCode: null }
    ]
  } as const;

  const invalidAssertions: unknown[] = [
    { ...validStopped, steps: [validStopped.steps[0], validStopped.steps[0], ...validStopped.steps.slice(2)] },
    { ...validStopped, steps: validStopped.steps.slice(0, 3) },
    { ...validStopped, steps: [...validStopped.steps, { stepKey: stepKey(5), result: "NOT_ATTEMPTED", errorCode: null }] },
    { ...validStopped, steps: [validStopped.steps[1], validStopped.steps[0], ...validStopped.steps.slice(2)] },
    { ...validStopped, fillAttemptId: OTHER_ATTEMPT_ID },
    { ...validStopped, steps: [{ ...validStopped.steps[0], stepKey: stepKey(1, OTHER_ATTEMPT_ID) }, ...validStopped.steps.slice(1)] },
    { ...validStopped, errorCode: "FILL_STALE" },
    { ...validStopped, errorCode: "FILL_REVIEW_REQUIRED" },
    { ...validStopped, errorCode: "FILL_ALREADY_IN_PROGRESS" },
    { ...validStopped, errorCode: "FILL_NO_ELIGIBLE_FIELDS" },
    { ...validStopped, steps: [
      { stepKey: stepKey(1), result: "FAILED", errorCode: "FILL_INTERNAL" },
      { stepKey: stepKey(2), result: "FAILED", errorCode: "FILL_INTERNAL" },
      ...validStopped.steps.slice(2)
    ] },
    { ...validStopped, steps: [
      { stepKey: stepKey(1), result: "FAILED", errorCode: "FILL_INTERNAL" },
      { stepKey: stepKey(2), result: "FILLED", errorCode: null },
      ...validStopped.steps.slice(2)
    ] },
    { ...validStopped, steps: [
      { stepKey: stepKey(1), result: "NOT_ATTEMPTED", errorCode: null },
      { stepKey: stepKey(2), result: "FILLED", errorCode: null },
      ...validStopped.steps.slice(2)
    ] },
    { ...validStopped, steps: validStopped.steps.map((step, index) => index === 1 ? { ...step, errorCode: "FILL_WRITE_FAILED" } : step) },
    { ...validStopped, steps: validStopped.steps.map((step, index) => index === 2 ? { ...step, errorCode: "FILL_INTERNAL" } : step) },
    { ...validStopped, outcome: "COMPLETED", errorCode: null, steps: validStopped.steps },
    { ...validStopped, outcome: "UNKNOWN" }
  ];

  for (const assertion of invalidAssertions) {
    assertDomainRejects(() => reconcileFillFinalization({
      fillAttemptId: ATTEMPT_ID,
      persistedSteps: PERSISTED_IDENTITIES,
      assertion
    }));
  }

  assertDomainRejects(() => reconcileFillFinalization({
    fillAttemptId: ATTEMPT_ID,
    persistedSteps: [
      PERSISTED_IDENTITIES[0],
      { fillAttemptId: OTHER_ATTEMPT_ID, stepKey: stepKey(2, OTHER_ATTEMPT_ID) },
      ...PERSISTED_IDENTITIES.slice(2)
    ],
    assertion: validStopped
  }));
});

test("terminal outcome derivation accepts completed, both stopped shapes, and recovered-loss persistence", () => {
  assert.deepEqual(deriveTerminalFillAttemptOutcome({
    state: "READY_FOR_USER_SUBMISSION",
    fillAttemptId: ATTEMPT_ID,
    errorCategory: null,
    canonicalStepKeys: [stepKey(1), stepKey(2), stepKey(3)],
    steps: [
      { stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null },
      { stepKey: stepKey(2), status: "SKIPPED", redactedValueSummary: "PRESERVED_EXISTING", errorCategory: null },
      { stepKey: stepKey(3), status: "SKIPPED", redactedValueSummary: "MANUAL", errorCategory: null }
    ]
  }), { outcome: "COMPLETED", errorCode: null });

  assert.deepEqual(deriveTerminalFillAttemptOutcome({
    state: "READY_FOR_USER_SUBMISSION",
    fillAttemptId: ATTEMPT_ID,
    errorCategory: "FILL_POLICY_DENIED",
    canonicalStepKeys: [stepKey(1), stepKey(2)],
    steps: [
      { stepKey: stepKey(1), status: "SKIPPED", redactedValueSummary: "MANUAL", errorCategory: null },
      { stepKey: stepKey(2), status: "SKIPPED", redactedValueSummary: "NOT_ATTEMPTED", errorCategory: null }
    ]
  }), { outcome: "STOPPED_EARLY", errorCode: "FILL_POLICY_DENIED" });

  assert.deepEqual(deriveTerminalFillAttemptOutcome({
    state: "READY_FOR_USER_SUBMISSION",
    fillAttemptId: ATTEMPT_ID,
    errorCategory: "FILL_UNEXPECTED_MUTATION",
    canonicalStepKeys: [stepKey(1), stepKey(2), stepKey(3)],
    steps: [
      { stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null },
      { stepKey: stepKey(2), status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_UNEXPECTED_MUTATION" },
      { stepKey: stepKey(3), status: "SKIPPED", redactedValueSummary: "NOT_ATTEMPTED", errorCategory: null }
    ]
  }), { outcome: "STOPPED_EARLY", errorCode: "FILL_UNEXPECTED_MUTATION" });

  assert.deepEqual(deriveTerminalFillAttemptOutcome({
    state: "READY_FOR_USER_SUBMISSION",
    fillAttemptId: ATTEMPT_ID,
    errorCategory: "FILL_STALE",
    canonicalStepKeys: [stepKey(1), stepKey(2), stepKey(3)],
    steps: [
      { stepKey: stepKey(1), status: "SKIPPED", redactedValueSummary: "PRESERVED_EXISTING", errorCategory: null },
      { stepKey: stepKey(2), status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_STALE" },
      { stepKey: stepKey(3), status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_STALE" }
    ]
  }), { outcome: "RECOVERED_AFTER_LOSS", errorCode: "FILL_STALE" });
});

test("cancelled runs derive no Fill outcome and contradictory non-cancelled persistence fails closed", () => {
  assert.deepEqual(deriveTerminalFillAttemptOutcome({
    state: "CANCELLED",
    fillAttemptId: ATTEMPT_ID,
    errorCategory: "raw-historical-error",
    canonicalStepKeys: [stepKey(1)],
    steps: [{ stepKey: stepKey(1), status: "RUNNING", redactedValueSummary: "raw", errorCategory: "raw" }]
  }), { outcome: null, errorCode: null });

  const contradictory = [
    {
      state: "READY",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: null,
      canonicalStepKeys: [stepKey(1)],
      steps: [{ stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null }]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: null,
      errorCategory: null,
      canonicalStepKeys: [stepKey(1)],
      steps: [{ stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null }]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: null,
      canonicalStepKeys: [stepKey(1), stepKey(2)],
      steps: [{ stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null }]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: "FILL_WRITE_FAILED",
      canonicalStepKeys: [stepKey(1), stepKey(2)],
      steps: [
        { stepKey: stepKey(1), status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_WRITE_FAILED" },
        { stepKey: stepKey(2), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null }
      ]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: "FILL_STALE",
      canonicalStepKeys: [stepKey(1), stepKey(2)],
      steps: [
        { stepKey: stepKey(1), status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_STALE" },
        { stepKey: stepKey(2), status: "SKIPPED", redactedValueSummary: "NOT_ATTEMPTED", errorCategory: null }
      ]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: "FILL_STALE",
      canonicalStepKeys: [stepKey(1)],
      steps: [{ stepKey: stepKey(1), status: "SUCCEEDED", redactedValueSummary: "FILLED", errorCategory: null }]
    },
    {
      state: "READY_FOR_USER_SUBMISSION",
      fillAttemptId: ATTEMPT_ID,
      errorCategory: "raw-secret-error",
      canonicalStepKeys: [stepKey(1)],
      steps: [{ stepKey: stepKey(1), status: "FAILED", redactedValueSummary: "raw-secret-value", errorCategory: "raw-secret-error" }]
    }
  ];

  for (const input of contradictory) {
    assert.deepEqual(deriveTerminalFillAttemptOutcome(input), {
      outcome: null,
      errorCode: "FILL_INTERNAL"
    });
  }
});
