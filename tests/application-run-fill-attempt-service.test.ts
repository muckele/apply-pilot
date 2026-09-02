import assert from "node:assert/strict";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { computeApplicationAnswerProposalHash } from "@/lib/application-runs/answer-packet-domain";
import type { VerifiedCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import {
  createApplicationRunFillAttemptService
} from "@/lib/application-runs/fill-attempt";

const USER_ID = "fill-service-user";
const RUN_ID = "clw0000000000000000000001";
const APPLICATION_ID = "clw0000000000000000000002";
const JOB_ID = "clw0000000000000000000003";
const PACKET_ID = "clw0000000000000000000004";
const INSPECTION_ID = "clw0000000000000000000005";
const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const FIELD_KEY = "1".repeat(64);
const SECOND_FIELD_KEY = "a".repeat(64);
const THIRD_FIELD_KEY = "b".repeat(64);
const FIELD_FINGERPRINT = "2".repeat(64);
const FORM_FINGERPRINT = "3".repeat(64);
const PACKET_HASH = "4".repeat(64);
const POLICY_HASH = "5".repeat(64);
const DB_NOW = new Date("2026-09-01T12:00:00.000Z");

type FakeState = ReturnType<typeof createFakeState>;
type FakePolicy = {
  id: string;
  userId: string;
  enabled: boolean;
  mode: string;
  allowedHosts: string[];
  blockedHosts: string[];
  sensitiveAnswerPolicy: string;
  finalReviewRequired: boolean;
};
type FakeRun = Omit<ReturnType<typeof createRun>, "state" | "fillAttemptId" | "fillLeaseExpiresAt"> & {
  state: string;
  fillAttemptId: string | null;
  fillLeaseExpiresAt: Date | null;
};

function createPolicy(): FakePolicy {
  return {
    id: "policy-1",
    userId: USER_ID,
    enabled: true,
    mode: "FILL_AND_REVIEW",
    allowedHosts: ["jobs.example.com"],
    blockedHosts: [],
    sensitiveAnswerPolicy: "EXCLUDE",
    finalReviewRequired: true
  };
}

function createRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "READY",
    stateVersion: 7,
    currentFormInspectionVersion: 2,
    currentAnswerPacketVersion: 3,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    errorCategory: null,
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    applyHost: "jobs.example.com",
    resumeVersionId: null,
    resumeContentHash: null,
    coverLetterVersionId: null,
    coverLetterContentHash: null,
    application: { id: APPLICATION_ID, userId: USER_ID, jobPostingId: JOB_ID },
    jobPosting: { id: JOB_ID, userId: USER_ID },
    ...overrides
  };
}

function createFillingRun(overrides: Record<string, unknown> = {}) {
  return createRun({
    state: "FILLING",
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 60_000),
    ...overrides
  });
}

