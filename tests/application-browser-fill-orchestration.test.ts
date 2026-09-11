import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGuardedFillOrchestrationService,
  GuardedFillOrchestrationError,
  type GuardedFillControllerPort
} from "@/lib/application-browser/fill-orchestration";
import { ApplicationFormInspectionControllerError } from "@/lib/application-browser/form-inspection-controller";
import {
  SameOriginClientError,
  type BrowserFillAcquisition,
  type BrowserFillAttemptStatus,
  type BrowserFillFinalizeInput,
  type SameOriginClientWithFill
} from "@/lib/application-browser/same-origin-client";
import type { ProtectedCandidateFieldWriteResult } from "@/lib/application-browser/protected-browser-session";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const TARGET_URL = "https://jobs.example.test/apply";
const LEASE_EXPIRES_AT = "2026-09-10T20:10:00.000Z";
const FORM_FINGERPRINT = "f".repeat(64);
const PACKET_HASH = "e".repeat(64);
const GENERATION_ID = Symbol("accepted-generation");
const FIELD_KEYS = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];

function acquisition(fieldCount = 3): BrowserFillAcquisition {
  const fieldTypes = ["TEXT", "EMAIL", "SELECT_ONE"] as const;
  return {
    attemptId: ATTEMPT_ID,
    runStateVersion: 8,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    formInspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: PACKET_HASH,
    formFingerprint: FORM_FINGERPRINT,
    eligibleFields: FIELD_KEYS.slice(0, fieldCount).map((normalizedFieldKey, index) => ({
      stepKey: `fill:${ATTEMPT_ID}:${normalizedFieldKey}`,
      normalizedFieldKey,
      fieldFingerprint: String(index + 4).repeat(64),
      fieldType: fieldTypes[index],
      proposal: index === 2
        ? { kind: "OPTIONS", optionKeys: ["a".repeat(64)] as const }
        : { kind: "SCALAR", value: `private-proposal-${index}` }
    }))
  };
}

function liveStatus(overrides: Partial<BrowserFillAttemptStatus> = {}): BrowserFillAttemptStatus {
  return {
    state: "FILLING",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: LEASE_EXPIRES_AT,
    leaseLive: true,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: true,
    outcome: null,
    errorCode: null,
    steps: [],
    ...overrides
  };
}

function terminalStatus(input: BrowserFillFinalizeInput): BrowserFillAttemptStatus {
  return {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: input.expectedStateVersion + 1,
    fillAttemptId: input.fillAttemptId,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: input.outcome,
    errorCode: input.errorCode,
    steps: input.steps
  };
}

function recoveredStatus(acquired = acquisition()): BrowserFillAttemptStatus {
  return {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: acquired.runStateVersion + 1,
    fillAttemptId: acquired.attemptId,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "RECOVERED_AFTER_LOSS",
    errorCode: "FILL_STALE",
    steps: acquired.eligibleFields.map((field) => ({
      stepKey: field.stepKey,
      result: "FAILED",
      errorCode: "FILL_STALE"
    }))
  };
}

function writeRequestFor(
  field: BrowserFillAcquisition["eligibleFields"][number]
): Omit<BrowserFillAcquisition["eligibleFields"][number], "stepKey"> {
  return {
    normalizedFieldKey: field.normalizedFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType,
    proposal: field.proposal
  };
}

type HarnessOptions = {
  acquired?: BrowserFillAcquisition;
  statuses?: Array<BrowserFillAttemptStatus | Error>;
  statusProvider?: () => BrowserFillAttemptStatus | Error;
  writes?: Array<ProtectedCandidateFieldWriteResult | Error>;
  acquireError?: Error;
  finalizeErrors?: Error[];
  finalizeResults?: BrowserFillAttemptStatus[];
  targetUrlAfterWrite?: string | null;
  recoverResult?: BrowserFillAttemptStatus;
  onAssertCurrent?: (call: number) => void | Promise<void>;
  now?: () => number;
};

