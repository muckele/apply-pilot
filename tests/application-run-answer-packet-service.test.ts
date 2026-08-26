import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Prisma, type ApplicationRunState } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  createApplicationRunAnswerPacketService,
  type ApplicationRunAnswerPacketServiceDependencies
} from "@/lib/application-runs/answer-packet-service";
import { FORM_INSPECTION_SCHEMA_VERSION } from "@/lib/application-runs/form-inspection";

const NOW = new Date("2026-08-26T20:00:00.000Z");
const USER_ID = "user-1";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const JOB_ID = "clz8w7m9a0001qwer1234tyui";

const EMPTY_CONSTRAINTS = {
  minLength: null,
  maxLength: null,
  min: null,
  max: null,
  step: null,
  acceptedFileTypes: [] as string[],
  multiple: false
};

function field(overrides: Record<string, unknown> = {}) {
  return {
    question: "LinkedIn profile URL",
    helpText: null,
    fieldType: "URL",
    unsupportedReason: null,
    required: true,
    autocomplete: "url",
    constraints: { ...EMPTY_CONSTRAINTS },
    choices: [],
    ...overrides
  };
}

function report(fields = [field()]) {
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{ title: "Application", sections: [{ heading: "Candidate", fields }] }]
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type FakeRow = Record<string, unknown>;

type FakePolicy = FakeRow & {
  id: string;
  userId: string;
  enabled: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
  sensitiveAnswerPolicy: "EXCLUDE";
  finalReviewRequired: boolean;
};

type FakeRun = FakeRow & {
  id: string;
  userId: string;
  applicationId: string;
  jobPostingId: string;
  state: ApplicationRunState;
  stateVersion: number;
  currentFormInspectionVersion: number;
  currentAnswerPacketVersion: number;
  applyUrlSnapshot: string;
  applyHost: string;
  resumeVersionId: string | null;
  resumeContentHash: string | null;
  coverLetterVersionId: string | null;
  coverLetterContentHash: string | null;
  application: { id: string; userId: string; jobPostingId: string };
  jobPosting: { id: string; userId: string };
};

type FakeVaultRow = FakeRow & {
  id: string;
  userId: string;
  category: string;
  question: string;
  answer: string;
  sensitive: boolean;
  isActive: boolean;
  updatedAt: Date;
};