function createAttemptStep(
  normalizedFieldKey: string,
  sequence: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    stepKey: `fill:${ATTEMPT_ID}:${normalizedFieldKey}`,
    sequence,
    action: "FILL_FIELD",
    semanticFieldKey: null,
    adapter: null,
    status: "PENDING",
    attemptNumber: 1,
    redactedValueSummary: null,
    errorCategory: null,
    artifactReference: null,
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

function completedFinalizationInput(
  steps: Array<{ stepKey: string; result: string; errorCode: string | null }> = [
    { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`, result: "FILLED", errorCode: null }
  ],
  overrides: Record<string, unknown> = {}
) {
  return {
    userId: USER_ID,
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 7,
    outcome: "COMPLETED",
    errorCode: null,
    steps,
    ...overrides
  };
}

function recoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    runId: RUN_ID,
    fillAttemptId: ATTEMPT_ID,
    expectedStateVersion: 7,
    ...overrides
  };
}

function createVerifiedPacket(options: { fieldType?: string; proposal?: unknown; ready?: boolean } = {}) {
  const fieldType = options.fieldType ?? "TEXT";
  const proposal = options.proposal === undefined ? { kind: "SCALAR", value: "Reviewed exact value" } : options.proposal;
  const field = {
    normalizedFieldKey: FIELD_KEY,
    semanticFieldKey: "applicant.name",
    question: "Name",
    normalizedQuestion: "name",
    helpText: null,
    fieldType,
    classification: "PERSONAL_INFO",
    permittedDisposition: "PROPOSABLE",
    dispositionReason: null,
    unsupportedReason: null,
    required: true,
    autocomplete: null,
    constraints: {
      minLength: null,
      maxLength: null,
      min: null,
      max: null,
      step: null,
      acceptedFileTypes: [],
      multiple: false
    },
    choices: [],
    fieldFingerprint: FIELD_FINGERPRINT
  };
  const packetAnswer = {
    normalizedFieldKey: FIELD_KEY,
    normalizedQuestion: "name",
    semanticFieldKey: "applicant.name",
    fieldFingerprint: FIELD_FINGERPRINT,
    fieldType,
    classification: "PERSONAL_INFO",
    disposition: "PROPOSABLE",
    dispositionReason: null,
    proposal,
    sourceType: "ANSWER_VAULT",
    sourceIds: ["source-1"],
    evidenceIds: [],
    sourceFingerprint: "6".repeat(64),
    confidence: 100,
    required: true,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false
  };
  const answerRow = {
    id: "answer-1",
    runId: RUN_ID,
    userId: USER_ID,
    answerPacketId: PACKET_ID,
    originalQuestion: "Name",
    proposedValue: "Reviewed exact value",
    ...packetAnswer,
    status: "APPROVED",
    reviewedByUser: true,
    reviewedAt: DB_NOW,
    finalValueHash: proposal === null ? null : computeApplicationAnswerProposalHash(proposal),
    reviewHashVersion: "CANONICAL_PROPOSAL_V1",
    createdAt: DB_NOW,
    updatedAt: DB_NOW
  };
  const summary = {
    fieldCount: 1,
    proposableCount: 1,
    pendingReviewCount: 0,
    approvedCount: 1,
    rejectedCount: 0,
    manualOnlyCount: 0,
    excludedCount: 0,
    unsupportedCount: 0,
    manualRequiredCount: 0,
    readyForRunResolution: options.ready ?? true
  };
  return {
    inspection: {
      id: INSPECTION_ID,
      runId: RUN_ID,
      userId: USER_ID,
      version: 2,
      schemaVersion: 1,
      normalizerVersion: 1,
      classifierVersion: 1,
      fingerprintVersion: 1,
      formFingerprint: FORM_FINGERPRINT,
      normalizedSnapshot: {},
      createdAt: DB_NOW
    },
    snapshot: { schemaVersion: 1, normalizerVersion: 1, classifierVersion: 1, fingerprintVersion: 1, forms: [] },
    fieldsByKey: new Map([[FIELD_KEY, field]]),
    packetRecord: {
      id: PACKET_ID,
      runId: RUN_ID,
      userId: USER_ID,
      version: 3,
      formInspectionId: INSPECTION_ID,
      schemaVersion: 1,
      builderVersion: 1,
      policyHash: POLICY_HASH,
      inputHash: "7".repeat(64),
      packetHash: PACKET_HASH,
      reviewedAt: DB_NOW,
      createdAt: DB_NOW
    },
    answerRows: [answerRow],
    packet: {
      schemaVersion: 1,
      inspectionVersion: 2,
      formFingerprint: FORM_FINGERPRINT,
      builderVersion: 1,
      policyHash: POLICY_HASH,
      answers: [packetAnswer]
    },
    validationContext: { fields: [] },
    summary,
    ownerSafe: {}
  } as unknown as VerifiedCurrentAnswerPacket;
}

function createCanonicalOrderPacket(): VerifiedCurrentAnswerPacket {
  const base = createVerifiedPacket();
  const sourceAnswer = base.packet.answers[0];
  const sourceRow = base.answerRows[0];
  const sourceField = base.fieldsByKey.get(FIELD_KEY)!;
  const specs = [
    { key: "f".repeat(64), fingerprint: "8".repeat(64), fieldType: "URL" as const, value: "https://first.example" },
    { key: "0".repeat(64), fingerprint: "9".repeat(64), fieldType: "NUMBER" as const, value: "42" },
    { key: "a".repeat(64), fingerprint: "b".repeat(64), fieldType: "TEXT" as const, value: "Third canonical value" }
  ];
  const answers = specs.map((spec) => ({
    ...sourceAnswer,
    normalizedFieldKey: spec.key,
    fieldFingerprint: spec.fingerprint,
    fieldType: spec.fieldType,
    proposal: { kind: "SCALAR" as const, value: spec.value }
  }));
  const answerRows = specs.map((spec, index) => ({
    ...sourceRow,
    id: `answer-${index}`,
    normalizedFieldKey: spec.key,
    fieldFingerprint: spec.fingerprint,
    fieldType: spec.fieldType,
    proposal: { kind: "SCALAR" as const, value: spec.value },
    finalValueHash: computeApplicationAnswerProposalHash({ kind: "SCALAR", value: spec.value })
  }));
  const fields = specs.map((spec) => ({
    ...sourceField,
    normalizedFieldKey: spec.key,
    fieldFingerprint: spec.fingerprint,
    fieldType: spec.fieldType
  }));
  return {
    ...base,
    packet: { ...base.packet, answers },
    answerRows,
    fieldsByKey: new Map(fields.map((field) => [field.normalizedFieldKey, field])),
    summary: {
      ...base.summary,
      fieldCount: specs.length,
      proposableCount: specs.length,
      approvedCount: specs.length
    }
  } as VerifiedCurrentAnswerPacket;
}

function createFakeState(options: {
  policy?: ReturnType<typeof createPolicy> | null;
  run?: ReturnType<typeof createRun>;
  verified?: VerifiedCurrentAnswerPacket | null;
  dbNow?: Date;
  terminalSteps?: Array<Record<string, unknown>>;
  policyReadThrows?: boolean;
  stepUpdateCounts?: number[];
  runUpdateCount?: number;
} = {}) {
  const state = {
    policy: options.policy === undefined ? createPolicy() : options.policy,
    run: (options.run ?? createRun()) as FakeRun,
    verified: options.verified === undefined ? createVerifiedPacket() : options.verified,
    dbNow: options.dbNow ?? DB_NOW,
    terminalSteps: options.terminalSteps ?? [],
    policyReadThrows: options.policyReadThrows ?? false,
    stepUpdateCounts: [...(options.stepUpdateCounts ?? [])],
    runUpdateCount: options.runUpdateCount,
    operations: [] as string[],
    transactionOptions: [] as unknown[],
    writes: [] as Array<{ model: string; method: string; args: unknown }>,
    stepRows: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>
  };

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join("?").replace(/\s+/g, " ");
      if (sql.includes("ApplicationAutomationPolicy")) {
        state.operations.push("lock-policy");
        return state.policy ? [{ id: state.policy.id }] : [];
      }
      if (sql.includes("ApplicationRunStep") && sql.includes("FOR UPDATE")) {
        state.operations.push("lock-steps");
        return state.terminalSteps;
      }
      if (sql.includes("ApplicationRun") && sql.includes("FOR UPDATE")) {
        state.operations.push("lock-run");
        return state.run.userId === USER_ID ? [{ id: state.run.id }] : [];
      }
      if (sql.includes("clock_timestamp")) {
        state.operations.push("clock");
        return [{ now: state.dbNow }];
      }
      throw new Error(`Unexpected raw SQL: ${sql}`);
    },
    applicationAutomationPolicy: {
      findUnique: async () => {
        state.operations.push("read-policy");
        if (state.policyReadThrows) throw new Error("policy access forbidden");
        return state.policy;
      },
      create: writeTrap("applicationAutomationPolicy", "create"),
      update: writeTrap("applicationAutomationPolicy", "update"),
      upsert: writeTrap("applicationAutomationPolicy", "upsert")
    },
    applicationRun: {
      findFirst: async () => {
        state.operations.push("read-run");
        return {
          ...state.run,
          application: { ...state.run.application },
          jobPosting: { ...state.run.jobPosting }
        };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.operations.push("write-run");
        state.writes.push({ model: "applicationRun", method: "updateMany", args });
        if (state.runUpdateCount !== undefined) return { count: state.runUpdateCount };
        if (args.where.state === "READY") {
          if (state.run.state !== "READY" || state.run.fillAttemptId !== null) return { count: 0 };
          Object.assign(state.run, {
            state: "FILLING",
            stateVersion: state.run.stateVersion + 1,
            fillAttemptId: String(args.data.fillAttemptId),
            fillLeaseExpiresAt: args.data.fillLeaseExpiresAt as Date,
            errorCategory: null
          });
          return { count: 1 };
        }
        if (
          state.run.state !== "FILLING" ||
          state.run.stateVersion !== args.where.stateVersion ||
          state.run.fillAttemptId !== args.where.fillAttemptId ||
          state.run.fillLeaseExpiresAt?.getTime() !== (args.where.fillLeaseExpiresAt as Date)?.getTime()
        ) return { count: 0 };
        Object.assign(state.run, {
          state: String(args.data.state),
          stateVersion: state.run.stateVersion + 1,
          fillLeaseExpiresAt: args.data.fillLeaseExpiresAt as Date | null,
          errorCategory: args.data.errorCategory as string | null
        });
        return { count: 1 };
      },
      create: writeTrap("applicationRun", "create"),
      update: writeTrap("applicationRun", "update")
    },
    applicationRunStep: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        state.operations.push("write-steps");
        state.writes.push({ model: "applicationRunStep", method: "createMany", args });
        state.stepRows.push(...args.data);
        return { count: args.data.length };
      },
      findMany: async () => {
        state.operations.push("read-steps");
        return state.terminalSteps;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.operations.push("write-step");
        state.writes.push({ model: "applicationRunStep", method: "updateMany", args });
        const forcedCount = state.stepUpdateCounts.shift();
        if (forcedCount !== undefined && forcedCount !== 1) return { count: forcedCount };
        const index = state.terminalSteps.findIndex((step) => step.stepKey === args.where.stepKey);
        if (index < 0) return { count: 0 };
        state.terminalSteps[index] = { ...state.terminalSteps[index], ...args.data };
        return { count: 1 };
      }
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.operations.push("write-audit");
        state.writes.push({ model: "auditLog", method: "create", args });
        state.audits.push(args.data);
        return args.data;
      }
    }
  };

  function writeTrap(model: string, method: string) {
    return async (args: unknown) => {
      state.writes.push({ model, method, args });
      throw new Error(`Unexpected ${model}.${method} write`);
    };
  }

  const prismaClient = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>, optionsArg?: unknown) => {
      state.transactionOptions.push(optionsArg);
      const runSnapshot = { ...state.run };
      const stepsSnapshot = state.terminalSteps.map((step) => ({ ...step }));
      const auditLength = state.audits.length;
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state.run, runSnapshot);
        state.terminalSteps.splice(0, state.terminalSteps.length, ...stepsSnapshot);
        state.audits.splice(auditLength);
        throw error;
      }
    }
  };
  return { ...state, tx, prismaClient };
}

function serviceFor(state: FakeState, overrides: Record<string, unknown> = {}) {
  return createApplicationRunFillAttemptService({
    prismaClient: state.prismaClient as never,
    env: { APPLICATION_AUTOMATION_ENABLED: "true" },
    attemptIdGenerator: () => ATTEMPT_ID,
    assertTransition: () => undefined,
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => state.verified,
    ...overrides
  });
}

function assertFillError(error: unknown, code: string, status?: number): boolean {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.details?.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
}

test("acquisition uses locked authority, DB time, one guarded attempt, canonical steps, and minimum material", async () => {
  const state = createFakeState();
  let transitions = 0;
  const result = await serviceFor(state, {
    assertTransition: (from: string, to: string) => {
      transitions += 1;
      state.operations.push("transition");
      assert.deepEqual([from, to], ["READY", "FILLING"]);
    },
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
      state.operations.push("verify-packet");
      return state.verified;
    }
  }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 });

  assert.equal(transitions, 1);
  assert.deepEqual(state.operations, [
    "lock-policy", "read-policy", "lock-run", "read-run", "verify-packet", "transition", "clock",
    "write-run", "write-steps", "write-audit"
  ]);
  assert.deepEqual(result, {
    attemptId: ATTEMPT_ID,
    runStateVersion: 8,
    leaseExpiresAt: new Date(DB_NOW.getTime() + 600_000),
    formInspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: PACKET_HASH,
    formFingerprint: FORM_FINGERPRINT,
    eligibleFields: [{
      normalizedFieldKey: FIELD_KEY,
      fieldFingerprint: FIELD_FINGERPRINT,
      fieldType: "TEXT",
      proposal: { kind: "SCALAR", value: "Reviewed exact value" }
    }]
  });
  assert.deepEqual(state.stepRows, [{
    runId: RUN_ID,
    userId: USER_ID,
    stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`,
    sequence: 0,
    action: "FILL_FIELD",
    semanticFieldKey: null,
    adapter: null,
    status: "PENDING",
    attemptNumber: 1,
    redactedValueSummary: null,
    errorCategory: null,
    artifactReference: null,
    startedAt: null,
    completedAt: null
  }]);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "application-run-fill-attempt.acquire");
  assert.deepEqual(Object.keys(state.audits[0].metadata as object).sort(), [
    "answerPacketVersion", "eligibleFieldCount", "fillAttemptId", "formInspectionVersion",
    "leaseExpiresAt", "nextStateVersion", "previousStateVersion", "runId"
  ]);
  const runWrite = state.writes.find((write) => write.model === "applicationRun" && write.method === "updateMany");
  assert.deepEqual(runWrite?.args, {
    where: {
      id: RUN_ID,
      userId: USER_ID,
      state: "READY",
      stateVersion: 7,
      fillAttemptId: null,
      currentFormInspectionVersion: 2,
      currentAnswerPacketVersion: 3
    },
    data: {
      state: "FILLING",
      stateVersion: { increment: 1 },
      fillAttemptId: ATTEMPT_ID,
      fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 600_000),
      errorCategory: null
    }
  });
});

