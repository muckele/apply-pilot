import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationExecutionScope, ApplicationRunState } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  buildExecutionTokenCreateData,
  buildReplacementRevokeWhere,
  buildRevokeWhere,
  buildRunBoundRevokeWhere,
  buildUsableExecutionTokenWhereForRun,
  buildUsableExecutionTokenWhereForUser,
  canConsumeToken,
  createExecutionTokenService,
  EXECUTION_TOKEN_PATTERN,
  ExecutionTokenError,
  generateExecutionToken,
  hashExecutionToken,
  isReplacementCandidate,
  isReusableAuthorizable,
  isSingleUseConsumable,
  isTokenConsumed,
  isTokenExpired,
  isTokenLive,
  isTokenRevoked,
  READ_TOKEN_ISSUABLE_RUN_STATES,
  READ_TOKEN_TTL_MS,
  revokeUsableExecutionTokensForRunInTransaction,
  revokeUsableExecutionTokensForUserInTransaction,
  type ExecutionTokenBindingInput,
  type ExecutionTokenPrismaClient,
  type ExecutionTokenRevocationTransaction,
  type ExecutionTokenSnapshot,
  type ExpectedTokenBinding,
  type IssueExecutionTokenInput,
  type RevokeExecutionTokenInput,
  type RevokeExecutionTokenForRunInput,
  type TokenSlot
} from "@/lib/application-runs/execution-token";

const T0 = new Date("2026-08-16T12:00:00.000Z");

function snapshot(overrides: Partial<ExecutionTokenSnapshot> = {}): ExecutionTokenSnapshot {
  return {
    userId: "user-1",
    runId: "run-1",
    host: "jobs.example.com",
    scope: "APPLICATION_READ",
    singleUse: false,
    consumedAt: null,
    revokedAt: null,
    expiresAt: new Date(T0.getTime() + READ_TOKEN_TTL_MS),
    ...overrides
  };
}

function expected(overrides: Partial<ExpectedTokenBinding> = {}): ExpectedTokenBinding {
  return {
    userId: "user-1",
    runId: "run-1",
    host: "jobs.example.com",
    scope: "APPLICATION_READ",
    ...overrides
  };
}

function slot(overrides: Partial<TokenSlot> = {}): TokenSlot {
  return {
    userId: "user-1",
    runId: "run-1",
    host: "jobs.example.com",
    scope: "APPLICATION_READ",
    singleUse: false,
    ...overrides
  };
}

test("generated token uses aet_ plus 43 base64url characters", () => {
  const { token } = generateExecutionToken();
  assert.match(token, /^aet_[A-Za-z0-9_-]{43}$/);
});

test("generated token hash is a 64-character lowercase SHA-256 hex string", () => {
  const { tokenHash } = generateExecutionToken();
  assert.match(tokenHash, /^[a-f0-9]{64}$/);
});

test("raw token differs from its persisted hash", () => {
  const { token, tokenHash } = generateExecutionToken();
  assert.notEqual(token, tokenHash);
});

test("hashing is deterministic", () => {
  const raw = "aet_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  assert.equal(hashExecutionToken(raw), hashExecutionToken(raw));
});

test("separately generated tokens differ", () => {
  const first = generateExecutionToken();
  const second = generateExecutionToken();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
});

test("display prefix is safe and derived from the token prefix only", () => {
  const { token, tokenPrefix } = generateExecutionToken();
  assert.equal(tokenPrefix, `${token.slice(0, 12)}...`);
  assert.equal(tokenPrefix.length, 15);
  assert.notEqual(tokenPrefix, token);
});

test("READ TTL is exactly 15 minutes", () => {
  assert.equal(READ_TOKEN_TTL_MS, 15 * 60 * 1000);
});

test("READ create data is reusable and expires exactly at now plus TTL", () => {
  const generated = generateExecutionToken();
  const data = buildExecutionTokenCreateData(
    {
      userId: "user-1",
      runId: "run-1",
      host: "jobs.example.com",
      scope: "APPLICATION_READ",
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix
    },
    T0
  );

  assert.equal(data.singleUse, false);
  assert.ok(data.expiresAt instanceof Date);
  assert.equal(data.expiresAt.getTime(), T0.getTime() + READ_TOKEN_TTL_MS);
});

test("create data never contains the raw token", () => {
  const generated = generateExecutionToken();
  const data = buildExecutionTokenCreateData(
    {
      userId: "user-1",
      runId: "run-1",
      host: "jobs.example.com",
      scope: "APPLICATION_READ",
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix
    },
    T0
  );

  assert.ok(!("token" in data));
  for (const value of Object.values(data)) {
    assert.notEqual(value, generated.token);
  }
});