type FakeToken = FakeRow & {
  id: string;
  userId: string;
  runId: string;
  singleUse: boolean;
  consumedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

type FakeState = {
  policy: FakePolicy | null;
  run: FakeRun;
  inspections: FakeRow[];
  packets: FakeRow[];
  packetAnswers: FakeRow[];
  vault: FakeVaultRow[];
  resumes: FakeRow[];
  documents: FakeRow[];
  tokens: FakeToken[];
  audits: FakeRow[];
  events: FakeRow[];
};

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function hasPublicErrorCode(error: unknown, code: string): boolean {
  return error instanceof PublicApiError && error.details?.code === code;
}

function assertPublicErrorCode(error: unknown, code: string, label?: string): true {
  assert.equal(error instanceof PublicApiError ? error.details?.code : undefined, code, label);
  return true;
}

class FakeAnswerPacketDatabase {
  state: FakeState;
  queryLog: string[] = [];
  queryValues: unknown[][] = [];
  rawPacketAnswerWrites: FakeRow[] = [];
  transactionIsolationLevels: unknown[] = [];
  failAt: string | null = null;
  private idCounter = 0;

  constructor(overrides: Partial<FakeState> = {}) {
    this.state = {
      policy: {
        id: "policy-1",
        userId: USER_ID,
        enabled: true,
        allowedHosts: ["jobs.example.com"],
        blockedHosts: [],
        sensitiveAnswerPolicy: "EXCLUDE",
        finalReviewRequired: true
      },
      run: {
        id: RUN_ID,
        userId: USER_ID,
        applicationId: APPLICATION_ID,
        jobPostingId: JOB_ID,
        state: "READY" as ApplicationRunState,
        stateVersion: 4,
        currentFormInspectionVersion: 0,
        currentAnswerPacketVersion: 0,
        applyUrlSnapshot: "https://jobs.example.com/apply/123#authoritative-fragment",
        applyHost: "jobs.example.com",
        resumeVersionId: null,
        resumeContentHash: null,
        coverLetterVersionId: null,
        coverLetterContentHash: null,
        application: { id: APPLICATION_ID, userId: USER_ID, jobPostingId: JOB_ID },
        jobPosting: { id: JOB_ID, userId: USER_ID }
      },
      inspections: [],
      packets: [],
      packetAnswers: [],
      vault: [
        {
          id: "vault-linkedin",
          userId: USER_ID,
          category: "LINKS",
          question: "LinkedIn profile URL",
          answer: "https://www.linkedin.com/in/example",
          sensitive: false,
          isActive: true,
          updatedAt: new Date("2026-08-20T10:00:00.000Z")
        }
      ],
      resumes: [],
      documents: [],
      tokens: [
        {
          id: "token-1",
          userId: USER_ID,
          runId: RUN_ID,
          singleUse: false,
          consumedAt: null,
          expiresAt: new Date(NOW.getTime() + 60_000),
          revokedAt: null
        }
      ],
      audits: [],
      events: [],
      ...cloneState(overrides)
    };
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  private maybeFail(operation: string): void {
    if (this.failAt === operation) throw new Error(`simulated ${operation} failure`);
  }

  private sqlText(query: unknown): string {
    if (Array.isArray(query)) return query.join("?");
    if (query && typeof query === "object" && "strings" in query) {
      return Array.from((query as { strings: readonly string[] }).strings).join("?");
    }
    return String(query);
  }

  private transactionClient(state: FakeState) {
    return {
      $queryRaw: async <T>(query: unknown, ...values: unknown[]): Promise<T> => {
        const sql = this.sqlText(query);
        this.queryLog.push(sql.replace(/\s+/g, " ").trim());
        this.queryValues.push(values);
        if (sql.includes('FROM "ApplicationAutomationPolicy"')) {
          const userId = values[0];
          return (state.policy && state.policy.userId === userId ? [{ id: state.policy.id }] : []) as T;
        }
        if (sql.includes('FROM "ApplicationRun"')) {
          const [runId, userId] = values;
          return (state.run.id === runId && state.run.userId === userId ? [{ id: state.run.id }] : []) as T;
        }
        if (sql.includes('FROM "ApplicationAnswer"')) {
          const [userId, includeLinks, includeAvailability] = values;
          return state.vault
            .filter((answer) =>
              answer.userId === userId &&
              answer.isActive === true &&
              answer.sensitive === false &&
              ((includeLinks === true && answer.category === "LINKS") ||
                (includeAvailability === true && answer.category === "AVAILABILITY"))
            )
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, 257) as T;
        }
        if (sql.includes('FROM "ResumeVersion"')) {
          const [id, userId, jobPostingId] = values;
          return state.resumes.filter((row) =>
            row.id === id && row.userId === userId && row.jobPostingId === jobPostingId
          ) as T;
        }
        if (sql.includes('FROM "GeneratedDocument"')) {
          const [id, userId, jobPostingId] = values;
          return state.documents.filter((row) =>
            row.id === id && row.userId === userId && row.jobPostingId === jobPostingId && row.type === "COVER_LETTER"
          ) as T;
        }
        throw new Error(`Unexpected raw query: ${sql}`);
      },
      applicationAutomationPolicy: {
        findUnique: async ({ where }: { where: { userId: string } }) =>
          state.policy?.userId === where.userId ? cloneState(state.policy) : null
      },
      applicationRun: {
        findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
          state.run.id === where.id && state.run.userId === where.userId ? cloneState(state.run) : null,
        updateMany: async ({ where, data }: {
          where: {
            id: string;
            userId: string;
            state: ApplicationRunState;
            stateVersion: number;
            currentFormInspectionVersion: number;
            currentAnswerPacketVersion: number;
          };
          data: {
            currentFormInspectionVersion: number;
            currentAnswerPacketVersion: number;
            state?: ApplicationRunState;
            stateVersion?: { increment: number };
          };
        }) => {
          this.maybeFail("run-update");
          const matches =
            state.run.id === where.id &&
            state.run.userId === where.userId &&
            state.run.state === where.state &&
            state.run.stateVersion === where.stateVersion &&
            state.run.currentFormInspectionVersion === where.currentFormInspectionVersion &&
            state.run.currentAnswerPacketVersion === where.currentAnswerPacketVersion;
          if (!matches) return { count: 0 };
          state.run.currentFormInspectionVersion = data.currentFormInspectionVersion;
          state.run.currentAnswerPacketVersion = data.currentAnswerPacketVersion;
          if (data.state) state.run.state = data.state;
          if (data.stateVersion?.increment) state.run.stateVersion += data.stateVersion.increment;
          return { count: 1 };
        }
      },
      applicationRunFormInspection: {
        findUnique: async ({ where }: { where: { runId_version: { runId: string; version: number } } }) => {
          const key = where.runId_version;
          return cloneState(state.inspections.find((row) => row.runId === key.runId && row.version === key.version) ?? null);
        },
        create: async ({ data }: { data: FakeRow }) => {
          this.maybeFail("inspection-create");
          const row = { id: this.nextId("inspection"), createdAt: new Date(NOW), ...cloneState(data) };
          state.inspections.push(row);
          return cloneState(row);
        }
      },
      applicationRunAnswerPacket: {
        findUnique: async ({ where }: { where: { runId_version: { runId: string; version: number } } }) => {
          const key = where.runId_version;
          return cloneState(state.packets.find((row) => row.runId === key.runId && row.version === key.version) ?? null);
        },
        create: async ({ data }: { data: FakeRow }) => {
          this.maybeFail("packet-create");
          const row = { id: this.nextId("packet"), createdAt: new Date(NOW), ...cloneState(data) };
          state.packets.push(row);
          return cloneState(row);
        }
      },
      applicationRunAnswer: {
        findMany: async ({ where }: { where: { answerPacketId: string } }) =>
          cloneState(state.packetAnswers.filter((row) => row.answerPacketId === where.answerPacketId)),
        createMany: async ({ data }: { data: FakeRow[] }) => {
          this.maybeFail("answer-createMany");
          for (const input of data) {
            const packetBacked = input.answerPacketId != null;
            const nonProposable =
              input.disposition === "MANUAL_ONLY" ||
              input.disposition === "EXCLUDED" ||
              input.disposition === "UNSUPPORTED";
            if (packetBacked && nonProposable && input.proposal !== Prisma.DbNull) {
              throw new Error("packet-backed non-proposable proposal must use Prisma.DbNull");
            }
            this.rawPacketAnswerWrites.push(input);
            state.packetAnswers.push({
              id: this.nextId("packet-answer"),
              createdAt: new Date(NOW),
              updatedAt: new Date(NOW),
              ...cloneState(input),
              proposal: input.proposal === Prisma.DbNull ? null : cloneState(input.proposal)
            });
          }
          return { count: data.length };
        }
      },
      applicationExecutionToken: {
        updateMany: async ({ where, data }: {
          where: {
            userId: string;
            runId: string;
            revokedAt: null;
            expiresAt: { gt: Date };
          };
          data: { revokedAt: Date };
        }) => {
          this.maybeFail("token-revoke");
          let count = 0;
          for (const token of state.tokens) {
            if (
              token.userId === where.userId &&
              token.runId === where.runId &&
              token.revokedAt === null &&
              token.expiresAt > where.expiresAt.gt &&
              (token.singleUse === false || token.consumedAt === null)
            ) {
              token.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }
      },
      auditLog: {
        create: async ({ data }: { data: FakeRow & { action: string } }) => {
          this.maybeFail(data.action === "application-execution-token.revoke-bulk" ? "token-audit" : "publication-audit");
          const row = { id: this.nextId("audit"), createdAt: new Date(NOW), ...cloneState(data) };
          state.audits.push(row);
          return cloneState(row);
        }
      },
      applicationEvent: {
        create: async ({ data }: { data: FakeRow }) => {
          this.maybeFail("event-create");
          const row = { id: this.nextId("event"), occurredAt: new Date(NOW), ...cloneState(data) };
          state.events.push(row);
          return cloneState(row);
        }
      }
    };
  }

  client = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      const working = cloneState(this.state);
      this.transactionIsolationLevels.push((options as { isolationLevel?: unknown } | undefined)?.isolationLevel);
      const result = await callback(this.transactionClient(working));
      this.state = working;
      return result;
    }
  };
}

function service(database: FakeAnswerPacketDatabase, env = { APPLICATION_AUTOMATION_ENABLED: "true" }) {
  return createApplicationRunAnswerPacketService({
    prismaClient: database.client as NonNullable<ApplicationRunAnswerPacketServiceDependencies["prismaClient"]>,
    env,
    clock: () => new Date(NOW)
  });
}

function publicationInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    runId: RUN_ID,
    expectedStateVersion: 4,
    expectedFormInspectionVersion: 0,
    expectedAnswerPacketVersion: 0,
    observedUrl: "https://JOBS.example.com:443/apply/123#browser-fragment",
    inspectionReport: report(),
    ...overrides
  };
}

