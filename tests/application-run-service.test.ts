import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { ApplicationRunAnswerStatus, ApplicationRunState } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { computeApplicationAnswerProposalHash } from "@/lib/application-runs/answer-packet-domain";
import type { VerifiedCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import type {
  ApplicationRunDto,
  AutomationPolicyValues
} from "@/lib/application-runs/contracts";
import {
  APPLICATION_AUTOMATION_POLICY_VALUE_KEYS,
  changedAutomationPolicyFields,
  createApplicationRunService,
  type ApplicationRunServiceDependencies,
  type ApplicationRunServicePrismaClient
} from "@/lib/application-runs/service";
import { AUTOMATION_POLICY_DEFAULTS } from "@/lib/application-runs/policy";

const NOW = new Date("2026-08-20T18:00:00.000Z");
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const OTHER_APPLICATION_ID = "clz8w7m9a0001qwer1234tyui";
const JOB_ID = "clz8w7m9a0002qwer1234tyui";
const OTHER_JOB_ID = "clz8w7m9a0003qwer1234tyui";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const ANSWER_ID = "clz8w7m9a0005qwer1234tyui";
const PACKET_ID = "clz8w7m9a0006qwer1234tyui";
const NORMALIZED_FIELD_KEY = "b".repeat(64);
const FIELD_FINGERPRINT = "c".repeat(64);
const PACKET_HASH = "d".repeat(64);

type FakePolicy = AutomationPolicyValues & {
  id: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
};

type FakeApplication = {
  id: string;
  userId: string;
  jobPostingId: string;
  jobPosting: {
    id: string;
    userId: string;
    applyUrl: string | null;
    sourceUrl: string;
  };
};

type FakeRun = ApplicationRunDto & {
  userId: string;
  idempotencyKey: string;
  activeRunKey: string | null;
  applyUrlSnapshot: string;
  prepareAttemptId: string | null;
  fillAttemptId: string | null;
  fillLeaseExpiresAt: Date | null;
  policySnapshot: unknown;
  applicationPlanSnapshot: unknown;
  firstPreparingAt: Date | null;
  currentFormInspectionVersion: number;
  currentAnswerPacketVersion: number;
  resumeVersionId: string | null;
  resumeContentHash: string | null;
  coverLetterVersionId: string | null;
  coverLetterContentHash: string | null;
};

type FakeAnswer = {
  id: string;
  runId: string;
  userId: string;
  answerPacketId: string | null;
  normalizedFieldKey: string;
  fieldFingerprint: string | null;
  semanticFieldKey: string | null;
  fieldType: "TEXT" | "CHECKBOX_BOOLEAN";
  classification: "AVAILABILITY";
  disposition: "PROPOSABLE" | "MANUAL_ONLY";
  proposedValue: string | null;
  proposal: unknown;
  valueRedacted: boolean;
  sensitive: boolean;
  status: ApplicationRunAnswerStatus;
  reviewedByUser: boolean;
  reviewedAt: Date | null;
  finalValueHash: string | null;
  reviewHashVersion: "LEGACY_SCALAR_SHA256" | "CANONICAL_PROPOSAL_V1" | null;
};

type FakePacket = {
  id: string;
  runId: string;
  userId: string;
  version: number;
  formInspectionId: string;
  packetHash: string;
  reviewedAt: Date | null;
  createdAt: Date;
};

type FakeToken = {
  id: string;
  userId: string;
  runId: string;
  tokenHash: string;
  singleUse: boolean;
  consumedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

type FakeAudit = {
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
};

function clonePolicyValues(): AutomationPolicyValues {
  return {
    enabled: AUTOMATION_POLICY_DEFAULTS.enabled,
    mode: AUTOMATION_POLICY_DEFAULTS.mode,
    minimumFitScore: AUTOMATION_POLICY_DEFAULTS.minimumFitScore,
    minimumConfidenceScore: AUTOMATION_POLICY_DEFAULTS.minimumConfidenceScore,
    dailyApplicationCap: AUTOMATION_POLICY_DEFAULTS.dailyApplicationCap,
    allowedHosts: [],
    blockedHosts: [],
    permittedAdapters: [],
    coverLetterRequired: AUTOMATION_POLICY_DEFAULTS.coverLetterRequired,
    sensitiveAnswerPolicy: AUTOMATION_POLICY_DEFAULTS.sensitiveAnswerPolicy,
    finalReviewRequired: AUTOMATION_POLICY_DEFAULTS.finalReviewRequired
  };
}

function fakePolicy(overrides: Partial<FakePolicy> = {}): FakePolicy {
  return {
    id: "policy-1",
    userId: USER_ID,
    ...clonePolicyValues(),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides
  };
}

function fakeApplication(overrides: Partial<FakeApplication> = {}): FakeApplication {
  return {
    id: APPLICATION_ID,
    userId: USER_ID,
    jobPostingId: JOB_ID,
    jobPosting: {
      id: JOB_ID,
      userId: USER_ID,
      applyUrl: "https://jobs.example.com/apply/123",
      sourceUrl: "https://jobs.example.com/posting/123"
    },
    ...overrides
  };
}

function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    id: RUN_ID,
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "DRAFT",
    stateVersion: 0,
    applyHost: "jobs.example.com",
    detectedAdapter: null,
    prepareLeaseExpiresAt: null,
    reviewReasons: [],
    reviewAcknowledgedAt: null,
    blockingReason: null,
    errorCategory: null,
    preparedAt: null,
    cancelledAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    idempotencyKey: "request-123",
    activeRunKey: APPLICATION_ID,
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    prepareAttemptId: null,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    policySnapshot: null,
    applicationPlanSnapshot: null,
    firstPreparingAt: null,
    currentFormInspectionVersion: 0,
    currentAnswerPacketVersion: 0,
    resumeVersionId: null,
    resumeContentHash: null,
    coverLetterVersionId: null,
    coverLetterContentHash: null,
    ...overrides
  };
}

function fakeAnswer(overrides: Partial<FakeAnswer> = {}): FakeAnswer {
  return {
    id: ANSWER_ID,
    runId: RUN_ID,
    userId: USER_ID,
    answerPacketId: null,
    normalizedFieldKey: NORMALIZED_FIELD_KEY,
    fieldFingerprint: FIELD_FINGERPRINT,
    semanticFieldKey: null,
    fieldType: "TEXT",
    classification: "AVAILABILITY",
    disposition: "PROPOSABLE",
    proposedValue: "A private proposed answer sentinel",
    proposal: null,
    valueRedacted: false,
    sensitive: false,
    status: "PENDING",
    reviewedByUser: false,
    reviewedAt: null,
    finalValueHash: null,
    reviewHashVersion: null,
    ...overrides
  };
}

function fakePacket(overrides: Partial<FakePacket> = {}): FakePacket {
  return {
    id: PACKET_ID,
    runId: RUN_ID,
    userId: USER_ID,
    version: 3,
    formInspectionId: "inspection-1",
    packetHash: PACKET_HASH,
    reviewedAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...overrides
  };
}

function verifiedPacketFor(
  database: FakeApplicationRunDatabase,
  summaryOverrides: Partial<VerifiedCurrentAnswerPacket["summary"]> = {}
): VerifiedCurrentAnswerPacket {
  const packet = database.packets[0] ?? fakePacket();
  const answer = database.answers.find((candidate) => candidate.answerPacketId === packet.id);
  return {
    packetRecord: packet,
    answerRows: answer ? [answer] : [],
    fieldsByKey: new Map([[NORMALIZED_FIELD_KEY, {
      normalizedFieldKey: NORMALIZED_FIELD_KEY,
      fieldFingerprint: FIELD_FINGERPRINT,
      fieldType: "TEXT",
      semanticFieldKey: null,
      choices: []
    }]]),
    summary: {
      fieldCount: 1,
      proposableCount: 1,
      pendingReviewCount: 0,
      approvedCount: 1,
      rejectedCount: 0,
      manualOnlyCount: 0,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 0,
      readyForRunResolution: true,
      ...summaryOverrides
    }
  } as unknown as VerifiedCurrentAnswerPacket;
}

function fakeToken(overrides: Partial<FakeToken> = {}): FakeToken {
  return {
    id: "token-1",
    userId: USER_ID,
    runId: RUN_ID,
    tokenHash: "not-a-real-secret-hash",
    singleUse: false,
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    ...overrides
  };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

function nested(value: unknown, key: string): Record<string, unknown> {
  return object(object(value)[key]);
}

function tokenMatches(token: FakeToken, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!(expected as Record<string, unknown>[]).some((clause) => tokenMatches(token, clause))) return false;
      continue;
    }
    if (key === "expiresAt") {
      const gt = object(expected).gt;
      if (gt instanceof Date && token.expiresAt.getTime() <= gt.getTime()) return false;
      continue;
    }
    if (token[key as keyof FakeToken] !== expected) return false;
  }
  return true;
}

type FakeApplicationRunDatabaseState = {
  policy: FakePolicy | null;
  applications: FakeApplication[];
  runs: FakeRun[];
  tokens: FakeToken[];
  answers: FakeAnswer[];
  packets: FakePacket[];
  audits: FakeAudit[];
  events: Array<Record<string, unknown>>;
  runCounter: number;
};

class FakeApplicationRunDatabase {
  policy: FakePolicy | null = null;
  applications: FakeApplication[] = [fakeApplication()];
  runs: FakeRun[] = [];
  tokens: FakeToken[] = [];
  answers: FakeAnswer[] = [];
  packets: FakePacket[] = [];
  audits: FakeAudit[] = [];
  events: Array<Record<string, unknown>> = [];
  operations: string[] = [];
  failAudit = false;
  failEvent = false;
  failTokenUpdate = false;
  failPacketUpdate = false;
  failRunUpdate = false;
  onEventCreate: (() => void) | null = null;
  verifiedPacket: VerifiedCurrentAnswerPacket | null = null;
  verificationError: Error | null = null;
  raceRun: FakeRun | null = null;
  createConflictRun: FakeRun | null = null;
  private runCounter = 0;
  private readonly transactionStates = new WeakMap<object, FakeApplicationRunDatabaseState>();