test("acquisition preserves verified packet order across filtering, response, and exact step sequence", async () => {
  const verified = createCanonicalOrderPacket();
  const state = createFakeState({ verified });
  const result = await serviceFor(state).acquireFillAttempt({
    userId: USER_ID,
    runId: RUN_ID,
    expectedStateVersion: 7
  });
  const expectedKeys = ["f".repeat(64), "a".repeat(64)];
  assert.deepEqual(result.eligibleFields.map((field) => field.normalizedFieldKey), expectedKeys);
  assert.deepEqual(state.stepRows.map((step) => ({ stepKey: step.stepKey, sequence: step.sequence })), [
    { stepKey: `fill:${ATTEMPT_ID}:${expectedKeys[0]}`, sequence: 0 },
    { stepKey: `fill:${ATTEMPT_ID}:${expectedKeys[1]}`, sequence: 1 }
  ]);
  assert.ok(state.stepRows.every((step) => step.semanticFieldKey === null));
});

test("acquisition exact global gate fails before a transaction", async () => {
  for (const value of [undefined, "false", "TRUE", "1", "yes", " true "]) {
    const state = createFakeState();
    const service = serviceFor(state, { env: { APPLICATION_AUTOMATION_ENABLED: value } });
    await assert.rejects(
      service.acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, "FILL_POLICY_DENIED", 403)
    );
    assert.equal(state.transactionOptions.length, 0);
    assert.equal(state.writes.length, 0);
  }
});

test("acquisition rejects stale expected state version before packet verification or Fill mutation", async () => {
  const state = createFakeState();
  let verifierCalls = 0;
  let transitionCalls = 0;
  let generatedAttemptIds = 0;

  await assert.rejects(
    serviceFor(state, {
      loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
        verifierCalls += 1;
        return state.verified;
      },
      assertTransition: () => {
        transitionCalls += 1;
      },
      attemptIdGenerator: () => {
        generatedAttemptIds += 1;
        return ATTEMPT_ID;
      }
    }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 6 }),
    (error) => assertFillError(error, "FILL_STALE", 409)
  );

  assert.deepEqual(state.operations, ["lock-policy", "read-policy", "lock-run", "read-run"]);
  assert.equal(verifierCalls, 0);
  assert.equal(transitionCalls, 0);
  assert.equal(generatedAttemptIds, 0);
  assert.equal(state.operations.includes("clock"), false);
  assert.equal(state.writes.length, 0);
  assert.equal(state.stepRows.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.writes.some((write) => write.model === "applicationEvent"), false);
  assert.equal(state.run.state, "READY");
  assert.equal(state.run.stateVersion, 7);
  assert.equal(state.run.fillAttemptId, null);
  assert.equal(state.run.fillLeaseExpiresAt, null);
});

test("zero eligible leaves the permanent attempt opportunity untouched before UUID, clock, or writes", async () => {
  const state = createFakeState({ verified: createVerifiedPacket({ fieldType: "NUMBER" }) });
  let generated = 0;
  await assert.rejects(
    serviceFor(state, { attemptIdGenerator: () => { generated += 1; return ATTEMPT_ID; } })
      .acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_NO_ELIGIBLE_FIELDS")
  );
  assert.equal(generated, 0);
  assert.equal(state.operations.includes("clock"), false);
  assert.equal(state.writes.length, 0);
  assert.equal(state.run.state, "READY");
  assert.equal(state.run.fillAttemptId, null);
});

test("acquisition policy and host gates fail closed without packet verification or mutation", async () => {
  const cases: Array<{
    label: string;
    policy: ReturnType<typeof createPolicy> | null;
    run?: ReturnType<typeof createRun>;
  }> = [
    { label: "missing policy", policy: null },
    { label: "disabled policy", policy: { ...createPolicy(), enabled: false } },
    { label: "wrong mode", policy: { ...createPolicy(), mode: "PREPARE_ONLY" } },
    { label: "empty allowlist", policy: { ...createPolicy(), allowedHosts: [] } },
    { label: "blocked wins", policy: { ...createPolicy(), blockedHosts: ["jobs.example.com"] as string[] } },
    { label: "sensitive mode", policy: { ...createPolicy(), sensitiveAnswerPolicy: "INCLUDE" } },
    { label: "review disabled", policy: { ...createPolicy(), finalReviewRequired: false } },
    {
      label: "host mismatch",
      policy: createPolicy(),
      run: createRun({ applyHost: "other.example.com" })
    },
    {
      label: "prohibited host",
      policy: { ...createPolicy(), allowedHosts: ["indeed.com"] },
      run: createRun({ applyUrlSnapshot: "https://indeed.com/apply/1", applyHost: "indeed.com" })
    }
  ];
  for (const scenario of cases) {
    const state = createFakeState({ policy: scenario.policy, ...(scenario.run ? { run: scenario.run } : {}) });
    let verifierCalls = 0;
    await assert.rejects(
      serviceFor(state, {
        loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
          verifierCalls += 1;
          return state.verified;
        }
      }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, "FILL_POLICY_DENIED", 403),
      scenario.label
    );
    assert.equal(verifierCalls, 0, scenario.label);
    assert.equal(state.writes.length, 0, scenario.label);
  }
});

test("verifier/current-review failures translate to the closed Fill taxonomy without writes", async () => {
  for (const scenario of [
    { label: "stale verifier", error: new PublicApiError("raw stale", 409, { code: "RUN_INSPECTION_STALE" }), code: "FILL_STALE" },
    { label: "target-stale verifier", error: new PublicApiError("raw target", 409, { code: "RUN_TARGET_STALE" }), code: "FILL_STALE" },
    { label: "packet-stale verifier", error: new PublicApiError("raw packet", 409, { code: "RUN_PACKET_STALE" }), code: "FILL_STALE" },
    { label: "review-incomplete verifier", error: new PublicApiError("raw review", 409, { code: "RUN_PACKET_REVIEW_INCOMPLETE" }), code: "FILL_REVIEW_REQUIRED" },
    { label: "invalid verifier", error: new PublicApiError("raw invalid", 409, { code: "RUN_PACKET_INVALID", detail: "secret" }), code: "FILL_INTERNAL" }
  ]) {
    const state = createFakeState();
    await assert.rejects(
      serviceFor(state, {
        loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => { throw scenario.error; }
      }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, scenario.code),
      scenario.label
    );
    assert.equal(state.writes.length, 0);
  }

  for (const verified of [null, createVerifiedPacket({ ready: false }), {
    ...createVerifiedPacket(),
    packetRecord: { ...createVerifiedPacket().packetRecord, reviewedAt: null }
  } as VerifiedCurrentAnswerPacket]) {
    const state = createFakeState({ verified });
    await assert.rejects(
      serviceFor(state).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, "FILL_REVIEW_REQUIRED")
    );
    assert.equal(state.writes.length, 0);
  }
});