function documentReport() {
  return report([
    field({ question: "Upload resume", fieldType: "FILE_UPLOAD", autocomplete: null }),
    field({ question: "Upload cover letter", fieldType: "FILE_UPLOAD", autocomplete: null })
  ]);
}

function configuredDocumentDatabase() {
  const resumeText = "Verified resume text";
  const coverContent = "Verified cover letter";
  const database = new FakeAnswerPacketDatabase();
  database.state.run.resumeVersionId = "resume-1";
  database.state.run.resumeContentHash = sha256(resumeText);
  database.state.run.coverLetterVersionId = "cover-1";
  database.state.run.coverLetterContentHash = sha256(coverContent);
  database.state.resumes.push({
    id: "resume-1",
    userId: USER_ID,
    jobPostingId: JOB_ID,
    fullText: resumeText,
    createdAt: new Date("2026-08-01T00:00:00.000Z")
  });
  database.state.documents.push({
    id: "cover-1",
    userId: USER_ID,
    jobPostingId: JOB_ID,
    type: "COVER_LETTER",
    title: "Original title",
    content: coverContent,
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z")
  });
  return database;
}

test("fake packet persistence rejects JavaScript null for a packet-backed non-proposable proposal", async () => {
  const database = new FakeAnswerPacketDatabase();

  await assert.rejects(
    database.client.$transaction(async (untypedTx) => {
      const tx = untypedTx as {
        applicationRunAnswer: {
          createMany: (input: { data: FakeRow[] }) => Promise<{ count: number }>;
        };
      };
      return tx.applicationRunAnswer.createMany({
        data: [{
          answerPacketId: "packet-1",
          disposition: "MANUAL_ONLY",
          proposal: null
        }]
      });
    }),
    /packet-backed non-proposable proposal must use Prisma\.DbNull/
  );
});