test("non-READ issuance is unavailable", () => {
  const generated = generateExecutionToken();

  assert.throws(
    () =>
      buildExecutionTokenCreateData(
        {
          userId: "user-1",
          runId: "run-1",
          host: "jobs.example.com",
          scope: "APPLICATION_FILL",
          tokenHash: generated.tokenHash,
          tokenPrefix: generated.tokenPrefix
        },
        T0
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ExecutionTokenError" &&
      error.message.includes("not available")
  );
});

test("just before expiration is live", () => {
  const record = snapshot();
  const now = new Date(record.expiresAt.getTime() - 1);
  assert.equal(isTokenExpired(record, now), false);
  assert.equal(isTokenLive(record, now), true);
});

test("exact expiration is expired", () => {
  const record = snapshot();
  assert.equal(isTokenExpired(record, record.expiresAt), true);
  assert.equal(isTokenLive(record, record.expiresAt), false);
});

test("after expiration is expired", () => {
  const record = snapshot();
  const now = new Date(record.expiresAt.getTime() + 1);
  assert.equal(isTokenExpired(record, now), true);
  assert.equal(isTokenLive(record, now), false);
});

test("fresh READ token is neither revoked nor consumed", () => {
  const record = snapshot();
  assert.equal(isTokenRevoked(record), false);
  assert.equal(isTokenConsumed(record), false);
});

test("revoked token is not live", () => {
  const record = snapshot({ revokedAt: T0 });
  assert.equal(isTokenRevoked(record), true);
  assert.equal(isTokenLive(record, T0), false);
});

test("consumed single-use token is not live", () => {
  const record = snapshot({ singleUse: true, consumedAt: T0 });
  assert.equal(isTokenConsumed(record), true);
  assert.equal(isTokenLive(record, T0), false);
});

test("reusable READ may remain live during its TTL even if consumedAt is populated", () => {
  const record = snapshot({ singleUse: false, consumedAt: T0 });
  assert.equal(isTokenLive(record, T0), true);
  assert.equal(canConsumeToken(record, T0), false);
});

test("reusable authorization accepts only a fully matching reusable live token", () => {
  const record = snapshot();
  assert.equal(isReusableAuthorizable(record, expected(), T0), true);

  assert.equal(isReusableAuthorizable(record, expected({ userId: "other-user" }), T0), false);
  assert.equal(isReusableAuthorizable(record, expected({ runId: "other-run" }), T0), false);
  assert.equal(isReusableAuthorizable(record, expected({ host: "other.example.com" }), T0), false);
  assert.equal(isReusableAuthorizable(record, expected({ scope: "APPLICATION_FILL" }), T0), false);
  assert.equal(isReusableAuthorizable({ ...record, singleUse: true }, expected(), T0), false);
  assert.equal(isReusableAuthorizable({ ...record, revokedAt: T0 }, expected(), T0), false);
  assert.equal(isReusableAuthorizable({ ...record, expiresAt: T0 }, expected(), T0), false);
});

test("single-use consumption accepts only a fully matching unconsumed live single-use token", () => {
  const record = snapshot({ singleUse: true });
  assert.equal(isSingleUseConsumable(record, expected(), T0), true);

  assert.equal(isSingleUseConsumable(record, expected({ userId: "other-user" }), T0), false);
  assert.equal(isSingleUseConsumable(record, expected({ runId: "other-run" }), T0), false);
  assert.equal(isSingleUseConsumable(record, expected({ host: "other.example.com" }), T0), false);
  assert.equal(isSingleUseConsumable(record, expected({ scope: "APPLICATION_FILL" }), T0), false);
  assert.equal(isSingleUseConsumable({ ...record, singleUse: false }, expected(), T0), false);
  assert.equal(isSingleUseConsumable({ ...record, consumedAt: T0 }, expected(), T0), false);
  assert.equal(isSingleUseConsumable({ ...record, revokedAt: T0 }, expected(), T0), false);
  assert.equal(isSingleUseConsumable({ ...record, expiresAt: T0 }, expected(), T0), false);
});

test("READ reusable token cannot be consumed", () => {
  const record = snapshot({ singleUse: false });
  assert.equal(canConsumeToken(record, T0), false);
  assert.equal(isSingleUseConsumable(record, expected(), T0), false);
});

test("replacement predicate selects only equivalent unconsumed and unrevoked predecessors", () => {
  const record = snapshot();

  assert.equal(isReplacementCandidate(record, slot()), true);
  assert.equal(isReplacementCandidate(record, slot({ userId: "other-user" })), false);
  assert.equal(isReplacementCandidate(record, slot({ runId: "other-run" })), false);
  assert.equal(isReplacementCandidate(record, slot({ host: "other.example.com" })), false);
  assert.equal(isReplacementCandidate(record, slot({ scope: "APPLICATION_FILL" })), false);
  assert.equal(isReplacementCandidate(record, slot({ singleUse: true })), false);
  assert.equal(isReplacementCandidate({ ...record, expiresAt: new Date(T0.getTime() - 1) }, slot()), true);
  assert.equal(isReplacementCandidate({ ...record, revokedAt: T0 }, slot()), false);
  assert.equal(isReplacementCandidate({ ...record, consumedAt: T0 }, slot()), false);
});

test("replacement database predicate is exact and excludes revoked or consumed rows", () => {
  assert.deepEqual(buildReplacementRevokeWhere(slot()), {
    userId: "user-1",
    runId: "run-1",
    host: "jobs.example.com",
    scope: "APPLICATION_READ",
    singleUse: false,
    revokedAt: null,
    consumedAt: null
  });
});

test("revocation database predicate is ownership-scoped and idempotency-compatible", () => {
  assert.deepEqual(buildRevokeWhere({ userId: "user-1", tokenId: "token-1" }), {
    id: "token-1",
    userId: "user-1",
    revokedAt: null
  });
});

test("run-bound and bulk revocation predicates retain every required binding", () => {
  assert.deepEqual(buildRunBoundRevokeWhere({ userId: "user-1", runId: "run-1", tokenId: "token-1" }), {
    id: "token-1",
    userId: "user-1",
    runId: "run-1",
    revokedAt: null
  });
  assert.deepEqual(
    buildUsableExecutionTokenWhereForUser({ userId: "user-1", now: T0, reason: "policy_changed" }),
    {
      userId: "user-1",
      revokedAt: null,
      expiresAt: { gt: T0 },
      OR: [{ singleUse: false }, { singleUse: true, consumedAt: null }]
    }
  );
  assert.equal(
    "runId" in buildUsableExecutionTokenWhereForUser({
      userId: "user-1",
      runId: "must-not-narrow-user-revocation",
      now: T0,
      reason: "policy_changed"
    } as Parameters<typeof buildUsableExecutionTokenWhereForUser>[0]),
    false
  );
  assert.deepEqual(
    buildUsableExecutionTokenWhereForRun({
      userId: "user-1",
      runId: "run-1",
      now: T0,
      reason: "run_cancelled"
    }),
    {
      userId: "user-1",
      runId: "run-1",
      revokedAt: null,
      expiresAt: { gt: T0 },
      OR: [{ singleUse: false }, { singleUse: true, consumedAt: null }]
    }
  );
  assert.throws(() =>
    buildUsableExecutionTokenWhereForRun({
      userId: "user-1",
      runId: "",
      now: T0,
      reason: "run_cancelled"
    })
  );
});

test("execution scope enum contains no SUBMIT scope", () => {
  assert.equal(Object.values(ApplicationExecutionScope).includes("SUBMIT" as ApplicationExecutionScope), false);
});

// ---------------------------------------------------------------------------
// Actual service behavior through a narrow in-memory Prisma transaction seam
// ---------------------------------------------------------------------------

const ISSUE_TIME = new Date("2026-08-20T18:00:00.000Z");
const RAW_READ_TOKEN = `aet_${"R".repeat(43)}`;
const RAW_FILL_TOKEN = `aet_${"F".repeat(43)}`;

type FakePolicy = {
  id: string;
  userId: string;
  enabled: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
};

type FakeRun = {
  id: string;
  userId: string;
  state: ApplicationRunState;
  applicationId: string;
  jobPostingId: string;
  applyUrlSnapshot: string;
  applyHost: string;
  application: { userId: string; jobPostingId: string };
  jobPosting: { userId: string };
};

type FakeToken = ExecutionTokenSnapshot & {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

type FakeAudit = {
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

function argumentRecord(value: unknown, field: string): Record<string, unknown> {
  const container = record(value);
  return record(container[field]);
}

function cloneToken(token: FakeToken): FakeToken {
  return {
    ...token,
    consumedAt: token.consumedAt ? new Date(token.consumedAt) : null,
    lastUsedAt: token.lastUsedAt ? new Date(token.lastUsedAt) : null,
    expiresAt: new Date(token.expiresAt),
    revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
    createdAt: new Date(token.createdAt)
  };
}

function fakePolicy(overrides: Partial<FakePolicy> = {}): FakePolicy {
  return {
    id: "policy-1",
    userId: "user-1",
    enabled: true,
    allowedHosts: ["example.com"],
    blockedHosts: [],
    ...overrides
  };
}

function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    id: "run-1",
    userId: "user-1",
    state: "READY",
    applicationId: "application-1",
    jobPostingId: "job-1",
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    applyHost: "jobs.example.com",
    application: { userId: "user-1", jobPostingId: "job-1" },
    jobPosting: { userId: "user-1" },
    ...overrides
  };
}

function fakeToken(overrides: Partial<FakeToken> = {}): FakeToken {
  return {
    id: "token-1",
    userId: "user-1",
    runId: "run-1",
    tokenHash: hashExecutionToken(RAW_READ_TOKEN),
    tokenPrefix: `${RAW_READ_TOKEN.slice(0, 12)}...`,
    host: "jobs.example.com",
    scope: "APPLICATION_READ",
    singleUse: false,
    consumedAt: null,
    lastUsedAt: null,
    expiresAt: new Date(ISSUE_TIME.getTime() + READ_TOKEN_TTL_MS),
    revokedAt: null,
    createdAt: new Date(ISSUE_TIME),
    ...overrides
  };
}

function deterministicGeneratedToken() {
  return {
    token: RAW_READ_TOKEN,
    tokenHash: hashExecutionToken(RAW_READ_TOKEN),
    tokenPrefix: `${RAW_READ_TOKEN.slice(0, 12)}...`
  };
}

function matchesTokenWhere(token: FakeToken, where: Record<string, unknown>): boolean {
  for (const [key, expectedValue] of Object.entries(where)) {
    if (expectedValue === undefined) continue; // Mirrors Prisma's default undefined omission.
    if (key === "OR") {
      const clauses = expectedValue as Record<string, unknown>[];
      if (!clauses.some((clause) => matchesTokenWhere(token, clause))) return false;
      continue;
    }
    if (key === "expiresAt") {
      const comparison = record(expectedValue);
      if (comparison.gt instanceof Date && token.expiresAt.getTime() <= comparison.gt.getTime()) return false;
      continue;
    }
    const actualValue = token[key as keyof FakeToken];
    if (expectedValue === null) {
      if (actualValue !== null) return false;
      continue;
    }
    if (actualValue !== expectedValue) return false;
  }
  return true;
}

class FakeExecutionTokenDatabase {
  policy: FakePolicy | null = fakePolicy();
  run: FakeRun | null = fakeRun();
  tokens: FakeToken[] = [];
  audits: FakeAudit[] = [];
  operations: string[] = [];
  createPayloads: Record<string, unknown>[] = [];
  failAudit = false;
  failNextTokenRead = false;
  private nextTokenNumber = 100;

  readonly client = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => this.transaction(callback),
    applicationExecutionToken: this.tokenDelegate()
  } as unknown as ExecutionTokenPrismaClient;

  addToken(overrides: Partial<FakeToken> = {}): FakeToken {
    const token = fakeToken(overrides);
    this.tokens.push(token);
    return token;
  }

  private tokenWithRun(token: FakeToken) {
    return {
      ...cloneToken(token),
      run: {
        applicationId: this.run?.applicationId ?? "missing-application",
        jobPostingId: this.run?.jobPostingId ?? "missing-job"
      }
    };
  }

  private tokenDelegate() {
    return {
      updateMany: async (args: unknown) => {
        this.operations.push("token.updateMany");
        const where = argumentRecord(args, "where");
        const data = argumentRecord(args, "data");
        const matches = this.tokens.filter((token) => matchesTokenWhere(token, where));
        for (const token of matches) {
          for (const [key, value] of Object.entries(data)) {
            (token as unknown as Record<string, unknown>)[key] = value;
          }
        }
        return { count: matches.length };
      },
      create: async (args: unknown) => {
        this.operations.push("token.create");
        const data = argumentRecord(args, "data");
        this.createPayloads.push(structuredClone(data));
        const expiresAt = data.expiresAt as Date;
        const created: FakeToken = fakeToken({
          id: `token-${this.nextTokenNumber++}`,
          userId: data.userId as string,
          runId: data.runId as string,
          tokenHash: data.tokenHash as string,
          tokenPrefix: data.tokenPrefix as string,
          host: data.host as string,
          scope: data.scope as ApplicationExecutionScope,
          singleUse: data.singleUse as boolean,
          consumedAt: null,
          lastUsedAt: null,
          expiresAt,
          revokedAt: null,
          createdAt: new Date(expiresAt.getTime() - READ_TOKEN_TTL_MS)
        });
        this.tokens.push(created);
        return cloneToken(created);
      },
      findUnique: async (args: unknown) => {
        this.operations.push("token.findUnique");
        if (this.failNextTokenRead) {
          this.failNextTokenRead = false;
          throw new Error("simulated authoritative token read failure");
        }
        const where = argumentRecord(args, "where");
        const found = this.tokens.find((token) => matchesTokenWhere(token, where));
        return found ? this.tokenWithRun(found) : null;
      },
      findFirst: async (args: unknown) => {
        this.operations.push("token.findFirst");
        const where = argumentRecord(args, "where");
        const found = this.tokens.find((token) => matchesTokenWhere(token, where));
        return found ? this.tokenWithRun(found) : null;
      }
    };
  }

  private transactionClient() {
    return {
      $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
        const query = strings.join("?");
        if (query.includes("ApplicationAutomationPolicy")) {
          this.operations.push("policy.lock");
          const userId = values[0];
          const policy = this.policy;
          return (policy !== null && policy.userId === userId ? [{ id: policy.id }] : []) as T;
        }
        if (query.includes("ApplicationRun")) {
          this.operations.push("run.lock");
          const [runId, userId] = values;
          const run = this.run;
          return (run !== null && run.id === runId && run.userId === userId ? [{ id: run.id }] : []) as T;
        }
        throw new Error("Unexpected raw query");
      },
      applicationAutomationPolicy: {
        findUnique: async () => {
          this.operations.push("policy.findUnique");
          return this.policy ? structuredClone(this.policy) : null;
        }
      },
      applicationRun: {
        findUnique: async () => {
          this.operations.push("run.findUnique");
          return this.run ? structuredClone(this.run) : null;
        }
      },
      applicationExecutionToken: this.tokenDelegate(),
      auditLog: {
        create: async (args: unknown) => {
          this.operations.push("audit.create");
          if (this.failAudit) throw new Error("simulated audit failure");
          const data = argumentRecord(args, "data") as FakeAudit;
          this.audits.push(structuredClone(data));
          return structuredClone(data);
        }
      }
    };
  }

  private async transaction(callback: (transaction: unknown) => Promise<unknown>) {
    this.operations.push("transaction.begin");
    const tokensBefore = this.tokens.map(cloneToken);
    const auditsBefore = structuredClone(this.audits);
    const payloadsBefore = structuredClone(this.createPayloads);
    const nextTokenBefore = this.nextTokenNumber;
    try {
      const result = await callback(this.transactionClient());
      this.operations.push("transaction.commit");
      return result;
    } catch (error) {
      this.tokens = tokensBefore;
      this.audits = auditsBefore;
      this.createPayloads = payloadsBefore;
      this.nextTokenNumber = nextTokenBefore;
      this.operations.push("transaction.rollback");
      throw error;
    }
  }
}