test("invalid database clock output is sanitized before UUID generation or mutation", async () => {
  const state = createFakeState({ dbNow: new Date(Number.NaN) });
  let generated = 0;
  await assert.rejects(
    serviceFor(state, { attemptIdGenerator: () => { generated += 1; return ATTEMPT_ID; } })
      .acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(generated, 0);
  assert.equal(state.writes.length, 0);
});

test("attempt identity is generated exactly once and invalid UUIDs cannot mutate", async () => {
  for (const generatedId of ["not-a-uuid", "", "550e8400-e29b-41d4-a716-44665544000z"]) {
    const state = createFakeState();
    let generated = 0;
    await assert.rejects(
      serviceFor(state, { attemptIdGenerator: () => { generated += 1; return generatedId; } })
        .acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, "FILL_INTERNAL", 500)
    );
    assert.equal(generated, 1);
    assert.equal(state.writes.length, 0);
  }
});

test("a lost guarded run update returns stale and writes no steps or audit", async () => {
  const state = createFakeState();
  await assert.rejects(
    serviceFor(state, {
      assertTransition: () => { state.run.state = "CANCELLED"; }
    }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_STALE")
  );
  assert.equal(state.writes.filter((write) => write.model === "applicationRun").length, 1);
  assert.equal(state.writes.some((write) => write.model === "applicationRunStep"), false);
  assert.equal(state.writes.some((write) => write.model === "auditLog"), false);
});

test("central transition authority is mandatory before DB time or mutation", async () => {
  const state = createFakeState();
  await assert.rejects(
    serviceFor(state, { assertTransition: () => { throw new Error("transition denied"); } })
      .acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.operations.includes("clock"), false);
  assert.equal(state.writes.length, 0);
});

test("a consumed attempt is a permanent fence and cannot replay proposal material", async () => {
  const state = createFakeState({ run: createRun({ state: "FILLING", fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: DB_NOW }) });
  await assert.rejects(
    serviceFor(state).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_ALREADY_IN_PROGRESS")
  );
  assert.equal(state.writes.length, 0);
  assert.equal(state.operations.includes("clock"), false);
});

test("the permanent attempt fence outranks review state and every post-Fill lifecycle state", async () => {
  const preFillReview = createFakeState({ run: createRun({ state: "REVIEW_REQUIRED" }) });
  await assert.rejects(
    serviceFor(preFillReview).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => assertFillError(error, "FILL_REVIEW_REQUIRED")
  );

  for (const stateName of ["REVIEW_REQUIRED", "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "CANCELLED"]) {
    const state = createFakeState({ run: createRun({ state: stateName, fillAttemptId: ATTEMPT_ID }) });
    let verifierCalls = 0;
    await assert.rejects(
      serviceFor(state, {
        loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
          verifierCalls += 1;
          return state.verified;
        }
      }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
      (error) => assertFillError(error, "FILL_ALREADY_IN_PROGRESS")
    );
    assert.equal(verifierCalls, 0);
    assert.equal(state.writes.length, 0);
  }
});

test("malformed service inputs and unknown prefix-matching dependency errors are sanitized", async () => {
  for (const operation of ["acquire", "get"] as const) {
    const state = createFakeState();
    const service = serviceFor(state);
    const request = operation === "acquire"
      ? service.acquireFillAttempt({ userId: USER_ID, runId: "not-a-cuid", expectedStateVersion: 7, extra: true })
      : service.getFillAttemptStatus({ userId: USER_ID, runId: "not-a-cuid", extra: true });
    await assert.rejects(request, (error) => {
      assertFillError(error, "FILL_INTERNAL", 500);
      assert.equal(error instanceof Error && error.name, "PublicApiError");
      return true;
    });
    assert.equal(state.transactionOptions.length, 0);
  }

  const state = createFakeState();
  await assert.rejects(
    serviceFor(state, {
      loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
        throw new PublicApiError("database detail", 418, {
          code: "FILL_DATABASE_DETAIL",
          query: "secret"
        });
      }
    }).acquireFillAttempt({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }),
    (error) => {
      assertFillError(error, "FILL_INTERNAL", 500);
      assert.equal((error as PublicApiError).message, "Fill status is unavailable.");
      assert.deepEqual((error as PublicApiError).details, { code: "FILL_INTERNAL" });
      return true;
    }
  );
});

test("GET uses one RepeatableRead transaction, DB time, virtual missing policy, and no writes", async () => {
  const state = createFakeState({ policy: null });
  const result = await serviceFor(state).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
  assert.deepEqual(state.transactionOptions, [{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }]);
  assert.deepEqual(state.operations, ["read-policy", "read-run", "clock"]);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(result, {
    state: "READY",
    stateVersion: 7,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: []
  });
});

test("GET computes exact live/expired Fill permission without mutation", async () => {
  for (const [lease, leaseLive, expired, allowed] of [
    [new Date(DB_NOW.getTime() + 1), true, false, true],
    [DB_NOW, false, true, false],
    [new Date(DB_NOW.getTime() - 1), false, true, false]
  ] as const) {
    const state = createFakeState({ run: createRun({ state: "FILLING", fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: lease }) });
    const result = await serviceFor(state).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
    assert.equal(result.leaseLive, leaseLive);
    assert.equal(result.expiredRecoveryRequired, expired);
    assert.equal(result.fieldOperationAllowed, allowed);
    assert.equal(state.writes.length, 0);
  }
});

test("GET fieldOperationAllowed requires every global, policy, host, state, attempt, and live-lease gate", async () => {
  const liveRun = () => createRun({
    state: "FILLING",
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 60_000)
  });
  const scenarios: Array<{
    label: string;
    policy?: ReturnType<typeof createPolicy> | null;
    run?: ReturnType<typeof createRun>;
    env?: Record<string, string | undefined>;
  }> = [
    { label: "global disabled", env: { APPLICATION_AUTOMATION_ENABLED: "false" } },
    { label: "missing policy", policy: null },
    { label: "policy disabled", policy: { ...createPolicy(), enabled: false } },
    { label: "mode", policy: { ...createPolicy(), mode: "PREPARE_ONLY" } },
    { label: "allowlist", policy: { ...createPolicy(), allowedHosts: [] } },
    { label: "blocked", policy: { ...createPolicy(), blockedHosts: ["jobs.example.com"] as string[] } },
    { label: "sensitive", policy: { ...createPolicy(), sensitiveAnswerPolicy: "INCLUDE" } },
    { label: "final review", policy: { ...createPolicy(), finalReviewRequired: false } },
    { label: "host mismatch", run: createRun({ ...liveRun(), applyHost: "other.example.com" }) },
    {
      label: "prohibited host",
      policy: { ...createPolicy(), allowedHosts: ["indeed.com"] },
      run: createRun({
        ...liveRun(),
        applyUrlSnapshot: "https://indeed.com/apply/1",
        applyHost: "indeed.com"
      })
    },
    { label: "wrong state", run: createRun() },
    { label: "missing attempt", run: createRun({ ...liveRun(), fillAttemptId: null }) },
    { label: "expired", run: createRun({ ...liveRun(), fillLeaseExpiresAt: DB_NOW }) }
  ];
  for (const scenario of scenarios) {
    const state = createFakeState({
      ...(scenario.policy !== undefined ? { policy: scenario.policy } : {}),
      run: scenario.run ?? liveRun()
    });
    const result = await serviceFor(state, {
      env: scenario.env ?? { APPLICATION_AUTOMATION_ENABLED: "true" }
    }).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
    assert.equal(result.fieldOperationAllowed, false, scenario.label);
    assert.equal(state.writes.length, 0, scenario.label);
  }
});