test("first publication persists inspection 1 and packet 1, transitions READY, and revokes tokens", async () => {
  const database = new FakeAnswerPacketDatabase();
  const result = await service(database).publishFormInspectionAndAnswerPacket(publicationInput());

  assert.equal(result.replayed, false);
  assert.equal(result.inspectionVersion, 1);
  assert.equal(result.packetVersion, 1);
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.equal(result.stateVersion, 5);
  assert.equal(database.state.inspections.length, 1);
  assert.equal(database.state.packets.length, 1);
  assert.equal(database.state.packetAnswers.length, 1);
  assert.equal(database.state.packetAnswers[0].disposition, "PROPOSABLE");
  assert.equal(database.state.packetAnswers[0].dispositionReason, null);
  assert.equal(database.state.packetAnswers[0].proposedValue, null);
  assert.deepEqual(database.state.packetAnswers[0].proposal, {
    kind: "SCALAR",
    value: "https://www.linkedin.com/in/example"
  });
  assert.equal(database.state.packetAnswers[0].reviewedByUser, false);
  assert.equal(database.state.packetAnswers[0].reviewHashVersion, null);
  assert.equal(database.state.tokens[0].revokedAt?.toISOString(), NOW.toISOString());
  assert.equal(database.state.audits.length, 2);
  assert.equal(database.state.events.length, 1);
  assert.deepEqual(database.queryLog.map((query) => query.match(/FROM "([^"]+)"/)?.[1]).filter(Boolean), [
    "ApplicationAutomationPolicy",
    "ApplicationRun",
    "ApplicationAnswer"
  ]);
});

test("exact replay tolerates stale artifact counters but performs no mutation or side effect", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
  const before = cloneState(database.state);

  const replay = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 0,
    expectedAnswerPacketVersion: 0
  }));

  assert.equal(replay.replayed, true);
  assert.equal(replay.inspectionVersion, 1);
  assert.equal(replay.packetVersion, 1);
  assert.deepEqual(database.state, before);
});

test("stale stateVersion fails even when the packet would otherwise replay", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());

  await assert.rejects(
    packetService.publishFormInspectionAndAnswerPacket(publicationInput({
      expectedStateVersion: 4,
      expectedFormInspectionVersion: 1,
      expectedAnswerPacketVersion: 1
    })),
    (error: unknown) => hasPublicErrorCode(error, "RUN_LIFECYCLE_STALE")
  );
});

test("same form with a relevant Vault edit creates only packet 2", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
  database.state.vault[0].answer = "https://www.linkedin.com/in/changed";
  database.state.vault[0].updatedAt = new Date("2026-08-21T10:00:00.000Z");

  const result = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  }));

  assert.equal(result.inspectionVersion, 1);
  assert.equal(result.packetVersion, 2);
  assert.equal(result.stateVersion, 5);
  assert.equal(database.state.inspections.length, 1);
  assert.equal(database.state.packets.length, 2);
});

test("form A to B to A creates monotonic inspection and packet versions without carry-forward", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());

  const b = report([field({ question: "Portfolio website" })]);
  const second = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1,
    inspectionReport: b
  }));
  const third = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 2,
    expectedAnswerPacketVersion: 2
  }));

  assert.deepEqual(
    [second.inspectionVersion, second.packetVersion, third.inspectionVersion, third.packetVersion],
    [2, 2, 3, 3]
  );
  assert.equal(database.state.packetAnswers.every((answer) => answer.status === "PENDING"), true);
});

test("current read verifies the packet without an automation or state gate and omits provenance", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
  database.state.policy!.enabled = false;
  database.state.run.state = "CANCELLED";

  const read = await packetService.getCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID });

  assert.equal(read.current?.packetVersion, 1);
  assert.equal(read.current?.answers[0].originalQuestion, "LinkedIn profile URL");
  assert.equal("sourceIds" in read.current!.answers[0], false);
  assert.equal("sourceFingerprint" in read.current!.answers[0], false);
  assert.equal("finalValueHash" in read.current!.answers[0], false);
  assert.equal(String(database.transactionIsolationLevels.at(-1)), "RepeatableRead");
});