function serviceFor(
  database: FakeExecutionTokenDatabase,
  overrides: {
    clock?: () => Date;
    tokenGenerator?: typeof deterministicGeneratedToken;
    env?: Readonly<Record<string, string | undefined>>;
  } = {}
) {
  return createExecutionTokenService({
    prismaClient: database.client,
    clock: overrides.clock ?? (() => new Date(ISSUE_TIME)),
    tokenGenerator: overrides.tokenGenerator ?? deterministicGeneratedToken,
    env: overrides.env ?? { APPLICATION_AUTOMATION_ENABLED: "true" }
  });
}

function issueInput(overrides: Partial<IssueExecutionTokenInput> = {}): IssueExecutionTokenInput {
  return {
    userId: "user-1",
    runId: "run-1",
    scope: "APPLICATION_READ",
    ...overrides
  };
}

function bindingInput(
  overrides: Omit<Partial<ExecutionTokenBindingInput>, "expected"> & { expected?: Partial<ExpectedTokenBinding> } = {}
): ExecutionTokenBindingInput {
  const { expected: expectedOverrides, ...bindingOverrides } = overrides;

  return {
    rawToken: RAW_READ_TOKEN,
    ...bindingOverrides,
    expected: expected(expectedOverrides)
  };
}

function isTokenError(code: string, status?: number) {
  return (error: unknown) =>
    error instanceof ExecutionTokenError && error.details?.code === code && (status === undefined || error.status === status);
}

