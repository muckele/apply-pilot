import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma, PrismaClient } from "@prisma/client";

export const POSTGRES_TEST_DATABASE_NAME = "apply_pilot_commit5_test";
export const POSTGRES_TEST_MARKER = "1";
export const POSTGRES_TEST_MAJOR_VERSION = 16;
export const POSTGRES_TEST_NODE_TIMEOUT_MS = 30_000;
export const POSTGRES_TEST_BARRIER_TIMEOUT_MS = 5_000;
export const POSTGRES_TEST_TRANSACTION_MAX_WAIT_MS = 5_000;
export const POSTGRES_TEST_TRANSACTION_TIMEOUT_MS = 20_000;
export const POSTGRES_TEST_LOCK_TIMEOUT = "8s";
export const POSTGRES_TEST_STATEMENT_TIMEOUT = "15s";
export const POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT = "15s";

const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const EXPECTED_ISOLATION = "read committed";
const ACTOR_APPLICATION_PREFIX = "apply-pilot-c5-";
const POLL_INTERVAL_MS = 25;

export type PostgresTestEnvironment = Readonly<Record<string, string | undefined>>;

export type ValidatedPostgresTestConfig = {
  url: string;
  databaseName: typeof POSTGRES_TEST_DATABASE_NAME;
  hostname: string;
  schema: "public" | null;
};

export type LivePostgresTestDatabase = {
  databaseName: string;
  isolation: string;
  serverVersionNum: string;
  serverMajorVersion: number;
};

export class PostgresTestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresTestSafetyError";
  }
}

export class PostgresTestActorSessionChangedError extends Error {
  readonly code = "POSTGRES_TEST_ACTOR_SESSION_CHANGED";

  constructor(actorName: string, phase: string) {
    super(
      `PostgreSQL test actor ${sanitizeDiagnosticLabel(actorName)} lost its pinned session during ` +
        `${sanitizeDiagnosticLabel(phase)}.`
    );
    this.name = "PostgresTestActorSessionChangedError";
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function decodedDatabaseName(url: URL): string {
  const encoded = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL contains an invalid encoded database name.");
  }
}

export function validatePostgresTestEnvironment(
  environment: PostgresTestEnvironment = process.env
): ValidatedPostgresTestConfig {
  if (environment.COMMIT5_POSTGRES_TEST !== POSTGRES_TEST_MARKER) {
    throw new PostgresTestSafetyError("COMMIT5_POSTGRES_TEST must be exactly \"1\".");
  }
  if (environment.NODE_ENV === "production") {
    throw new PostgresTestSafetyError("PostgreSQL concurrency tests cannot run with NODE_ENV=production.");
  }

  const sourceUrl = environment.TEST_DATABASE_URL;
  if (!sourceUrl) {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL is required; DATABASE_URL and DIRECT_URL are never fallbacks.");
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL must use the postgres: or postgresql: protocol.");
  }

  const hostname = normalizedHostname(parsed);
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL must target localhost, 127.0.0.1, or ::1.");
  }

  const databaseName = decodedDatabaseName(parsed);
  if (databaseName !== POSTGRES_TEST_DATABASE_NAME) {
    throw new PostgresTestSafetyError(`TEST_DATABASE_URL must target exactly ${POSTGRES_TEST_DATABASE_NAME}.`);
  }

  const parameters = [...parsed.searchParams.entries()];
  const unsupportedParameter = parameters.find(([name]) => name !== "schema");
  if (unsupportedParameter) {
    throw new PostgresTestSafetyError(
      `TEST_DATABASE_URL query parameter ${unsupportedParameter[0]} is not allowed; only schema=public is accepted.`
    );
  }

  const schemas = parsed.searchParams.getAll("schema");
  if (schemas.length > 1 || (schemas.length === 1 && schemas[0] !== "public")) {
    throw new PostgresTestSafetyError("TEST_DATABASE_URL schema must be absent or exactly schema=public.");
  }

  return {
    url: sourceUrl,
    databaseName: POSTGRES_TEST_DATABASE_NAME,
    hostname,
    schema: schemas.length === 1 ? "public" : null
  };
}