  readonly client = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => this.transaction(callback),
    applicationAutomationPolicy: {
      findUnique: async (args: unknown) => this.findPolicy(args, "policy.findUnique")
    },
    application: {
      findFirst: async (args: unknown) => this.findApplication(args)
    },
    applicationRun: {
      findUnique: async (args: unknown) => this.findRunUnique(args),
      findFirst: async (args: unknown) => this.findRunFirst(args)
    },
    applicationRunAnswer: {
      findFirst: async (args: unknown) => this.findAnswerFirst(args)
    },
    applicationRunAnswerPacket: {
      findUnique: async (args: unknown) => this.findPacketUnique(args)
    }
  } as unknown as ApplicationRunServicePrismaClient;

  private committedState(): FakeApplicationRunDatabaseState {
    return {
      policy: this.policy,
      applications: this.applications,
      runs: this.runs,
      tokens: this.tokens,
      answers: this.answers,
      packets: this.packets,
      audits: this.audits,
      events: this.events,
      runCounter: this.runCounter
    };
  }

  private publishCommittedState(state: FakeApplicationRunDatabaseState) {
    this.policy = state.policy;
    this.applications = state.applications;
    this.runs = state.runs;
    this.tokens = state.tokens;
    this.answers = state.answers;
    this.packets = state.packets;
    this.audits = state.audits;
    this.events = state.events;
    this.runCounter = state.runCounter;
  }

  private findPolicy(
    args: unknown,
    operation: string,
    state: FakeApplicationRunDatabaseState = this.committedState()
  ) {
    this.operations.push(operation);
    const userId = nested(args, "where").userId;
    return state.policy?.userId === userId ? structuredClone(state.policy) : null;
  }

  private findApplication(args: unknown, state: FakeApplicationRunDatabaseState = this.committedState()) {
    this.operations.push("application.findFirst");
    const where = nested(args, "where");
    const found = state.applications.find(
      (application) => application.id === where.id && application.userId === where.userId
    );
    return found ? structuredClone(found) : null;
  }

  private visibleRuns(state: FakeApplicationRunDatabaseState = this.committedState()) {
    return this.raceRun ? [...state.runs, this.raceRun] : state.runs;
  }

  private findRunUnique(args: unknown, state: FakeApplicationRunDatabaseState = this.committedState()) {
    this.operations.push("run.findUnique");
    const where = nested(args, "where");
    const composite = where.userId_idempotencyKey as Record<string, unknown> | undefined;
    const found = composite
      ? this.visibleRuns(state).find(
          (run) => run.userId === composite.userId && run.idempotencyKey === composite.idempotencyKey
        )
      : this.visibleRuns(state).find((run) => run.activeRunKey === where.activeRunKey);
    return found ? structuredClone(found) : null;
  }

  private findRunFirst(args: unknown, state: FakeApplicationRunDatabaseState = this.committedState()) {
    this.operations.push("run.findFirst");
    const where = nested(args, "where");
    const found = this.visibleRuns(state).find((run) => run.id === where.id && run.userId === where.userId);
    if (!found) return null;
    const application = state.applications.find((candidate) => candidate.id === found.applicationId);
    return structuredClone({
      ...found,
      application: application
        ? { id: application.id, userId: application.userId, jobPostingId: application.jobPostingId }
        : { id: found.applicationId, userId: found.userId, jobPostingId: found.jobPostingId },
      jobPosting: application
        ? { id: application.jobPosting.id, userId: application.jobPosting.userId }
        : { id: found.jobPostingId, userId: found.userId }
    });
  }

  private findAnswerFirst(args: unknown, state: FakeApplicationRunDatabaseState = this.committedState()) {
    this.operations.push("answer.findFirst");
    const where = nested(args, "where");
    const found = state.answers.find(
      (answer) =>
        answer.id === where.id &&
        answer.runId === where.runId &&
        answer.userId === where.userId &&
        (where.answerPacketId === undefined || answer.answerPacketId === where.answerPacketId)
    );
    return found ? structuredClone(found) : null;
  }

  private findPacketUnique(args: unknown, state: FakeApplicationRunDatabaseState = this.committedState()) {
    this.operations.push("packet.findUnique");
    const where = nested(args, "where");
    const binding = object(where.runId_version);
    const found = state.packets.find(
      (packet) => packet.runId === binding.runId && packet.version === binding.version
    );
    return found ? structuredClone(found) : null;
  }

  async loadVerifiedCurrentPacket(tx: unknown): Promise<VerifiedCurrentAnswerPacket | null> {
    this.operations.push("packet.verify");
    if (this.verificationError) throw this.verificationError;
    const state = typeof tx === "object" && tx !== null
      ? this.transactionStates.get(tx)
      : undefined;
    assert.ok(state, "packet verifier must use the active transaction working state");
    if (!this.verifiedPacket) return null;
    const packetRecord = state.packets.find(
      (packet) => packet.id === this.verifiedPacket?.packetRecord.id
    );
    if (!packetRecord) return null;
    return {
      ...this.verifiedPacket,
      packetRecord: structuredClone(packetRecord) as VerifiedCurrentAnswerPacket["packetRecord"],
      answerRows: structuredClone(
        state.answers.filter((answer) => answer.answerPacketId === packetRecord.id)
      ) as unknown as VerifiedCurrentAnswerPacket["answerRows"]
    };
  }

  private transactionClient(state: FakeApplicationRunDatabaseState) {
    return {
      $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
        const query = strings.join("?");
        if (query.includes("CURRENT_TIMESTAMP")) {
          this.operations.push("database.now");
          return [{ now: new Date(NOW) }] as T;
        }
        if (query.includes('FROM "User"')) {
          assert.equal(
            query.replace(/\s+/g, " ").trim(),
            'SELECT "id" FROM "User" WHERE "id" = ? FOR NO KEY UPDATE'
          );
          this.operations.push("user.lock.for-no-key-update");
          return [{ id: values[0] }] as T;
        }
        if (query.includes('FROM "ApplicationRunAnswer"')) {
          this.operations.push("answer.lock");
          const answer = state.answers.find(
            (candidate) =>
              candidate.id === values[0] &&
              candidate.runId === values[1] &&
              candidate.userId === values[2] &&
              (values.length < 4 || candidate.answerPacketId === values[3])
          );
          return (answer ? [{ id: answer.id }] : []) as T;
        }
        if (query.includes('FROM "ApplicationRun"')) {
          this.operations.push("run.lock");
          const run = state.runs.find((candidate) => candidate.id === values[0] && candidate.userId === values[1]);
          return (run ? [{ id: run.id }] : []) as T;
        }
        this.operations.push("policy.lock");
        const policy = state.policy;
        if (policy && policy.userId === values[0]) return [{ id: policy.id }] as T;
        return [] as T;
      },
      applicationAutomationPolicy: {
        findUnique: async (args: unknown) => this.findPolicy(args, "policy.findUnique.tx", state),
        create: async (args: unknown) => {
          this.operations.push("policy.create");
          assert.equal(state.policy, null);
          const data = nested(args, "data");
          state.policy = fakePolicy({ ...data, id: "policy-created" } as Partial<FakePolicy>);
          return { id: state.policy.id };
        },
        update: async (args: unknown) => {
          this.operations.push("policy.update");
          assert.ok(state.policy);
          const data = nested(args, "data");
          state.policy = {
            ...state.policy,
            ...structuredClone(data),
            updatedAt: new Date(NOW)
          };
          return structuredClone(state.policy);
        }
      },
      applicationRun: {
        findFirst: async (args: unknown) => this.findRunFirst(args, state),
        updateMany: async (args: unknown) => {
          this.operations.push("run.updateMany");
          if (this.failRunUpdate) return { count: 0 };
          const where = nested(args, "where");
          const data = nested(args, "data");
          const matches = state.runs.filter((run) =>
            Object.entries(where).every(([key, expected]) => run[key as keyof FakeRun] === expected)
          );
          for (const run of matches) {
            for (const [key, value] of Object.entries(data)) {
              if (key === "stateVersion") {
                run.stateVersion += Number(object(value).increment);
              } else {
                (run as unknown as Record<string, unknown>)[key] = structuredClone(value);
              }
            }
            run.updatedAt = new Date(NOW);
          }
          return { count: matches.length };
        },
        create: async (args: unknown) => {
          this.operations.push("run.create");
          if (this.createConflictRun) {
            this.raceRun = this.createConflictRun;
            this.createConflictRun = null;
            throw { code: "P2002" };
          }
          const data = nested(args, "data");
          const created = fakeRun({
            id: state.runCounter++ === 0 ? RUN_ID : `clz8w7m9a000${state.runCounter + 4}qwer1234tyui`,
            userId: data.userId as string,
            applicationId: data.applicationId as string,
            jobPostingId: data.jobPostingId as string,
            state: data.state as ApplicationRunState,
            idempotencyKey: data.idempotencyKey as string,
            activeRunKey: data.activeRunKey as string,
            applyUrlSnapshot: data.applyUrlSnapshot as string,
            applyHost: data.applyHost as string
          });
          state.runs.push(created);
          return structuredClone(created);
        }
      },
      applicationRunAnswer: {
        findFirst: async (args: unknown) => this.findAnswerFirst(args, state),
        updateMany: async (args: unknown) => {
          this.operations.push("answer.updateMany");
          const where = nested(args, "where");
          const data = nested(args, "data");
          const matches = state.answers.filter((answer) =>
            Object.entries(where).every(([key, expected]) => answer[key as keyof FakeAnswer] === expected)
          );
          for (const answer of matches) Object.assign(answer, structuredClone(data));
          return { count: matches.length };
        }
      },
      applicationRunAnswerPacket: {
        findUnique: async (args: unknown) => this.findPacketUnique(args, state),
        updateMany: async (args: unknown) => {
          this.operations.push("packet.updateMany");
          if (this.failPacketUpdate) return { count: 0 };
          const where = nested(args, "where");
          const data = nested(args, "data");
          const matches = state.packets.filter((packet) =>
            Object.entries(where).every(([key, expected]) => packet[key as keyof FakePacket] === expected)
          );
          for (const packet of matches) Object.assign(packet, structuredClone(data));
          return { count: matches.length };
        }
      },
      applicationExecutionToken: {
        updateMany: async (args: unknown) => {
          this.operations.push("token.updateMany");
          if (this.failTokenUpdate) throw new Error("simulated token update failure");
          const where = nested(args, "where");
          const data = nested(args, "data");
          const matches = state.tokens.filter((token) => tokenMatches(token, where));
          for (const token of matches) Object.assign(token, data);
          return { count: matches.length };
        }
      },
      applicationEvent: {
        create: async (args: unknown) => {
          this.operations.push("event.create");
          this.onEventCreate?.();
          if (this.failEvent) throw new Error("simulated event failure");
          const data = nested(args, "data");
          state.events.push(structuredClone(data));
          return structuredClone(data);
        }
      },
      auditLog: {
        create: async (args: unknown) => {
          this.operations.push("audit.create");
          if (this.failAudit) throw new Error("simulated audit failure");
          const data = nested(args, "data") as unknown as FakeAudit;
          state.audits.push(structuredClone(data));
          return structuredClone(data);
        }
      }
    };
  }

  private async transaction(callback: (tx: unknown) => Promise<unknown>) {
    this.operations.push("transaction.begin");
    const workingState = structuredClone(this.committedState());
    const tx = this.transactionClient(workingState);
    this.transactionStates.set(tx, workingState);
    try {
      const result = await callback(tx);
      this.publishCommittedState(workingState);
      this.operations.push("transaction.commit");
      return result;
    } catch (error) {
      this.operations.push("transaction.rollback");
      throw error;
    } finally {
      this.transactionStates.delete(tx);
    }
  }
}