test("runtime revocation validation rejects undefined and blank identifiers before any database call", async () => {
  const invalid = [
    { userId: "user-1", tokenId: undefined },
    { userId: undefined, tokenId: "token-1" },
    { userId: undefined, tokenId: undefined },
    { userId: "", tokenId: "token-1" },
    { userId: "user-1", tokenId: "   " }
  ];

  for (const value of invalid) {
    const database = new FakeExecutionTokenDatabase();
    await assert.rejects(
      serviceFor(database).revokeExecutionToken(value as unknown as RevokeExecutionTokenInput),
      isTokenError("EXECUTION_TOKEN_NOT_FOUND", 404)
    );
    assert.deepEqual(database.operations, []);
  }
});

test("security-sensitive exported builders reject malformed runtime identifiers and slots", () => {
  assert.throws(
    () => buildRevokeWhere({ userId: "user-1", tokenId: undefined } as unknown as { userId: string; tokenId: string }),
    isTokenError("EXECUTION_TOKEN_NOT_FOUND")
  );
  assert.throws(
    () => buildReplacementRevokeWhere({ ...slot(), runId: undefined } as unknown as TokenSlot),
    isTokenError("EXECUTION_TOKEN_DATA_INVALID")
  );
  assert.equal(isTokenLive(undefined as unknown as ExecutionTokenSnapshot, T0), false);
  assert.equal(isReusableAuthorizable({ ...snapshot(), expiresAt: undefined } as unknown as ExecutionTokenSnapshot, expected(), T0), false);
  assert.equal(isSingleUseConsumable(undefined as unknown as ExecutionTokenSnapshot, expected(), T0), false);
  assert.equal(isReplacementCandidate(undefined as unknown as ExecutionTokenSnapshot, slot()), false);
});

