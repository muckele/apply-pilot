import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateFillResults,
  classifyFillStatus,
  fillStatusPresentation,
  parseFillStatusResponse,
  reconcileFillStatusSnapshot,
  stoppedFillErrorDescription,
  type BrowserFillAttemptStatus
} from "@/lib/application-browser/fill-status-presentation";

const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const FIELD_KEY = "a".repeat(64);
const STEP_KEY = `fill:${ATTEMPT_ID}:${FIELD_KEY}`;

function noAttemptStatus(
  overrides: Partial<BrowserFillAttemptStatus> = {}
): BrowserFillAttemptStatus {
  return {
    state: "READY",
    stateVersion: 7,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: [],
    ...overrides
  };
}

function fillingStatus(
  overrides: Partial<BrowserFillAttemptStatus> = {}
): BrowserFillAttemptStatus {
  return noAttemptStatus({
    state: "FILLING",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: "2026-09-11T18:00:00.000Z",
    leaseLive: true,
    fieldOperationAllowed: true,
    ...overrides
  });
}

function terminalStatus(
  overrides: Partial<BrowserFillAttemptStatus> = {}
): BrowserFillAttemptStatus {
  return noAttemptStatus({
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 9,
    fillAttemptId: ATTEMPT_ID,
    outcome: "COMPLETED",
    steps: [{ stepKey: STEP_KEY, result: "FILLED", errorCode: null }],
    ...overrides
  });
}

test("strict Fill-status parsing preserves the accepted frozen structural contract", () => {
  const input = fillingStatus();
  const parsed = parseFillStatusResponse(input);
  assert.deepEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.steps), true);

  const terminal = parseFillStatusResponse(terminalStatus());
  assert.equal(Object.isFrozen(terminal.steps[0]), true);
});

test("strict Fill-status parsing rejects malformed top-level authority", () => {
  const invalid = [
    null,
    [],
    { ...noAttemptStatus(), extra: true },
    { ...noAttemptStatus(), state: "NOT_A_STATE" },
    { ...noAttemptStatus(), stateVersion: -1 },
    { ...noAttemptStatus(), stateVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...noAttemptStatus(), fillAttemptId: "not-a-uuid" },
    { ...noAttemptStatus(), fillAttemptId: ATTEMPT_ID.toUpperCase() },
    { ...noAttemptStatus(), fillLeaseExpiresAt: "2026-09-11T18:00:00+00:00" },
    { ...noAttemptStatus(), leaseLive: 1 },
    { ...noAttemptStatus(), expiredRecoveryRequired: 0 },
    { ...noAttemptStatus(), fieldOperationAllowed: "false" },
    { ...noAttemptStatus(), outcome: "UNKNOWN" },
    { ...noAttemptStatus(), errorCode: "SERVER_MESSAGE" },
    { ...noAttemptStatus(), steps: "none" }
  ];

  for (const value of invalid) {
    assert.throws(() => parseFillStatusResponse(value), /Invalid Fill status response/i);
  }
});

test("strict Fill-status parsing enforces bounded unique attempt-bound step identities and result pairing", () => {
  const step = terminalStatus().steps[0];
  const invalid = [
    terminalStatus({ steps: [{ ...step, extra: true } as never] }),
    terminalStatus({ steps: [{ ...step, stepKey: "not-a-step" }] }),
    terminalStatus({ steps: [{ ...step, stepKey: `fill:${ATTEMPT_ID}:${"A".repeat(64)}` }] }),
    terminalStatus({ steps: [{ ...step, result: "UNKNOWN" as never }] }),
    terminalStatus({ steps: [{ ...step, result: "FAILED", errorCode: null }] }),
    terminalStatus({ steps: [{ ...step, result: "FILLED", errorCode: "FILL_WRITE_FAILED" }] }),
    terminalStatus({ steps: [step, step] }),
    noAttemptStatus({ steps: [{ ...step }] }),
    terminalStatus({
      steps: Array.from({ length: 201 }, (_, index) => ({
        stepKey: `fill:${ATTEMPT_ID}:${index.toString(16).padStart(64, "0")}`,
        result: "FILLED" as const,
        errorCode: null
      }))
    })
  ];

  for (const value of invalid) {
    assert.throws(() => parseFillStatusResponse(value), /Invalid Fill status response/i);
  }
});

