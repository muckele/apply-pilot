import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

// Simultaneous first page loads for a brand-new user, against the disposable PostgreSQL database.
// The AI settings page and GET /api/ai/settings each ask for AI settings and the monthly usage
// (which also creates the month's budget ledger) in parallel, so even one load races itself.
// Synthetic users only.

const ROUNDS = 8;
const SIMULTANEOUS_LOADS = 4;

function describeFailure(reason: unknown) {
  if (reason instanceof Prisma.PrismaClientKnownRequestError) return `${reason.code}: ${reason.message.split("\n").at(-1)}`;
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

function failures(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) => (result.status === "rejected" ? [describeFailure(result.reason)] : []));
}

async function withDatabase(run: (client: PrismaClient) => Promise<void>) {
  const config = validatePostgresTestEnvironment(process.env);
  assertPostgresTestMajorVersion(await verifyLivePostgresTestDatabase(config));
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const { prisma } = await import("@/lib/prisma");
  try {
    await run(client);
  } finally {
    await client.$disconnect();
    await prisma.$disconnect();
  }
}

async function createSyntheticUser(client: PrismaClient, label: string) {
  return client.user.create({
    data: { email: `${label}-${randomUUID()}@example.test`, name: "Synthetic First Visit User" }
  });
}

test("simultaneous first AI settings requests for a new user create one row, and none fails", { timeout: 60_000 }, async () => {
  await withDatabase(async (client) => {
    const { getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");

    for (let round = 0; round < ROUNDS; round += 1) {
      const user = await createSyntheticUser(client, "first-visit-settings");
      const results = await Promise.allSettled(
        Array.from({ length: SIMULTANEOUS_LOADS * 2 }, () => getOrCreateAiSettings(user.id))
      );

      assert.deepEqual(failures(results), [], `round ${round + 1}: every simultaneous settings request succeeds`);
      assert.equal(await client.aISettings.count({ where: { userId: user.id } }), 1);
    }
  });
});

test("simultaneous first page loads create one AI settings row and one budget ledger, and none fails", { timeout: 60_000 }, async () => {
  await withDatabase(async (client) => {
    const { getMonthlyAiUsage, getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");

    for (let round = 0; round < ROUNDS; round += 1) {
      const user = await createSyntheticUser(client, "first-visit");
      const loads = Array.from({ length: SIMULTANEOUS_LOADS }, () =>
        Promise.all([getOrCreateAiSettings(user.id), getMonthlyAiUsage(user.id)])
      );
      const results = await Promise.allSettled(loads);

      assert.deepEqual(failures(results), [], `round ${round + 1}: every simultaneous first load succeeds`);
      const settingsIds = new Set(
        results.flatMap((result) => (result.status === "fulfilled" ? [result.value[0].id] : []))
      );
      assert.equal(settingsIds.size, 1, "every load sees the same AI settings row");
      assert.equal(await client.aISettings.count({ where: { userId: user.id } }), 1);
      assert.equal(await client.aIBudgetLedger.count({ where: { userId: user.id } }), 1);
    }
  });
});

test("a user's chosen budget survives simultaneous visits", { timeout: 60_000 }, async () => {
  await withDatabase(async (client) => {
    const { getMonthlyAiUsage, getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");
    const user = await createSyntheticUser(client, "first-visit-budget");
    await client.aISettings.create({ data: { userId: user.id, monthlyBudgetCents: 250 } });

    const results = await Promise.allSettled(
      Array.from({ length: SIMULTANEOUS_LOADS }, () =>
        Promise.all([getOrCreateAiSettings(user.id), getMonthlyAiUsage(user.id)])
      )
    );

    assert.deepEqual(failures(results), []);
    for (const result of results) {
      if (result.status === "fulfilled") assert.equal(result.value[0].monthlyBudgetCents, 250);
    }
    const stored = await client.aISettings.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(stored.monthlyBudgetCents, 250);
  });
});

test("simultaneous first AI requests in a month all reserve against one budget ledger", { timeout: 60_000 }, async () => {
  await withDatabase(async (client) => {
    const { reserveAiBudget } = await import("@/lib/ai/application-plan-budget");

    for (let round = 0; round < ROUNDS; round += 1) {
      const user = await createSyntheticUser(client, "first-visit-reserve");
      const results = await Promise.allSettled(
        Array.from({ length: SIMULTANEOUS_LOADS }, (_, index) =>
          reserveAiBudget({
            userId: user.id,
            provider: "gemini",
            model: "gemini-synthetic",
            feature: "JOB_MATCH",
            promptName: "synthetic-first-visit",
            promptVersion: "v1",
            requestHash: `synthetic-request-${index}`,
            maximumCostMicros: 10_000,
            automation: false
          })
        )
      );

      assert.deepEqual(failures(results), [], `round ${round + 1}: every simultaneous first request reserves`);
      assert.equal(await client.aIBudgetLedger.count({ where: { userId: user.id } }), 1);
      const ledger = await client.aIBudgetLedger.findFirstOrThrow({ where: { userId: user.id } });
      assert.equal(ledger.reservedMicros, SIMULTANEOUS_LOADS * 10_000);
      assert.equal(await client.aIBudgetReservation.count({ where: { userId: user.id, status: "RESERVED" } }), SIMULTANEOUS_LOADS);
    }
  });
});