test("malformed bearer tokens and bindings fail generically before hashing/querying", async () => {
  const malformed: unknown[] = [
    undefined,
    {},
    { rawToken: undefined, expected: expected() },
    { rawToken: "jmc_" + "A".repeat(43), expected: expected() },
    { rawToken: "aet_" + "A".repeat(42), expected: expected() },
    { rawToken: "aet_" + "A".repeat(44), expected: expected() },
    { rawToken: "aet_" + "A".repeat(42) + "!", expected: expected() },
    { rawToken: RAW_READ_TOKEN },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), userId: undefined } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), runId: undefined } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), host: undefined } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), scope: undefined } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), userId: "" } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), runId: "   " } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), host: "" } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), host: "Jobs.Example.com" } },
    { rawToken: RAW_READ_TOKEN, expected: { ...expected(), scope: "INVALID" } }
  ];

  for (const value of malformed) {
    for (const operation of ["authorize", "consume"] as const) {
      const database = new FakeExecutionTokenDatabase();
      const service = serviceFor(database);
      const request = value as ExecutionTokenBindingInput;
      await assert.rejects(
        operation === "authorize"
          ? service.authorizeReusableExecutionToken(request)
          : service.consumeSingleUseExecutionToken(request),
        isTokenError("EXECUTION_TOKEN_INVALID", 401)
      );
      assert.deepEqual(database.operations, []);
    }
  }
});

test("the exact raw-token structural pattern is enforced", () => {
  assert.equal(EXECUTION_TOKEN_PATTERN.test(RAW_READ_TOKEN), true);
  assert.equal(EXECUTION_TOKEN_PATTERN.test(`aet_${"A".repeat(42)}`), false);
  assert.equal(EXECUTION_TOKEN_PATTERN.test(`aet_${"A".repeat(42)}!`), false);
  assert.equal(EXECUTION_TOKEN_PATTERN.test(`jmc_${"A".repeat(43)}`), false);
});

test("issuance rejects unsupported runtime scopes before database access", async () => {
  for (const scope of ["APPLICATION_FILL", "APPLICATION_EVENT_WRITE", "INVALID", undefined]) {
    const database = new FakeExecutionTokenDatabase();
    await assert.rejects(
      serviceFor(database).issueExecutionToken({ ...issueInput(), scope } as unknown as IssueExecutionTokenInput),
      isTokenError("EXECUTION_TOKEN_SCOPE_UNAVAILABLE", 409)
    );
    assert.deepEqual(database.operations, []);
  }
});

test("issuance rejects missing and blank identifiers before database access", async () => {
  for (const input of [
    { ...issueInput(), userId: undefined },
    { ...issueInput(), runId: undefined },
    { ...issueInput(), userId: "" },
    { ...issueInput(), runId: "   " }
  ]) {
    const database = new FakeExecutionTokenDatabase();
    await assert.rejects(
      serviceFor(database).issueExecutionToken(input as unknown as IssueExecutionTokenInput),
      isTokenError("RUN_NOT_FOUND", 404)
    );
    assert.deepEqual(database.operations, []);
  }
});

test("issuance fails closed for missing policy, global disablement, and policy disablement", async () => {
  const missing = new FakeExecutionTokenDatabase();
  missing.policy = null;
  await assert.rejects(serviceFor(missing).issueExecutionToken(issueInput()), isTokenError("AUTOMATION_DISABLED", 403));

  const globalDisabled = new FakeExecutionTokenDatabase();
  await assert.rejects(
    serviceFor(globalDisabled, { env: { APPLICATION_AUTOMATION_ENABLED: "false" } }).issueExecutionToken({
      ...issueInput(),
      env: { APPLICATION_AUTOMATION_ENABLED: "true" }
    } as unknown as IssueExecutionTokenInput),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "AUTOMATION_DISABLED"
  );

  const policyDisabled = new FakeExecutionTokenDatabase();
  policyDisabled.policy = fakePolicy({ enabled: false });
  await assert.rejects(serviceFor(policyDisabled).issueExecutionToken(issueInput()), (error: unknown) =>
    error instanceof PublicApiError && error.details?.code === "AUTOMATION_DISABLED"
  );
});

test("issuance hides a wrong-user run behind RUN_NOT_FOUND", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.policy = fakePolicy({ userId: "user-2" });
  await assert.rejects(
    serviceFor(database).issueExecutionToken(issueInput({ userId: "user-2" })),
    isTokenError("RUN_NOT_FOUND", 404)
  );
});

test("APPLICATION_READ issuance allows exactly READY and REVIEW_REQUIRED", async () => {
  assert.deepEqual(READ_TOKEN_ISSUABLE_RUN_STATES, ["READY", "REVIEW_REQUIRED"]);
  const allStates = Object.values(ApplicationRunState);
  for (const state of allStates) {
    const database = new FakeExecutionTokenDatabase();
    database.run = fakeRun({ state });
    const operation = serviceFor(database).issueExecutionToken(issueInput());
    if (state === "READY" || state === "REVIEW_REQUIRED") {
      const issued = await operation;
      assert.equal(issued.token, RAW_READ_TOKEN);
    } else {
      await assert.rejects(operation, isTokenError("RUN_INVALID_STATE", 409));
      assert.equal(database.tokens.length, 0);
    }
  }
});

test("issuance rejects cross-user application, cross-user job, and application/job mismatch", async () => {
  const runs = [
    fakeRun({ application: { userId: "other-user", jobPostingId: "job-1" } }),
    fakeRun({ jobPosting: { userId: "other-user" } }),
    fakeRun({ application: { userId: "user-1", jobPostingId: "other-job" } })
  ];
  for (const run of runs) {
    const database = new FakeExecutionTokenDatabase();
    database.run = run;
    await assert.rejects(serviceFor(database).issueExecutionToken(issueInput()), isTokenError("RUN_NOT_FOUND", 404));
    assert.equal(database.tokens.length, 0);
  }
});

test("issuance rejects blocked/disallowed hosts and URL-to-stored-host mismatch", async () => {
  const blocked = new FakeExecutionTokenDatabase();
  blocked.policy = fakePolicy({ blockedHosts: ["jobs.example.com"] });
  await assert.rejects(
    serviceFor(blocked).issueExecutionToken(issueInput()),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "RUN_HOST_NOT_ALLOWED"
  );

  const disallowed = new FakeExecutionTokenDatabase();
  disallowed.policy = fakePolicy({ allowedHosts: ["other.example"] });
  await assert.rejects(
    serviceFor(disallowed).issueExecutionToken(issueInput()),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "RUN_HOST_NOT_ALLOWED"
  );

  const mismatch = new FakeExecutionTokenDatabase();
  mismatch.run = fakeRun({ applyHost: "other.example.com" });
  await assert.rejects(serviceFor(mismatch).issueExecutionToken(issueInput()), isTokenError("RUN_HOST_NOT_ALLOWED", 403));
});