test("semantic Fill-status classification is closed and conservative", () => {
  const cases: Array<[BrowserFillAttemptStatus, string]> = [
    [noAttemptStatus(), "NO_ATTEMPT"],
    [fillingStatus(), "FILLING"],
    [fillingStatus({ leaseLive: false, expiredRecoveryRequired: true, fieldOperationAllowed: false }), "RECOVERY_PENDING"],
    [terminalStatus(), "COMPLETED"],
    [terminalStatus({
      outcome: "STOPPED_EARLY",
      errorCode: "FILL_WRITE_FAILED",
      steps: [{ stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_WRITE_FAILED" }]
    }), "STOPPED_EARLY"],
    [terminalStatus({
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: [{ stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_STALE" }]
    }), "RECOVERED_AFTER_LOSS"],
    [noAttemptStatus({ state: "CANCELLED" }), "CANCELLED"],
    [noAttemptStatus({ state: "REVIEW_REQUIRED", fillAttemptId: ATTEMPT_ID }), "ATTEMPT_CONSUMED"]
  ];

  for (const [status, expected] of cases) {
    assert.equal(classifyFillStatus(status), expected, expected);
  }

  for (const status of [
    noAttemptStatus({ fillAttemptId: ATTEMPT_ID }),
    fillingStatus({ fillLeaseExpiresAt: null }),
    fillingStatus({ leaseLive: true, expiredRecoveryRequired: true }),
    fillingStatus({ errorCode: "FILL_INTERNAL" }),
    terminalStatus({ fieldOperationAllowed: true }),
    terminalStatus({ outcome: "COMPLETED", errorCode: "FILL_WRITE_FAILED" }),
    terminalStatus({ outcome: null }),
    terminalStatus({
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: [
        { stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_STALE" },
        { stepKey: `fill:${ATTEMPT_ID}:${"b".repeat(64)}`, result: "FILLED", errorCode: null }
      ]
    }),
    terminalStatus({
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: [{ stepKey: STEP_KEY, result: "NOT_ATTEMPTED", errorCode: null }]
    }),
    noAttemptStatus({ state: "READY_FOR_USER_SUBMISSION" })
  ]) {
    assert.equal(classifyFillStatus(status), "UNAVAILABLE");
  }
});

test("aggregate Fill results expose counts only", () => {
  const result = aggregateFillResults([
    { stepKey: STEP_KEY, result: "FILLED", errorCode: null },
    { stepKey: `fill:${ATTEMPT_ID}:${"b".repeat(64)}`, result: "PRESERVED_EXISTING", errorCode: null },
    { stepKey: `fill:${ATTEMPT_ID}:${"c".repeat(64)}`, result: "MANUAL", errorCode: null },
    { stepKey: `fill:${ATTEMPT_ID}:${"d".repeat(64)}`, result: "FAILED", errorCode: "FILL_WRITE_FAILED" },
    { stepKey: `fill:${ATTEMPT_ID}:${"e".repeat(64)}`, result: "NOT_ATTEMPTED", errorCode: null }
  ]);
  assert.deepEqual(result, {
    filled: 1,
    preservedExisting: 1,
    runtimeManual: 1,
    failed: 1,
    notAttempted: 1
  });
  assert.deepEqual(Object.keys(result), [
    "filled",
    "preservedExisting",
    "runtimeManual",
    "failed",
    "notAttempted"
  ]);
});

test("closed terminal presentation preserves the Human-Submit boundary", () => {
  for (const status of [
    terminalStatus(),
    terminalStatus({
      outcome: "STOPPED_EARLY",
      errorCode: "FILL_WRITE_FAILED",
      steps: [{ stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_WRITE_FAILED" }]
    }),
    terminalStatus({
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: [{ stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_STALE" }]
    }),
    fillingStatus({ leaseLive: false, expiredRecoveryRequired: true, fieldOperationAllowed: false }),
    noAttemptStatus({ state: "CANCELLED" })
  ]) {
    const presentation = fillStatusPresentation(status);
    assert.equal(presentation.allowRecoveryMutation, false);
    assert.match(presentation.text, /has not submitted this application/i);
    assert.doesNotMatch(presentation.text, /successfully applied|application submitted|application completed/i);
  }
});

test("stopped-error presentation maps only the five closed human descriptions", () => {
  for (const code of [
    "FILL_POLICY_DENIED",
    "FILL_TARGET_TRUST_LOST",
    "FILL_UNEXPECTED_MUTATION",
    "FILL_WRITE_FAILED",
    "FILL_INTERNAL"
  ] as const) {
    const description = stoppedFillErrorDescription(code);
    assert.equal(typeof description, "string", code);
    assert.doesNotMatch(description ?? "", /exception|stack|response body/i, code);
  }

  for (const code of [
    null,
    "FILL_REVIEW_REQUIRED",
    "FILL_ALREADY_IN_PROGRESS",
    "FILL_NO_ELIGIBLE_FIELDS",
    "FILL_STALE"
  ] as const) {
    assert.equal(stoppedFillErrorDescription(code), null, String(code));
  }
});

test("Fill-status snapshot reconciliation is monotonic and preserves safe authority on contradictions", () => {
  const terminal = terminalStatus();
  const olderReady = noAttemptStatus({ stateVersion: 7 });
  const ignored = reconcileFillStatusSnapshot({
    current: terminal,
    currentVerified: true,
    incoming: olderReady
  });
  assert.deepEqual(ignored, {
    status: terminal,
    verified: true,
    decision: "IGNORED_OLDER"
  });

  const contradiction = reconcileFillStatusSnapshot({
    current: terminal,
    currentVerified: true,
    incoming: terminalStatus({ outcome: "STOPPED_EARLY", errorCode: "FILL_WRITE_FAILED" })
  });
  assert.deepEqual(contradiction, {
    status: terminal,
    verified: false,
    decision: "CONTRADICTION"
  });

  const repeated = reconcileFillStatusSnapshot({
    current: terminal,
    currentVerified: true,
    incoming: structuredClone(terminal)
  });
  assert.deepEqual(repeated, {
    status: terminal,
    verified: true,
    decision: "UNCHANGED"
  });

  const higher = fillingStatus({ stateVersion: 10 });
  const advanced = reconcileFillStatusSnapshot({
    current: terminal,
    currentVerified: false,
    incoming: higher
  });
  assert.deepEqual(advanced, {
    status: higher,
    verified: true,
    decision: "ACCEPTED_NEWER"
  });

  const unavailable = noAttemptStatus({
    stateVersion: 11,
    fillAttemptId: ATTEMPT_ID
  });
  assert.deepEqual(reconcileFillStatusSnapshot({
    current: higher,
    currentVerified: true,
    incoming: unavailable
  }), {
    status: unavailable,
    verified: false,
    decision: "ACCEPTED_UNAVAILABLE"
  });
});