function serviceFor(
  database: FakeApplicationRunDatabase,
  enabled = false,
  overrides: Partial<ApplicationRunServiceDependencies> = {}
) {
  return createApplicationRunService({
    prismaClient: database.client,
    env: enabled ? { APPLICATION_AUTOMATION_ENABLED: "true" } : {},
    clock: () => new Date(NOW),
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async (tx) =>
      database.loadVerifiedCurrentPacket(tx),
    ...overrides
  });
}

function packetReviewDatabase(input: {
  run?: Partial<FakeRun>;
  answer?: Partial<FakeAnswer>;
  packet?: Partial<FakePacket>;
  summary?: Partial<VerifiedCurrentAnswerPacket["summary"]>;
} = {}) {
  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({
    state: "REVIEW_REQUIRED",
    stateVersion: 4,
    currentFormInspectionVersion: 2,
    currentAnswerPacketVersion: 3,
    ...input.run
  }));
  database.packets.push(fakePacket(input.packet));
  database.answers.push(fakeAnswer({
    answerPacketId: PACKET_ID,
    proposedValue: null,
    proposal: { kind: "SCALAR", value: "Persisted packet proposal sentinel" },
    ...input.answer
  }));
  database.verifiedPacket = verifiedPacketFor(database, input.summary);
  return database;
}

function assertPublicError(error: unknown, status: number, code: string) {
  return error instanceof PublicApiError && error.status === status && error.details?.code === code;
}

test("policy GET returns exact virtual defaults without any write, audit, lock, or token mutation", async () => {
  const database = new FakeApplicationRunDatabase();
  database.tokens.push(fakeToken());

  const result = await serviceFor(database, true).readAutomationPolicy(USER_ID);

  assert.deepEqual(result, {
    ...AUTOMATION_POLICY_DEFAULTS,
    persisted: false,
    effectiveEnabled: false
  });
  assert.deepEqual(database.operations, ["policy.findUnique"]);
  assert.equal(database.audits.length, 0);
  assert.equal(database.tokens[0].revokedAt, null);
});

test("policy GET reports persistence and requires both stored and global gates", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy({ enabled: true, allowedHosts: ["jobs.example.com"] });

  const disabled = await serviceFor(database, false).readAutomationPolicy(USER_ID);
  const enabled = await serviceFor(database, true).readAutomationPolicy(USER_ID);

  assert.equal(disabled.persisted, true);
  assert.equal(disabled.effectiveEnabled, false);
  assert.equal(enabled.effectiveEnabled, true);
  assert.deepEqual(enabled.allowedHosts, ["jobs.example.com"]);
});

test("strict empty policy PATCH is a true read-only no-op for missing and persisted rows", async () => {
  const missing = new FakeApplicationRunDatabase();
  const missingResult = await serviceFor(missing).updateAutomationPolicy(USER_ID, {});
  assert.equal(missingResult.changed, false);
  assert.equal(missing.policy, null);
  assert.deepEqual(missing.operations, ["policy.findUnique"]);

  const persisted = new FakeApplicationRunDatabase();
  persisted.policy = fakePolicy();
  const originalUpdatedAt = persisted.policy.updatedAt.getTime();
  persisted.tokens.push(fakeToken());
  const result = await serviceFor(persisted).updateAutomationPolicy(USER_ID, {});
  assert.equal(result.changed, false);
  assert.equal(persisted.policy.updatedAt.getTime(), originalUpdatedAt);
  assert.equal(persisted.tokens[0].revokedAt, null);
  assert.equal(persisted.audits.length, 0);
  assert.deepEqual(persisted.operations, ["policy.findUnique"]);
});

test("identical nonempty policy PATCH does not update, revoke, or audit", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy({ minimumFitScore: 90 });
  database.tokens.push(fakeToken());

  const result = await serviceFor(database).updateAutomationPolicy(USER_ID, { minimumFitScore: 90 });

  assert.equal(result.changed, false);
  assert.equal(result.revokedExecutionTokenCount, 0);
  assert.equal(database.operations.includes("policy.update"), false);
  assert.equal(database.operations.includes("token.updateMany"), false);
  assert.equal(database.operations.includes("policy.create"), false);
  assert.equal(database.audits.length, 0);
});

test("policy PATCH uses User FOR NO KEY UPDATE before the policy row lock", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy();

  await serviceFor(database).updateAutomationPolicy(USER_ID, { enabled: false });

  assert.deepEqual(database.operations, [
    "transaction.begin",
    "user.lock.for-no-key-update",
    "policy.findUnique.tx",
    "policy.lock",
    "policy.findUnique.tx",
    "transaction.commit"
  ]);
});

test("explicit defaults may persist a missing policy without token revocation", async () => {
  const database = new FakeApplicationRunDatabase();
  database.tokens.push(fakeToken());

  const result = await serviceFor(database).updateAutomationPolicy(USER_ID, { enabled: false });

  assert.equal(result.persisted, true);
  assert.equal(result.changed, false);
  assert.deepEqual(database.policy && {
    enabled: database.policy.enabled,
    allowedHosts: database.policy.allowedHosts,
    blockedHosts: database.policy.blockedHosts
  }, { enabled: false, allowedHosts: [], blockedHosts: [] });
  assert.equal(database.tokens[0].revokedAt, null);
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0].action, "application-automation-policy.create");
  assert.ok(
    database.operations.indexOf("user.lock.for-no-key-update") <
      database.operations.indexOf("policy.findUnique.tx")
  );
  assert.ok(database.operations.indexOf("policy.create") < database.operations.indexOf("policy.lock"));
});

test("policy PATCH audit action follows whether this locked transaction inserted the row", async () => {
  const created = new FakeApplicationRunDatabase();
  const createdService = serviceFor(created);
  await createdService.updateAutomationPolicy(USER_ID, { enabled: true });
  assert.equal(
    created.audits.find((audit) => audit.resource === "ApplicationAutomationPolicy")?.action,
    "application-automation-policy.create"
  );
  assert.equal(created.operations.filter((operation) => operation === "policy.create").length, 1);
  await createdService.updateAutomationPolicy(USER_ID, { enabled: true });
  assert.equal(
    created.audits.filter((audit) => audit.action === "application-automation-policy.create").length,
    1
  );

  const updated = new FakeApplicationRunDatabase();
  updated.policy = fakePolicy();
  await serviceFor(updated).updateAutomationPolicy(USER_ID, { enabled: true });
  assert.equal(
    updated.audits.find((audit) => audit.resource === "ApplicationAutomationPolicy")?.action,
    "application-automation-policy.update"
  );
  assert.equal(updated.operations.includes("policy.create"), false);
});

test("every mutable scalar policy field change conservatively revokes usable user tokens", async () => {
  const patches = [
    { enabled: true },
    { minimumFitScore: 86 },
    { minimumConfidenceScore: 86 },
    { dailyApplicationCap: 6 },
    { coverLetterRequired: false }
  ];

  for (const patch of patches) {
    const database = new FakeApplicationRunDatabase();
    database.policy = fakePolicy();
    database.tokens.push(fakeToken());
    const result = await serviceFor(database).updateAutomationPolicy(USER_ID, patch);
    assert.equal(result.changed, true, JSON.stringify(patch));
    assert.equal(result.revokedExecutionTokenCount, 1, JSON.stringify(patch));
    assert.deepEqual(database.tokens[0].revokedAt, NOW, JSON.stringify(patch));
  }
});