function harness(options: HarnessOptions = {}) {
  const acquired = options.acquired ?? acquisition();
  const calls: string[] = [];
  const finalizations: BrowserFillFinalizeInput[] = [];
  const boundAuthorities: unknown[] = [];
  const writeRequests: unknown[] = [];
  const statuses = [...(options.statuses ?? [])];
  const writes = [...(options.writes ?? [{ status: "FILLED" }, { status: "PRESERVED_EXISTING" }, { status: "MANUAL", reason: "UNWRITABLE" }])];
  const finalizeErrors = [...(options.finalizeErrors ?? [])];
  const finalizeResults = [...(options.finalizeResults ?? [])];
  let targetUrl: string | null = TARGET_URL;
  let acquireCalls = 0;
  let acquireDispatches = 0;
  let finalizeCalls = 0;
  let finalizeDispatches = 0;
  let recoverCalls = 0;
  let recoverDispatches = 0;
  let assertCurrentCalls = 0;
  let currentWriterCount = 0;
  let maximumWriterCount = 0;

  const nextStatus = async (): Promise<BrowserFillAttemptStatus> => {
    calls.push("status");
    const next = options.statusProvider?.() ?? statuses.shift();
    if (next instanceof Error) throw next;
    return next ?? liveStatus();
  };

  const client = {
    async getApplicationRun() {
      calls.push("run");
      return {
        id: RUN_ID,
        state: "READY",
        stateVersion: 7,
        applyHost: "jobs.example.test",
        applyUrlSnapshot: TARGET_URL
      };
    },
    async getAutomationPolicy() {
      calls.push("policy");
      return {
        effectiveEnabled: true,
        allowedHosts: ["jobs.example.test"],
        blockedHosts: []
      };
    },
    async getCurrentAnswerPacket() {
      calls.push("packet");
      return { runId: RUN_ID, current: { inspectionVersion: 2, answerPacketVersion: 3 } };
    },
    async acquireFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
      calls.push("acquire");
      acquireCalls += 1;
      if (
        options.acquireError instanceof SameOriginClientError &&
        options.acquireError.dispatchState === "NOT_DISPATCHED"
      ) {
        throw options.acquireError;
      }
      assertReadyToDispatch();
      acquireDispatches += 1;
      if (options.acquireError) throw options.acquireError;
      return acquired;
    },
    getFillAttemptStatus: nextStatus,
    async finalizeFillAttempt(input: BrowserFillFinalizeInput, assertReadyToDispatch: () => void) {
      calls.push("finalize");
      finalizeCalls += 1;
      const error = finalizeErrors.shift();
      if (error instanceof SameOriginClientError && error.dispatchState === "NOT_DISPATCHED") {
        throw error;
      }
      finalizations.push(structuredClone(input));
      assertReadyToDispatch();
      finalizeDispatches += 1;
      if (error) throw error;
      return finalizeResults.shift() ?? terminalStatus(input);
    },
    async recoverExpiredFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
      calls.push("recover");
      recoverCalls += 1;
      assertReadyToDispatch();
      recoverDispatches += 1;
      return options.recoverResult ?? recoveredStatus(acquired);
    }
  } as unknown as SameOriginClientWithFill;

  const controller: GuardedFillControllerPort = {
    currentTargetUrl: () => targetUrl,
    async assertCurrent(generationId) {
      calls.push("current");
      assertCurrentCalls += 1;
      await options.onAssertCurrent?.(assertCurrentCalls);
      if (generationId !== GENERATION_ID) {
        throw new ApplicationFormInspectionControllerError("FORM_GENERATION_INVALIDATED");
      }
      return { generationId };
    },
    assertAcquiredFillAuthority(generationId, authority) {
      calls.push("bind");
      assert.equal(generationId, GENERATION_ID);
      boundAuthorities.push(structuredClone(authority));
    },
    async writeApprovedField(generationId, request) {
      calls.push(`write:${request.normalizedFieldKey}`);
      assert.equal(generationId, GENERATION_ID);
      writeRequests.push(structuredClone(request));
      currentWriterCount += 1;
      maximumWriterCount = Math.max(maximumWriterCount, currentWriterCount);
      await Promise.resolve();
      currentWriterCount -= 1;
      if (options.targetUrlAfterWrite !== undefined && writeRequests.length === 1) {
        targetUrl = options.targetUrlAfterWrite;
      }
      const next = writes.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected writer call");
      return next;
    }
  };

  const service = createGuardedFillOrchestrationService({
    client,
    controller,
    now: options.now ?? (() => Date.parse("2026-09-10T20:00:00.000Z"))
  });
  const execute = () => service.execute({
    runId: RUN_ID,
    generationId: GENERATION_ID,
    formInspectionVersion: 2,
    answerPacketVersion: 3,
    frozenTargetUrl: TARGET_URL,
    assertActive: () => undefined
  });

  return {
    acquired,
    calls,
    finalizations,
    boundAuthorities,
    writeRequests,
    service,
    execute,
    counts: () => ({
      acquireCalls,
      acquireDispatches,
      finalizeCalls,
      finalizeDispatches,
      recoverCalls,
      recoverDispatches,
      maximumWriterCount
    })
  };
}