test("GET returns deterministic CANCELLED without loading contradictory historical steps", async () => {
  const state = createFakeState({
    run: createRun({ state: "CANCELLED", stateVersion: 11, fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: [{ action: "raw-secret" }]
  });
  const result = await serviceFor(state).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
  assert.deepEqual(result, {
    state: "CANCELLED",
    stateVersion: 11,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: []
  });
  assert.equal(state.operations.includes("read-steps"), false);
  assert.equal(state.writes.length, 0);
});

test("GET preserves post-Fill REVIEW_REQUIRED and COMPLETED_BY_USER identity without outcome inference", async () => {
  for (const stateName of ["REVIEW_REQUIRED", "COMPLETED_BY_USER"] as const) {
    const state = createFakeState({
      run: createRun({ state: stateName, stateVersion: 12, fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: null }),
      terminalSteps: [{ action: "FILL_FIELD", redactedValueSummary: "raw-secret" }]
    });
    const result = await serviceFor(state).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
    assert.deepEqual(result, {
      state: stateName,
      stateVersion: 12,
      fillAttemptId: ATTEMPT_ID,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: false,
      outcome: null,
      errorCode: null,
      steps: []
    });
    assert.equal(state.operations.includes("read-steps"), false);
    assert.equal(state.writes.length, 0);
  }
});

test("GET derives closed terminal status and suppresses contradictory persistence", async () => {
  const stepKey = `fill:${ATTEMPT_ID}:${FIELD_KEY}`;
  const valid = createFakeState({
    run: createRun({ state: "READY_FOR_USER_SUBMISSION", fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: null }),
    terminalSteps: [{
      stepKey, sequence: 0, action: "FILL_FIELD", semanticFieldKey: null, adapter: null,
      artifactReference: null, attemptNumber: 1, status: "SUCCEEDED",
      redactedValueSummary: "FILLED", errorCategory: null
    }]
  });
  assert.deepEqual(await serviceFor(valid).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID }), {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 7,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{ stepKey, result: "FILLED", errorCode: null }]
  });

  const contradictory = createFakeState({
    run: createRun({ state: "READY_FOR_USER_SUBMISSION", fillAttemptId: ATTEMPT_ID, fillLeaseExpiresAt: null }),
    terminalSteps: [{
      stepKey, sequence: 3, action: "FILL_FIELD", semanticFieldKey: "secret", adapter: null,
      artifactReference: null, attemptNumber: 2, status: "SUCCEEDED",
      redactedValueSummary: "raw-secret", errorCategory: "raw-secret"
    }]
  });
  const result = await serviceFor(contradictory).getFillAttemptStatus({ userId: USER_ID, runId: RUN_ID });
  assert.equal(result.outcome, null);
  assert.equal(result.errorCode, "FILL_INTERNAL");
  assert.deepEqual(result.steps, []);
});

test("factory exposes exactly the four approved Fill operations", () => {
  const state = createFakeState();
  assert.deepEqual(Object.keys(serviceFor(state)).sort(), [
    "acquireFillAttempt",
    "finalizeFillAttempt",
    "getFillAttemptStatus",
    "recoverExpiredFillAttempt"
  ]);
});

test("FINALIZE COMPLETED locks run, clock, and exact steps then persists a privacy-safe terminal result", async () => {
  const steps = [
    createAttemptStep(FIELD_KEY, 0),
    createAttemptStep(SECOND_FIELD_KEY, 1),
    createAttemptStep(THIRD_FIELD_KEY, 2)
  ];
  const state = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 1) }),
    terminalSteps: steps,
    policyReadThrows: true
  });
  const result = await serviceFor(state, {
    env: { APPLICATION_AUTOMATION_ENABLED: "false" },
    assertTransition: (from: string, to: string) => {
      state.operations.push("transition");
      assert.deepEqual([from, to], ["FILLING", "READY_FOR_USER_SUBMISSION"]);
    }
  }).finalizeFillAttempt(completedFinalizationInput([
    { stepKey: steps[0].stepKey, result: "FILLED", errorCode: null },
    { stepKey: steps[1].stepKey, result: "PRESERVED_EXISTING", errorCode: null },
    { stepKey: steps[2].stepKey, result: "MANUAL", errorCode: null }
  ]));

  assert.deepEqual(state.operations, [
    "lock-run", "read-run", "clock", "lock-steps", "transition",
    "write-step", "write-step", "write-step", "write-run", "write-audit"
  ]);
  assert.deepEqual(result, {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [
      { stepKey: steps[0].stepKey, result: "FILLED", errorCode: null },
      { stepKey: steps[1].stepKey, result: "PRESERVED_EXISTING", errorCode: null },
      { stepKey: steps[2].stepKey, result: "MANUAL", errorCode: null }
    ]
  });
  assert.deepEqual(state.terminalSteps.map((step) => ({
    status: step.status,
    result: step.redactedValueSummary,
    error: step.errorCategory,
    completedAt: step.completedAt
  })), [
    { status: "SUCCEEDED", result: "FILLED", error: null, completedAt: DB_NOW },
    { status: "SKIPPED", result: "PRESERVED_EXISTING", error: null, completedAt: DB_NOW },
    { status: "SKIPPED", result: "MANUAL", error: null, completedAt: DB_NOW }
  ]);
  assert.equal(state.run.fillAttemptId, ATTEMPT_ID);
  assert.equal(state.run.fillLeaseExpiresAt, null);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "application-run-fill-attempt.finalize");
  assert.deepEqual(Object.keys(state.audits[0].metadata as object).sort(), [
    "completedAt", "errorCode", "fillAttemptId", "nextStateVersion", "outcome",
    "previousStateVersion", "resultCounts", "runId"
  ]);
  assert.equal(state.operations.includes("read-policy"), false);
  assert.equal(JSON.stringify({ result, audit: state.audits[0] }).includes("Reviewed exact value"), false);
  const finalizedStepWrites = state.writes.filter((write) => write.model === "applicationRunStep");
  assert.deepEqual(finalizedStepWrites.map((write) => write.args), [
    ["SUCCEEDED", "FILLED"],
    ["SKIPPED", "PRESERVED_EXISTING"],
    ["SKIPPED", "MANUAL"]
  ].map(([status, redactedValueSummary], index) => ({
    where: {
      runId: RUN_ID,
      userId: USER_ID,
      stepKey: steps[index].stepKey,
      sequence: index,
      action: "FILL_FIELD",
      attemptNumber: 1,
      semanticFieldKey: null,
      adapter: null,
      artifactReference: null,
      status: "PENDING",
      redactedValueSummary: null,
      errorCategory: null,
      startedAt: null,
      completedAt: null
    },
    data: {
      status,
      redactedValueSummary,
      errorCategory: null,
      completedAt: DB_NOW
    }
  })));
  const finalizedRunWrite = state.writes.find((write) => write.model === "applicationRun");
  assert.deepEqual(finalizedRunWrite?.args, {
    where: {
      id: RUN_ID,
      userId: USER_ID,
      state: "FILLING",
      stateVersion: 7,
      fillAttemptId: ATTEMPT_ID,
      fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 1)
    },
    data: {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: { increment: 1 },
      fillLeaseExpiresAt: null,
      errorCategory: null
    }
  });
  assert.equal(Object.hasOwn((finalizedRunWrite?.args as { data: object }).data, "fillAttemptId"), false);
});

test("FINALIZE STOPPED_EARLY preserves the pre-field pattern without inventing a FAILED step", async () => {
  const steps = [
    createAttemptStep(FIELD_KEY, 0),
    createAttemptStep(SECOND_FIELD_KEY, 1),
    createAttemptStep(THIRD_FIELD_KEY, 2)
  ];
  const state = createFakeState({ run: createFillingRun(), terminalSteps: steps });
  const result = await serviceFor(state).finalizeFillAttempt(completedFinalizationInput([
    { stepKey: steps[0].stepKey, result: "MANUAL", errorCode: null },
    { stepKey: steps[1].stepKey, result: "NOT_ATTEMPTED", errorCode: null },
    { stepKey: steps[2].stepKey, result: "NOT_ATTEMPTED", errorCode: null }
  ], { outcome: "STOPPED_EARLY", errorCode: "FILL_POLICY_DENIED" }));
  assert.equal(result.outcome, "STOPPED_EARLY");
  assert.equal(result.errorCode, "FILL_POLICY_DENIED");
  assert.deepEqual(result.steps.map((step: { result: string }) => step.result), [
    "MANUAL", "NOT_ATTEMPTED", "NOT_ATTEMPTED"
  ]);
  assert.equal(result.steps.some((step: { result: string }) => step.result === "FAILED"), false);
  assert.deepEqual(state.terminalSteps.map((step) => step.status), ["SKIPPED", "SKIPPED", "SKIPPED"]);
});

test("FINALIZE STOPPED_EARLY accepts exactly one matching in-field failure followed by an untouched tail", async () => {
  const steps = [
    createAttemptStep(FIELD_KEY, 0, { startedAt: new Date(DB_NOW.getTime() - 100) }),
    createAttemptStep(SECOND_FIELD_KEY, 1, { startedAt: new Date(DB_NOW.getTime() - 50) }),
    createAttemptStep(THIRD_FIELD_KEY, 2)
  ];
  const state = createFakeState({ run: createFillingRun(), terminalSteps: steps });
  const result = await serviceFor(state).finalizeFillAttempt(completedFinalizationInput([
    { stepKey: steps[0].stepKey, result: "FILLED", errorCode: null },
    { stepKey: steps[1].stepKey, result: "FAILED", errorCode: "FILL_WRITE_FAILED" },
    { stepKey: steps[2].stepKey, result: "NOT_ATTEMPTED", errorCode: null }
  ], { outcome: "STOPPED_EARLY", errorCode: "FILL_WRITE_FAILED" }));
  assert.deepEqual(result.steps.map((step: { result: string; errorCode: string | null }) => [step.result, step.errorCode]), [
    ["FILLED", null], ["FAILED", "FILL_WRITE_FAILED"], ["NOT_ATTEMPTED", null]
  ]);
  assert.equal((state.terminalSteps[1].startedAt as Date).getTime(), DB_NOW.getTime() - 50);
  assert.equal(state.run.errorCategory, "FILL_WRITE_FAILED");
});