test("issuance clocks TTL after authoritative checks and orders supersession before create and audit", async () => {
  const database = new FakeExecutionTokenDatabase();
  const clock = () => {
    database.operations.push("clock.now");
    return new Date(ISSUE_TIME);
  };
  const issued = await serviceFor(database, { clock }).issueExecutionToken({
    ...issueInput(),
    now: new Date("2000-01-01T00:00:00.000Z")
  } as unknown as IssueExecutionTokenInput);

  assert.equal(issued.tokenRecord.expiresAt.getTime(), ISSUE_TIME.getTime() + READ_TOKEN_TTL_MS);
  assert.ok(database.operations.indexOf("clock.now") > database.operations.indexOf("run.findUnique"));
  assert.ok(database.operations.indexOf("token.updateMany") < database.operations.indexOf("token.create"));
  assert.ok(database.operations.indexOf("token.create") < database.operations.indexOf("audit.create"));
});

test("issuance intentionally supersedes expired equivalents but not consumed, revoked, or different-slot rows", async () => {
  const database = new FakeExecutionTokenDatabase();
  const expired = database.addToken({ id: "expired", expiresAt: new Date(ISSUE_TIME.getTime() - 1) });
  const consumed = database.addToken({ id: "consumed", consumedAt: new Date(ISSUE_TIME.getTime() - 5_000) });
  const revokedAt = new Date(ISSUE_TIME.getTime() - 6_000);
  const revoked = database.addToken({ id: "revoked", revokedAt });
  const singleUse = database.addToken({ id: "single", singleUse: true });
  const otherUser = database.addToken({ id: "other-user", userId: "user-2" });

  await serviceFor(database).issueExecutionToken(issueInput());

  assert.equal(expired.revokedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(consumed.revokedAt, null);
  assert.equal(revoked.revokedAt?.getTime(), revokedAt.getTime());
  assert.equal(singleUse.revokedAt, null);
  assert.equal(otherUser.revokedAt, null);
  assert.equal(database.audits[0]?.metadata?.supersededCount, 1);
});

test("issuance audit carries lifecycle context but no bearer token or token hash", async () => {
  const database = new FakeExecutionTokenDatabase();
  const issued = await serviceFor(database).issueExecutionToken(issueInput());
  const audit = database.audits[0];
  const serializedAudit = JSON.stringify(audit);
  const serializedCreate = JSON.stringify(database.createPayloads[0]);

  assert.equal(audit?.action, "application-execution-token.create");
  assert.equal(audit?.resourceId, issued.tokenRecord.id);
  assert.deepEqual(audit?.metadata, {
    runId: "run-1",
    applicationId: "application-1",
    jobPostingId: "job-1",
    scope: "APPLICATION_READ",
    host: "jobs.example.com",
    expiresAt: new Date(ISSUE_TIME.getTime() + READ_TOKEN_TTL_MS).toISOString(),
    supersededCount: 0
  });
  assert.equal(serializedCreate.includes(RAW_READ_TOKEN), false);
  assert.equal(serializedAudit.includes(RAW_READ_TOKEN), false);
  assert.equal(serializedAudit.includes("tokenHash"), false);
  assert.equal(serializedAudit.includes(hashExecutionToken(RAW_READ_TOKEN)), false);
});

test("issuance audit failure rolls back predecessor supersession and token creation", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.addToken({ id: "predecessor" });
  database.failAudit = true;

  await assert.rejects(serviceFor(database).issueExecutionToken(issueInput()), /simulated audit failure/);
  assert.equal(database.tokens.length, 1);
  assert.equal(database.tokens[0]?.id, "predecessor");
  assert.equal(database.tokens[0]?.revokedAt, null);
  assert.equal(database.audits.length, 0);
  assert.ok(database.operations.includes("transaction.rollback"));
});

test("valid reusable authorization updates lastUsedAt without consuming", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = database.addToken();
  const authorized = await serviceFor(database).authorizeReusableExecutionToken(bindingInput());

  assert.equal(authorized.id, token.id);
  assert.equal(token.lastUsedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(token.consumedAt, null);
});

test("global emergency stop pauses reusable authorization without database work or token mutation, then re-enables", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = database.addToken();
  const env: Record<string, string | undefined> = { APPLICATION_AUTOMATION_ENABLED: "false" };
  const service = serviceFor(database, { env });
  const before = cloneToken(token);

  await assert.rejects(
    service.authorizeReusableExecutionToken(bindingInput()),
    (error: unknown) => error instanceof PublicApiError && error.status === 403 && error.details?.code === "AUTOMATION_DISABLED"
  );
  assert.deepEqual(database.operations, []);
  assert.deepEqual(token, before);

  env.APPLICATION_AUTOMATION_ENABLED = "true";
  const authorized = await service.authorizeReusableExecutionToken(bindingInput());
  assert.equal(authorized.id, token.id);
  assert.equal(token.lastUsedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(token.revokedAt, null);
  assert.equal(token.consumedAt, null);
});

test("malformed reusable credential wins over the disabled global gate before database work", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.addToken();

  await assert.rejects(
    serviceFor(database, { env: { APPLICATION_AUTOMATION_ENABLED: "false" } }).authorizeReusableExecutionToken({
      ...bindingInput(),
      rawToken: "malformed"
    }),
    isTokenError("EXECUTION_TOKEN_INVALID", 401)
  );
  assert.deepEqual(database.operations, []);
});

test("reusable authorization rejects single-use, wrong bindings, expired, and revoked tokens generically", async () => {
  const cases: Array<{ token?: Partial<FakeToken>; binding?: Partial<ExpectedTokenBinding> }> = [
    { token: { singleUse: true } },
    { binding: { userId: "other-user" } },
    { binding: { runId: "other-run" } },
    { binding: { host: "other.example.com" } },
    { binding: { scope: "APPLICATION_FILL" } },
    { token: { expiresAt: ISSUE_TIME } },
    { token: { revokedAt: ISSUE_TIME } }
  ];
  for (const entry of cases) {
    const database = new FakeExecutionTokenDatabase();
    database.addToken(entry.token);
    await assert.rejects(
      serviceFor(database).authorizeReusableExecutionToken(bindingInput({ expected: entry.binding })),
      isTokenError("EXECUTION_TOKEN_INVALID", 401)
    );
  }
});