function prismaClientForUrl(url: string, applicationName?: string): PrismaClient {
  const actorUrl = new URL(url);
  if (applicationName) {
    actorUrl.searchParams.set("connection_limit", "1");
    actorUrl.searchParams.set("application_name", applicationName);
  }
  return new PrismaClient({
    datasources: { db: { url: actorUrl.toString() } },
    ...(applicationName
      ? {
          transactionOptions: {
            maxWait: POSTGRES_TEST_TRANSACTION_MAX_WAIT_MS,
            timeout: POSTGRES_TEST_TRANSACTION_TIMEOUT_MS
          }
        }
      : {})
  });
}

function parseServerMajorVersion(serverVersionNum: string): number {
  const numericVersion = Number.parseInt(serverVersionNum, 10);
  if (!Number.isSafeInteger(numericVersion) || numericVersion <= 0) {
    throw new PostgresTestSafetyError("PostgreSQL returned an invalid server_version_num.");
  }
  return Math.floor(numericVersion / 10_000);
}

export async function verifyLivePostgresTestDatabase(
  config: ValidatedPostgresTestConfig
): Promise<LivePostgresTestDatabase> {
  const client = prismaClientForUrl(config.url);
  try {
    await client.$connect();
    const databaseRows = await client.$queryRawUnsafe<Array<{ current_database: string }>>(
      "SELECT current_database()"
    );
    const isolationRows = await client.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
      "SHOW transaction_isolation"
    );
    const versionRows = await client.$queryRawUnsafe<Array<{ server_version_num: string }>>(
      "SHOW server_version_num"
    );
    const databaseName = databaseRows[0]?.current_database;
    const isolation = isolationRows[0]?.transaction_isolation;
    const serverVersionNum = versionRows[0]?.server_version_num;

    if (databaseName !== POSTGRES_TEST_DATABASE_NAME) {
      throw new PostgresTestSafetyError(
        `Live PostgreSQL database identity must be exactly ${POSTGRES_TEST_DATABASE_NAME}.`
      );
    }
    if (isolation !== EXPECTED_ISOLATION) {
      throw new PostgresTestSafetyError(
        `Live PostgreSQL transaction isolation must be ${EXPECTED_ISOLATION}; received ${isolation ?? "unknown"}.`
      );
    }
    if (!serverVersionNum) {
      throw new PostgresTestSafetyError("Live PostgreSQL did not report server_version_num.");
    }

    return {
      databaseName,
      isolation,
      serverVersionNum,
      serverMajorVersion: parseServerMajorVersion(serverVersionNum)
    };
  } finally {
    await client.$disconnect();
  }
}

export function assertPostgresTestMajorVersion(database: LivePostgresTestDatabase): void {
  if (database.serverMajorVersion !== POSTGRES_TEST_MAJOR_VERSION) {
    throw new PostgresTestSafetyError(
      `Commit 5 requires PostgreSQL ${POSTGRES_TEST_MAJOR_VERSION}; received major ${database.serverMajorVersion}.`
    );
  }
}

function sanitizeActorName(actorName: string): string {
  const sanitized = actorName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!sanitized) {
    throw new Error("PostgreSQL test actor name must contain an ASCII letter or digit.");
  }
  return sanitized;
}

function actorApplicationName(actorName: string): string {
  return `${ACTOR_APPLICATION_PREFIX}${sanitizeActorName(actorName)}-${randomUUID().slice(0, 8)}`;
}

type SessionIdentityRow = {
  backendPid: number;
  applicationName: string;
  databaseName: string;
  isolation: string;
  serverVersionNum: string;
  lockTimeout: string;
  statementTimeout: string;
  idleTransactionTimeout: string;
};

type SessionIdentityClient = Pick<PrismaClient, "$queryRaw">;

async function readSessionIdentity(client: SessionIdentityClient): Promise<SessionIdentityRow> {
  const rows = await client.$queryRaw<Array<SessionIdentityRow>>(Prisma.sql`
    SELECT
      pg_backend_pid()::integer AS "backendPid",
      current_setting('application_name') AS "applicationName",
      current_database() AS "databaseName",
      current_setting('transaction_isolation') AS "isolation",
      current_setting('server_version_num') AS "serverVersionNum",
      current_setting('lock_timeout') AS "lockTimeout",
      current_setting('statement_timeout') AS "statementTimeout",
      current_setting('idle_in_transaction_session_timeout') AS "idleTransactionTimeout"
  `);
  const identity = rows[0];
  if (!identity || !Number.isInteger(identity.backendPid) || identity.backendPid <= 0) {
    throw new Error("PostgreSQL actor did not return a valid backend PID.");
  }
  return identity;
}