test("guarded Fill uses canonical server order, sequential writes, and exact completed finalization", async () => {
  const value = harness();
  const result = await value.execute();

  assert.equal(result.disposition, "FINALIZED");
  assert.deepEqual(value.writeRequests, value.acquired.eligibleFields.map(writeRequestFor));
  assert.equal(value.counts().maximumWriterCount, 1);
  assert.equal(value.counts().acquireCalls, 1);
  assert.equal(value.counts().acquireDispatches, 1);
  assert.equal(value.counts().finalizeCalls, 1);
  assert.equal(value.counts().finalizeDispatches, 1);
  assert.deepEqual(value.finalizations, [{
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 8,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[0]}`, result: "FILLED", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[1]}`, result: "PRESERVED_EXISTING", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[2]}`, result: "MANUAL", errorCode: null }
    ]
  }]);
  assert.deepEqual(value.boundAuthorities, [{
    formFingerprint: FORM_FINGERPRINT,
    fields: value.acquired.eligibleFields.map(writeRequestFor)
  }]);
  assert.equal(JSON.stringify(result).includes("private-proposal"), false);
});

test("malformed or lost acquisition never reacquires and never writes", async () => {
  const malformedAcquisition = {
    ...acquisition(1),
    eligibleFields: [{
      ...acquisition(1).eligibleFields[0],
      stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[1]}`
    }]
  } as BrowserFillAcquisition;
  for (const value of [
    harness({ acquired: malformedAcquisition }),
    harness({
      acquireError: new SameOriginClientError(
        "safe",
        "SAME_ORIGIN_REQUEST_FAILED",
        "MAY_HAVE_DISPATCHED"
      )
    })
  ]) {
    const result = await value.execute();
    assert.equal(result.disposition, "RECOVERY_PENDING");
    assert.deepEqual(value.counts(), {
      acquireCalls: 1,
      acquireDispatches: 1,
      finalizeCalls: 0,
      finalizeDispatches: 0,
      recoverCalls: 0,
      recoverDispatches: 0,
      maximumWriterCount: 0
    });
    assert.equal(value.writeRequests.length, 0);
    assert.equal(value.calls.filter((call) => call === "acquire").length, 1);
  }
});

test("lost acquisition accepts only semantically exact terminal or cancellation status", async () => {
  const lostResponse = new SameOriginClientError(
    "safe",
    "SAME_ORIGIN_REQUEST_FAILED",
    "MAY_HAVE_DISPATCHED"
  );
  const completedAssertion: BrowserFillFinalizeInput = {
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 8,
    outcome: "COMPLETED",
    errorCode: null,
    steps: acquisition().eligibleFields.map((field) => ({
      stepKey: field.stepKey,
      result: "FILLED",
      errorCode: null
    }))
  };
  const exactTerminal = harness({
    acquireError: lostResponse,
    statuses: [terminalStatus(completedAssertion)]
  });
  assert.equal((await exactTerminal.execute()).disposition, "FINALIZED");
  assert.equal(exactTerminal.writeRequests.length, 0);

  const contradictoryTerminal = terminalStatus({
    ...completedAssertion,
    steps: [{
      stepKey: acquisition(1).eligibleFields[0].stepKey,
      result: "FAILED",
      errorCode: "FILL_INTERNAL"
    }]
  });
  const contradictoryCancellation = liveStatus({
    state: "CANCELLED",
    fieldOperationAllowed: false
  });
  for (const status of [contradictoryTerminal, contradictoryCancellation]) {
    const value = harness({ acquireError: lostResponse, statuses: [status] });
    await assert.rejects(
      value.execute(),
      (error: unknown) =>
        error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
    );
    assert.equal(value.writeRequests.length, 0);
    assert.equal(value.counts().finalizeCalls, 0);
  }
});