test("FINALIZE rejects forbidden or mismatched stopped errors without mutation", async () => {
  const step = createAttemptStep(FIELD_KEY, 0);
  for (const errorCode of [
    "FILL_REVIEW_REQUIRED", "FILL_ALREADY_IN_PROGRESS", "FILL_NO_ELIGIBLE_FIELDS", "FILL_STALE"
  ]) {
    const state = createFakeState({ run: createFillingRun(), terminalSteps: [{ ...step }] });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput([
        { stepKey: step.stepKey, result: "FAILED", errorCode }
      ], { outcome: "STOPPED_EARLY", errorCode })),
      (error) => assertFillError(error, "FILL_INTERNAL", 500)
    );
    assert.equal(state.writes.length, 0);
  }

  const state = createFakeState({ run: createFillingRun(), terminalSteps: [{ ...step }] });
  await assert.rejects(
    serviceFor(state).finalizeFillAttempt(completedFinalizationInput([
      { stepKey: step.stepKey, result: "FAILED", errorCode: "FILL_WRITE_FAILED" }
    ], { outcome: "STOPPED_EARLY", errorCode: "FILL_INTERNAL" })),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.writes.length, 0);
});

test("FINALIZE enforces the active attempt fence and the strict live-lease boundary", async () => {
  const scenarios = [
    { label: "wrong state", run: createFillingRun({ state: "READY_FOR_USER_SUBMISSION" }), code: "FILL_STALE" },
    { label: "wrong attempt", run: createFillingRun({ fillAttemptId: "550e8400-e29b-41d4-a716-446655440001" }), code: "FILL_STALE" },
    { label: "stale version", run: createFillingRun({ stateVersion: 8 }), code: "FILL_STALE" },
    { label: "null attempt corruption", run: createFillingRun({ fillAttemptId: null }), code: "FILL_INTERNAL" },
    { label: "invalid attempt corruption", run: createFillingRun({ fillAttemptId: "corrupt" }), code: "FILL_INTERNAL" },
    { label: "missing lease", run: createFillingRun({ fillLeaseExpiresAt: null }), code: "FILL_INTERNAL" },
    { label: "invalid lease", run: createFillingRun({ fillLeaseExpiresAt: new Date(Number.NaN) }), code: "FILL_INTERNAL" },
    { label: "expired by one millisecond", run: createFillingRun({ fillLeaseExpiresAt: new Date(DB_NOW.getTime() - 1) }), code: "FILL_STALE" },
    { label: "equal expiry", run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }), code: "FILL_STALE" }
  ];
  for (const scenario of scenarios) {
    const state = createFakeState({ run: scenario.run, terminalSteps: [createAttemptStep(FIELD_KEY, 0)] });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput()),
      (error) => assertFillError(error, scenario.code),
      scenario.label
    );
    assert.equal(state.writes.length, 0, scenario.label);
    assert.equal(state.audits.length, 0, scenario.label);
  }

  const live = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 1) }),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });
  assert.equal((await serviceFor(live).finalizeFillAttempt(completedFinalizationInput())).outcome, "COMPLETED");
});

test("FINALIZE rejects non-exact client coverage and malformed persisted step identity", async () => {
  const first = createAttemptStep(FIELD_KEY, 0);
  const second = createAttemptStep(SECOND_FIELD_KEY, 1);
  const baseAssertions = [
    { stepKey: first.stepKey, result: "FILLED", errorCode: null },
    { stepKey: second.stepKey, result: "MANUAL", errorCode: null }
  ];
  const clientCases = [
    { label: "duplicate", assertions: [baseAssertions[0], baseAssertions[0]] },
    { label: "missing", assertions: [baseAssertions[0]] },
    { label: "extra", assertions: [...baseAssertions, { stepKey: `fill:${ATTEMPT_ID}:${THIRD_FIELD_KEY}`, result: "MANUAL", errorCode: null }] },
    { label: "foreign", assertions: [{ ...baseAssertions[0], stepKey: `fill:550e8400-e29b-41d4-a716-446655440001:${FIELD_KEY}` }, baseAssertions[1]] },
    { label: "wrong order", assertions: [baseAssertions[1], baseAssertions[0]] }
  ];
  for (const scenario of clientCases) {
    const state = createFakeState({ run: createFillingRun(), terminalSteps: [{ ...first }, { ...second }] });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput(scenario.assertions)),
      (error) => assertFillError(error, "FILL_INTERNAL"),
      scenario.label
    );
    assert.equal(state.writes.length, 0, scenario.label);
  }

  const persistedCases = [
    { label: "duplicate sequence", steps: [{ ...first }, { ...second, sequence: 0 }] },
    { label: "sequence gap", steps: [{ ...first }, { ...second, sequence: 2 }] },
    { label: "foreign prefix", steps: [{ ...first, stepKey: `fill:550e8400-e29b-41d4-a716-446655440001:${FIELD_KEY}` }, { ...second }] },
    { label: "wrong action", steps: [{ ...first, action: "PREPARE" }, { ...second }] },
    { label: "wrong attempt number", steps: [{ ...first, attemptNumber: 2 }, { ...second }] },
    { label: "semantic identity", steps: [{ ...first, semanticFieldKey: "private.field" }, { ...second }] },
    { label: "adapter identity", steps: [{ ...first, adapter: "secret-adapter" }, { ...second }] },
    { label: "artifact identity", steps: [{ ...first, artifactReference: "secret-artifact" }, { ...second }] }
  ];
  for (const scenario of persistedCases) {
    const state = createFakeState({ run: createFillingRun(), terminalSteps: scenario.steps });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput(baseAssertions)),
      (error) => assertFillError(error, "FILL_INTERNAL"),
      scenario.label
    );
    assert.equal(state.writes.length, 0, scenario.label);
  }
});

test("FINALIZE rejects contradictory current persistence and central transition denial before writes", async () => {
  for (const step of [
    createAttemptStep(FIELD_KEY, 0, { status: "SUCCEEDED", redactedValueSummary: "FILLED", completedAt: DB_NOW }),
    createAttemptStep(FIELD_KEY, 0, { status: "RUNNING" }),
    createAttemptStep(FIELD_KEY, 0, { errorCategory: "FILL_INTERNAL" }),
    createAttemptStep(FIELD_KEY, 0, { completedAt: DB_NOW })
  ]) {
    const state = createFakeState({ run: createFillingRun(), terminalSteps: [step] });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput()),
      (error) => assertFillError(error, "FILL_INTERNAL")
    );
    assert.equal(state.writes.length, 0);
  }

  const denied = createFakeState({ run: createFillingRun(), terminalSteps: [createAttemptStep(FIELD_KEY, 0)] });
  await assert.rejects(
    serviceFor(denied, { assertTransition: () => { throw new Error("denied"); } })
      .finalizeFillAttempt(completedFinalizationInput()),
    (error) => assertFillError(error, "FILL_INTERNAL")
  );
  assert.equal(denied.writes.length, 0);
  assert.equal(denied.audits.length, 0);
});

test("FINALIZE guarded step or run loss rolls back every attempted mutation", async () => {
  const twoSteps = [createAttemptStep(FIELD_KEY, 0), createAttemptStep(SECOND_FIELD_KEY, 1)];
  const assertions = twoSteps.map((step) => ({ stepKey: step.stepKey, result: "FILLED", errorCode: null }));
  for (const options of [{ stepUpdateCounts: [1, 0] }, { runUpdateCount: 0 }]) {
    const state = createFakeState({ run: createFillingRun(), terminalSteps: twoSteps.map((step) => ({ ...step })), ...options });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput(assertions)),
      (error) => assertFillError(error, "FILL_INTERNAL")
    );
    assert.equal(state.run.state, "FILLING");
    assert.deepEqual(state.terminalSteps.map((step) => step.status), ["PENDING", "PENDING"]);
    assert.equal(state.audits.length, 0);
  }
});

