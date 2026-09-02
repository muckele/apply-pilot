import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT,
  POSTGRES_TEST_LOCK_TIMEOUT,
  POSTGRES_TEST_STATEMENT_TIMEOUT,
  PostgresTestActorSessionChangedError,
  PostgresTestLateFailureError,
  assertActorSessionPinned,
  assertDistinctActorSessions,
  assertNoIdleTransactions,
  assertNoUnexpectedConcurrencyError,
  assertPostgresTestMajorVersion,
  createHookedPrismaClient,
  createPostgresTestActor,
  createSyntheticTestUser,
  deferred,
  deleteSyntheticTestUsers,
  disconnectPostgresTestActors,
  lateFailureSentinel,
  normalizePostgresTestError,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase,
  waitForActorLockWait,
  withTimeout,
  type Deferred,
  type PostgresTestActor
} from "@/tests/postgres/postgres-test-harness";

type OperationResult = PromiseSettledResult<unknown>;

function requireFulfilled(result: OperationResult, actorName: string, phase: string): void {
  if (result.status === "fulfilled") return;
  assertNoUnexpectedConcurrencyError(result.reason, actorName, phase);
  assert.fail(`PostgreSQL actor ${actorName} failed during ${phase}.`);
}

async function assertIsolationRejectedBeforeCallback(
  invoke: (callback: () => Promise<void>) => Promise<unknown>,
  expectedMessage = /must inherit the database READ COMMITTED isolation level/
): Promise<void> {
  let callbackCount = 0;
  let caught: unknown;
  try {
    await invoke(async () => {
      callbackCount += 1;
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(callbackCount, 0);
  assert.ok(caught instanceof Error);
  assert.match(caught.message, expectedMessage);
}

async function readActorIsolation(actor: PostgresTestActor): Promise<string | undefined> {
  const rows = await actor.client.$queryRaw<Array<{ isolation: string }>>(Prisma.sql`
    SELECT current_setting('transaction_isolation') AS "isolation"
  `);
  return rows[0]?.isolation;
}

async function waitForBackendExit(observer: PostgresTestActor, actor: PostgresTestActor): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer.client.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${actor.backendPid} AND application_name = ${actor.applicationName}
      ) AS "present"
    `);
    if (rows[0]?.present === false) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PostgreSQL actor ${actor.actorName} backend did not exit within the bounded deadline.`);
}

type CapturedChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  combinedOutput: string;
  outputOverflowed: boolean;
  timedOut: boolean;
};

async function runCapturedNode(source: string, environment: NodeJS.ProcessEnv): Promise<CapturedChildResult> {
  const outputLimit = 64 * 1024;
  return new Promise<CapturedChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let combinedOutput = "";
    let outputOverflowed = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (combinedOutput.length < outputLimit) {
        combinedOutput += chunk.toString("utf8", 0, outputLimit - combinedOutput.length);
      }
      if (combinedOutput.length >= outputLimit) outputOverflowed = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => reject(new Error("Failed to start the captured PostgreSQL privacy probe.")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, combinedOutput, outputOverflowed, timedOut });
    });
  });
}