test("current read returns null only for 0/0 and rejects every broken or unverifiable current artifact", async () => {
  const empty = new FakeAnswerPacketDatabase();
  assert.deepEqual(
    await service(empty).getCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID }),
    { runId: RUN_ID, current: null }
  );

  const corruptions: Array<[string, (database: FakeAnswerPacketDatabase) => void, string]> = [
    ["0/positive pointer", (database) => { database.state.run.currentFormInspectionVersion = 0; }, "RUN_PACKET_INVALID"],
    ["positive/0 pointer", (database) => { database.state.run.currentAnswerPacketVersion = 0; }, "RUN_PACKET_INVALID"],
    ["missing inspection", (database) => { database.state.inspections = []; }, "RUN_INSPECTION_INVALID"],
    ["missing packet", (database) => { database.state.packets = []; }, "RUN_PACKET_INVALID"],
    ["wrong packet binding", (database) => { database.state.packets[0].formInspectionId = "other"; }, "RUN_PACKET_INVALID"],
    ["unsupported inspection", (database) => {
      database.state.inspections[0].schemaVersion = Number(database.state.inspections[0].schemaVersion) + 1;
    }, "RUN_INSPECTION_STALE"],
    ["unsupported packet", (database) => {
      database.state.packets[0].builderVersion = Number(database.state.packets[0].builderVersion) + 1;
    }, "RUN_PACKET_INVALID"],
    ["invalid snapshot", (database) => { database.state.inspections[0].normalizedSnapshot = {}; }, "RUN_INSPECTION_INVALID"],
    ["form fingerprint mismatch", (database) => { database.state.inspections[0].formFingerprint = "0".repeat(64); }, "RUN_INSPECTION_INVALID"],
    ["packet hash mismatch", (database) => { database.state.packets[0].packetHash = "0".repeat(64); }, "RUN_PACKET_INVALID"],
    ["missing answer", (database) => { database.state.packetAnswers = []; }, "RUN_PACKET_INVALID"],
    ["extra answer", (database) => { database.state.packetAnswers.push({ ...cloneState(database.state.packetAnswers[0]), id: "extra" }); }, "RUN_PACKET_INVALID"],
    ["legacy packet review hash", (database) => { database.state.packetAnswers[0].reviewHashVersion = "LEGACY_SCALAR_SHA256"; }, "RUN_PACKET_INVALID"]
  ];

  for (const [label, mutate, expectedCode] of corruptions) {
    const database = new FakeAnswerPacketDatabase();
    const packetService = service(database);
    await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
    mutate(database);
    await assert.rejects(
      packetService.getCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID }),
      (error: unknown) => assertPublicErrorCode(error, expectedCode, label)
    );
  }
});

test("fresh publication advances beyond unsupported historical inspection or packet versions", async () => {
  const staleInspection = new FakeAnswerPacketDatabase();
  const staleInspectionService = service(staleInspection);
  await staleInspectionService.publishFormInspectionAndAnswerPacket(publicationInput());
  staleInspection.state.inspections[0].normalizerVersion =
    Number(staleInspection.state.inspections[0].normalizerVersion) + 1;
  const newInspection = await staleInspectionService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  }));
  assert.deepEqual([newInspection.inspectionVersion, newInspection.packetVersion], [2, 2]);

  const stalePacket = new FakeAnswerPacketDatabase();
  const stalePacketService = service(stalePacket);
  await stalePacketService.publishFormInspectionAndAnswerPacket(publicationInput());
  stalePacket.state.packets[0].builderVersion = Number(stalePacket.state.packets[0].builderVersion) + 1;
  const replacementPacket = await stalePacketService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  }));
  assert.deepEqual([replacementPacket.inspectionVersion, replacementPacket.packetVersion], [1, 2]);
});

test("material rebuild creates packet N+1 without creating an inspection", async () => {
  const database = new FakeAnswerPacketDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
  database.state.vault[0].answer = "https://www.linkedin.com/in/rebuilt";
  database.state.vault[0].updatedAt = new Date("2026-08-22T10:00:00.000Z");

  const rebuilt = await packetService.rebuildCurrentAnswerPacket({
    userId: USER_ID,
    runId: RUN_ID,
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  });

  assert.equal(rebuilt.replayed, false);
  assert.equal(rebuilt.inspectionVersion, 1);
  assert.equal(rebuilt.packetVersion, 2);
  assert.equal(database.state.inspections.length, 1);
});

test("exact rebuild replays before artifact-counter fences, while rebuild gates and inspection integrity remain mandatory", async () => {
  const exact = new FakeAnswerPacketDatabase();
  const exactService = service(exact);
  await exactService.publishFormInspectionAndAnswerPacket(publicationInput());
  const before = cloneState(exact.state);
  const replay = await exactService.rebuildCurrentAnswerPacket({
    userId: USER_ID,
    runId: RUN_ID,
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 0,
    expectedAnswerPacketVersion: 0
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(exact.state, before);

  const disabled = new FakeAnswerPacketDatabase();
  const disabledService = service(disabled);
  await disabledService.publishFormInspectionAndAnswerPacket(publicationInput());
  disabled.state.policy!.enabled = false;
  await assert.rejects(
    disabledService.rebuildCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 5,
      expectedFormInspectionVersion: 1, expectedAnswerPacketVersion: 1 }),
    (error: unknown) => hasPublicErrorCode(error, "AUTOMATION_DISABLED")
  );

  const disallowedHost = new FakeAnswerPacketDatabase();
  const disallowedService = service(disallowedHost);
  await disallowedService.publishFormInspectionAndAnswerPacket(publicationInput());
  disallowedHost.state.policy!.allowedHosts = [];
  await assert.rejects(
    disallowedService.rebuildCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 5,
      expectedFormInspectionVersion: 1, expectedAnswerPacketVersion: 1 }),
    (error: unknown) => hasPublicErrorCode(error, "RUN_HOST_NOT_ALLOWED")
  );

  for (const [label, mutate, code] of [
    ["invalid", (database: FakeAnswerPacketDatabase) => { database.state.inspections[0].normalizedSnapshot = {}; }, "RUN_INSPECTION_INVALID"],
    ["unsupported", (database: FakeAnswerPacketDatabase) => {
      database.state.inspections[0].classifierVersion =
        Number(database.state.inspections[0].classifierVersion) + 1;
    }, "RUN_INSPECTION_STALE"]
  ] as const) {
    const database = new FakeAnswerPacketDatabase();
    const packetService = service(database);
    await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
    mutate(database);
    await assert.rejects(
      packetService.rebuildCurrentAnswerPacket({ userId: USER_ID, runId: RUN_ID, expectedStateVersion: 5,
        expectedFormInspectionVersion: 1, expectedAnswerPacketVersion: 1 }),
      (error: unknown) => assertPublicErrorCode(error, code, label)
    );
  }
});