test("acquisition validation rejects unsafe proposal text and an impossible run-version transition", async () => {
  const unsafeProposal = acquisition(1);
  const malformedProposal = {
    ...unsafeProposal,
    eligibleFields: [{
      ...unsafeProposal.eligibleFields[0],
      proposal: { kind: "SCALAR", value: "   " }
    }]
  } as BrowserFillAcquisition;
  const impossibleVersion = {
    ...acquisition(1),
    runStateVersion: 9
  };

  for (const value of [
    harness({ acquired: malformedProposal }),
    harness({ acquired: impossibleVersion })
  ]) {
    const result = await value.execute();
    assert.equal(result.disposition, "RECOVERY_PENDING");
    assert.equal(value.counts().acquireCalls, 1);
    assert.equal(value.calls.filter((call) => call === "acquire").length, 1);
    assert.equal(value.writeRequests.length, 0);
    assert.equal(value.boundAuthorities.length, 0);
    assert.equal(value.counts().finalizeCalls, 0);
  }
});

test("pre-field policy loss preserves the safe prefix without fabricating a failed field", async () => {
  const value = harness({
    statuses: [
      liveStatus(),
      liveStatus({ fieldOperationAllowed: false }),
      liveStatus({ fieldOperationAllowed: false })
    ],
    writes: [{ status: "FILLED" }]
  });
  await value.execute();

  assert.equal(value.writeRequests.length, 1);
  assert.deepEqual(value.finalizations[0], {
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 8,
    outcome: "STOPPED_EARLY",
    errorCode: "FILL_POLICY_DENIED",
    steps: [
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[0]}`, result: "FILLED", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[1]}`, result: "NOT_ATTEMPTED", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[2]}`, result: "NOT_ATTEMPTED", errorCode: null }
    ]
  });
});

test("in-field protected failures map closed errors onto only the current step", async () => {
  const cases = [
    ["CANDIDATE_INVALID", "FILL_TARGET_TRUST_LOST"],
    ["TARGET_INVALID", "FILL_TARGET_TRUST_LOST"],
    ["UNEXPECTED_ACTIVITY", "FILL_UNEXPECTED_MUTATION"],
    ["WRITE_FAILED", "FILL_WRITE_FAILED"]
  ] as const;
  for (const [reason, expectedError] of cases) {
    const value = harness({ writes: [{ status: "FAILED", reason }] });
    await value.execute();
    assert.equal(value.writeRequests.length, 1);
    assert.equal(value.finalizations[0].outcome, "STOPPED_EARLY");
    assert.equal(value.finalizations[0].errorCode, expectedError);
    assert.deepEqual(value.finalizations[0].steps, [
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[0]}`, result: "FAILED", errorCode: expectedError },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[1]}`, result: "NOT_ATTEMPTED", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[2]}`, result: "NOT_ATTEMPTED", errorCode: null }
    ]);
  }
});

test("target loss between fields is a pre-field trust stop with no second writer call", async () => {
  const value = harness({
    targetUrlAfterWrite: "https://jobs.example.test/changed",
    writes: [{ status: "FILLED" }]
  });
  await value.execute();
  assert.equal(value.writeRequests.length, 1);
  assert.equal(value.finalizations[0].errorCode, "FILL_TARGET_TRUST_LOST");
  assert.equal(value.finalizations[0].steps[1].result, "NOT_ATTEMPTED");
});