test("PostgreSQL concurrency harness proves session identity, lock observation, and lock release", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  const liveDatabase = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(liveDatabase);
  assert.equal(liveDatabase.databaseName, "apply_pilot_commit5_test");
  assert.equal(liveDatabase.isolation, "read committed");

  const actors: PostgresTestActor[] = [];
  const releases: Array<Deferred<void>> = [];
  const operations: Array<Promise<unknown>> = [];
  const syntheticUserIds: string[] = [];
  let observer: PostgresTestActor | undefined;

  try {
    observer = await createPostgresTestActor("observer");
    actors.push(observer);
    const holder = await createPostgresTestActor("holder");
    actors.push(holder);
    const waiter = await createPostgresTestActor("waiter");
    actors.push(waiter);

    assertDistinctActorSessions([holder, waiter, observer]);
    assert.notEqual(holder.backendPid, waiter.backendPid);
    assert.notEqual(holder.backendPid, observer.backendPid);
    assert.notEqual(waiter.backendPid, observer.backendPid);

    const visibleSessions = await observer.client.$queryRaw<Array<{ pid: number; applicationName: string }>>(Prisma.sql`
      SELECT pid::integer AS "pid", application_name AS "applicationName"
      FROM pg_stat_activity
      WHERE pid IN (${Prisma.join(actors.map((actor) => actor.backendPid))})
    `);
    assert.equal(visibleSessions.length, 3);
    for (const actor of actors) {
      assert.ok(
        visibleSessions.some(
          (session) => session.pid === actor.backendPid && session.applicationName === actor.applicationName
        ),
        actor.actorName
      );
      assert.deepEqual(actor.sessionTimeouts, {
        lockTimeout: POSTGRES_TEST_LOCK_TIMEOUT,
        statementTimeout: POSTGRES_TEST_STATEMENT_TIMEOUT,
        idleTransactionTimeout: POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT
      });
      const isolationRows = await actor.client.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
        "SHOW transaction_isolation"
      );
      assert.equal(isolationRows[0]?.transaction_isolation, "read committed");
    }

    const commitUser = await createSyntheticTestUser(observer, "commit-release");
    syntheticUserIds.push(commitUser.id);
    const commitHolderReached = deferred("commit holder acquired row lock");
    const commitHolderRelease = deferred("release commit holder");
    const commitWaiterStarted = deferred("commit waiter started lock query");
    releases.push(commitHolderRelease);

    const commitHolderHooks = createHookedPrismaClient(holder, [
      {
        name: "commit holder user lock",
        match: { kind: "queryRaw", includes: ['FROM "User"', "FOR UPDATE"] },
        after: async () => {
          commitHolderReached.resolve();
          await commitHolderRelease.wait();
        }
      }
    ]);
    const commitWaiterHooks = createHookedPrismaClient(waiter, [
      {
        name: "commit waiter user lock",
        match: { kind: "queryRaw", includes: ['FROM "User"', "FOR UPDATE"] },
        before: () => commitWaiterStarted.resolve()
      }
    ]);

    const commitHolderOperation = commitHolderHooks.prismaClient.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "User" WHERE "id" = ${commitUser.id} FOR UPDATE
      `);
    });
    operations.push(commitHolderOperation);
    await commitHolderReached.wait();

    const commitWaiterOperation = commitWaiterHooks.prismaClient.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "User" WHERE "id" = ${commitUser.id} FOR UPDATE
      `);
    });
    operations.push(commitWaiterOperation);
    await commitWaiterStarted.wait();
    const commitWait = await waitForActorLockWait(observer, waiter, holder);
    assert.equal(commitWait.waitEventType, "Lock");
    assert.equal(commitWait.hasUngrantedLock, true);
    assert.ok(commitWait.blockingPids.includes(holder.backendPid));

    commitHolderRelease.resolve();
    const commitResults = await withTimeout(
      Promise.allSettled([commitHolderOperation, commitWaiterOperation]),
      10_000,
      "commit lock release operations"
    );
    requireFulfilled(commitResults[0], holder.actorName, "commit-holder");
    requireFulfilled(commitResults[1], waiter.actorName, "commit-waiter");
    commitHolderHooks.assertExpectedHooksReached();
    commitWaiterHooks.assertExpectedHooksReached();

    const rollbackUser = await createSyntheticTestUser(observer, "rollback-release");
    syntheticUserIds.push(rollbackUser.id);
    const originalRollbackName = rollbackUser.name;
    const rollbackWriteReached = deferred("rollback holder completed real write");
    const rollbackHolderRelease = deferred("release rollback holder");
    const rollbackWaiterStarted = deferred("rollback waiter started lock query");
    releases.push(rollbackHolderRelease);
    const injectedFailure = lateFailureSentinel("self-test rollback after user update");

    const rollbackHolderHooks = createHookedPrismaClient(holder, [
      {
        name: "late user update failure",
        match: { kind: "model", model: "user", method: "update" },
        after: async () => {
          rollbackWriteReached.resolve();
          await rollbackHolderRelease.wait();
        },
        throwAfter: injectedFailure
      }
    ]);
    const rollbackWaiterHooks = createHookedPrismaClient(waiter, [
      {
        name: "rollback waiter user lock",
        match: { kind: "queryRaw", includes: ['FROM "User"', "FOR UPDATE"] },
        before: () => rollbackWaiterStarted.resolve()
      }
    ]);

    const rollbackHolderOperation = rollbackHolderHooks.prismaClient.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: rollbackUser.id },
        data: { name: "This real write must roll back" }
      });
    });
    operations.push(rollbackHolderOperation);
    await rollbackWriteReached.wait();

    const rollbackWaiterOperation = rollbackWaiterHooks.prismaClient.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "User" WHERE "id" = ${rollbackUser.id} FOR UPDATE
      `);
    });
    operations.push(rollbackWaiterOperation);
    await rollbackWaiterStarted.wait();
    const rollbackWait = await waitForActorLockWait(observer, waiter, holder);
    assert.equal(rollbackWait.waitEventType, "Lock");
    assert.ok(rollbackWait.blockingPids.includes(holder.backendPid));

    rollbackHolderRelease.resolve();
    const rollbackResults = await withTimeout(
      Promise.allSettled([rollbackHolderOperation, rollbackWaiterOperation]),
      10_000,
      "rollback lock release operations"
    );
    assert.equal(rollbackResults[0].status, "rejected");
    if (rollbackResults[0].status === "rejected") {
      assert.ok(rollbackResults[0].reason instanceof PostgresTestLateFailureError);
      assert.equal(rollbackResults[0].reason.code, "POSTGRES_TEST_LATE_FAILURE");
      assertNoUnexpectedConcurrencyError(rollbackResults[0].reason, holder.actorName, "expected-late-failure");
    }
    requireFulfilled(rollbackResults[1], waiter.actorName, "rollback-waiter");
    rollbackHolderHooks.assertExpectedHooksReached();
    rollbackWaiterHooks.assertExpectedHooksReached();

    const rolledBackUser = await observer.client.user.findUnique({
      where: { id: rollbackUser.id },
      select: { name: true }
    });
    assert.equal(rolledBackUser?.name, originalRollbackName);

    await assertActorSessionPinned(holder, "after commit and rollback lock release");
    await assertActorSessionPinned(waiter, "after commit and rollback lock release");
    await assertActorSessionPinned(observer, "after lock observation");
    await assertNoIdleTransactions(observer, [holder, waiter]);
    await deleteSyntheticTestUsers(observer, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    for (const release of releases) release.resolve();
    await Promise.allSettled(operations);
    if (observer && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(observer, syntheticUserIds);
      } catch {
        // The bounded disconnect below remains mandatory even when fixture cleanup fails.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("opted-in hooked clients execute exact verified RepeatableRead transactions", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("repeatable-read-commit");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "repeatable-read-commit");
    syntheticUserIds.push(user.id);
    assert.equal(await readActorIsolation(actor), "read committed");

    let modelBeforeCount = 0;
    let modelAfterCount = 0;
    let transactionBeforeCount = 0;
    let transactionAfterCount = 0;
    const transactionOptions = Object.freeze({
      maxWait: 4_321,
      timeout: 19_876,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    const nativeTransactionDescriptor = Object.getOwnPropertyDescriptor(
      PrismaClient.prototype,
      "$transaction"
    );
    assert.ok(nativeTransactionDescriptor);
    assert.equal(typeof nativeTransactionDescriptor.value, "function");
    const nativeTransactionMethod = nativeTransactionDescriptor.value as (
      this: PrismaClient,
      ...args: unknown[]
    ) => Promise<unknown>;
    let nativeTransactionCallCount = 0;
    Object.defineProperty(PrismaClient.prototype, "$transaction", {
      ...nativeTransactionDescriptor,
      value: function (this: PrismaClient, ...args: unknown[]) {
        nativeTransactionCallCount += 1;
        assert.strictEqual(args[1], transactionOptions);
        return Reflect.apply(nativeTransactionMethod, this, args);
      }
    });
    const { hooks, derived } = (() => {
      try {
        const hooks = createHookedPrismaClient(
          actor,
          [
            {
              name: "repeatable read user lookup",
              match: { kind: "model", model: "user", method: "findUnique" },
              before: () => {
                modelBeforeCount += 1;
              },
              after: () => {
                modelAfterCount += 1;
              }
            },
            {
              name: "repeatable read transaction",
              match: { kind: "transaction" },
              before: () => {
                transactionBeforeCount += 1;
              },
              after: () => {
                transactionAfterCount += 1;
              }
            }
          ],
          {
            requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
          }
        );
        return {
          hooks,
          derived: hooks.prismaClient.$extends({ name: "repeatable-read-derived" })
        };
      } finally {
        Object.defineProperty(PrismaClient.prototype, "$transaction", nativeTransactionDescriptor);
      }
    })();
    let callbackCount = 0;

    const result = await derived.$transaction(async (transaction) => {
      callbackCount += 1;
      const identityRows = await transaction.$queryRaw<
        Array<{
          backendPid: number;
          applicationName: string;
          databaseName: string;
          isolation: string;
          lockTimeout: string;
          statementTimeout: string;
          idleTransactionTimeout: string;
        }>
      >(Prisma.sql`
        SELECT
          pg_backend_pid()::integer AS "backendPid",
          current_setting('application_name') AS "applicationName",
          current_database() AS "databaseName",
          current_setting('transaction_isolation') AS "isolation",
          current_setting('lock_timeout') AS "lockTimeout",
          current_setting('statement_timeout') AS "statementTimeout",
          current_setting('idle_in_transaction_session_timeout') AS "idleTransactionTimeout"
      `);
      const found = await transaction.user.findUnique({
        where: { id: user.id },
        select: { id: true, name: true }
      });
      return { identity: identityRows[0], found };
    }, transactionOptions);

    assert.equal(callbackCount, 1);
    assert.deepEqual(result.found, { id: user.id, name: user.name });
    assert.deepEqual(result.identity, {
      backendPid: actor.backendPid,
      applicationName: actor.applicationName,
      databaseName: "apply_pilot_commit5_test",
      isolation: "repeatable read",
      lockTimeout: POSTGRES_TEST_LOCK_TIMEOUT,
      statementTimeout: POSTGRES_TEST_STATEMENT_TIMEOUT,
      idleTransactionTimeout: POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT
    });
    assert.equal(nativeTransactionCallCount, 1);
    assert.equal(modelBeforeCount, 1);
    assert.equal(modelAfterCount, 1);
    assert.equal(transactionBeforeCount, 1);
    assert.equal(transactionAfterCount, 1);
    hooks.assertExpectedHooksReached();
    assert.equal(await readActorIsolation(actor), "read committed");
    await assertActorSessionPinned(actor, "after exact RepeatableRead commit");

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed RepeatableRead commit regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("RepeatableRead opt-in rejects default, missing, mismatched, and batch isolation authority", async () => {
  const actors: PostgresTestActor[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("repeatable-read-restrictions");
    actors.push(actor);
    const defaultDerived = actor.client.$extends({ name: "default-repeatable-read-derived" });

    await assertIsolationRejectedBeforeCallback((callback) =>
      actor!.client.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      })
    );
    await assertIsolationRejectedBeforeCallback((callback) =>
      actor!.client.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      })
    );
    await assertIsolationRejectedBeforeCallback((callback) =>
      defaultDerived.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      })
    );

    const hooks = createHookedPrismaClient(actor, [], {
      requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    const requiredIsolationMessage = /must explicitly request its configured interactive transaction isolation level/;
    await assertIsolationRejectedBeforeCallback(
      (callback) => hooks.prismaClient.$transaction(callback),
      requiredIsolationMessage
    );
    await assertIsolationRejectedBeforeCallback(
      (callback) =>
        hooks.prismaClient.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }),
      requiredIsolationMessage
    );

    const batchOperation = hooks.prismaClient.user.count();
    assert.throws(
      () =>
        hooks.prismaClient.$transaction([batchOperation], {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
        }),
      /explicit transaction isolation is restricted to interactive transactions/
    );
    await assertActorSessionPinned(actor, "after RepeatableRead usage rejections");
    assert.equal(await readActorIsolation(actor), "read committed");
  } finally {
    await disconnectPostgresTestActors(actors);
  }
});

test("default controlled clients reject malformed interactive options before writes", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("default-interactive-option-rejection");
    actors.push(actor);
    const callableUser = await createSyntheticTestUser(actor, "interactive-callable-options");
    const deceptiveUser = await createSyntheticTestUser(actor, "interactive-deceptive-options");
    const nullUser = await createSyntheticTestUser(actor, "interactive-null-options");
    const primitiveUser = await createSyntheticTestUser(actor, "interactive-primitive-options");
    syntheticUserIds.push(callableUser.id, deceptiveUser.id, nullUser.id, primitiveUser.id);
    const derived = actor.client.$extends({ name: "default-interactive-option-derived" });
    const callableOptions = Object.assign(() => undefined, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
    let deceptiveIsolationReads = 0;
    const deceptiveOptions = new Proxy(
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      {
        has(target, property) {
          return property === "isolationLevel" ? false : Reflect.has(target, property);
        },
        get(target, property, receiver) {
          if (property === "isolationLevel") deceptiveIsolationReads += 1;
          return Reflect.get(target, property, receiver);
        }
      }
    );
    const malformedOptions = [callableOptions, deceptiveOptions, null, 17] as const;
    const clients = [actor.client, derived, actor.client, derived] as const;
    const users = [callableUser, deceptiveUser, nullUser, primitiveUser] as const;
    const callbackCounts = [0, 0, 0, 0];
    const errorMessages: Array<string | null> = [];

    for (let index = 0; index < malformedOptions.length; index += 1) {
      const client = clients[index] as PrismaClient;
      try {
        await client.$transaction(
          async (transaction) => {
            callbackCounts[index] += 1;
            await transaction.user.update({
              where: { id: users[index].id },
              data: { name: `malformed interactive options write ${index}` }
            });
          },
          malformedOptions[index] as unknown as {
            maxWait?: number;
            timeout?: number;
            isolationLevel?: Prisma.TransactionIsolationLevel;
          }
        );
        errorMessages.push(null);
      } catch (error) {
        errorMessages.push(error instanceof Error ? error.message : "non-error rejection");
      }
    }

    const reusableResult = await actor.client.$transaction(async (transaction) =>
      transaction.user.findMany({
        where: { id: { in: syntheticUserIds } },
        orderBy: { id: "asc" },
        select: { id: true, name: true }
      })
    );
    const expectedUsers = users
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const usageError = "PostgreSQL test interactive transaction options must be a plain non-proxy object.";

    assert.deepEqual(callbackCounts, [0, 0, 0, 0]);
    assert.deepEqual(errorMessages, [usageError, usageError, usageError, usageError]);
    assert.deepEqual(reusableResult, expectedUsers);
    assert.equal(deceptiveIsolationReads, 0);
    assert.equal(await readActorIsolation(actor), "read committed");
    await assertActorSessionPinned(actor, "after malformed interactive options rejection and reuse");

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed interactive-options regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("default controlled clients preserve plain interactive option identity", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("default-interactive-option-identity");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "default-interactive-option-identity");
    syntheticUserIds.push(user.id);
    const transactionOptions = Object.freeze({ maxWait: 4_123, timeout: 19_321 });
    const nativeTransactionDescriptor = Object.getOwnPropertyDescriptor(
      PrismaClient.prototype,
      "$transaction"
    );
    assert.ok(nativeTransactionDescriptor);
    assert.equal(typeof nativeTransactionDescriptor.value, "function");
    const nativeTransactionMethod = nativeTransactionDescriptor.value as (
      this: PrismaClient,
      ...args: unknown[]
    ) => Promise<unknown>;
    let nativeTransactionCallCount = 0;
    Object.defineProperty(PrismaClient.prototype, "$transaction", {
      ...nativeTransactionDescriptor,
      value: function (this: PrismaClient, ...args: unknown[]) {
        nativeTransactionCallCount += 1;
        assert.strictEqual(args[1], transactionOptions);
        return Reflect.apply(nativeTransactionMethod, this, args);
      }
    });
    const hooks = (() => {
      try {
        return createHookedPrismaClient(actor, []);
      } finally {
        Object.defineProperty(PrismaClient.prototype, "$transaction", nativeTransactionDescriptor);
      }
    })();

    const updated = await hooks.prismaClient.$transaction(
      async (transaction) =>
        transaction.user.update({
          where: { id: user.id },
          data: { name: "plain default options committed" },
          select: { id: true, name: true }
        }),
      transactionOptions
    );

    assert.deepEqual(updated, { id: user.id, name: "plain default options committed" });
    assert.equal(nativeTransactionCallCount, 1);
    assert.equal(await readActorIsolation(actor), "read committed");
    await assertActorSessionPinned(actor, "after plain default interactive options commit");

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed plain-options regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("controlled batch transactions reject callable and deceptive options before writes", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("batch-option-rejection");
    actors.push(actor);
    const callableUser = await createSyntheticTestUser(actor, "batch-callable-options");
    const deceptiveUser = await createSyntheticTestUser(actor, "batch-deceptive-options");
    syntheticUserIds.push(callableUser.id, deceptiveUser.id);
    const hooks = createHookedPrismaClient(actor, [], {
      requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    const callableOptions = Object.assign(() => undefined, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    let deceptiveIsolationReads = 0;
    const deceptiveOptions = new Proxy(
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      {
        has(target, property) {
          return property === "isolationLevel" ? false : Reflect.has(target, property);
        },
        get(target, property, receiver) {
          if (property === "isolationLevel") deceptiveIsolationReads += 1;
          return Reflect.get(target, property, receiver);
        }
      }
    );
    const callableWrite = actor.client.user.update({
      where: { id: callableUser.id },
      data: { name: "callable batch options must not write" }
    });
    const deceptiveWrite = hooks.prismaClient.user.update({
      where: { id: deceptiveUser.id },
      data: { name: "deceptive batch options must not write" }
    });
    const batchErrors: unknown[] = [];

    try {
      await actor.client.$transaction(
        [callableWrite],
        callableOptions as unknown as { isolationLevel?: Prisma.TransactionIsolationLevel }
      );
    } catch (error) {
      batchErrors.push(error);
    }
    try {
      await hooks.prismaClient.$transaction(
        [deceptiveWrite],
        deceptiveOptions as { isolationLevel?: Prisma.TransactionIsolationLevel }
      );
    } catch (error) {
      batchErrors.push(error);
    }

    const persistedUsers = await actor.client.user.findMany({
      where: { id: { in: syntheticUserIds } },
      orderBy: { id: "asc" },
      select: { id: true, name: true }
    });
    const expectedUsers = [callableUser, deceptiveUser]
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(persistedUsers, expectedUsers);
    assert.equal(batchErrors.length, 2);
    for (const error of batchErrors) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /explicit transaction isolation is restricted to interactive transactions/);
    }
    assert.equal(deceptiveIsolationReads, 0);
    await assertActorSessionPinned(actor, "after malformed batch options rejection");

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed batch-options regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("RepeatableRead callback failure rolls back and restores the usable actor session", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("repeatable-read-rollback");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "repeatable-read-rollback");
    syntheticUserIds.push(user.id);
    const sentinel = new Error("repeatable read rollback sentinel");
    const hooks = createHookedPrismaClient(actor, [], {
      requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    let callbackCount = 0;
    let actualIsolation: string | undefined;

    await assert.rejects(
      hooks.prismaClient.$transaction(
        async (transaction) => {
          callbackCount += 1;
          const rows = await transaction.$queryRaw<Array<{ isolation: string }>>(Prisma.sql`
            SELECT current_setting('transaction_isolation') AS "isolation"
          `);
          actualIsolation = rows[0]?.isolation;
          await transaction.user.update({
            where: { id: user.id },
            data: { name: "repeatable read write must roll back" }
          });
          throw sentinel;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      ),
      (error: unknown) => error === sentinel
    );
    assert.equal(callbackCount, 1);
    assert.equal(actualIsolation, "repeatable read");
    assert.equal(await readActorIsolation(actor), "read committed");
    await assertActorSessionPinned(actor, "after exact RepeatableRead rollback");
    const rolledBackUser = await actor.client.user.findUnique({
      where: { id: user.id },
      select: { name: true }
    });
    assert.deepEqual(rolledBackUser, { name: user.name });
    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed RepeatableRead rollback regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("actual RepeatableRead isolation mismatch poisons the actor before the callback", async () => {
  const actors: PostgresTestActor[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("repeatable-read-mismatch");
    actors.push(actor);
    const hooks = createHookedPrismaClient(actor, [], {
      requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    });
    let isolationReads = 0;
    const switchingOptions = {
      get isolationLevel(): Prisma.TransactionIsolationLevel {
        isolationReads += 1;
        return isolationReads === 1
          ? Prisma.TransactionIsolationLevel.RepeatableRead
          : Prisma.TransactionIsolationLevel.Serializable;
      }
    };
    let callbackCount = 0;
    let caught: unknown;

    try {
      await hooks.prismaClient.$transaction(async () => {
        callbackCount += 1;
      }, switchingOptions);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof PostgresTestActorSessionChangedError);
    assert.equal(callbackCount, 0);
    assert.ok(isolationReads >= 2);
    await assert.rejects(
      assertActorSessionPinned(actor, "after actual RepeatableRead mismatch"),
      (error: unknown) => error === caught
    );
  } finally {
    await disconnectPostgresTestActors(actors);
  }
});

test("PostgreSQL actors poison permanently before a replacement session can perform a write", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let observer: PostgresTestActor | undefined;

  try {
    observer = await createPostgresTestActor("replacement-observer");
    actors.push(observer);
    const victim = await createPostgresTestActor("replacement-victim");
    actors.push(victim);
    const user = await createSyntheticTestUser(observer, "replacement-poisoning");
    syntheticUserIds.push(user.id);

    assert.deepEqual(victim.sessionTimeouts, {
      lockTimeout: POSTGRES_TEST_LOCK_TIMEOUT,
      statementTimeout: POSTGRES_TEST_STATEMENT_TIMEOUT,
      idleTransactionTimeout: POSTGRES_TEST_IDLE_TRANSACTION_TIMEOUT
    });
    await assertActorSessionPinned(victim, "before forced backend termination");

    const hooks = createHookedPrismaClient(victim, [
      {
        name: "replacement victim write must not delegate",
        match: { kind: "model", model: "user", method: "update" },
        expectedMatches: 0,
        before: () => undefined,
        after: () => undefined
      }
    ]);
    const terminationRows = await observer.client.$queryRaw<Array<{ terminated: boolean }>>(Prisma.sql`
      SELECT pg_terminate_backend(${victim.backendPid}::integer) AS "terminated"
    `);
    assert.equal(terminationRows[0]?.terminated, true);
    await waitForBackendExit(observer, victim);

    const attemptWrite = () =>
      hooks.prismaClient.user.update({
        where: { id: user.id },
        data: { name: "replacement session must not write" }
      });
    await assert.rejects(
      attemptWrite(),
      (error: unknown) =>
        error instanceof PostgresTestActorSessionChangedError &&
        error.code === "POSTGRES_TEST_ACTOR_SESSION_CHANGED"
    );
    await assert.rejects(
      attemptWrite(),
      (error: unknown) =>
        error instanceof PostgresTestActorSessionChangedError &&
        error.code === "POSTGRES_TEST_ACTOR_SESSION_CHANGED"
    );
    hooks.assertExpectedHooksReached();

    const unchanged = await observer.client.user.findUnique({ where: { id: user.id }, select: { name: true } });
    assert.equal(unchanged?.name, user.name);
    await assert.rejects(
      assertActorSessionPinned(victim, "after actor poisoning"),
      (error: unknown) => error instanceof PostgresTestActorSessionChangedError
    );
    await deleteSyntheticTestUsers(observer, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (observer && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(observer, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed poisoning regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("PostgreSQL actors poison when required session timeout state is lost", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let observer: PostgresTestActor | undefined;

  try {
    observer = await createPostgresTestActor("timeout-observer");
    actors.push(observer);
    const victim = await createPostgresTestActor("timeout-victim");
    actors.push(victim);
    const user = await createSyntheticTestUser(observer, "timeout-poisoning");
    syntheticUserIds.push(user.id);
    const hooks = createHookedPrismaClient(victim, [
      {
        name: "timeout poisoned victim write must not delegate",
        match: { kind: "model", model: "user", method: "update" },
        expectedMatches: 0,
        before: () => undefined,
        after: () => undefined
      }
    ]);

    await assert.rejects(
      victim.client.$executeRawUnsafe("SET statement_timeout = 0"),
      (error: unknown) =>
        error instanceof PostgresTestActorSessionChangedError &&
        error.code === "POSTGRES_TEST_ACTOR_SESSION_CHANGED"
    );
    await assert.rejects(
      hooks.prismaClient.user.update({
        where: { id: user.id },
        data: { name: "timeout poisoned actor must not write" }
      }),
      (error: unknown) => error instanceof PostgresTestActorSessionChangedError
    );
    hooks.assertExpectedHooksReached();

    const unchanged = await observer.client.user.findUnique({ where: { id: user.id }, select: { name: true } });
    assert.equal(unchanged?.name, user.name);
    await deleteSyntheticTestUsers(observer, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (observer && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(observer, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed timeout regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("publicly derived clients retain isolation control and native batch semantics", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("derived-control");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "derived-control");
    syntheticUserIds.push(user.id);
    const derived = actor.client.$extends({ name: "derived-control-review" });
    let isolationCallbackCount = 0;

    assert.throws(
      () =>
        derived.$transaction(
          async () => {
            isolationCallbackCount += 1;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      /must inherit the database READ COMMITTED isolation level/
    );
    assert.equal(isolationCallbackCount, 0);
    await assertActorSessionPinned(actor, "after derived isolation rejection");

    const findOperation = derived.user.findMany({
      where: { id: user.id },
      select: { id: true, name: true }
    });
    assert.equal(Object.prototype.toString.call(findOperation), "[object PrismaPromise]");
    assert.deepEqual(await findOperation, [{ id: user.id, name: user.name }]);

    const firstCount = derived.user.count({ where: { id: user.id } });
    const secondCount = derived.user.count({ where: { id: user.id } });
    assert.equal(Object.prototype.toString.call(firstCount), "[object PrismaPromise]");
    assert.equal(Object.prototype.toString.call(secondCount), "[object PrismaPromise]");
    assert.deepEqual(await derived.$transaction([firstCount, secondCount]), [1, 1]);
    await assertActorSessionPinned(actor, "after derived batch transaction");

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed derived-client regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("supported public extensions retain transaction hooks and native Prisma behavior", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("hooked-derived");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "hooked-derived");
    syntheticUserIds.push(user.id);
    let beforeCount = 0;
    let afterCount = 0;
    let transactionCount = 0;
    const hooks = createHookedPrismaClient(actor, [
      {
        name: "multiply derived lazy findMany",
        match: { kind: "model", model: "user", method: "findMany" },
        before: () => {
          beforeCount += 1;
        },
        after: () => {
          afterCount += 1;
        }
      },
      {
        name: "multiply derived transaction entry",
        match: { kind: "transaction" },
        before: () => {
          transactionCount += 1;
        }
      }
    ]);
    let functionalCapture: PostgresTestActor["client"] | undefined;
    const functionalDerived = hooks.prismaClient.$extends((extensionClient) => {
      functionalCapture = extensionClient as unknown as PostgresTestActor["client"];
      return extensionClient.$extends({
        name: "hooked-functional-client-method",
        client: {
          exposeClient() {
            return this as unknown as PostgresTestActor["client"];
          }
        }
      });
    });
    const derived = functionalDerived.$extends({ name: "hooked-functional-recursive" });
    assert.ok(functionalCapture);
    const functionalClient = functionalCapture;
    const methodClient = derived.exposeClient();

    await assertIsolationRejectedBeforeCallback((callback) =>
      functionalClient.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      })
    );
    await assertIsolationRejectedBeforeCallback((callback) =>
      derived.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      })
    );
    await assertIsolationRejectedBeforeCallback((callback) =>
      methodClient.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      })
    );
    assert.equal(transactionCount, 0);
    await assertActorSessionPinned(actor, "after supported extension isolation rejection");

    const operation = methodClient.user.findMany({
      where: { id: user.id },
      select: { id: true, name: true }
    });
    assert.equal(Object.prototype.toString.call(operation), "[object PrismaPromise]");
    assert.equal(beforeCount, 0);
    assert.equal(afterCount, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(beforeCount, 0);
    assert.equal(afterCount, 0);
    assert.deepEqual(await operation, [{ id: user.id, name: user.name }]);
    assert.equal(beforeCount, 1);
    assert.equal(afterCount, 1);

    const firstCount = methodClient.user.count({ where: { id: user.id } });
    const secondCount = methodClient.user.count({ where: { id: user.id } });
    assert.equal(Object.prototype.toString.call(firstCount), "[object PrismaPromise]");
    assert.equal(Object.prototype.toString.call(secondCount), "[object PrismaPromise]");
    assert.deepEqual(await methodClient.$transaction([firstCount, secondCount]), [1, 1]);
    assert.equal(transactionCount, 0);

    const transactionResult = await methodClient.$transaction(async (transaction) =>
      transaction.user.findUnique({ where: { id: user.id }, select: { id: true } })
    );
    assert.deepEqual(transactionResult, { id: user.id });
    assert.equal(transactionCount, 1);
    hooks.assertExpectedHooksReached();

    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed hooked-derived regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("derived clients share permanent session-replacement poison with their base actor", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let observer: PostgresTestActor | undefined;

  async function expectSessionChanged(operation: PromiseLike<unknown>): Promise<PostgresTestActorSessionChangedError> {
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof PostgresTestActorSessionChangedError);
    assert.equal(caught.code, "POSTGRES_TEST_ACTOR_SESSION_CHANGED");
    return caught;
  }

  try {
    observer = await createPostgresTestActor("derived-poison-observer");
    actors.push(observer);
    const victim = await createPostgresTestActor("derived-poison-victim");
    actors.push(victim);
    const user = await createSyntheticTestUser(observer, "derived-poison");
    syntheticUserIds.push(user.id);
    let functionalCapture: PostgresTestActor["client"] | undefined;
    const functionalDerived = victim.client.$extends((extensionClient) => {
      functionalCapture = extensionClient as unknown as PostgresTestActor["client"];
      return extensionClient.$extends({
        name: "derived-poison-functional",
        client: {
          exposeClient() {
            return this as unknown as PostgresTestActor["client"];
          }
        }
      });
    });
    const derivedA = functionalDerived.$extends({ name: "derived-poison-recursive" });
    assert.ok(functionalCapture);
    const functionalClient = functionalCapture;
    const methodClient = derivedA.exposeClient();
    const derivedB = victim.client.$extends({ name: "derived-poison-object-sibling" });
    let callbackCount = 0;

    const terminationRows = await observer.client.$queryRaw<Array<{ terminated: boolean }>>(Prisma.sql`
      SELECT pg_terminate_backend(${victim.backendPid}::integer) AS "terminated"
    `);
    assert.equal(terminationRows[0]?.terminated, true);
    await waitForBackendExit(observer, victim);

    const firstError = await expectSessionChanged(
      methodClient.$transaction(async (transaction) => {
        callbackCount += 1;
        await transaction.user.update({
          where: { id: user.id },
          data: { name: "derived replacement must not write" }
        });
      })
    );
    assert.equal(callbackCount, 0);

    const secondError = await expectSessionChanged(
      methodClient.$transaction(async () => {
        callbackCount += 1;
      })
    );
    const functionalError = await expectSessionChanged(
      functionalClient.$transaction(async () => {
        callbackCount += 1;
      })
    );
    const derivedError = await expectSessionChanged(
      derivedA.$transaction(async () => {
        callbackCount += 1;
      })
    );
    const baseError = await expectSessionChanged(
      victim.client.user.findUnique({ where: { id: user.id }, select: { id: true } })
    );
    const siblingError = await expectSessionChanged(
      derivedB.$transaction(async () => {
        callbackCount += 1;
      })
    );
    const pinError = await expectSessionChanged(assertActorSessionPinned(victim, "after derived poisoning"));
    assert.equal(callbackCount, 0);
    assert.strictEqual(secondError, firstError);
    assert.strictEqual(functionalError, firstError);
    assert.strictEqual(derivedError, firstError);
    assert.strictEqual(baseError, firstError);
    assert.strictEqual(siblingError, firstError);
    assert.strictEqual(pinError, firstError);

    const unchanged = await observer.client.user.findUnique({ where: { id: user.id }, select: { name: true } });
    assert.equal(unchanged?.name, user.name);
    await deleteSyntheticTestUsers(observer, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (observer && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(observer, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed shared-poison regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("hooked model operations remain lazy native PrismaPromises", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("promise-laziness");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "promise-laziness");
    syntheticUserIds.push(user.id);
    let beforeCount = 0;
    let afterCount = 0;
    const hooks = createHookedPrismaClient(actor, [
      {
        name: "lazy user findMany",
        match: { kind: "model", model: "user", method: "findMany" },
        before: () => {
          beforeCount += 1;
        },
        after: () => {
          afterCount += 1;
        }
      }
    ]);

    const operation = hooks.prismaClient.user.findMany({
      where: { id: user.id },
      select: { id: true, name: true }
    });
    assert.equal(Object.prototype.toString.call(operation), "[object PrismaPromise]");
    assert.equal(beforeCount, 0);
    assert.equal(afterCount, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(beforeCount, 0);
    assert.equal(afterCount, 0);

    const result = await operation;
    assert.deepEqual(result, [{ id: user.id, name: user.name }]);
    assert.equal(beforeCount, 1);
    assert.equal(afterCount, 1);
    hooks.assertExpectedHooksReached();
    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed laziness regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("hooked native PrismaPromises participate in a successful batch transaction", async () => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("batch-success");
    actors.push(actor);
    const first = await createSyntheticTestUser(actor, "batch-success-first");
    const second = await createSyntheticTestUser(actor, "batch-success-second");
    syntheticUserIds.push(first.id, second.id);
    const hooks = createHookedPrismaClient(actor, [
      {
        name: "batch user counts",
        match: { kind: "model", model: "user", method: "count" },
        expectedMatches: 2,
        before: () => undefined,
        after: () => undefined
      }
    ]);

    const firstCount = hooks.prismaClient.user.count({ where: { id: { in: syntheticUserIds } } });
    const secondCount = hooks.prismaClient.user.count({ where: { id: { in: syntheticUserIds } } });
    assert.equal(Object.prototype.toString.call(firstCount), "[object PrismaPromise]");
    assert.equal(Object.prototype.toString.call(secondCount), "[object PrismaPromise]");
    const counts = await hooks.prismaClient.$transaction([firstCount, secondCount]);
    assert.deepEqual(counts, [2, 2]);
    hooks.assertExpectedHooksReached();
    await deleteSyntheticTestUsers(actor, syntheticUserIds);
    syntheticUserIds.length = 0;
  } finally {
    if (actor && syntheticUserIds.length > 0) {
      try {
        await deleteSyntheticTestUsers(actor, syntheticUserIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed batch regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("hooked native PrismaPromises preserve batch rollback semantics", async () => {
  const actors: PostgresTestActor[] = [];
  const cleanupIds = [`commit5-batch-${randomUUID()}`, `commit5-batch-${randomUUID()}`];
  let actor: PostgresTestActor | undefined;

  try {
    actor = await createPostgresTestActor("batch-rollback");
    actors.push(actor);
    const duplicateEmail = `commit5-batch-${randomUUID()}@example.test`;
    const hooks = createHookedPrismaClient(actor, [
      {
        name: "batch user creates",
        match: { kind: "model", model: "user", method: "create" },
        expectedMatches: 2,
        before: () => undefined
      }
    ]);
    const firstCreate = hooks.prismaClient.user.create({
      data: { id: cleanupIds[0], name: "batch rollback first", email: duplicateEmail }
    });
    const secondCreate = hooks.prismaClient.user.create({
      data: { id: cleanupIds[1], name: "batch rollback second", email: duplicateEmail }
    });
    assert.equal(Object.prototype.toString.call(firstCreate), "[object PrismaPromise]");
    assert.equal(Object.prototype.toString.call(secondCreate), "[object PrismaPromise]");

    let diagnostic: ReturnType<typeof normalizePostgresTestError> | undefined;
    try {
      await hooks.prismaClient.$transaction([firstCreate, secondCreate]);
      assert.fail("The duplicate-email batch transaction unexpectedly committed.");
    } catch (error) {
      diagnostic = normalizePostgresTestError(error, actor.actorName, "batch-rollback");
    }
    assert.equal(diagnostic?.prismaCode, "P2002");
    hooks.assertExpectedHooksReached();
    const persisted = await actor.client.user.findMany({
      where: { id: { in: cleanupIds } },
      select: { id: true }
    });
    assert.deepEqual(persisted, []);
  } finally {
    if (actor) {
      try {
        await deleteSyntheticTestUsers(actor, cleanupIds);
      } catch {
        // Bounded actor disconnect remains mandatory after a failed rollback regression.
      }
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("captured Prisma failures do not expose operation arguments or connection secrets", async () => {
  const modelMarker = "COMMIT5_SECRET_MODEL_MARKER";
  const passwordMarker = "COMMIT5_SECRET_PASSWORD_MARKER";
  const queryMarker = "COMMIT5_SECRET_QUERY_MARKER";
  const validUrl = process.env.TEST_DATABASE_URL;
  assert.ok(validUrl);
  const invalidUrl = new URL(validUrl);
  invalidUrl.password = passwordMarker;

  const source = `
    import {
      createPostgresTestActor,
      disconnectPostgresTestActors
    } from "./tests/postgres/postgres-test-harness.ts";

    const validEnvironment = {
      COMMIT5_POSTGRES_TEST: "1",
      NODE_ENV: "test",
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL
    };
    const invalidUrl = new URL(process.env.TEST_DATABASE_URL);
    invalidUrl.password = "${passwordMarker}";
    let invalidPasswordRejected = false;
    try {
      const unexpectedActor = await createPostgresTestActor("privacy-password", {
        ...validEnvironment,
        TEST_DATABASE_URL: invalidUrl.toString()
      });
      await disconnectPostgresTestActors([unexpectedActor]);
    } catch {
      invalidPasswordRejected = true;
    }
    if (!invalidPasswordRejected) throw new Error("The invalid-password privacy probe unexpectedly connected.");

    const actor = await createPostgresTestActor("privacy-errors", validEnvironment);
    try {
      let invalidModelRejected = false;
      try {
        await actor.client.user.create({
          data: { email: "${modelMarker}@example.test", name: { invalid: "${modelMarker}" } }
        });
      } catch {
        invalidModelRejected = true;
      }
      if (!invalidModelRejected) throw new Error("The invalid-model privacy probe unexpectedly succeeded.");
      let invalidQueryRejected = false;
      try {
        await actor.client.$queryRawUnsafe("SELECT $1::integer", "${queryMarker}");
      } catch {
        invalidQueryRejected = true;
      }
      if (!invalidQueryRejected) throw new Error("The invalid-query privacy probe unexpectedly succeeded.");
    } finally {
      await disconnectPostgresTestActors([actor]);
    }
    console.log("privacy-probe-complete");
  `;
  const result = await runCapturedNode(source, {
    ...process.env,
    NODE_ENV: "test",
    COMMIT5_POSTGRES_TEST: "1",
    TEST_DATABASE_URL: validUrl,
    DATABASE_URL: validUrl,
    DIRECT_URL: validUrl,
    AI_ENABLED: "false",
    AI_MOCK_MODE: "true",
    OPENAI_MOCK_MODE: "true",
    GEMINI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENAI_API_KEY: ""
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.outputOverflowed, false);
  assert.equal(result.signal, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.combinedOutput.includes("privacy-probe-complete"), true);
  const forbiddenOutput = [
    modelMarker,
    passwordMarker,
    queryMarker,
    validUrl,
    invalidUrl.toString(),
    "Invalid `prisma.user.create()` invocation",
    "Raw query failed"
  ];
  forbiddenOutput.forEach((forbidden, index) => {
    assert.equal(
      result.combinedOutput.includes(forbidden),
      false,
      `Captured Prisma privacy output exposed forbidden value ${index}.`
    );
  });
});