test("every array policy field change conservatively revokes usable user tokens", async () => {
  const patches = [
    { allowedHosts: ["Jobs.Example.com."] },
    { blockedHosts: ["blocked.example"] },
    { permittedAdapters: ["greenhouse"] }
  ];

  for (const patch of patches) {
    const database = new FakeApplicationRunDatabase();
    database.policy = fakePolicy();
    database.tokens.push(fakeToken());
    const result = await serviceFor(database).updateAutomationPolicy(USER_ID, patch);
    assert.equal(result.changed, true, JSON.stringify(patch));
    assert.equal(result.revokedExecutionTokenCount, 1, JSON.stringify(patch));
    assert.deepEqual(database.tokens[0].revokedAt, NOW, JSON.stringify(patch));
  }
});

test("policy change comparison includes every persisted configurable field", () => {
  const current = clonePolicyValues();
  assert.deepEqual(APPLICATION_AUTOMATION_POLICY_VALUE_KEYS, Object.keys(current));
  const next = {
    ...clonePolicyValues(),
    enabled: true,
    minimumFitScore: 86,
    minimumConfidenceScore: 86,
    dailyApplicationCap: 6,
    allowedHosts: ["allowed.example"],
    blockedHosts: ["blocked.example"],
    permittedAdapters: ["greenhouse"],
    coverLetterRequired: false
  };
  assert.deepEqual(changedAutomationPolicyFields(current, next), [
    "enabled",
    "minimumFitScore",
    "minimumConfidenceScore",
    "dailyApplicationCap",
    "allowedHosts",
    "blockedHosts",
    "permittedAdapters",
    "coverLetterRequired"
  ]);
  assert.deepEqual(changedAutomationPolicyFields(current, clonePolicyValues()), []);
});

test("policy revocation excludes expired, revoked, consumed single-use, other-user, and other valid states", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy();
  database.tokens.push(
    fakeToken({ id: "reusable-live" }),
    fakeToken({ id: "single-live", singleUse: true }),
    fakeToken({ id: "expired", expiresAt: new Date(NOW) }),
    fakeToken({ id: "revoked", revokedAt: new Date(NOW.getTime() - 1) }),
    fakeToken({ id: "single-consumed", singleUse: true, consumedAt: new Date(NOW.getTime() - 1) }),
    fakeToken({ id: "other-user", userId: OTHER_USER_ID })
  );

  const result = await serviceFor(database).updateAutomationPolicy(USER_ID, { enabled: true });

  assert.equal(result.revokedExecutionTokenCount, 2);
  assert.deepEqual(
    database.tokens.filter((token) => token.revokedAt?.getTime() === NOW.getTime()).map((token) => token.id),
    ["reusable-live", "single-live"]
  );
});

test("policy update, token revocation, and required audits roll back atomically", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy();
  database.tokens.push(fakeToken());
  database.failAudit = true;

  await assert.rejects(
    serviceFor(database).updateAutomationPolicy(USER_ID, { enabled: true }),
    /simulated audit failure/
  );
  assert.equal(database.policy.enabled, false);
  assert.equal(database.tokens[0].revokedAt, null);
  assert.equal(database.audits.length, 0);
  assert.ok(database.operations.includes("transaction.rollback"));
});

test("policy change rolls back when direct token revocation fails", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy();
  database.tokens.push(fakeToken());
  database.failTokenUpdate = true;

  await assert.rejects(
    serviceFor(database).updateAutomationPolicy(USER_ID, { enabled: true }),
    /simulated token update failure/
  );
  assert.equal(database.policy.enabled, false);
  assert.equal(database.tokens[0].revokedAt, null);
  assert.equal(database.audits.length, 0);
  assert.ok(database.operations.includes("transaction.rollback"));
});

test("policy audits contain only explicit safe metadata and no token secret or hash", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy();
  database.tokens.push(fakeToken());

  await serviceFor(database).updateAutomationPolicy(USER_ID, { allowedHosts: ["jobs.example.com"] });

  const serialized = JSON.stringify(database.audits);
  assert.equal(serialized.includes("not-a-real-secret-hash"), false);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.deepEqual(database.audits.at(-1)?.metadata.changedFields, ["allowedHosts"]);
  assert.equal(database.audits.at(-1)?.metadata.enabled, false);
  assert.equal(database.audits.at(-1)?.metadata.revokedExecutionTokenCount, 1);
});

test("DRAFT creation is policy/global-gate independent and does not touch capability fields", async () => {
  for (const policy of [null, fakePolicy({ enabled: false })]) {
    const database = new FakeApplicationRunDatabase();
    database.policy = policy;
    const result = await serviceFor(database, false).createApplicationRun(USER_ID, {
      applicationId: APPLICATION_ID,
      idempotencyKey: "request-123"
    });

    assert.equal(result.replayed, false);
    assert.equal(result.run.state, "DRAFT");
    assert.equal(database.operations.some((operation) => operation.startsWith("policy.")), false);
    assert.equal("firstPreparingAt" in result.run, false);
    assert.equal("dailyApplicationCap" in result.run, false);
    assert.equal(database.operations.some((operation) => /provider|planner|token/i.test(operation)), false);
  }
});

test("DRAFT creation derives owner, job, target URL, host, state, and active key", async () => {
  const database = new FakeApplicationRunDatabase();
  const result = await serviceFor(database).createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });

  const stored = database.runs[0];
  assert.equal(stored.userId, USER_ID);
  assert.equal(stored.jobPostingId, JOB_ID);
  assert.equal(stored.applyUrlSnapshot, "https://jobs.example.com/apply/123");
  assert.equal(stored.applyHost, "jobs.example.com");
  assert.equal(stored.state, "DRAFT");
  assert.equal(stored.activeRunKey, APPLICATION_ID);
  assert.deepEqual(result.run, {
    id: RUN_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "DRAFT",
    stateVersion: 0,
    applyHost: "jobs.example.com",
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    detectedAdapter: null,
    prepareLeaseExpiresAt: null,
    reviewReasons: [],
    reviewAcknowledgedAt: null,
    blockingReason: null,
    errorCategory: null,
    preparedAt: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW
  });
  assert.equal(database.audits.length, 1);
  assert.equal(database.events.length, 1);
});

test("DRAFT creation rejects cross-user applications, cross-user jobs, and relation mismatch non-enumeratingly", async () => {
  const cases = [
    fakeApplication({ userId: OTHER_USER_ID }),
    fakeApplication({ jobPosting: { ...fakeApplication().jobPosting, userId: OTHER_USER_ID } }),
    fakeApplication({ jobPostingId: OTHER_JOB_ID })
  ];

  for (const application of cases) {
    const database = new FakeApplicationRunDatabase();
    database.applications = [application];
    await assert.rejects(
      serviceFor(database).createApplicationRun(USER_ID, {
        applicationId: APPLICATION_ID,
        idempotencyKey: "request-123"
      }),
      (error) => assertPublicError(error, 404, "APPLICATION_NOT_FOUND")
    );
    assert.equal(database.runs.length, 0);
  }
});

test("DRAFT creation rejects malformed, insecure, userinfo, private, and IP targets", async () => {
  const targets = [
    "not-a-url",
    "http://jobs.example.com/apply",
    "https://user:password@jobs.example.com/apply",
    "https://localhost/apply",
    "https://192.168.1.2/apply",
    "https://[::1]/apply",
    "https://intranet/apply",
    "https://printer.local/apply",
    "https://metadata.google.internal/apply",
    "https://printer.home.arpa/apply"
  ];
  for (const target of targets) {
    const database = new FakeApplicationRunDatabase();
    database.applications[0].jobPosting.applyUrl = target;
    await assert.rejects(
      serviceFor(database).createApplicationRun(USER_ID, {
        applicationId: APPLICATION_ID,
        idempotencyKey: "request-123"
      }),
      (error) => assertPublicError(error, 422, "RUN_TARGET_INVALID"),
      target
    );
  }
});

test("DRAFT creation falls back to source URL and allows safe statically restricted targets", async () => {
  const database = new FakeApplicationRunDatabase();
  database.applications[0].jobPosting.applyUrl = null;
  database.applications[0].jobPosting.sourceUrl = "https://jobs.linkedin.com/view/123";

  const result = await serviceFor(database).createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });

  assert.equal(result.run.state, "DRAFT");
  assert.equal(result.run.applyHost, "jobs.linkedin.com");
});

test("run creation replays idempotently without duplicate audit/event", async () => {
  const database = new FakeApplicationRunDatabase();
  const service = serviceFor(database);
  await service.createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });
  const replay = await service.createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });

  assert.equal(replay.replayed, true);
  assert.equal(database.runs.length, 1);
  assert.equal(database.audits.length, 1);
  assert.equal(database.events.length, 1);
});

test("authenticated idempotent replay precedes validation of a now-invalid mutable target", async () => {
  const database = new FakeApplicationRunDatabase();
  const service = serviceFor(database);
  const original = await service.createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });
  database.applications[0].jobPosting.applyUrl = "http://localhost/changed-after-create";

  const replay = await service.createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.run, original.run);
  assert.equal(database.runs.length, 1);
  assert.equal(database.audits.length, 1);
  assert.equal(database.events.length, 1);
});

test("run creation audit failure rolls back the run, event, and audit atomically", async () => {
  const database = new FakeApplicationRunDatabase();
  database.failAudit = true;

  await assert.rejects(
    serviceFor(database).createApplicationRun(USER_ID, {
      applicationId: APPLICATION_ID,
      idempotencyKey: "request-123"
    }),
    /simulated audit failure/
  );

  assert.equal(database.runs.length, 0);
  assert.equal(database.events.length, 0);
  assert.equal(database.audits.length, 0);
  assert.ok(database.operations.includes("transaction.rollback"));
});