test("a possibly dispatched FINALIZE is never resent and reconciles only through GET", async () => {
  const expected = terminalStatus({
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 8,
    outcome: "COMPLETED",
    errorCode: null,
    steps: acquisition().eligibleFields.map((field, index) => ({
      stepKey: field.stepKey,
      result: index === 0 ? "FILLED" : index === 1 ? "PRESERVED_EXISTING" : "MANUAL",
      errorCode: null
    }))
  });
  const value = harness({
    statuses: [liveStatus(), liveStatus(), liveStatus(), liveStatus(), expected],
    finalizeErrors: [new SameOriginClientError(
      "safe",
      "SAME_ORIGIN_REQUEST_FAILED",
      "MAY_HAVE_DISPATCHED"
    )]
  });
  const result = await value.execute();
  assert.equal(result.disposition, "FINALIZED");
  assert.equal(value.counts().finalizeCalls, 1);
  assert.equal(value.counts().finalizeDispatches, 1);
  assert.deepEqual(result.status, expected);
});

const EXACT_COMPLETED_ASSERTION: BrowserFillFinalizeInput = {
  runId: RUN_ID,
  fillAttemptId: ATTEMPT_ID,
  expectedStateVersion: 8,
  outcome: "COMPLETED",
  errorCode: null,
  steps: acquisition().eligibleFields.map((field, index) => ({
    stepKey: field.stepKey,
    result: index === 0 ? "FILLED" : index === 1 ? "PRESERVED_EXISTING" : "MANUAL",
    errorCode: null
  }))
};
const EXACT_COMPLETED_STATUS = terminalStatus(EXACT_COMPLETED_ASSERTION);
const OTHER_ATTEMPT_ID = "c56a4180-65aa-42ec-a945-5fd21dec0538";

for (const scenario of [
  { label: "still FILLING", response: liveStatus() },
  {
    label: "wrong attempt",
    response: {
      ...EXACT_COMPLETED_STATUS,
      fillAttemptId: OTHER_ATTEMPT_ID,
      steps: EXACT_COMPLETED_STATUS.steps.map((step) => ({
        ...step,
        stepKey: step.stepKey.replace(ATTEMPT_ID, OTHER_ATTEMPT_ID)
      }))
    }
  },
  {
    label: "wrong version",
    response: { ...EXACT_COMPLETED_STATUS, stateVersion: EXACT_COMPLETED_STATUS.stateVersion + 1 }
  },
  {
    label: "wrong terminal outcome",
    response: { ...EXACT_COMPLETED_STATUS, outcome: "STOPPED_EARLY" as const, errorCode: "FILL_INTERNAL" as const }
  },
  {
    label: "reordered steps",
    response: { ...EXACT_COMPLETED_STATUS, steps: [...EXACT_COMPLETED_STATUS.steps].reverse() }
  },
  {
    label: "changed error",
    response: { ...EXACT_COMPLETED_STATUS, errorCode: "FILL_INTERNAL" as const }
  },
  {
    label: "unexpected expiry",
    response: liveStatus({
      leaseLive: false,
      expiredRecoveryRequired: true,
      fieldOperationAllowed: false
    })
  },
  {
    label: "unexpected cancellation",
    response: liveStatus({
      state: "CANCELLED",
      stateVersion: 9,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      fieldOperationAllowed: false
    })
  }
] as const) {
  test(`a dispatched FINALIZE reconciles a structurally valid ${scenario.label} response through one GET`, async () => {
    const value = harness({
      statuses: [liveStatus(), liveStatus(), liveStatus(), liveStatus(), EXACT_COMPLETED_STATUS],
      finalizeResults: [scenario.response]
    });

    const result = await value.execute();

    assert.equal(result.disposition, "FINALIZED");
    assert.deepEqual(result.status, EXACT_COMPLETED_STATUS);
    assert.equal(value.counts().finalizeCalls, 1);
    assert.equal(value.counts().finalizeDispatches, 1);
    assert.equal(value.calls.filter((call) => call === "status").length, 5);
    assert.deepEqual(value.calls.slice(-2), ["finalize", "status"]);
    assert.equal(value.writeRequests.length, 3);
    assert.equal(value.counts().maximumWriterCount, 1);
  });
}