test("late transaction failures commit no packet, counters, token revocation, audit, or event", async () => {
  for (const failAt of ["answer-createMany", "run-update", "token-revoke", "publication-audit", "event-create"]) {
    const database = new FakeAnswerPacketDatabase();
    database.failAt = failAt;
    const before = cloneState(database.state);

    await assert.rejects(
      service(database).publishFormInspectionAndAnswerPacket(publicationInput()),
      new RegExp(`simulated ${failAt} failure`)
    );
    assert.deepEqual(database.state, before, failAt);
  }
});

test("capability and target fences fail closed before artifact writes, including replay", async () => {
  const disabledGlobal = new FakeAnswerPacketDatabase();
  await assert.rejects(
    service(disabledGlobal, { APPLICATION_AUTOMATION_ENABLED: "false" })
      .publishFormInspectionAndAnswerPacket(publicationInput()),
    (error: unknown) => hasPublicErrorCode(error, "AUTOMATION_DISABLED")
  );
  assert.equal(disabledGlobal.state.packets.length, 0);

  const disabledPolicy = new FakeAnswerPacketDatabase();
  disabledPolicy.state.policy!.enabled = false;
  await assert.rejects(
    service(disabledPolicy).publishFormInspectionAndAnswerPacket(publicationInput()),
    (error: unknown) => hasPublicErrorCode(error, "AUTOMATION_DISABLED")
  );

  const missingPolicy = new FakeAnswerPacketDatabase({ policy: null });
  await assert.rejects(
    service(missingPolicy).publishFormInspectionAndAnswerPacket(publicationInput()),
    (error: unknown) => hasPublicErrorCode(error, "AUTOMATION_DISABLED")
  );

  const staleTarget = new FakeAnswerPacketDatabase();
  await assert.rejects(
    service(staleTarget).publishFormInspectionAndAnswerPacket(publicationInput({
      observedUrl: "https://jobs.example.com/apply/other"
    })),
    (error: unknown) => hasPublicErrorCode(error, "RUN_TARGET_STALE")
  );

  for (const [label, mutatePolicy, observedUrl, expectedCode] of [
    ["blocked host", (policy: FakePolicy) => { policy.blockedHosts = ["example.com"]; }, undefined, "RUN_HOST_NOT_ALLOWED"],
    ["absent allowlist host", (policy: FakePolicy) => { policy.allowedHosts = ["other.example.com"]; }, undefined, "RUN_HOST_NOT_ALLOWED"],
    ["empty allowlist", (policy: FakePolicy) => { policy.allowedHosts = []; }, undefined, "RUN_HOST_NOT_ALLOWED"],
    ["observed host mismatch", () => {}, "https://other.example.com/apply/123", "RUN_TARGET_STALE"],
    ["observed query mismatch", () => {}, "https://jobs.example.com/apply/123?changed=1", "RUN_TARGET_STALE"]
  ] as const) {
    const fenced = new FakeAnswerPacketDatabase();
    mutatePolicy(fenced.state.policy!);
    await assert.rejects(
      service(fenced).publishFormInspectionAndAnswerPacket(publicationInput({
        ...(observedUrl ? { observedUrl } : {})
      })),
      (error: unknown) => assertPublicErrorCode(error, expectedCode, label)
    );
    assert.equal(fenced.state.packets.length, 0, label);
  }

  const replayDatabase = new FakeAnswerPacketDatabase();
  const replayService = service(replayDatabase);
  await replayService.publishFormInspectionAndAnswerPacket(publicationInput());
  const beforeReplay = cloneState(replayDatabase.state);
  replayDatabase.state.policy!.enabled = false;
  await assert.rejects(
    replayService.publishFormInspectionAndAnswerPacket(publicationInput({
      expectedStateVersion: 5,
      expectedFormInspectionVersion: 1,
      expectedAnswerPacketVersion: 1
    })),
    (error: unknown) => hasPublicErrorCode(error, "AUTOMATION_DISABLED")
  );
  assert.deepEqual(replayDatabase.state, { ...beforeReplay, policy: replayDatabase.state.policy });
});