export type PostgresTestActor = {
  actorName: string;
  applicationName: string;
  backendPid: number;
  client: PrismaClient;
  sessionTimeouts: {
    lockTimeout: string;
    statementTimeout: string;
    idleTransactionTimeout: string;
  };
};

type ActorRuntimeState = {
  actorName: string;
  applicationName: string;
  backendPid: number;
  baseClient: PrismaClient;
  poisonedError: PostgresTestActorSessionChangedError | null;
  transactionScope: AsyncLocalStorage<boolean>;
};

const actorRuntimeStates = new WeakMap<PostgresTestActor, ActorRuntimeState>();

function runtimeStateForActor(actor: PostgresTestActor): ActorRuntimeState {
  const state = actorRuntimeStates.get(actor);
  if (!state) {
    throw new Error(`PostgreSQL test actor ${sanitizeDiagnosticLabel(actor.actorName)} was not created by this harness.`);
  }
  return state;
}

function throwIfActorPoisoned(state: ActorRuntimeState): void {
  if (state.poisonedError) throw state.poisonedError;
}

function poisonActor(state: ActorRuntimeState, phase: string): never {
  state.poisonedError ??= new PostgresTestActorSessionChangedError(state.actorName, phase);
  throw state.poisonedError;
}

function sessionIdentityMatches(state: ActorRuntimeState, identity: SessionIdentityRow): boolean {
  let serverMajorVersion: number;
  try {
    serverMajorVersion = parseServerMajorVersion(identity.serverVersionNum);
  } catch {
    return false;
  }
  return (
    identity.backendPid === state.backendPid &&
    identity.applicationName === state.applicationName &&
    identity.databaseName === POSTGRES_TEST_DATABASE_NAME &&
    identity.isolation === EXPECTED_ISOLATION &&
    serverMajorVersion === POSTGRES_TEST_MAJOR_VERSION &&
    identity.lockTimeout === POSTGRES_TEST_LOCK_TIMEOUT &&
    identity.statementTimeout === POSTGRES_TEST_STATEMENT_TIMEOUT &&
    identity.idleTransactionTimeout === POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT
  );
}

async function verifyActorRuntimeState(
  state: ActorRuntimeState,
  phase: string,
  client: SessionIdentityClient = state.baseClient
): Promise<void> {
  throwIfActorPoisoned(state);
  let identity: SessionIdentityRow;
  try {
    identity = await readSessionIdentity(client);
  } catch {
    poisonActor(state, phase);
  }
  if (!sessionIdentityMatches(state, identity)) poisonActor(state, phase);
}