test("post-FINALIZE reconciliation remains GET-only when its status is expired", async () => {
  const expired = liveStatus({
    leaseLive: false,
    expiredRecoveryRequired: true,
    fieldOperationAllowed: false
  });
  const value = harness({
    statuses: [
      liveStatus(),
      liveStatus(),
      liveStatus(),
      liveStatus(),
      expired
    ],
    finalizeResults: [liveStatus()]
  });

  const result = await value.execute();

  assert.equal(value.counts().recoverDispatches, 0);
  assert.equal(result.disposition, "RECOVERY_PENDING");
  assert.deepEqual(result.status, expired);
  assert.equal(value.counts().finalizeCalls, 1);
  assert.equal(value.counts().finalizeDispatches, 1);
  assert.equal(value.counts().recoverCalls, 0);
  assert.equal(value.calls.filter((call) => call === "status").length, 5);
  assert.deepEqual(value.calls.slice(-2), ["finalize", "status"]);
  assert.equal(value.writeRequests.length, 3);
  assert.equal(value.counts().maximumWriterCount, 1);
});

for (const scenario of [
  {
    label: "live",
    status: liveStatus(),
    disposition: "RECOVERY_PENDING"
  },
  {
    label: "exact cancellation",
    status: liveStatus({
      state: "CANCELLED",
      stateVersion: 9,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      fieldOperationAllowed: false
    }),
    disposition: "CANCELLED"
  }
] as const) {
  test(`post-FINALIZE reconciliation GET ${scenario.label} remains non-mutating`, async () => {
    const value = harness({
      statuses: [
        liveStatus(),
        liveStatus(),
        liveStatus(),
        liveStatus(),
        scenario.status
      ],
      finalizeResults: [liveStatus()]
    });

    const result = await value.execute();

    assert.equal(result.disposition, scenario.disposition);
    assert.deepEqual(result.status, scenario.status);
    assert.equal(value.counts().finalizeCalls, 1);
    assert.equal(value.counts().finalizeDispatches, 1);
    assert.equal(value.counts().recoverCalls, 0);
    assert.equal(value.counts().recoverDispatches, 0);
    assert.equal(value.calls.filter((call) => call === "status").length, 5);
    assert.deepEqual(value.calls.slice(-2), ["finalize", "status"]);
    assert.equal(value.writeRequests.length, 3);
    assert.equal(value.counts().maximumWriterCount, 1);
  });
}

test("a definitely undispatched FINALIZE permits one real dispatch only after an exact live GET", async () => {
  const value = harness({
    statuses: [liveStatus(), liveStatus(), liveStatus(), liveStatus(), liveStatus()],
    finalizeErrors: [new SameOriginClientError(
      "safe",
      "SAME_ORIGIN_REQUEST_FAILED",
      "NOT_DISPATCHED"
    )]
  });

  const result = await value.execute();

  assert.equal(result.disposition, "FINALIZED");
  assert.equal(value.counts().finalizeCalls, 2);
  assert.equal(value.counts().finalizeDispatches, 1);
  assert.equal(value.finalizations.length, 1);
  assert.deepEqual(value.calls.slice(-3), ["finalize", "status", "finalize"]);
});