test("FINALIZE and RECOVER inputs are strict, bounded, and sanitized", async () => {
  const state = createFakeState({ run: createFillingRun(), terminalSteps: [createAttemptStep(FIELD_KEY, 0)] });
  const service = serviceFor(state);
  for (const request of [
    service.finalizeFillAttempt({ ...completedFinalizationInput(), extra: true }),
    service.finalizeFillAttempt({ ...completedFinalizationInput(), expectedStateVersion: -1 }),
    service.finalizeFillAttempt({ ...completedFinalizationInput(), fillAttemptId: "not-a-uuid" }),
    service.finalizeFillAttempt({ ...completedFinalizationInput(), steps: [] }),
    service.finalizeFillAttempt({
      ...completedFinalizationInput(),
      steps: Array.from({ length: 201 }, () => ({
        stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`,
        result: "FILLED",
        errorCode: null
      }))
    }),
    service.recoverExpiredFillAttempt({ ...recoveryInput(), steps: [] }),
    service.recoverExpiredFillAttempt({ ...recoveryInput(), expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 })
  ]) {
    await assert.rejects(request, (error) => assertFillError(error, "FILL_INTERNAL", 500));
  }
  assert.equal(state.transactionOptions.length, 0);
});

test("FINALIZE rejects malformed, duplicate, and foreign attempt step keys before a transaction", async () => {
  const canonical = {
    stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`,
    result: "FILLED",
    errorCode: null
  };
  const cases = [
    {
      label: "malformed shape",
      steps: [{ ...canonical, stepKey: "arbitrary-client-step-key" }]
    },
    {
      label: "malformed canonical field key",
      steps: [{ ...canonical, stepKey: `fill:${ATTEMPT_ID}:${"A".repeat(64)}` }]
    },
    {
      label: "duplicate keys",
      steps: [canonical, { ...canonical }]
    },
    {
      label: "foreign attempt prefix",
      steps: [{
        ...canonical,
        stepKey: `fill:550e8400-e29b-41d4-a716-446655440001:${FIELD_KEY}`
      }]
    }
  ];

  for (const scenario of cases) {
    const state = createFakeState({
      run: createFillingRun(),
      terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
    });
    await assert.rejects(
      serviceFor(state).finalizeFillAttempt(completedFinalizationInput(scenario.steps)),
      (error) => assertFillError(error, "FILL_INTERNAL", 500),
      scenario.label
    );
    assert.equal(state.transactionOptions.length, 0, scenario.label);
    assert.deepEqual(state.operations, [], scenario.label);
    assert.equal(state.writes.length, 0, scenario.label);
  }
});

test("FINALIZE rejects invalid completed step semantics before a transaction", async () => {
  const state = createFakeState({
    run: createFillingRun(),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });

  await assert.rejects(
    serviceFor(state).finalizeFillAttempt(completedFinalizationInput([{
      stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`,
      result: "FILLED",
      errorCode: "FILL_INTERNAL"
    }])),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.transactionOptions.length, 0);
  assert.deepEqual(state.operations, []);
  assert.equal(state.writes.length, 0);
  assert.equal(state.audits.length, 0);
});

test("FINALIZE rejects a mismatched stopped error before a transaction", async () => {
  const state = createFakeState({
    run: createFillingRun(),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });

  await assert.rejects(
    serviceFor(state).finalizeFillAttempt(completedFinalizationInput([{
      stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`,
      result: "FAILED",
      errorCode: "FILL_WRITE_FAILED"
    }], { outcome: "STOPPED_EARLY", errorCode: "FILL_INTERNAL" })),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.transactionOptions.length, 0);
  assert.deepEqual(state.operations, []);
  assert.equal(state.writes.length, 0);
  assert.equal(state.audits.length, 0);
});

test("FINALIZE rejects success after a stopped tail before a transaction", async () => {
  const state = createFakeState({
    run: createFillingRun(),
    terminalSteps: [
      createAttemptStep(FIELD_KEY, 0),
      createAttemptStep(SECOND_FIELD_KEY, 1),
      createAttemptStep(THIRD_FIELD_KEY, 2)
    ]
  });

  await assert.rejects(
    serviceFor(state).finalizeFillAttempt(completedFinalizationInput([
      { stepKey: `fill:${ATTEMPT_ID}:${FIELD_KEY}`, result: "FILLED", errorCode: null },
      { stepKey: `fill:${ATTEMPT_ID}:${SECOND_FIELD_KEY}`, result: "FAILED", errorCode: "FILL_INTERNAL" },
      { stepKey: `fill:${ATTEMPT_ID}:${THIRD_FIELD_KEY}`, result: "FILLED", errorCode: null }
    ], { outcome: "STOPPED_EARLY", errorCode: "FILL_INTERNAL" })),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.transactionOptions.length, 0);
  assert.deepEqual(state.operations, []);
  assert.equal(state.writes.length, 0);
  assert.equal(state.audits.length, 0);
});

test("RECOVER equality success preserves safe prefix and conservatively fails unresolved tail", async () => {
  const completedAt = new Date(DB_NOW.getTime() - 200);
  const startedAt = new Date(DB_NOW.getTime() - 100);
  const steps = [
    createAttemptStep(FIELD_KEY, 0, {
      status: "SUCCEEDED", redactedValueSummary: "FILLED", completedAt
    }),
    createAttemptStep(SECOND_FIELD_KEY, 1, {
      status: "SKIPPED", redactedValueSummary: "PRESERVED_EXISTING", completedAt
    }),
    createAttemptStep(THIRD_FIELD_KEY, 2, {
      status: "SKIPPED", redactedValueSummary: "MANUAL", completedAt
    }),
    createAttemptStep("c".repeat(64), 3, { status: "RUNNING", startedAt }),
    createAttemptStep("d".repeat(64), 4)
  ];
  const state = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: steps,
    policyReadThrows: true
  });
  const result = await serviceFor(state, {
    env: { APPLICATION_AUTOMATION_ENABLED: "false" },
    assertTransition: (from: string, to: string) => {
      state.operations.push("transition");
      assert.deepEqual([from, to], ["FILLING", "READY_FOR_USER_SUBMISSION"]);
    }
  }).recoverExpiredFillAttempt(recoveryInput());

  assert.deepEqual(state.operations, [
    "lock-run", "read-run", "clock", "lock-steps", "transition",
    "write-step", "write-step", "write-run", "write-audit"
  ]);
  assert.deepEqual(result, {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "RECOVERED_AFTER_LOSS",
    errorCode: "FILL_STALE",
    steps: [
      { stepKey: steps[0].stepKey, result: "FILLED", errorCode: null },
      { stepKey: steps[1].stepKey, result: "PRESERVED_EXISTING", errorCode: null },
      { stepKey: steps[2].stepKey, result: "MANUAL", errorCode: null },
      { stepKey: steps[3].stepKey, result: "FAILED", errorCode: "FILL_STALE" },
      { stepKey: steps[4].stepKey, result: "FAILED", errorCode: "FILL_STALE" }
    ]
  });
  assert.equal(state.terminalSteps[0].completedAt, completedAt);
  assert.equal(state.terminalSteps[1].completedAt, completedAt);
  assert.equal(state.terminalSteps[2].completedAt, completedAt);
  assert.equal(state.terminalSteps[3].startedAt, startedAt);
  assert.equal(state.terminalSteps[3].completedAt, DB_NOW);
  assert.equal(state.terminalSteps[4].startedAt, null);
  assert.equal(state.run.fillAttemptId, ATTEMPT_ID);
  assert.equal(state.run.errorCategory, "FILL_STALE");
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "application-run-fill-attempt.recover");
  assert.deepEqual(Object.keys(state.audits[0].metadata as object).sort(), [
    "errorCode", "fillAttemptId", "nextStateVersion", "preservedSafeCount",
    "previousStateVersion", "recoveredAt", "recoveredFailedCount", "runId"
  ]);
  assert.equal(state.operations.includes("read-policy"), false);
  assert.equal(JSON.stringify({ result, audit: state.audits[0] }).includes("secret"), false);
  const recoveryStepWrites = state.writes.filter((write) => write.model === "applicationRunStep");
  assert.deepEqual(recoveryStepWrites.map((write) => write.args), [
    {
      where: {
        runId: RUN_ID,
        userId: USER_ID,
        stepKey: steps[3].stepKey,
        sequence: 3,
        action: "FILL_FIELD",
        attemptNumber: 1,
        semanticFieldKey: null,
        adapter: null,
        artifactReference: null,
        status: "RUNNING",
        redactedValueSummary: null,
        errorCategory: null,
        startedAt,
        completedAt: null
      },
      data: {
        status: "FAILED",
        redactedValueSummary: "FAILED",
        errorCategory: "FILL_STALE",
        completedAt: DB_NOW
      }
    },
    {
      where: {
        runId: RUN_ID,
        userId: USER_ID,
        stepKey: steps[4].stepKey,
        sequence: 4,
        action: "FILL_FIELD",
        attemptNumber: 1,
        semanticFieldKey: null,
        adapter: null,
        artifactReference: null,
        status: "PENDING",
        redactedValueSummary: null,
        errorCategory: null,
        startedAt: null,
        completedAt: null
      },
      data: {
        status: "FAILED",
        redactedValueSummary: "FAILED",
        errorCategory: "FILL_STALE",
        completedAt: DB_NOW
      }
    }
  ]);
  const recoveryRunWrite = state.writes.find((write) => write.model === "applicationRun");
  assert.deepEqual(recoveryRunWrite?.args, {
    where: {
      id: RUN_ID,
      userId: USER_ID,
      state: "FILLING",
      stateVersion: 7,
      fillAttemptId: ATTEMPT_ID,
      fillLeaseExpiresAt: DB_NOW
    },
    data: {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: { increment: 1 },
      fillLeaseExpiresAt: null,
      errorCategory: "FILL_STALE"
    }
  });
  assert.equal(Object.hasOwn((recoveryRunWrite?.args as { data: object }).data, "fillAttemptId"), false);
});

test("RECOVER rejects a live lease at one millisecond and accepts equality", async () => {
  const live = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: new Date(DB_NOW.getTime() + 1) }),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });
  await assert.rejects(
    serviceFor(live).recoverExpiredFillAttempt(recoveryInput()),
    (error) => assertFillError(error, "FILL_ALREADY_IN_PROGRESS", 409)
  );
  assert.equal(live.writes.length, 0);

  const equal = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });
  assert.equal((await serviceFor(equal).recoverExpiredFillAttempt(recoveryInput())).outcome, "RECOVERED_AFTER_LOSS");
});