test("idempotency-key reuse and active-run collisions are distinct conflicts", async () => {
  const keyReuse = new FakeApplicationRunDatabase();
  keyReuse.runs.push(fakeRun({ applicationId: OTHER_APPLICATION_ID, activeRunKey: OTHER_APPLICATION_ID }));
  await assert.rejects(
    serviceFor(keyReuse).createApplicationRun(USER_ID, {
      applicationId: APPLICATION_ID,
      idempotencyKey: "request-123"
    }),
    (error) => assertPublicError(error, 409, "IDEMPOTENCY_KEY_REUSED")
  );

  const active = new FakeApplicationRunDatabase();
  active.runs.push(fakeRun({ idempotencyKey: "another-key", activeRunKey: APPLICATION_ID }));
  await assert.rejects(
    serviceFor(active).createApplicationRun(USER_ID, {
      applicationId: APPLICATION_ID,
      idempotencyKey: "request-123"
    }),
    (error) => assertPublicError(error, 409, "APPLICATION_RUN_ACTIVE")
  );
});

test("unique-constraint race resolves by authoritative idempotency reread", async () => {
  const database = new FakeApplicationRunDatabase();
  database.createConflictRun = fakeRun();

  const result = await serviceFor(database).createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-123"
  });

  assert.equal(result.replayed, true);
  assert.equal(result.run.id, RUN_ID);
  assert.ok(database.operations.includes("run.create"));
  assert.ok(database.operations.includes("transaction.rollback"));
  assert.equal(database.audits.length, 0);
  assert.equal(database.events.length, 0);
});

test("owned run GET returns only the narrow DTO and wrong/missing users share 404 behavior", async () => {
  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({
    policySnapshot: { enabled: true },
    applicationPlanSnapshot: { secret: "internal" },
    prepareAttemptId: "attempt-internal"
  }));
  const service = serviceFor(database);

  const result = await service.getApplicationRun(USER_ID, RUN_ID);
  assert.deepEqual(Object.keys(result).sort(), [
    "applicationId",
    "applyHost",
    "applyUrlSnapshot",
    "blockingReason",
    "cancelledAt",
    "createdAt",
    "detectedAdapter",
    "errorCategory",
    "id",
    "jobPostingId",
    "prepareLeaseExpiresAt",
    "preparedAt",
    "reviewAcknowledgedAt",
    "reviewReasons",
    "state",
    "stateVersion",
    "updatedAt"
  ]);
  assert.equal(result.applyUrlSnapshot, "https://jobs.example.com/apply/123");
  for (const userId of [OTHER_USER_ID, USER_ID]) {
    const id = userId === USER_ID ? "clz8w7m9a0099qwer1234tyui" : RUN_ID;
    await assert.rejects(
      service.getApplicationRun(userId, id),
      (error) => assertPublicError(error, 404, "RUN_NOT_FOUND")
    );
  }
});

test("owned run GET keeps the canonical frozen target after the posting URL changes", async () => {
  const database = new FakeApplicationRunDatabase();
  database.applications[0].jobPosting.applyUrl =
    "https://JOBS.example.com:443/apply/123?source=posting#frozen-authority";
  const service = serviceFor(database);

  const created = await service.createApplicationRun(USER_ID, {
    applicationId: APPLICATION_ID,
    idempotencyKey: "request-frozen-target"
  });
  database.applications[0].jobPosting.applyUrl = "https://jobs.example.com/apply/replaced";

  const reread = await service.getApplicationRun(USER_ID, created.run.id);
  assert.equal(
    reread.applyUrlSnapshot,
    "https://jobs.example.com/apply/123?source=posting#frozen-authority"
  );
  assert.notEqual(reread.applyUrlSnapshot, database.applications[0].jobPosting.applyUrl);
  await assert.rejects(
    service.getApplicationRun(OTHER_USER_ID, created.run.id),
    (error) => assertPublicError(error, 404, "RUN_NOT_FOUND")
  );
});

test("run GET validates a CUID before constructing a Prisma predicate", async () => {
  const database = new FakeApplicationRunDatabase();
  await assert.rejects(serviceFor(database).getApplicationRun(USER_ID, "not-a-cuid"));
  assert.equal(database.operations.includes("run.findFirst"), false);
});

test("cancellation accepts every state already authorized by the state machine and preserves provenance", async () => {
  const cancellable: ApplicationRunState[] = [
    "DRAFT",
    "PREPARING",
    "READY",
    "REVIEW_REQUIRED",
    "BLOCKED",
    "FAILED",
    "FILLING",
    "READY_FOR_USER_SUBMISSION"
  ];
  for (const state of cancellable) {
    const database = new FakeApplicationRunDatabase();
    const firstPreparingAt = new Date("2026-08-19T12:00:00.000Z");
    const fillAttemptId = ["FILLING", "READY_FOR_USER_SUBMISSION"].includes(state)
      ? "550e8400-e29b-41d4-a716-446655440000"
      : null;
    database.runs.push(fakeRun({
      state,
      stateVersion: 4,
      firstPreparingAt,
      prepareAttemptId: state === "PREPARING" ? "attempt-sensitive" : null,
      prepareLeaseExpiresAt: state === "PREPARING" ? new Date(NOW.getTime() + 60_000) : null,
      fillAttemptId,
      fillLeaseExpiresAt: state === "FILLING" ? new Date(NOW.getTime() + 60_000) : null,
      policySnapshot: { provenance: "preserve" },
      applicationPlanSnapshot: { evidence: "preserve" }
    }));

    const result = await serviceFor(database, false).cancelApplicationRun({ userId: USER_ID, runId: RUN_ID });
    const stored = database.runs[0];
    assert.equal(result.run.state, "CANCELLED", state);
    assert.equal(result.run.stateVersion, 5, state);
    assert.deepEqual(result.run.cancelledAt, NOW, state);
    assert.equal(stored.activeRunKey, null, state);
    assert.equal(stored.prepareAttemptId, null, state);
    assert.equal(stored.prepareLeaseExpiresAt, null, state);
    assert.equal(stored.fillAttemptId, fillAttemptId, state);
    assert.equal(stored.fillLeaseExpiresAt, null, state);
    assert.deepEqual(stored.firstPreparingAt, firstPreparingAt, state);
    assert.deepEqual(stored.policySnapshot, { provenance: "preserve" }, state);
    assert.deepEqual(stored.applicationPlanSnapshot, { evidence: "preserve" }, state);
    assert.equal(database.operations.some((operation) => operation.startsWith("policy.")), false, state);
  }
});

test("cancellation rejects terminal states and is not idempotently repeatable", async () => {
  for (const state of ["COMPLETED_BY_USER", "CANCELLED"] as const) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state }));
    await assert.rejects(
      serviceFor(database).cancelApplicationRun({ userId: USER_ID, runId: RUN_ID }),
      (error) => assertPublicError(error, 409, "RUN_INVALID_STATE"),
      state
    );
    assert.equal(database.runs[0].state, state);
  }
});

test("cancellation validates IDs before Prisma and keeps wrong-owner/missing runs non-enumerating", async () => {
  const malformed = new FakeApplicationRunDatabase();
  await assert.rejects(serviceFor(malformed).cancelApplicationRun({ userId: USER_ID, runId: "not-a-cuid" }));
  assert.equal(malformed.operations.length, 0);

  for (const [userId, runId] of [[OTHER_USER_ID, RUN_ID], [USER_ID, "clz8w7m9a0099qwer1234tyui"]]) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun());
    await assert.rejects(
      serviceFor(database).cancelApplicationRun({ userId, runId }),
      (error) => assertPublicError(error, 404, "RUN_NOT_FOUND")
    );
  }
});

test("cancellation revokes only currently usable run-bound tokens and writes safe atomic records", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy({ enabled: false });
  database.runs.push(fakeRun({ state: "PREPARING", stateVersion: 3, prepareAttemptId: "attempt-private" }));
  database.tokens.push(
    fakeToken({ id: "run-live" }),
    fakeToken({ id: "run-single-live", singleUse: true }),
    fakeToken({ id: "expired", expiresAt: new Date(NOW) }),
    fakeToken({ id: "revoked", revokedAt: new Date(NOW.getTime() - 1) }),
    fakeToken({ id: "consumed", singleUse: true, consumedAt: new Date(NOW.getTime() - 1) }),
    fakeToken({ id: "other-run", runId: "clz8w7m9a0099qwer1234tyui" })
  );

  const result = await serviceFor(database, false).cancelApplicationRun({ userId: USER_ID, runId: RUN_ID });

  assert.equal(result.revokedExecutionTokenCount, 2);
  assert.deepEqual(
    database.tokens.filter((token) => token.revokedAt?.getTime() === NOW.getTime()).map((token) => token.id),
    ["run-live", "run-single-live"]
  );
  assert.equal(database.audits.filter((audit) => audit.action === "application-execution-token.revoke-bulk").length, 1);
  assert.equal(database.audits.filter((audit) => audit.action === "application-run.cancel").length, 1);
  assert.equal(database.events.length, 1);
  assert.equal(database.events[0].type, "APPLICATION_RUN_EVENT");
  const serialized = JSON.stringify({ audits: database.audits, events: database.events });
  for (const forbidden of ["not-a-real-secret-hash", "attempt-private", "tokenHash", "provenance", "evidence"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("cancellation rolls back run and token invalidation if token, audit, or event persistence fails", async () => {
  for (const failure of ["token", "audit", "event"] as const) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state: "READY", stateVersion: 2 }));
    database.tokens.push(fakeToken());
    database.failTokenUpdate = failure === "token";
    database.failAudit = failure === "audit";
    database.failEvent = failure === "event";

    await assert.rejects(
      serviceFor(database).cancelApplicationRun({ userId: USER_ID, runId: RUN_ID }),
      /simulated/
    );
    assert.equal(database.runs[0].state, "READY", failure);
    assert.equal(database.runs[0].stateVersion, 2, failure);
    assert.equal(database.tokens[0].revokedAt, null, failure);
    assert.equal(database.audits.length, 0, failure);
    assert.equal(database.events.length, 0, failure);
  }
});