test("an in-field throw marks only the invoked step failed and never leaks its message", async () => {
  const privateMessage = "PRIVATE CURRENT EMPLOYER VALUE";
  const value = harness({ writes: [new Error(privateMessage)] });

  const result = await value.execute();

  assert.equal(value.writeRequests.length, 1);
  assert.equal(value.counts().finalizeCalls, 1);
  assert.deepEqual(value.finalizations[0].steps, [
    { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[0]}`, result: "FAILED", errorCode: "FILL_INTERNAL" },
    { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[1]}`, result: "NOT_ATTEMPTED", errorCode: null },
    { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEYS[2]}`, result: "NOT_ATTEMPTED", errorCode: null }
  ]);
  assert.equal(JSON.stringify(value.finalizations).includes(privateMessage), false);
  assert.equal(JSON.stringify(result).includes(privateMessage), false);
});

test("the local lease deadline is deny-only and starts no writer or terminal mutation", async () => {
  const localExpiry = "2026-09-10T20:00:00.000Z";
  const acquired = { ...acquisition(), leaseExpiresAt: localExpiry };
  const value = harness({
    acquired,
    statuses: [liveStatus({ fillLeaseExpiresAt: localExpiry })]
  });

  const result = await value.execute();

  assert.equal(result.disposition, "RECOVERY_PENDING");
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeDispatches, 0);
  assert.equal(value.counts().recoverCalls, 0);
});

test("lease crossing during awaited currentness is observed before any writer begins", async () => {
  let currentTime = Date.parse(LEASE_EXPIRES_AT) - 1;
  const value = harness({
    acquired: acquisition(1),
    now: () => currentTime,
    async onAssertCurrent(call) {
      if (call !== 2) return;
      await Promise.resolve();
      currentTime = Date.parse(LEASE_EXPIRES_AT) + 1;
    }
  });

  const result = await value.execute();

  assert.equal(result.disposition, "RECOVERY_PENDING");
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeDispatches, 0);
  assert.equal(value.counts().recoverCalls, 0);
});

test("cancellation during awaited currentness is observed before any writer begins", async () => {
  let status = liveStatus();
  const cancelled = liveStatus({
    state: "CANCELLED",
    stateVersion: 9,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    fieldOperationAllowed: false
  });
  const value = harness({
    acquired: acquisition(1),
    statusProvider: () => status,
    async onAssertCurrent(call) {
      if (call !== 2) return;
      await Promise.resolve();
      status = cancelled;
    }
  });

  const result = await value.execute();

  assert.equal(result.disposition, "CANCELLED");
  assert.deepEqual(result.status, cancelled);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeCalls, 0);
  assert.equal(value.counts().recoverCalls, 0);
});

test("policy revocation during awaited currentness creates a PRE_FIELD stop", async () => {
  let status = liveStatus();
  const policyDenied = liveStatus({ fieldOperationAllowed: false });
  const value = harness({
    acquired: acquisition(1),
    statusProvider: () => status,
    async onAssertCurrent(call) {
      if (call !== 2) return;
      await Promise.resolve();
      status = policyDenied;
    }
  });

  await value.execute();

  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.finalizations.length, 1);
  assert.equal(value.finalizations[0].outcome, "STOPPED_EARLY");
  assert.equal(value.finalizations[0].errorCode, "FILL_POLICY_DENIED");
  assert.equal(value.finalizations[0].steps[0].result, "NOT_ATTEMPTED");
});

test("expired recovery during awaited currentness is observed before any writer begins", async () => {
  let status = liveStatus();
  const expired = liveStatus({
    leaseLive: false,
    expiredRecoveryRequired: true,
    fieldOperationAllowed: false
  });
  const value = harness({
    acquired: acquisition(1),
    statusProvider: () => status,
    async onAssertCurrent(call) {
      if (call !== 2) return;
      await Promise.resolve();
      status = expired;
    }
  });

  const result = await value.execute();

  assert.equal(result.disposition, "FINALIZED");
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().recoverCalls, 1);
  assert.equal(value.counts().finalizeCalls, 0);
});

test("the exact lease edge reached during awaited currentness prevents writer invocation", async () => {
  let currentTime = Date.parse(LEASE_EXPIRES_AT) - 1;
  const value = harness({
    acquired: acquisition(1),
    now: () => currentTime,
    async onAssertCurrent(call) {
      if (call !== 2) return;
      await Promise.resolve();
      currentTime = Date.parse(LEASE_EXPIRES_AT);
    }
  });

  const result = await value.execute();

  assert.equal(result.disposition, "RECOVERY_PENDING");
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeDispatches, 0);
  assert.equal(value.counts().recoverCalls, 0);
});

test("server cancellation wins before a field and causes no later operation", async () => {
  const cancelled = liveStatus({
    state: "CANCELLED",
    stateVersion: 9,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    fieldOperationAllowed: false
  });
  const value = harness({ statuses: [cancelled] });

  const result = await value.execute();

  assert.equal(result.disposition, "CANCELLED");
  assert.deepEqual(result.status, cancelled);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeCalls, 0);
  assert.equal(value.counts().recoverCalls, 0);
  assert.deepEqual(value.calls.slice(-1), ["status"]);
});

for (const scenario of [
  { label: "null attempt ID", overrides: { fillAttemptId: null } },
  { label: "different attempt ID", overrides: { fillAttemptId: OTHER_ATTEMPT_ID } },
  { label: "impossible state version", overrides: { stateVersion: 8 } }
] as const) {
  test(`known-attempt cancellation rejects ${scenario.label} before any later operation`, async () => {
    const cancelled = liveStatus({
      state: "CANCELLED",
      stateVersion: 9,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      fieldOperationAllowed: false,
      ...scenario.overrides
    });
    const value = harness({ acquired: acquisition(1), statuses: [cancelled] });

    await assert.rejects(
      value.execute(),
      (error: unknown) =>
        error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
    );
    assert.equal(value.writeRequests.length, 0);
    assert.equal(value.counts().finalizeCalls, 0);
    assert.equal(value.counts().recoverCalls, 0);
  });
}

test("known-attempt cancellation accepts a later permitted post-Fill lifecycle version", async () => {
  const cancelled = liveStatus({
    state: "CANCELLED",
    stateVersion: 10,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    fieldOperationAllowed: false
  });
  const value = harness({ acquired: acquisition(1), statuses: [cancelled] });

  const result = await value.execute();

  assert.equal(result.disposition, "CANCELLED");
  assert.deepEqual(result.status, cancelled);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeCalls, 0);
  assert.equal(value.counts().recoverCalls, 0);
});

test("server-verified expiry performs no write and dispatches one RECOVER_EXPIRED", async () => {
  const acquired = acquisition();
  const expired = liveStatus({
    leaseLive: false,
    expiredRecoveryRequired: true,
    fieldOperationAllowed: false
  });
  const recovered = recoveredStatus(acquired);
  const value = harness({ acquired, statuses: [expired], recoverResult: recovered });
  const result = await value.execute();

  assert.equal(result.disposition, "FINALIZED");
  assert.deepEqual(result.status, recovered);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().recoverCalls, 1);
  assert.equal(value.counts().finalizeCalls, 0);
});

test("expired recovery accepts only the exact conservative failed tail", async () => {
  const expired = liveStatus({
    leaseLive: false,
    expiredRecoveryRequired: true,
    fieldOperationAllowed: false
  });
  const contradictoryRecovery = {
    ...recoveredStatus(),
    steps: acquisition().eligibleFields.map((field) => ({
      stepKey: field.stepKey,
      result: "FILLED" as const,
      errorCode: null
    }))
  };
  const value = harness({
    statuses: [expired],
    recoverResult: contradictoryRecovery
  });

  await assert.rejects(
    value.execute(),
    (error: unknown) =>
      error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
  );
  assert.equal(value.counts().recoverCalls, 1);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeCalls, 0);
});

test("definitely-not-dispatched acquisition failure remains pre-attempt and bounded", async () => {
  const value = harness({
    acquireError: new SameOriginClientError(
      "safe",
      "FILL_POLICY_DENIED",
      "NOT_DISPATCHED"
    )
  });
  await assert.rejects(value.execute(), (error: unknown) => {
    assert.ok(error instanceof GuardedFillOrchestrationError);
    assert.equal(error.code, "FILL_POLICY_DENIED");
    return true;
  });
  assert.equal(value.calls.includes("status"), false);
  assert.equal(value.writeRequests.length, 0);
  assert.equal(value.counts().finalizeCalls, 0);
});

test("an exact rejected acquisition response preserves the closed backend code without reconciliation", async () => {
  for (const code of [
    "FILL_POLICY_DENIED",
    "FILL_REVIEW_REQUIRED",
    "FILL_ALREADY_IN_PROGRESS",
    "FILL_NO_ELIGIBLE_FIELDS"
  ] as const) {
    const value = harness({
      acquireError: new SameOriginClientError("safe", code, "MAY_HAVE_DISPATCHED", true)
    });
    await assert.rejects(
      value.execute(),
      (error: unknown) =>
        error instanceof GuardedFillOrchestrationError && error.code === code
    );
    assert.equal(value.calls.includes("status"), false, code);
    assert.equal(value.writeRequests.length, 0, code);
    assert.equal(value.counts().finalizeCalls, 0, code);
  }
});