export async function createPostgresTestActor(
  actorName: string,
  environment: PostgresTestEnvironment = process.env
): Promise<PostgresTestActor> {
  const config = validatePostgresTestEnvironment(environment);
  const sanitizedName = sanitizeActorName(actorName);
  const applicationName = actorApplicationName(sanitizedName);
  const client = prismaClientForUrl(config.url, applicationName);

  try {
    await client.$connect();
    await client.$executeRawUnsafe(`SET lock_timeout = '${POSTGRES_TEST_LOCK_TIMEOUT}'`);
    await client.$executeRawUnsafe(`SET statement_timeout = '${POSTGRES_TEST_STATEMENT_TIMEOUT}'`);
    await client.$executeRawUnsafe(
      `SET idle_in_transaction_session_timeout = '${POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT}'`
    );
    const identity = await readSessionIdentity(client);
    const sessionTimeouts = {
      lockTimeout: identity.lockTimeout,
      statementTimeout: identity.statementTimeout,
      idleTransactionTimeout: identity.idleTransactionTimeout
    };

    if (
      sessionTimeouts.lockTimeout !== POSTGRES_TEST_LOCK_TIMEOUT ||
      sessionTimeouts.statementTimeout !== POSTGRES_TEST_STATEMENT_TIMEOUT ||
      sessionTimeouts.idleTransactionTimeout !== POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT
    ) {
      throw new Error(`PostgreSQL actor ${sanitizedName} did not retain the required session timeout settings.`);
    }
    if (identity.applicationName !== applicationName) {
      throw new Error(`PostgreSQL actor ${sanitizedName} did not retain its controlled application_name.`);
    }
    if (identity.databaseName !== POSTGRES_TEST_DATABASE_NAME || identity.isolation !== EXPECTED_ISOLATION) {
      throw new PostgresTestSafetyError(
        `PostgreSQL actor ${sanitizedName} is not connected to the approved database at ${EXPECTED_ISOLATION}.`
      );
    }
    if (parseServerMajorVersion(identity.serverVersionNum) !== POSTGRES_TEST_MAJOR_VERSION) {
      throw new PostgresTestSafetyError(
        `PostgreSQL actor ${sanitizedName} is not connected to PostgreSQL ${POSTGRES_TEST_MAJOR_VERSION}.`
      );
    }

    const actor: PostgresTestActor = {
      actorName: sanitizedName,
      applicationName,
      backendPid: identity.backendPid,
      client,
      sessionTimeouts
    };
    const state: ActorRuntimeState = {
      actorName: sanitizedName,
      applicationName,
      backendPid: identity.backendPid,
      baseClient: client,
      poisonedError: null,
      transactionScope: new AsyncLocalStorage<boolean>()
    };
    actor.client = createInvariantPrismaClient(state);
    actorRuntimeStates.set(actor, state);
    return actor;
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
}

export async function assertActorSessionPinned(actor: PostgresTestActor, phase: string): Promise<void> {
  await verifyActorRuntimeState(runtimeStateForActor(actor), phase);
}

export function assertDistinctActorSessions(actors: readonly PostgresTestActor[]): void {
  const pids = actors.map((actor) => actor.backendPid);
  if (new Set(pids).size !== pids.length) {
    throw new Error("PostgreSQL test actors must use distinct backend PIDs.");
  }
}

export type Deferred<T> = {
  name: string;
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (error: unknown) => void;
  wait: (timeoutMs?: number) => Promise<T>;
};

export function deferred<T = void>(name: string): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    name,
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
    reject: rejectPromise,
    wait: (timeoutMs = POSTGRES_TEST_BARRIER_TIMEOUT_MS) =>
      withTimeout(promise, timeoutMs, `barrier ${sanitizeDiagnosticLabel(name)}`)
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms while waiting for ${sanitizeDiagnosticLabel(phase)}.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ActorLockWait = {
  waiterPid: number;
  waiterApplicationName: string;
  waitEventType: string | null;
  waitEvent: string | null;
  blockingPids: number[];
  hasUngrantedLock: boolean;
};

async function readActorLockWait(
  observer: PostgresTestActor,
  waiter: PostgresTestActor
): Promise<ActorLockWait | null> {
  const rows = await observer.client.$queryRaw<Array<ActorLockWait>>(Prisma.sql`
    SELECT
      activity.pid::integer AS "waiterPid",
      activity.application_name AS "waiterApplicationName",
      activity.wait_event_type AS "waitEventType",
      activity.wait_event AS "waitEvent",
      pg_blocking_pids(activity.pid)::integer[] AS "blockingPids",
      EXISTS (
        SELECT 1 FROM pg_locks waiting_lock
        WHERE waiting_lock.pid = activity.pid AND waiting_lock.granted = false
      ) AS "hasUngrantedLock"
    FROM pg_stat_activity activity
    WHERE activity.pid = ${waiter.backendPid}
      AND activity.application_name = ${waiter.applicationName}
  `);
  return rows[0] ?? null;
}

export async function waitForActorLockWait(
  observer: PostgresTestActor,
  waiter: PostgresTestActor,
  blocker: PostgresTestActor,
  timeoutMs = POSTGRES_TEST_BARRIER_TIMEOUT_MS
): Promise<ActorLockWait> {
  const deadline = Date.now() + timeoutMs;
  let lastObservation: ActorLockWait | null = null;
  while (Date.now() < deadline) {
    lastObservation = await readActorLockWait(observer, waiter);
    if (
      lastObservation?.waitEventType === "Lock" &&
      lastObservation.hasUngrantedLock &&
      lastObservation.blockingPids.includes(blocker.backendPid)
    ) {
      return lastObservation;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const blockers = lastObservation?.blockingPids.join(",") || "none";
  const waitType = lastObservation?.waitEventType ?? "none";
  throw new Error(
    `PostgreSQL actor ${waiter.actorName} was not observed waiting on ${blocker.actorName}; ` +
      `waitEventType=${waitType}, blockerPids=${blockers}.`
  );
}

export async function assertNoIdleTransactions(
  observer: PostgresTestActor,
  actors: readonly PostgresTestActor[]
): Promise<void> {
  if (actors.length === 0) return;
  const pids = actors.map((actor) => actor.backendPid);
  const rows = await observer.client.$queryRaw<Array<{ pid: number; applicationName: string }>>(Prisma.sql`
    SELECT pid::integer AS "pid", application_name AS "applicationName"
    FROM pg_stat_activity
    WHERE pid IN (${Prisma.join(pids)}) AND state = 'idle in transaction'
  `);
  if (rows.length > 0) {
    const names = rows.map((row) => row.applicationName).join(", ");
    throw new Error(`PostgreSQL test actors remained idle in transaction: ${names}.`);
  }
}

type HookOperation =
  | { kind: "transaction" }
  | { kind: "queryRaw"; sqlShape: string }
  | { kind: "model"; model: string; method: string };

export type PrismaHookMatcher =
  | { kind: "transaction" }
  | { kind: "queryRaw"; includes: readonly string[] }
  | { kind: "model"; model: string; method: string };

export type PrismaHookCheckpoint = {
  actorName: string;
  operation: HookOperation;
};

export type PrismaOperationHook = {
  name: string;
  match: PrismaHookMatcher;
  expectedMatches?: number;
  before?: (checkpoint: PrismaHookCheckpoint) => void | Promise<void>;
  after?: (checkpoint: PrismaHookCheckpoint) => void | Promise<void>;
  throwAfter?: Error;
};

type HookState = {
  hook: PrismaOperationHook;
  beforeMatches: number;
  afterMatches: number;
};

export class PostgresTestLateFailureError extends Error {
  readonly code = "POSTGRES_TEST_LATE_FAILURE";

  constructor(label: string) {
    super(`Injected PostgreSQL test failure: ${sanitizeDiagnosticLabel(label)}.`);
    this.name = "PostgresTestLateFailureError";
  }
}

export function lateFailureSentinel(label: string): PostgresTestLateFailureError {
  return new PostgresTestLateFailureError(label);
}

function normalizedSqlShape(args: readonly unknown[]): string {
  const first = args[0];
  let strings: readonly string[] | null = null;
  if (Array.isArray(first) && first.every((value) => typeof value === "string")) {
    strings = first;
  } else if (first && typeof first === "object" && "strings" in first) {
    const candidate = (first as { strings?: unknown }).strings;
    if (Array.isArray(candidate) && candidate.every((value) => typeof value === "string")) {
      strings = candidate;
    }
  }
  if (!strings) return "<unsafe-or-unrecognized-query>";
  return strings.join("?").replace(/\s+/g, " ").trim();
}

function operationMatches(matcher: PrismaHookMatcher, operation: HookOperation): boolean {
  if (matcher.kind !== operation.kind) return false;
  if (matcher.kind === "transaction" && operation.kind === "transaction") return true;
  if (matcher.kind === "queryRaw" && operation.kind === "queryRaw") {
    return matcher.includes.every((fragment) => operation.sqlShape.includes(fragment));
  }
  return (
    matcher.kind === "model" &&
    operation.kind === "model" &&
    matcher.model === operation.model &&
    matcher.method === operation.method
  );
}

export type HookedPrismaClient = {
  prismaClient: PrismaClient;
  assertExpectedHooksReached: () => void;
};

async function executeWithActorInvariant<T>(
  state: ActorRuntimeState,
  operationLabel: string,
  delegate: () => Promise<T>
): Promise<T> {
  throwIfActorPoisoned(state);
  try {
    await verifyActorRuntimeState(state, `before-${operationLabel}`);
    const result = await delegate();
    await verifyActorRuntimeState(state, `after-${operationLabel}`);
    return result;
  } catch (error) {
    if (state.poisonedError) throw state.poisonedError;
    try {
      await verifyActorRuntimeState(state, `failure-${operationLabel}`);
    } catch (sessionError) {
      throw sessionError;
    }
    throw error;
  }
}

function createInvariantPrismaClient(state: ActorRuntimeState): PrismaClient {
  const extended = state.baseClient.$extends({
    name: "commit5ActorSessionInvariant",
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (state.transactionScope.getStore()) return query(args);
        const operationLabel = `${model ?? "client"}.${operation}`;
        return executeWithActorInvariant(state, operationLabel, () => query(args));
      }
    }
  });
  return createControlledTransactionClient(state, extended as unknown as PrismaClient);
}

type TransactionCheckpoint = () => Promise<void>;

type ControlledPrismaClientMetadata = {
  nativeClient: PrismaClient;
  state: ActorRuntimeState;
  transactionCheckpoint?: TransactionCheckpoint;
};

const controlledPrismaClients = new WeakMap<PrismaClient, ControlledPrismaClientMetadata>();

function nativePrismaClientForControl(client: PrismaClient): PrismaClient {
  return controlledPrismaClients.get(client)?.nativeClient ?? client;
}

async function configureAndVerifyTransaction(
  state: ActorRuntimeState,
  transaction: Prisma.TransactionClient,
  phase: string
): Promise<void> {
  await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${POSTGRES_TEST_LOCK_TIMEOUT}'`);
  await transaction.$executeRawUnsafe(`SET LOCAL statement_timeout = '${POSTGRES_TEST_STATEMENT_TIMEOUT}'`);
  await transaction.$executeRawUnsafe(
    `SET LOCAL idle_in_transaction_session_timeout = '${POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT}'`
  );
  await verifyActorRuntimeState(state, phase, transaction as SessionIdentityClient);
}

async function runControlledTransaction(
  state: ActorRuntimeState,
  target: PrismaClient,
  transactionMethod: (...args: unknown[]) => Promise<unknown>,
  operation: unknown,
  options: unknown,
  transactionCheckpoint?: TransactionCheckpoint
): Promise<unknown> {
  await verifyActorRuntimeState(state, "before-transaction");
  try {
    let result: unknown;
    if (typeof operation === "function") {
      const callback = operation as (transaction: Prisma.TransactionClient) => Promise<unknown>;
      const wrapped = (transaction: Prisma.TransactionClient) =>
        state.transactionScope.run(true, async () => {
          await configureAndVerifyTransaction(state, transaction, "transaction-entry");
          await transactionCheckpoint?.();
          const callbackResult = await callback(transaction);
          await verifyActorRuntimeState(state, "transaction-exit", transaction as SessionIdentityClient);
          return callbackResult;
        });
      result = await Reflect.apply(
        transactionMethod,
        target,
        options === undefined ? [wrapped] : [wrapped, options]
      );
    } else {
      result = await state.transactionScope.run(true, () =>
        Reflect.apply(
          transactionMethod,
          target,
          options === undefined ? [operation] : [operation, options]
        )
      );
    }
    await verifyActorRuntimeState(state, "after-transaction");
    return result;
  } catch (error) {
    if (state.poisonedError) throw state.poisonedError;
    try {
      await verifyActorRuntimeState(state, "transaction-failure");
    } catch (sessionError) {
      throw sessionError;
    }
    throw error;
  }
}

function createControlledTransactionClient(
  state: ActorRuntimeState,
  client: PrismaClient,
  transactionCheckpoint?: TransactionCheckpoint
): PrismaClient {
  const existingControl = controlledPrismaClients.get(client);
  if (
    existingControl?.state === state &&
    existingControl.transactionCheckpoint === transactionCheckpoint
  ) {
    return client;
  }
  if (existingControl && existingControl.state !== state) {
    throw new Error("A controlled Prisma client cannot be attached to a different PostgreSQL test actor.");
  }
  const nativeClient = existingControl?.nativeClient ?? client;
  const nativeExtendsMethod = Reflect.get(
    state.baseClient,
    "$extends",
    state.baseClient
  ) as unknown as (...args: unknown[]) => PrismaClient;
  const nativeTransactionMethod = Reflect.get(
    state.baseClient,
    "$transaction",
    state.baseClient
  ) as (...args: unknown[]) => Promise<unknown>;
  const controlledClient: PrismaClient = new Proxy(nativeClient, {
    get(target, property) {
      if (property === "$extends") {
        return (...extensionArguments: unknown[]) => {
          const extendedClient = Reflect.apply(
            nativeExtendsMethod,
            controlledClient,
            extensionArguments
          ) as PrismaClient;
          if (typeof extensionArguments[0] === "function") {
            const returnedControl = controlledPrismaClients.get(extendedClient);
            if (
              returnedControl?.state !== state ||
              returnedControl.transactionCheckpoint !== transactionCheckpoint
            ) {
              throw new Error(
                "A functional Prisma extension must return its controlled client or a controlled client derived from it."
              );
            }
            return extendedClient;
          }
          return createControlledTransactionClient(state, extendedClient, transactionCheckpoint);
        };
      }
      if (property === "$transaction") {
        return (operation: unknown, options?: unknown) => {
          if (isObject(options) && "isolationLevel" in options) {
            throw new Error("PostgreSQL test transactions must inherit the database READ COMMITTED isolation level.");
          }
          return runControlledTransaction(
            state,
            target,
            nativeTransactionMethod,
            operation,
            options,
            transactionCheckpoint
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(controlledClient) : value;
    }
  }) as PrismaClient;
  controlledPrismaClients.set(controlledClient, {
    nativeClient,
    state,
    transactionCheckpoint
  });
  return controlledClient;
}

function uncapitalizeModelName(model: string): string {
  return model.length === 0 ? model : `${model[0].toLowerCase()}${model.slice(1)}`;
}

function hookOperationForQueryExtension(
  model: string | undefined,
  operation: string,
  args: unknown
): HookOperation | null {
  if (model) return { kind: "model", model: uncapitalizeModelName(model), method: operation };
  if (operation === "$queryRaw") return { kind: "queryRaw", sqlShape: normalizedSqlShape([args]) };
  return null;
}

export function createHookedPrismaClient(
  actor: PostgresTestActor,
  hooks: readonly PrismaOperationHook[]
): HookedPrismaClient {
  const states: HookState[] = hooks.map((hook) => ({ hook, beforeMatches: 0, afterMatches: 0 }));

  async function beginOperation(operation: HookOperation): Promise<HookState[]> {
    const matched = states.filter((state) => operationMatches(state.hook.match, operation));
    for (const state of matched) {
      state.beforeMatches += 1;
      await state.hook.before?.({ actorName: actor.actorName, operation });
    }
    return matched;
  }

  async function finishOperation(operation: HookOperation, matched: readonly HookState[]): Promise<void> {
    for (const state of matched) {
      state.afterMatches += 1;
      await state.hook.after?.({ actorName: actor.actorName, operation });
      if (state.hook.throwAfter) throw state.hook.throwAfter;
    }
  }

  const extended = nativePrismaClientForControl(actor.client).$extends({
    name: "commit5OperationHooks",
    query: {
      async $allOperations({ model, operation, args, query }) {
        const hookOperation = hookOperationForQueryExtension(model, operation, args);
        if (!hookOperation) return query(args);
        const matched = await beginOperation(hookOperation);
        const result = await query(args);
        await finishOperation(hookOperation, matched);
        return result;
      }
    }
  });
  const runtimeState = runtimeStateForActor(actor);
  const prismaClient = createControlledTransactionClient(
    runtimeState,
    extended as unknown as PrismaClient,
    async () => {
      const transactionOperation: HookOperation = { kind: "transaction" };
      const matched = await beginOperation(transactionOperation);
      await finishOperation(transactionOperation, matched);
    }
  );

  return {
    prismaClient,
    assertExpectedHooksReached: () => {
      for (const state of states) {
        const expected = state.hook.expectedMatches ?? 1;
        if (state.beforeMatches !== expected) {
          throw new Error(
            `Prisma hook ${sanitizeDiagnosticLabel(state.hook.name)} expected ${expected} matches but saw ` +
              `${state.beforeMatches}.`
          );
        }
        if ((state.hook.after || state.hook.throwAfter) && state.afterMatches !== expected) {
          throw new Error(
            `Prisma hook ${sanitizeDiagnosticLabel(state.hook.name)} expected ${expected} completed operations but saw ` +
              `${state.afterMatches}.`
          );
        }
      }
    }
  };
}

export type NormalizedPostgresTestError = {
  actorName: string;
  phase: string;
  prismaCode: string | null;
  postgresSqlState: string | null;
  unexpectedConcurrencyFailure: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function findSqlState(value: unknown, depth = 0, seen = new Set<object>()): string | null {
  if (!isObject(value) || depth > 5 || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (
      typeof nested === "string" &&
      ["code", "sqlstate", "sqlState"].includes(key) &&
      /^[0-9A-Z]{5}$/.test(nested) &&
      !/^P\d{4}$/.test(nested)
    ) {
      return nested;
    }
    const found = findSqlState(nested, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function sanitizeDiagnosticLabel(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, 80);
  return sanitized || "unspecified";
}

export function normalizePostgresTestError(
  error: unknown,
  actorName: string,
  phase: string
): NormalizedPostgresTestError {
  const prismaCode = isObject(error) && typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ? error.code
    : null;
  const postgresSqlState = isObject(error) && "meta" in error ? findSqlState(error.meta) : findSqlState(error);
  return {
    actorName: sanitizeDiagnosticLabel(actorName),
    phase: sanitizeDiagnosticLabel(phase),
    prismaCode,
    postgresSqlState,
    unexpectedConcurrencyFailure:
      prismaCode === "P2034" ||
      postgresSqlState === "40P01" ||
      postgresSqlState === "55P03" ||
      (prismaCode === "P2010" && ["40P01", "55P03"].includes(postgresSqlState ?? ""))
  };
}

export function assertNoUnexpectedConcurrencyError(
  error: unknown,
  actorName: string,
  phase: string
): void {
  const diagnostic = normalizePostgresTestError(error, actorName, phase);
  if (!diagnostic.unexpectedConcurrencyFailure) return;
  throw new Error(
    `Unexpected PostgreSQL concurrency failure for actor=${diagnostic.actorName}, phase=${diagnostic.phase}, ` +
      `prismaCode=${diagnostic.prismaCode ?? "none"}, sqlState=${diagnostic.postgresSqlState ?? "none"}.`
  );
}

export async function createSyntheticTestUser(
  actor: PostgresTestActor,
  label: string,
  environment: PostgresTestEnvironment = process.env
): Promise<{ id: string; name: string; email: string }> {
  validatePostgresTestEnvironment(environment);
  const safeLabel = sanitizeActorName(label);
  return actor.client.user.create({
    data: {
      name: `Commit 5 ${safeLabel}`,
      email: `commit5-${safeLabel}-${randomUUID()}@example.test`
    },
    select: { id: true, name: true, email: true }
  }) as Promise<{ id: string; name: string; email: string }>;
}

export async function deleteSyntheticTestUsers(
  actor: PostgresTestActor,
  userIds: readonly string[],
  environment: PostgresTestEnvironment = process.env
): Promise<void> {
  validatePostgresTestEnvironment(environment);
  if (userIds.length === 0 || userIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Synthetic user cleanup requires one or more explicit user IDs.");
  }
  await actor.client.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

export async function disconnectPostgresTestActors(
  actors: readonly PostgresTestActor[],
  timeoutMs = POSTGRES_TEST_BARRIER_TIMEOUT_MS
): Promise<void> {
  const results = await Promise.allSettled(
    actors.map((actor) => {
      const state = actorRuntimeStates.get(actor);
      const client = state?.baseClient ?? actor.client;
      return withTimeout(client.$disconnect(), timeoutMs, `disconnect ${actor.actorName}`);
    })
  );
  const failedActors = results
    .map((result, index) => ({ result, actor: actors[index] }))
    .filter((entry) => entry.result.status === "rejected")
    .map((entry) => entry.actor.actorName);
  if (failedActors.length > 0) {
    throw new Error(`Failed to disconnect PostgreSQL test actors: ${failedActors.join(", ")}.`);
  }
}