test("review resolution requires the exact version and deterministic ordered current reasons", async () => {
  const reasons = ["unknown_requirement_ids", "evidence_gaps_present"] as const;
  const database = new FakeApplicationRunDatabase();
  const firstPreparingAt = new Date("2026-08-19T12:00:00.000Z");
  database.policy = fakePolicy({ enabled: false });
  database.runs.push(fakeRun({
    state: "REVIEW_REQUIRED",
    stateVersion: 8,
    reviewReasons: [...reasons],
    firstPreparingAt,
    policySnapshot: { enabled: true },
    applicationPlanSnapshot: { privatePlan: true }
  }));

  const result = await serviceFor(database, false).resolveApplicationRunReview({
    userId: USER_ID,
    runId: RUN_ID,
    stateVersion: 8,
    acknowledgedReviewReasons: [...reasons],
    answerPacketVersion: 0,
    packetHash: null
  });

  assert.equal(result.state, "READY");
  assert.equal(result.stateVersion, 9);
  assert.deepEqual(result.reviewReasons, reasons);
  assert.deepEqual(result.reviewAcknowledgedAt, NOW);
  assert.equal(database.runs[0].activeRunKey, APPLICATION_ID);
  assert.deepEqual(database.runs[0].firstPreparingAt, firstPreparingAt);
  assert.deepEqual(database.runs[0].policySnapshot, { enabled: true });
  assert.deepEqual(database.runs[0].applicationPlanSnapshot, { privatePlan: true });
  assert.equal(database.tokens.length, 0);
  assert.equal(database.operations.some((operation) => operation.startsWith("policy.")), false);
  assert.equal(database.audits.at(-1)?.action, "application-run.review.resolve");
  assert.equal(database.events.at(-1)?.type, "APPLICATION_RUN_EVENT");
});

test("review resolution rejects stale versions, wrong states, and inexact reason acknowledgments", async () => {
  const validReasons = ["unknown_requirement_ids", "evidence_gaps_present"];
  const cases: Array<{ state?: ApplicationRunState; stateVersion?: number; reasons: string[]; code: string }> = [
    { stateVersion: 6, reasons: validReasons, code: "RUN_REVIEW_STALE" },
    { state: "READY", stateVersion: 7, reasons: validReasons, code: "RUN_INVALID_STATE" },
    { stateVersion: 7, reasons: ["unknown_requirement_ids"], code: "RUN_REVIEW_REASONS_MISMATCH" },
    { stateVersion: 7, reasons: ["evidence_gaps_present", "unknown_requirement_ids"], code: "RUN_REVIEW_REASONS_MISMATCH" },
    { stateVersion: 7, reasons: ["unknown_requirement_ids", "invented_numeric_claims"], code: "RUN_REVIEW_REASONS_MISMATCH" }
  ];
  for (const testCase of cases) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({
      state: testCase.state ?? "REVIEW_REQUIRED",
      stateVersion: 7,
      reviewReasons: validReasons
    }));
    await assert.rejects(
      serviceFor(database).resolveApplicationRunReview({
        userId: USER_ID,
        runId: RUN_ID,
        stateVersion: testCase.stateVersion,
        acknowledgedReviewReasons: testCase.reasons,
        answerPacketVersion: 0,
        packetHash: null
      }),
      (error) => assertPublicError(error, 409, testCase.code)
    );
    assert.equal(database.runs[0].state, testCase.state ?? "REVIEW_REQUIRED");
  }
});

test("review resolution is ownership-scoped and rolls back if its audit or event fails", async () => {
  for (const [userId, runId] of [
    [OTHER_USER_ID, RUN_ID],
    [USER_ID, "clz8w7m9a0099qwer1234tyui"]
  ]) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state: "REVIEW_REQUIRED", reviewReasons: ["evidence_gaps_present"] }));
    await assert.rejects(
      serviceFor(database).resolveApplicationRunReview({
        userId,
        runId,
        stateVersion: 0,
        acknowledgedReviewReasons: ["evidence_gaps_present"],
        answerPacketVersion: 0,
        packetHash: null
      }),
      (error) => assertPublicError(error, 404, "RUN_NOT_FOUND")
    );
  }

  const malformed = new FakeApplicationRunDatabase();
  await assert.rejects(serviceFor(malformed).resolveApplicationRunReview({
    userId: USER_ID,
    runId: "not-a-cuid",
    stateVersion: 0,
    acknowledgedReviewReasons: ["evidence_gaps_present"],
    answerPacketVersion: 0,
    packetHash: null
  }));
  assert.equal(malformed.operations.length, 0);

  for (const failure of ["audit", "event"] as const) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state: "REVIEW_REQUIRED", reviewReasons: ["evidence_gaps_present"] }));
    database.failAudit = failure === "audit";
    database.failEvent = failure === "event";
    await assert.rejects(
      serviceFor(database).resolveApplicationRunReview({
        userId: USER_ID,
        runId: RUN_ID,
        stateVersion: 0,
        acknowledgedReviewReasons: ["evidence_gaps_present"],
        answerPacketVersion: 0,
        packetHash: null
      }),
      /simulated/
    );
    assert.equal(database.runs[0].state, "REVIEW_REQUIRED");
    assert.equal(database.runs[0].reviewAcknowledgedAt, null);
  }
});

test("legacy review resolution requires artifact counters 0/0", async () => {
  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({
    state: "REVIEW_REQUIRED",
    currentFormInspectionVersion: 1,
    currentAnswerPacketVersion: 0
  }));

  await assert.rejects(
    serviceFor(database).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 0,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 0,
      packetHash: null
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_INVALID")
  );
  assert.equal(database.runs[0].state, "REVIEW_REQUIRED");
  assert.equal(database.operations.includes("packet.findUnique"), false);
});

test("packet review resolution applies version and stored-hash stale fences before verification", async () => {
  const staleVersion = packetReviewDatabase();
  await assert.rejects(
    serviceFor(staleVersion).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 2,
      packetHash: PACKET_HASH
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_STALE")
  );
  assert.equal(staleVersion.operations.includes("packet.findUnique"), false);
  assert.equal(staleVersion.operations.includes("packet.verify"), false);

  const staleHash = packetReviewDatabase();
  await assert.rejects(
    serviceFor(staleHash).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 3,
      packetHash: "e".repeat(64)
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_STALE")
  );
  assert.equal(staleHash.operations.includes("packet.findUnique"), true);
  assert.equal(staleHash.operations.includes("packet.verify"), false);
});

test("packet review resolution distinguishes structural invalidity from incomplete review", async () => {
  const invalid = packetReviewDatabase();
  invalid.verificationError = new PublicApiError("The current answer packet is invalid.", 409, {
    code: "RUN_PACKET_INVALID"
  });
  await assert.rejects(
    serviceFor(invalid).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_INVALID")
  );

  const alreadyAcknowledged = packetReviewDatabase({ packet: { reviewedAt: new Date(NOW) } });
  await assert.rejects(
    serviceFor(alreadyAcknowledged).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_INVALID")
  );

  for (const summary of [
    { pendingReviewCount: 1, readyForRunResolution: false },
    { approvedCount: 1, readyForRunResolution: false }
  ]) {
    const incomplete = packetReviewDatabase({ summary });
    await assert.rejects(
      serviceFor(incomplete).resolveApplicationRunReview({
        userId: USER_ID,
        runId: RUN_ID,
        stateVersion: 4,
        acknowledgedReviewReasons: [],
        answerPacketVersion: 3,
        packetHash: PACKET_HASH
      }),
      (error) => assertPublicError(error, 409, "RUN_PACKET_REVIEW_INCOMPLETE")
    );
    assert.equal(incomplete.packets[0].reviewedAt, null);
  }
});

test("packet review resolution uses one database timestamp and permits manual-required work", async () => {
  const database = packetReviewDatabase({
    run: { reviewReasons: ["evidence_gaps_present"] },
    summary: { manualRequiredCount: 2, readyForRunResolution: true }
  });
  database.tokens.push(fakeToken());

  const result = await serviceFor(database).resolveApplicationRunReview({
    userId: USER_ID,
    runId: RUN_ID,
    stateVersion: 4,
    acknowledgedReviewReasons: ["evidence_gaps_present"],
    answerPacketVersion: 3,
    packetHash: PACKET_HASH
  });

  assert.equal(result.state, "READY");
  assert.equal(result.stateVersion, 5);
  assert.deepEqual(database.packets[0].reviewedAt, NOW);
  assert.equal(database.runs[0].state, "READY");
  assert.equal(database.runs[0].stateVersion, 5);
  assert.deepEqual(database.runs[0].reviewAcknowledgedAt, NOW);
  assert.equal(database.audits.length, 1);
  assert.equal(database.events.length, 1);
  assert.equal(database.operations.filter((operation) => operation === "database.now").length, 1);
  assert.ok(database.operations.indexOf("packet.updateMany") < database.operations.indexOf("run.updateMany"));
  assert.equal(database.tokens[0].revokedAt, null);
  assert.equal(database.operations.includes("token.updateMany"), false);
});