function fillBindingInput(): ExecutionTokenBindingInput {
  return {
    rawToken: RAW_FILL_TOKEN,
    expected: expected({ scope: "APPLICATION_FILL" })
  };
}

function addFillToken(database: FakeExecutionTokenDatabase, overrides: Partial<FakeToken> = {}) {
  return database.addToken({
    tokenHash: hashExecutionToken(RAW_FILL_TOKEN),
    tokenPrefix: `${RAW_FILL_TOKEN.slice(0, 12)}...`,
    scope: "APPLICATION_FILL",
    singleUse: true,
    ...overrides
  });
}

test("single-use consume claims once, updates telemetry, and writes one secret-free audit", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = addFillToken(database);
  const service = serviceFor(database);

  const consumed = await service.consumeSingleUseExecutionToken(fillBindingInput());
  assert.equal(consumed.id, token.id);
  assert.equal(token.consumedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(token.lastUsedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0]?.action, "application-execution-token.consume");
  assert.deepEqual(database.audits[0]?.metadata, {
    tokenId: token.id,
    runId: "run-1",
    applicationId: "application-1",
    jobPostingId: "job-1",
    scope: "APPLICATION_FILL",
    host: "jobs.example.com",
    consumedAt: ISSUE_TIME.toISOString()
  });
  const serialized = JSON.stringify(database.audits[0]);
  assert.equal(serialized.includes(RAW_FILL_TOKEN), false);
  assert.equal(serialized.includes("tokenHash"), false);

  await assert.rejects(service.consumeSingleUseExecutionToken(fillBindingInput()), isTokenError("EXECUTION_TOKEN_INVALID", 401));
  assert.equal(database.audits.length, 1);
});

test("global emergency stop pauses single-use consumption without database work or token mutation, then re-enables", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = addFillToken(database);
  const env: Record<string, string | undefined> = { APPLICATION_AUTOMATION_ENABLED: "false" };
  const service = serviceFor(database, { env });
  const before = cloneToken(token);

  await assert.rejects(
    service.consumeSingleUseExecutionToken(fillBindingInput()),
    (error: unknown) => error instanceof PublicApiError && error.status === 403 && error.details?.code === "AUTOMATION_DISABLED"
  );
  assert.deepEqual(database.operations, []);
  assert.deepEqual(token, before);

  env.APPLICATION_AUTOMATION_ENABLED = "true";
  const consumed = await service.consumeSingleUseExecutionToken(fillBindingInput());
  assert.equal(consumed.id, token.id);
  assert.equal(token.consumedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(token.revokedAt, null);
});

test("malformed single-use credential wins over the disabled global gate before database work", async () => {
  const database = new FakeExecutionTokenDatabase();
  addFillToken(database);

  await assert.rejects(
    serviceFor(database, { env: { APPLICATION_AUTOMATION_ENABLED: "false" } }).consumeSingleUseExecutionToken({
      ...fillBindingInput(),
      rawToken: "malformed"
    }),
    isTokenError("EXECUTION_TOKEN_INVALID", 401)
  );
  assert.deepEqual(database.operations, []);
});

test("reusable token cannot be consumed through the single-use path", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.addToken({ tokenHash: hashExecutionToken(RAW_FILL_TOKEN), scope: "APPLICATION_FILL", singleUse: false });
  await assert.rejects(
    serviceFor(database).consumeSingleUseExecutionToken(fillBindingInput()),
    isTokenError("EXECUTION_TOKEN_INVALID", 401)
  );
});

test("post-claim read failure rolls back single-use consumption", async () => {
  const database = new FakeExecutionTokenDatabase();
  addFillToken(database);
  database.failNextTokenRead = true;

  await assert.rejects(
    serviceFor(database).consumeSingleUseExecutionToken(fillBindingInput()),
    /simulated authoritative token read failure/
  );
  assert.equal(database.tokens[0]?.consumedAt, null);
  assert.equal(database.tokens[0]?.lastUsedAt, null);
  assert.equal(database.audits.length, 0);
});

test("consume audit failure rolls back the claim", async () => {
  const database = new FakeExecutionTokenDatabase();
  addFillToken(database);
  database.failAudit = true;

  await assert.rejects(serviceFor(database).consumeSingleUseExecutionToken(fillBindingInput()), /simulated audit failure/);
  assert.equal(database.tokens[0]?.consumedAt, null);
  assert.equal(database.tokens[0]?.lastUsedAt, null);
  assert.equal(database.audits.length, 0);
});

test("first revocation is transactional and audited; repeat revocation is idempotent without a duplicate audit", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = database.addToken();
  const service = serviceFor(database);

  assert.deepEqual(await service.revokeExecutionToken({ userId: "user-1", tokenId: token.id }), {
    revoked: true,
    alreadyRevoked: false
  });
  assert.equal(token.revokedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0]?.action, "application-execution-token.revoke");
  assert.deepEqual(database.audits[0]?.metadata, {
    tokenId: token.id,
    runId: "run-1",
    applicationId: "application-1",
    jobPostingId: "job-1",
    scope: "APPLICATION_READ",
    host: "jobs.example.com",
    revokedAt: ISSUE_TIME.toISOString()
  });

  assert.deepEqual(await service.revokeExecutionToken({ userId: "user-1", tokenId: token.id }), {
    revoked: false,
    alreadyRevoked: true
  });
  assert.equal(database.audits.length, 1);
  const serialized = JSON.stringify(database.audits[0]);
  assert.equal(serialized.includes(RAW_READ_TOKEN), false);
  assert.equal(serialized.includes("tokenHash"), false);
});