test("257 eligible Vault rows fail closed without producing a truncated packet", async () => {
  const database = new FakeAnswerPacketDatabase();
  database.state.vault = Array.from({ length: 257 }, (_, index) => ({
    id: `vault-${String(index).padStart(3, "0")}`,
    userId: USER_ID,
    category: "LINKS",
    question: "LinkedIn profile URL",
    answer: `https://www.linkedin.com/in/example-${index}`,
    sensitive: false,
    isActive: true,
    updatedAt: new Date("2026-08-20T10:00:00.000Z")
  }));

  await assert.rejects(
    service(database).publishFormInspectionAndAnswerPacket(publicationInput()),
    (error: unknown) => hasPublicErrorCode(error, "RUN_ANSWER_SOURCE_SET_TOO_LARGE")
  );
  assert.equal(database.state.packets.length, 0);
});

test("source resolution is classification-bounded and returns deterministic zero, ambiguous, valid, and invalid outcomes", async () => {
  const noMatch = new FakeAnswerPacketDatabase({ vault: [] });
  await service(noMatch).publishFormInspectionAndAnswerPacket(publicationInput());
  assert.equal(noMatch.state.packetAnswers[0].disposition, "MANUAL_ONLY");
  assert.equal(noMatch.state.packetAnswers[0].dispositionReason, "NO_ELIGIBLE_SOURCE");
  assert.equal(noMatch.rawPacketAnswerWrites[0].proposal, Prisma.DbNull);

  const ambiguous = new FakeAnswerPacketDatabase();
  ambiguous.state.vault.push({
    ...cloneState(ambiguous.state.vault[0]),
    id: "vault-linkedin-2",
    answer: "https://www.linkedin.com/in/second"
  });
  await service(ambiguous).publishFormInspectionAndAnswerPacket(publicationInput());
  assert.equal(ambiguous.state.packetAnswers[0].disposition, "MANUAL_ONLY");
  assert.equal(ambiguous.state.packetAnswers[0].dispositionReason, "AMBIGUOUS_SOURCE");

  const ignored = new FakeAnswerPacketDatabase();
  ignored.state.vault.unshift(
    {
      ...cloneState(ignored.state.vault[0]),
      id: "inactive",
      isActive: false
    },
    {
      ...cloneState(ignored.state.vault[0]),
      id: "sensitive",
      sensitive: true
    },
    {
      ...cloneState(ignored.state.vault[0]),
      id: "wrong-category",
      category: "AVAILABILITY"
    },
    {
      ...cloneState(ignored.state.vault[0]),
      id: "wrong-classification",
      question: "When can you start?"
    },
    {
      ...cloneState(ignored.state.vault[0]),
      id: "null-semantic-key",
      question: "Website"
    }
  );
  await service(ignored).publishFormInspectionAndAnswerPacket(publicationInput());
  assert.equal(ignored.state.packetAnswers[0].disposition, "PROPOSABLE");
  assert.deepEqual(ignored.state.packetAnswers[0].sourceIds, ["vault-linkedin"]);
  const vaultQueryValues = ignored.queryValues.find((_, index) =>
    ignored.queryLog[index].includes('FROM "ApplicationAnswer"')
  );
  assert.deepEqual(vaultQueryValues, [USER_ID, true, false]);

  const incompatible = new FakeAnswerPacketDatabase();
  incompatible.state.vault[0].answer = "x".repeat(2_049);
  await service(incompatible).publishFormInspectionAndAnswerPacket(publicationInput());
  assert.equal(incompatible.state.packetAnswers[0].disposition, "MANUAL_ONLY");
  assert.equal(incompatible.state.packetAnswers[0].dispositionReason, "INVALID_SOURCE_VALUE");
});

test("source-prohibited and excluded fields perform no Vault query, and excluded persistence is plaintext-free", async () => {
  const database = new FakeAnswerPacketDatabase();
  const excludedQuestion = "What is your race?";
  const sourceAnswer = database.state.vault[0].answer;
  const observedPath = "/apply/123";
  const privacyReport = report([
    field({ question: excludedQuestion, fieldType: "SELECT_ONE", autocomplete: null, choices: [
      { label: "Prefer not to say", disabled: false }
    ] }),
    field({ question: "Are you legally authorized to work in the United States?", fieldType: "RADIO_GROUP", autocomplete: null,
      choices: [{ label: "Yes", disabled: false }, { label: "No", disabled: false }] })
  ]);

  await service(database).publishFormInspectionAndAnswerPacket(publicationInput({ inspectionReport: privacyReport }));

  assert.equal(database.queryLog.some((query) => query.includes('FROM "ApplicationAnswer"')), false);
  const excluded = database.state.packetAnswers.find((answer) => answer.disposition === "EXCLUDED");
  assert.ok(excluded);
  assert.equal(excluded.dispositionReason, "POLICY_EXCLUDED");
  assert.equal(excluded.sensitive, true);
  assert.equal(excluded.valueRedacted, true);
  assert.equal(excluded.proposal, null);
  assert.deepEqual(excluded.sourceIds, []);
  assert.equal(excluded.sourceFingerprint, null);
  const sideEffects = JSON.stringify({ audits: database.state.audits, events: database.state.events });
  assert.equal(sideEffects.includes(excludedQuestion), false);
  assert.equal(sideEffects.includes(sourceAnswer), false);
  assert.equal(sideEffects.includes(observedPath), false);
  assert.equal(sideEffects.includes("sourceFingerprint"), false);
});