test("post-fill packet review resolves to user submission readiness without erasing fill provenance", async () => {
  const fillAttemptId = "550e8400-e29b-41d4-a716-446655440000";
  const database = packetReviewDatabase({
    run: {
      fillAttemptId,
      fillLeaseExpiresAt: null,
      errorCategory: "FILL_STOPPED_EARLY"
    }
  });

  const result = await serviceFor(database).resolveApplicationRunReview({
    userId: USER_ID,
    runId: RUN_ID,
    stateVersion: 4,
    acknowledgedReviewReasons: [],
    answerPacketVersion: 3,
    packetHash: PACKET_HASH
  });

  assert.equal(result.state, "READY_FOR_USER_SUBMISSION");
  assert.equal(result.stateVersion, 5);
  assert.equal(database.runs[0].state, "READY_FOR_USER_SUBMISSION");
  assert.equal(database.runs[0].fillAttemptId, fillAttemptId);
  assert.equal(database.runs[0].fillLeaseExpiresAt, null);
  assert.equal(database.runs[0].errorCategory, "FILL_STOPPED_EARLY");
  assert.deepEqual(database.packets[0].reviewedAt, NOW);
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0].metadata.nextState, "READY_FOR_USER_SUBMISSION");
  assert.equal(database.events.length, 1);
  assert.equal(nested(database.events[0], "metadata").nextState, "READY_FOR_USER_SUBMISSION");
});

test("post-fill review rejects contradictory lease state and transition denial without mutation", async () => {
  const fillAttemptId = "550e8400-e29b-41d4-a716-446655440000";
  const contradictory = packetReviewDatabase({
    run: { fillAttemptId, fillLeaseExpiresAt: new Date(NOW.getTime() + 60_000) }
  });
  const contradictoryBefore = structuredClone({
    run: contradictory.runs[0],
    packet: contradictory.packets[0]
  });
  await assert.rejects(
    serviceFor(contradictory).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    }),
    (error) => assertPublicError(error, 409, "RUN_INVALID_STATE")
  );
  assert.deepEqual(contradictory.runs[0], contradictoryBefore.run);
  assert.deepEqual(contradictory.packets[0], contradictoryBefore.packet);
  assert.equal(contradictory.audits.length, 0);
  assert.equal(contradictory.events.length, 0);

  const denied = packetReviewDatabase({ run: { fillAttemptId, fillLeaseExpiresAt: null } });
  const deniedBefore = structuredClone({ run: denied.runs[0], packet: denied.packets[0] });
  await assert.rejects(
    serviceFor(denied, false, {
      assertTransition: (from, to) => {
        assert.equal(from, "REVIEW_REQUIRED");
        assert.equal(to, "READY_FOR_USER_SUBMISSION");
        throw new Error("transition denied");
      }
    }).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    }),
    /transition denied/
  );
  assert.deepEqual(denied.runs[0], deniedBefore.run);
  assert.deepEqual(denied.packets[0], deniedBefore.packet);
  assert.equal(denied.audits.length, 0);
  assert.equal(denied.events.length, 0);
});

test("packet review resolution preserves existing planner acknowledgment and does not fabricate one", async () => {
  const existing = new Date("2026-08-19T00:00:00.000Z");
  const cases: Array<[string, Partial<FakeRun>, Date | null]> = [
    ["existing", { reviewReasons: ["evidence_gaps_present"], reviewAcknowledgedAt: existing }, existing],
    ["empty reasons", { reviewReasons: [], reviewAcknowledgedAt: null }, null]
  ];
  for (const [label, run, expected] of cases) {
    const database = packetReviewDatabase({ run });
    await serviceFor(database).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: [...(run.reviewReasons ?? [])],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    });
    assert.deepEqual(database.runs[0].reviewAcknowledgedAt, expected, label);
    assert.deepEqual(database.packets[0].reviewedAt, NOW, label);
  }
});

test("packet review resolution rolls back packet acknowledgment on every later transactional failure", async () => {
  for (const failure of ["packet", "run", "audit", "event"] as const) {
    const database = packetReviewDatabase({ run: { reviewReasons: ["evidence_gaps_present"] } });
    database.failPacketUpdate = failure === "packet";
    database.failRunUpdate = failure === "run";
    database.failAudit = failure === "audit";
    database.failEvent = failure === "event";

    await assert.rejects(
      serviceFor(database).resolveApplicationRunReview({
        userId: USER_ID,
        runId: RUN_ID,
        stateVersion: 4,
        acknowledgedReviewReasons: ["evidence_gaps_present"],
        answerPacketVersion: 3,
        packetHash: PACKET_HASH
      })
    );
    assert.equal(database.packets[0].reviewedAt, null, failure);
    assert.equal(database.runs[0].state, "REVIEW_REQUIRED", failure);
    assert.equal(database.runs[0].stateVersion, 4, failure);
    assert.equal(database.runs[0].reviewAcknowledgedAt, null, failure);
    assert.equal(database.audits.length, 0, failure);
    assert.equal(database.events.length, 0, failure);
    assert.equal(database.operations.at(-1), "transaction.rollback", failure);
  }
});

test("packet review resolution publishes committed state only after transaction callback success", async () => {
  const database = packetReviewDatabase({ run: { reviewReasons: ["evidence_gaps_present"] } });
  database.failEvent = true;
  let observedBeforeFailure = false;
  database.onEventCreate = () => {
    observedBeforeFailure = true;
    assert.equal(database.packets[0].reviewedAt, null);
    assert.equal(database.runs[0].state, "REVIEW_REQUIRED");
    assert.equal(database.runs[0].stateVersion, 4);
    assert.equal(database.runs[0].reviewAcknowledgedAt, null);
    assert.equal(database.audits.length, 0);
    assert.equal(database.events.length, 0);
  };

  await assert.rejects(
    serviceFor(database).resolveApplicationRunReview({
      userId: USER_ID,
      runId: RUN_ID,
      stateVersion: 4,
      acknowledgedReviewReasons: ["evidence_gaps_present"],
      answerPacketVersion: 3,
      packetHash: PACKET_HASH
    }),
    /simulated event failure/
  );
  assert.equal(observedBeforeFailure, true);
});

test("answer review binds owner, run, and answer; locks run before answer; and returns a safe DTO", async () => {
  const database = new FakeApplicationRunDatabase();
  database.policy = fakePolicy({ enabled: false });
  database.runs.push(fakeRun({ state: "READY" }));
  database.answers.push(fakeAnswer());

  const result = await serviceFor(database, false).reviewApplicationRunAnswer({
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    status: "APPROVED",
    answerPacketVersion: 0
  });

  const expectedHash = createHash("sha256").update("A private proposed answer sentinel").digest("hex");
  assert.equal(database.answers[0].finalValueHash, expectedHash);
  assert.equal(database.answers[0].reviewHashVersion, "LEGACY_SCALAR_SHA256");
  assert.equal(database.answers[0].status, "APPROVED");
  assert.equal(database.answers[0].reviewedByUser, true);
  assert.deepEqual(database.answers[0].reviewedAt, NOW);
  assert.deepEqual(Object.keys(result).sort(), [
    "id", "reviewedAt", "reviewedByUser", "runId", "sensitive", "status", "valueRedacted"
  ]);
  assert.ok(database.operations.indexOf("run.lock") < database.operations.indexOf("answer.lock"));
  assert.equal(database.operations.some((operation) => operation.startsWith("policy.")), false);
  const serialized = JSON.stringify({ result, audits: database.audits });
  assert.equal(serialized.includes("A private proposed answer sentinel"), false);
  assert.equal(serialized.includes(expectedHash), false);
});

test("legacy answer approval hashes the exact persisted UTF-8 scalar without trimming", async () => {
  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({ state: "READY" }));
  database.answers.push(fakeAnswer({ proposedValue: "  exact scalar\n" }));

  await serviceFor(database).reviewApplicationRunAnswer({
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    status: "APPROVED",
    answerPacketVersion: 0
  });

  assert.equal(
    database.answers[0].finalValueHash,
    createHash("sha256").update("  exact scalar\n", "utf8").digest("hex")
  );
  assert.equal(database.answers[0].reviewHashVersion, "LEGACY_SCALAR_SHA256");
});

test("answer approval fails closed for null, sensitive, or redacted legacy values without disclosure", async () => {
  const cases: Partial<FakeAnswer>[] = [
    { proposedValue: null },
    { sensitive: true, proposedValue: "sensitive sentinel" },
    { valueRedacted: true, proposedValue: "redacted sentinel" }
  ];
  for (const overrides of cases) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state: "REVIEW_REQUIRED" }));
    database.answers.push(fakeAnswer(overrides));
    await assert.rejects(
      serviceFor(database).reviewApplicationRunAnswer({
        userId: USER_ID,
        runId: RUN_ID,
        answerId: ANSWER_ID,
        status: "APPROVED",
        answerPacketVersion: 0
      }),
      (error) => {
        assert.equal(JSON.stringify(error).includes("sentinel"), false);
        return assertPublicError(error, 422, "RUN_ANSWER_NOT_APPROVABLE");
      }
    );
    assert.equal(database.answers[0].status, "PENDING");
    assert.equal(database.audits.length, 0);
  }
});

