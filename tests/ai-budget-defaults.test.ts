import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test, type TestContext } from "node:test";

const priorDatabaseUrl = process.env.DATABASE_URL;
const priorDirectUrl = process.env.DIRECT_URL;
process.env.DATABASE_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
process.env.DIRECT_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
after(() => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDirectUrl === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = priorDirectUrl;
});

function schemaDefault(model: string, field: string): number {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const block = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  assert.ok(block, `schema model ${model} not found`);
  const line = new RegExp(`^\\s*${field}\\s+Int\\s+@default\\((\\d+)\\)`, "m").exec(block[1]);
  assert.ok(line, `${model}.${field} has no integer @default`);
  return Number(line[1]);
}

type AiSettingsCreate = { monthlyBudgetCents?: number; maxAnalysesPerSync?: number; automationBudgetCents?: number };

async function captureCreate(t: TestContext, create: (userId: string) => Promise<unknown>) {
  const { prisma } = await import("@/lib/prisma");
  const settings = prisma.aISettings as unknown as Record<string, unknown>;
  const original = settings.upsert;
  t.after(() => {
    settings.upsert = original;
  });
  let captured: AiSettingsCreate | undefined;
  settings.upsert = async (args: { create: AiSettingsCreate }) => {
    captured = args.create;
    return { ...args.create };
  };
  await create("budget-default-user");
  assert.ok(captured, "getOrCreateAiSettings should upsert AISettings");
  return captured;
}

test("shared AI settings defaults equal the Prisma schema defaults", async () => {
  const defaults = await import("@/lib/ai/budget-defaults");

  assert.equal(defaults.DEFAULT_MONTHLY_BUDGET_CENTS, 500);
  assert.equal(defaults.DEFAULT_MONTHLY_BUDGET_CENTS, schemaDefault("AISettings", "monthlyBudgetCents"));
  assert.equal(defaults.DEFAULT_AUTOMATION_BUDGET_CENTS, schemaDefault("AISettings", "automationBudgetCents"));
  assert.equal(defaults.DEFAULT_MAX_ANALYSES_PER_SYNC, schemaDefault("AISettings", "maxAnalysesPerSync"));
});

test("the legacy usage path creates AI settings with the shared monthly budget", async (t) => {
  const { DEFAULT_MONTHLY_BUDGET_CENTS, DEFAULT_MAX_ANALYSES_PER_SYNC } = await import("@/lib/ai/budget-defaults");
  const { getOrCreateAiSettings } = await import("@/lib/ai/usage");

  const created = await captureCreate(t, getOrCreateAiSettings);

  assert.equal(created.monthlyBudgetCents, DEFAULT_MONTHLY_BUDGET_CENTS);
  assert.equal(created.maxAnalysesPerSync, DEFAULT_MAX_ANALYSES_PER_SYNC);
});

test("the hard-ledger path creates AI settings with the same shared defaults", async (t) => {
  const defaults = await import("@/lib/ai/budget-defaults");
  const { getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");

  const created = await captureCreate(t, getOrCreateAiSettings);

  assert.equal(created.monthlyBudgetCents, defaults.DEFAULT_MONTHLY_BUDGET_CENTS);
  assert.equal(created.automationBudgetCents, defaults.DEFAULT_AUTOMATION_BUDGET_CENTS);
  assert.equal(created.maxAnalysesPerSync, defaults.DEFAULT_MAX_ANALYSES_PER_SYNC);
});

test("no AI module redefines its own default monthly budget", () => {
  for (const file of ["../lib/ai/usage.ts", "../lib/ai/application-plan-budget.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !/const\s+DEFAULT_MONTHLY_BUDGET_CENTS\s*=/.test(source),
      `${file} must import the shared default instead of declaring its own`
    );
  }
});