test("irrelevant Vault changes replay, while exact relevant values and revisions change packet input identity", async () => {
  const database = new FakeAnswerPacketDatabase();
  database.state.vault.push({
    ...cloneState(database.state.vault[0]),
    id: "irrelevant",
    category: "OTHER",
    question: "Unrelated answer",
    answer: "before"
  });
  const packetService = service(database);
  const first = await packetService.publishFormInspectionAndAnswerPacket(publicationInput());
  database.state.vault[1].answer = "after";
  database.state.vault[1].updatedAt = new Date("2026-08-23T00:00:00.000Z");
  const replay = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  }));
  assert.equal(replay.replayed, true);

  database.state.vault[0].answer = "https://www.linkedin.com/in/material";
  database.state.vault[0].updatedAt = new Date("2026-08-24T00:00:00.000Z");
  const changed = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1
  }));
  assert.equal(changed.replayed, false);
  assert.notEqual(changed.packetHash, first.packetHash);
  assert.notEqual(database.state.packets[1].inputHash, database.state.packets[0].inputHash);
});

test("document references bind exact content and ignore cover-letter title-only updatedAt churn", async () => {
  const database = configuredDocumentDatabase();
  const packetService = service(database);
  const first = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    inspectionReport: documentReport()
  }));

  database.state.documents[0].title = "Changed title";
  database.state.documents[0].updatedAt = new Date("2026-08-25T00:00:00.000Z");
  const replay = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1,
    inspectionReport: documentReport()
  }));

  assert.equal(first.packet.answers.every((answer) => answer.proposal?.kind === "DOCUMENT_REFERENCE"), true);
  assert.equal(replay.replayed, true);
});

test("document absence is manual-only, and stale resume/cover bindings fail closed without publication", async () => {
  const absent = new FakeAnswerPacketDatabase();
  await service(absent).publishFormInspectionAndAnswerPacket(publicationInput({ inspectionReport: documentReport() }));
  assert.equal(absent.state.packetAnswers.length, 2);
  assert.equal(absent.state.packetAnswers.every((answer) =>
    answer.disposition === "MANUAL_ONLY" && answer.dispositionReason === "NO_SELECTED_DOCUMENT"
  ), true);

  const staleCases: Array<[string, (database: FakeAnswerPacketDatabase) => void]> = [
    ["missing resume", (database) => { database.state.resumes = []; }],
    ["resume owner", (database) => { database.state.resumes[0].userId = "other-user"; }],
    ["resume job", (database) => { database.state.resumes[0].jobPostingId = "other-job"; }],
    ["resume content", (database) => { database.state.resumes[0].fullText = "changed"; }],
    ["missing cover", (database) => { database.state.documents = []; }],
    ["cover owner", (database) => { database.state.documents[0].userId = "other-user"; }],
    ["cover job", (database) => { database.state.documents[0].jobPostingId = "other-job"; }],
    ["cover type", (database) => { database.state.documents[0].type = "RESUME"; }],
    ["cover content", (database) => { database.state.documents[0].content = "changed"; }]
  ];
  for (const [label, mutate] of staleCases) {
    const database = configuredDocumentDatabase();
    mutate(database);
    await assert.rejects(
      service(database).publishFormInspectionAndAnswerPacket(publicationInput({ inspectionReport: documentReport() })),
      (error: unknown) => assertPublicErrorCode(error, "RUN_DOCUMENT_STALE", label)
    );
    assert.equal(database.state.packets.length, 0, label);
  }
});

test("same-form document rebinding creates packet N+1 only and locks sources in the required order", async () => {
  const database = configuredDocumentDatabase();
  const packetService = service(database);
  await packetService.publishFormInspectionAndAnswerPacket(publicationInput({ inspectionReport: documentReport() }));
  const replacementText = "Replacement resume text";
  database.state.run.resumeVersionId = "resume-2";
  database.state.run.resumeContentHash = sha256(replacementText);
  database.state.resumes.push({
    id: "resume-2",
    userId: USER_ID,
    jobPostingId: JOB_ID,
    fullText: replacementText,
    createdAt: new Date("2026-08-03T00:00:00.000Z")
  });
  const beforeQueryCount = database.queryLog.length;
  const result = await packetService.publishFormInspectionAndAnswerPacket(publicationInput({
    expectedStateVersion: 5,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1,
    inspectionReport: documentReport()
  }));
  assert.equal(result.packetVersion, 2);
  assert.equal(result.inspectionVersion, 1);
  assert.equal(database.state.inspections.length, 1);
  const lockOrder = database.queryLog.slice(beforeQueryCount)
    .map((query) => query.match(/FROM "([^"]+)"/)?.[1])
    .filter(Boolean);
  assert.deepEqual(lockOrder, [
    "ApplicationAutomationPolicy",
    "ApplicationRun",
    "ResumeVersion",
    "GeneratedDocument"
  ]);
});