test("answer rejection is allowed for sensitive/redacted values and clears any approval hash", async () => {
  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({ state: "REVIEW_REQUIRED" }));
  database.answers.push(fakeAnswer({
    sensitive: true,
    valueRedacted: true,
    proposedValue: "never serialize this answer",
    finalValueHash: "stale-hash"
  }));

  const result = await serviceFor(database, false).reviewApplicationRunAnswer({
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    status: "REJECTED",
    answerPacketVersion: 0
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(database.answers[0].finalValueHash, null);
  assert.equal(database.answers[0].reviewHashVersion, null);
  assert.equal(JSON.stringify({ result, audits: database.audits }).includes("never serialize this answer"), false);
  assert.equal(database.audits.length, 1);
  assert.equal(database.events.length, 0);
});

test("legacy answer review requires artifact counters 0/0 and an answer without packet membership", async () => {
  const mixed = new FakeApplicationRunDatabase();
  mixed.runs.push(fakeRun({
    state: "REVIEW_REQUIRED",
    currentFormInspectionVersion: 1,
    currentAnswerPacketVersion: 0
  }));
  mixed.answers.push(fakeAnswer());
  await assert.rejects(
    serviceFor(mixed).reviewApplicationRunAnswer({
      userId: USER_ID,
      runId: RUN_ID,
      answerId: ANSWER_ID,
      status: "REJECTED",
      answerPacketVersion: 0
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_INVALID")
  );
  assert.equal(mixed.operations.includes("answer.lock"), false);

  const packetMember = new FakeApplicationRunDatabase();
  packetMember.runs.push(fakeRun({ state: "READY" }));
  packetMember.answers.push(fakeAnswer({ answerPacketId: PACKET_ID }));
  await assert.rejects(
    serviceFor(packetMember).reviewApplicationRunAnswer({
      userId: USER_ID,
      runId: RUN_ID,
      answerId: ANSWER_ID,
      status: "REJECTED",
      answerPacketVersion: 0
    }),
    (error) => assertPublicError(error, 404, "RUN_ANSWER_NOT_FOUND")
  );
});

test("packet answer review fences stale versions before historical answer status or existence", async () => {
  const database = packetReviewDatabase({
    answer: {
      answerPacketId: "historical-packet",
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: NOW
    }
  });

  await assert.rejects(
    serviceFor(database).reviewApplicationRunAnswer({
      userId: USER_ID,
      runId: RUN_ID,
      answerId: ANSWER_ID,
      status: "REJECTED",
      answerPacketVersion: 2
    }),
    (error) => assertPublicError(error, 409, "RUN_PACKET_STALE")
  );
  assert.equal(database.operations.includes("packet.verify"), false);
  assert.equal(database.operations.includes("answer.lock"), false);
});

test("packet answer review verifies the current packet before a packet-scoped nonmember lookup", async () => {
  const database = packetReviewDatabase({ answer: { answerPacketId: "other-packet" } });

  await assert.rejects(
    serviceFor(database).reviewApplicationRunAnswer({
      userId: USER_ID,
      runId: RUN_ID,
      answerId: ANSWER_ID,
      status: "REJECTED",
      answerPacketVersion: 3
    }),
    (error) => assertPublicError(error, 404, "RUN_ANSWER_NOT_FOUND")
  );
  assert.ok(database.operations.indexOf("packet.verify") < database.operations.indexOf("answer.lock"));
});

test("packet answer approval requires a pending approvable proposal compatible with the frozen field", async () => {
  const cases: Array<[string, Partial<FakeAnswer>]> = [
    ["manual disposition", { disposition: "MANUAL_ONLY" }],
    ["missing proposal", { proposal: null }],
    ["sensitive", { sensitive: true }],
    ["redacted", { valueRedacted: true }],
    ["incompatible proposal", { fieldType: "CHECKBOX_BOOLEAN" }]
  ];
  for (const [label, answer] of cases) {
    const database = packetReviewDatabase({ answer });
    await assert.rejects(
      serviceFor(database).reviewApplicationRunAnswer({
        userId: USER_ID,
        runId: RUN_ID,
        answerId: ANSWER_ID,
        status: "APPROVED",
        answerPacketVersion: 3
      }),
      (error) => assertPublicError(error, 422, "RUN_ANSWER_NOT_APPROVABLE"),
      label
    );
    assert.equal(database.answers[0].status, "PENDING", label);
  }

  const reviewed = packetReviewDatabase({
    answer: { status: "REJECTED", reviewedByUser: true, reviewedAt: NOW }
  });
  await assert.rejects(
    serviceFor(reviewed).reviewApplicationRunAnswer({
      userId: USER_ID,
      runId: RUN_ID,
      answerId: ANSWER_ID,
      status: "APPROVED",
      answerPacketVersion: 3
    }),
    (error) => assertPublicError(error, 409, "RUN_ANSWER_ALREADY_REVIEWED")
  );
});

test("packet answer approval stores the F1 canonical proposal hash and canonical review version", async () => {
  const database = packetReviewDatabase();
  const proposal = database.answers[0].proposal;

  const result = await serviceFor(database).reviewApplicationRunAnswer({
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    status: "APPROVED",
    answerPacketVersion: 3
  });

  assert.equal(result.status, "APPROVED");
  assert.equal(database.answers[0].finalValueHash, computeApplicationAnswerProposalHash(proposal));
  assert.equal(database.answers[0].reviewHashVersion, "CANONICAL_PROPOSAL_V1");
  assert.equal(database.operations.filter((operation) => operation === "packet.verify").length, 1);
});

test("packet answer rejection preserves the proposal, clears review hashes, and emits only a private audit", async () => {
  const database = packetReviewDatabase({
    answer: { finalValueHash: "stale-hash", reviewHashVersion: "CANONICAL_PROPOSAL_V1" }
  });
  database.tokens.push(fakeToken());
  const proposalBefore = structuredClone(database.answers[0].proposal);

  await serviceFor(database).reviewApplicationRunAnswer({
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    status: "REJECTED",
    answerPacketVersion: 3
  });

  assert.deepEqual(database.answers[0].proposal, proposalBefore);
  assert.equal(database.answers[0].finalValueHash, null);
  assert.equal(database.answers[0].reviewHashVersion, null);
  assert.equal(database.events.length, 0);
  assert.equal(database.tokens[0].revokedAt, null);
  assert.equal(database.operations.includes("token.updateMany"), false);
  const serialized = JSON.stringify(database.audits);
  for (const forbidden of ["Persisted packet proposal sentinel", "finalValueHash", "sourceIds", "sourceFingerprint"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(database.audits[0].metadata, {
    runId: RUN_ID,
    answerId: ANSWER_ID,
    answerPacketVersion: 3,
    normalizedFieldKey: NORMALIZED_FIELD_KEY,
    status: "REJECTED",
    reviewedAt: NOW.toISOString()
  });
});

test("answer review rejects invalid parent states, repeats, and mismatched owner/run/answer bindings", async () => {
  for (const state of ["DRAFT", "PREPARING", "CANCELLED", "FAILED", "BLOCKED", "FILLING"] as const) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state }));
    database.answers.push(fakeAnswer());
    await assert.rejects(
      serviceFor(database).reviewApplicationRunAnswer({
        userId: USER_ID,
        runId: RUN_ID,
        answerId: ANSWER_ID,
        status: "REJECTED",
        answerPacketVersion: 0
      }),
      (error) => assertPublicError(error, 409, "RUN_INVALID_STATE")
    );
  }

  const repeats = new FakeApplicationRunDatabase();
  repeats.runs.push(fakeRun({ state: "READY" }));
  repeats.answers.push(fakeAnswer({ status: "APPROVED", reviewedByUser: true, reviewedAt: NOW }));
  await assert.rejects(
    serviceFor(repeats).reviewApplicationRunAnswer({
      userId: USER_ID, runId: RUN_ID, answerId: ANSWER_ID, status: "APPROVED", answerPacketVersion: 0
    }),
    (error) => assertPublicError(error, 409, "RUN_ANSWER_ALREADY_REVIEWED")
  );

  const wrongOwnerRun = new FakeApplicationRunDatabase();
  wrongOwnerRun.runs.push(fakeRun({ state: "READY" }));
  wrongOwnerRun.answers.push(fakeAnswer());
  await assert.rejects(
    serviceFor(wrongOwnerRun).reviewApplicationRunAnswer({
      userId: OTHER_USER_ID, runId: RUN_ID, answerId: ANSWER_ID, status: "REJECTED", answerPacketVersion: 0
    }),
    (error) => assertPublicError(error, 404, "RUN_NOT_FOUND")
  );

  for (const setup of ["wrong-user", "wrong-run", "missing"] as const) {
    const database = new FakeApplicationRunDatabase();
    database.runs.push(fakeRun({ state: "READY" }));
    if (setup !== "missing") {
      database.answers.push(fakeAnswer(setup === "wrong-user"
        ? { userId: OTHER_USER_ID }
        : { runId: "clz8w7m9a0099qwer1234tyui" }));
    }
    await assert.rejects(
      serviceFor(database).reviewApplicationRunAnswer({
        userId: USER_ID, runId: RUN_ID, answerId: ANSWER_ID, status: "REJECTED", answerPacketVersion: 0
      }),
      (error) => assertPublicError(error, 404, "RUN_ANSWER_NOT_FOUND")
    );
    assert.equal(database.answers[0]?.status, setup === "missing" ? undefined : "PENDING");
  }
});

test("answer review validates both IDs before Prisma and rolls back mutation when audit fails", async () => {
  for (const input of [
    { runId: "not-a-cuid", answerId: ANSWER_ID },
    { runId: RUN_ID, answerId: "not-a-cuid" }
  ]) {
    const database = new FakeApplicationRunDatabase();
    await assert.rejects(serviceFor(database).reviewApplicationRunAnswer({
      userId: USER_ID,
      ...input,
      status: "REJECTED",
      answerPacketVersion: 0
    }));
    assert.equal(database.operations.length, 0);
  }

  const database = new FakeApplicationRunDatabase();
  database.runs.push(fakeRun({ state: "READY" }));
  database.answers.push(fakeAnswer());
  database.failAudit = true;
  await assert.rejects(
    serviceFor(database).reviewApplicationRunAnswer({
      userId: USER_ID, runId: RUN_ID, answerId: ANSWER_ID, status: "REJECTED", answerPacketVersion: 0
    }),
    /simulated audit failure/
  );
  assert.equal(database.answers[0].status, "PENDING");
  assert.equal(database.answers[0].reviewedAt, null);
});