test("wrong-user and unknown-token revocation share the same ownership-scoped 404", async () => {
  for (const input of [
    { userId: "other-user", tokenId: "token-1" },
    { userId: "user-1", tokenId: "missing-token" }
  ]) {
    const database = new FakeExecutionTokenDatabase();
    database.addToken();
    await assert.rejects(serviceFor(database).revokeExecutionToken(input), isTokenError("EXECUTION_TOKEN_NOT_FOUND", 404));
    assert.equal(database.audits.length, 0);
  }
});

test("revocation audit failure rolls back mutation", async () => {
  const database = new FakeExecutionTokenDatabase();
  const token = database.addToken();
  database.failAudit = true;

  await assert.rejects(
    serviceFor(database).revokeExecutionToken({ userId: "user-1", tokenId: token.id }),
    /simulated audit failure/
  );
  assert.equal(database.tokens[0]?.revokedAt, null);
  assert.equal(database.audits.length, 0);
});

test("normal and run-bound revocation remain available while global automation and user policy are disabled", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.policy = fakePolicy({ enabled: false });
  const normalToken = database.addToken({ id: "normal-token" });
  const runBoundToken = database.addToken({ id: "run-bound-token" });
  const service = serviceFor(database, { env: { APPLICATION_AUTOMATION_ENABLED: "false" } });
  const normalResult = await service.revokeExecutionToken({ userId: "user-1", tokenId: normalToken.id });
  const runBoundResult = await service.revokeExecutionTokenForRun({
    userId: "user-1",
    runId: "run-1",
    tokenId: runBoundToken.id
  });

  assert.deepEqual(normalResult, { revoked: true, alreadyRevoked: false });
  assert.deepEqual(runBoundResult, { revoked: true, alreadyRevoked: false });
  assert.equal(database.operations.includes("policy.lock"), false);
  assert.equal(database.operations.includes("policy.findUnique"), false);
});

test("run-bound revocation requires token, owner, and run inside the authoritative transaction", async () => {
  const validDatabase = new FakeExecutionTokenDatabase();
  const validToken = validDatabase.addToken();
  assert.deepEqual(
    await serviceFor(validDatabase).revokeExecutionTokenForRun({
      userId: "user-1",
      runId: "run-1",
      tokenId: validToken.id
    }),
    { revoked: true, alreadyRevoked: false }
  );

  for (const input of [
    { userId: "user-1", runId: "other-run", tokenId: "token-1" },
    { userId: "other-user", runId: "run-1", tokenId: "token-1" },
    { userId: "user-1", runId: "run-1", tokenId: "missing-token" }
  ]) {
    const database = new FakeExecutionTokenDatabase();
    database.addToken();
    await assert.rejects(
      serviceFor(database).revokeExecutionTokenForRun(input),
      isTokenError("EXECUTION_TOKEN_NOT_FOUND", 404)
    );
    assert.equal(database.tokens[0]?.revokedAt, null);
    assert.equal(database.audits.length, 0);
  }
});

test("run-bound revocation validates every identifier before database access", async () => {
  for (const input of [
    { userId: "user-1", runId: undefined, tokenId: "token-1" },
    { userId: undefined, runId: "run-1", tokenId: "token-1" },
    { userId: "user-1", runId: "run-1", tokenId: undefined }
  ]) {
    const database = new FakeExecutionTokenDatabase();
    await assert.rejects(
      serviceFor(database).revokeExecutionTokenForRun(input as unknown as RevokeExecutionTokenForRunInput),
      isTokenError("EXECUTION_TOKEN_NOT_FOUND", 404)
    );
    assert.deepEqual(database.operations, []);
  }
});

test("user-wide bulk invalidation revokes only currently usable tokens and writes a secret-free audit", async () => {
  const database = new FakeExecutionTokenDatabase();
  const reusable = database.addToken({ id: "reusable" });
  const singleUse = database.addToken({ id: "single-use", runId: "run-2", singleUse: true });
  const consumed = database.addToken({ id: "consumed", singleUse: true, consumedAt: ISSUE_TIME });
  const expired = database.addToken({ id: "expired", expiresAt: ISSUE_TIME });
  const revokedAt = new Date(ISSUE_TIME.getTime() - 1);
  const revoked = database.addToken({ id: "revoked", revokedAt });
  const otherUser = database.addToken({ id: "other-user", userId: "user-2" });

  const count = await database.client.$transaction((tx) =>
    revokeUsableExecutionTokensForUserInTransaction(tx as ExecutionTokenRevocationTransaction, {
      userId: "user-1",
      now: ISSUE_TIME,
      reason: "policy_changed"
    })
  );

  assert.equal(count, 2);
  assert.equal(reusable.revokedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(singleUse.revokedAt?.getTime(), ISSUE_TIME.getTime());
  assert.equal(consumed.revokedAt, null);
  assert.equal(expired.revokedAt, null);
  assert.equal(revoked.revokedAt?.getTime(), revokedAt.getTime());
  assert.equal(otherUser.revokedAt, null);
  assert.deepEqual(database.audits[0], {
    userId: "user-1",
    action: "application-execution-token.revoke-bulk",
    resource: "User",
    resourceId: "user-1",
    metadata: {
      reason: "policy_changed",
      revokedCount: 2,
      revokedAt: ISSUE_TIME.toISOString()
    }
  });
  const serialized = JSON.stringify(database.audits[0]);
  assert.equal(serialized.includes(RAW_READ_TOKEN), false);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.equal(serialized.includes(hashExecutionToken(RAW_READ_TOKEN)), false);
});

test("run-wide bulk invalidation is run-bound and audit failure rolls the revocation back", async () => {
  const database = new FakeExecutionTokenDatabase();
  database.addToken({ id: "target", runId: "run-1" });
  database.addToken({ id: "other-run", runId: "run-2" });
  database.failAudit = true;

  await assert.rejects(
    database.client.$transaction((tx) =>
      revokeUsableExecutionTokensForRunInTransaction(tx as ExecutionTokenRevocationTransaction, {
        userId: "user-1",
        runId: "run-1",
        now: ISSUE_TIME,
        reason: "run_cancelled"
      })
    ),
    /simulated audit failure/
  );
  assert.equal(database.tokens[0]?.revokedAt, null);
  assert.equal(database.tokens[1]?.revokedAt, null);
  assert.equal(database.audits.length, 0);
});