test("RECOVER enforces state, attempt, version, lease, and exact persisted step identity fences", async () => {
  const fenceCases = [
    { label: "wrong state", run: createFillingRun({ state: "READY_FOR_USER_SUBMISSION", fillLeaseExpiresAt: null }), code: "FILL_STALE" },
    { label: "wrong attempt", run: createFillingRun({ fillAttemptId: "550e8400-e29b-41d4-a716-446655440001", fillLeaseExpiresAt: DB_NOW }), code: "FILL_STALE" },
    { label: "stale version", run: createFillingRun({ stateVersion: 8, fillLeaseExpiresAt: DB_NOW }), code: "FILL_STALE" },
    { label: "null attempt", run: createFillingRun({ fillAttemptId: null, fillLeaseExpiresAt: DB_NOW }), code: "FILL_INTERNAL" },
    { label: "invalid attempt", run: createFillingRun({ fillAttemptId: "corrupt", fillLeaseExpiresAt: DB_NOW }), code: "FILL_INTERNAL" },
    { label: "missing lease", run: createFillingRun({ fillLeaseExpiresAt: null }), code: "FILL_INTERNAL" },
    { label: "invalid lease", run: createFillingRun({ fillLeaseExpiresAt: new Date(Number.NaN) }), code: "FILL_INTERNAL" }
  ];
  for (const scenario of fenceCases) {
    const state = createFakeState({ run: scenario.run, terminalSteps: [createAttemptStep(FIELD_KEY, 0)] });
    await assert.rejects(
      serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
      (error) => assertFillError(error, scenario.code),
      scenario.label
    );
    assert.equal(state.writes.length, 0, scenario.label);
  }

  for (const step of [
    createAttemptStep(FIELD_KEY, 1),
    createAttemptStep(FIELD_KEY, 0, { action: "PREPARE" }),
    createAttemptStep(FIELD_KEY, 0, { stepKey: `fill:550e8400-e29b-41d4-a716-446655440001:${FIELD_KEY}` }),
    createAttemptStep(FIELD_KEY, 0, { semanticFieldKey: "private.field" })
  ]) {
    const state = createFakeState({
      run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
      terminalSteps: [step]
    });
    await assert.rejects(
      serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
      (error) => assertFillError(error, "FILL_INTERNAL")
    );
    assert.equal(state.writes.length, 0);
  }
});

test("RECOVER rejects contradictory persistence and terminal-only projections", async () => {
  const safe = createAttemptStep(FIELD_KEY, 0, {
    status: "SUCCEEDED", redactedValueSummary: "FILLED", completedAt: new Date(DB_NOW.getTime() - 10)
  });
  const contradictoryCases = [
    [createAttemptStep(FIELD_KEY, 0, { status: "FAILED", redactedValueSummary: "FAILED", errorCategory: "FILL_WRITE_FAILED", completedAt: DB_NOW })],
    [createAttemptStep(FIELD_KEY, 0, { status: "SKIPPED", redactedValueSummary: "NOT_ATTEMPTED", completedAt: DB_NOW })],
    [createAttemptStep(FIELD_KEY, 0, { completedAt: DB_NOW })],
    [createAttemptStep(FIELD_KEY, 0), createAttemptStep(SECOND_FIELD_KEY, 1, { status: "SUCCEEDED", redactedValueSummary: "FILLED", completedAt: DB_NOW })],
    [{ ...safe }]
  ];
  for (const terminalSteps of contradictoryCases) {
    const state = createFakeState({
      run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
      terminalSteps
    });
    await assert.rejects(
      serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
      (error) => assertFillError(error, "FILL_INTERNAL")
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.audits.length, 0);
  }
});

test("RECOVER rejects PENDING persistence with a startedAt timestamp without mutation", async () => {
  const startedAt = new Date(DB_NOW.getTime() - 100);
  const step = createAttemptStep(FIELD_KEY, 0, { startedAt });
  const state = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: [step]
  });

  await assert.rejects(
    serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.run.state, "FILLING");
  assert.equal(state.run.stateVersion, 7);
  assert.equal(state.run.fillAttemptId, ATTEMPT_ID);
  assert.equal(state.run.fillLeaseExpiresAt, DB_NOW);
  assert.equal(state.terminalSteps[0].status, "PENDING");
  assert.equal(state.terminalSteps[0].startedAt, startedAt);
  assert.equal(state.writes.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.writes.some((write) => write.model === "applicationEvent"), false);
});

test("RECOVER rejects RUNNING persistence without startedAt without mutation", async () => {
  const step = createAttemptStep(FIELD_KEY, 0, { status: "RUNNING" });
  const state = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: [step]
  });

  await assert.rejects(
    serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
    (error) => assertFillError(error, "FILL_INTERNAL", 500)
  );
  assert.equal(state.run.state, "FILLING");
  assert.equal(state.run.stateVersion, 7);
  assert.equal(state.run.fillAttemptId, ATTEMPT_ID);
  assert.equal(state.run.fillLeaseExpiresAt, DB_NOW);
  assert.equal(state.terminalSteps[0].status, "RUNNING");
  assert.equal(state.terminalSteps[0].startedAt, null);
  assert.equal(state.writes.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.writes.some((write) => write.model === "applicationEvent"), false);
});

test("RECOVER transition denial and guarded mutation loss roll back without audit", async () => {
  const denied = createFakeState({
    run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
    terminalSteps: [createAttemptStep(FIELD_KEY, 0)]
  });
  await assert.rejects(
    serviceFor(denied, { assertTransition: () => { throw new Error("denied"); } })
      .recoverExpiredFillAttempt(recoveryInput()),
    (error) => assertFillError(error, "FILL_INTERNAL")
  );
  assert.equal(denied.writes.length, 0);
  assert.equal(denied.audits.length, 0);

  for (const options of [{ stepUpdateCounts: [0] }, { runUpdateCount: 0 }]) {
    const state = createFakeState({
      run: createFillingRun({ fillLeaseExpiresAt: DB_NOW }),
      terminalSteps: [createAttemptStep(FIELD_KEY, 0)],
      ...options
    });
    await assert.rejects(
      serviceFor(state).recoverExpiredFillAttempt(recoveryInput()),
      (error) => assertFillError(error, "FILL_INTERNAL")
    );
    assert.equal(state.run.state, "FILLING");
    assert.equal(state.terminalSteps[0].status, "PENDING");
    assert.equal(state.audits.length, 0);
  }
});
