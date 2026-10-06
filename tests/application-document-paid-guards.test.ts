import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import OpenAI from "openai";
import { z } from "zod";

import { generateJson, getOpenAIClient } from "@/lib/ai/client";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function paidEnvironment(t: TestContext) {
  const changes: Record<string, string | undefined> = {
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: "openai",
    AI_PROVIDER_OVERRIDES: "",
    OPENAI_API_KEY: "synthetic-never-log",
    OPENAI_MOCK_MODE: "false",
    OPENAI_MODEL: "gpt-4o-mini",
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function installLedger(
  t: TestContext,
  priorAttempt: "RESERVED" | "UNCERTAIN" | null = null,
  cachedOutput: Record<string, unknown> | null = null,
  failReconciliation = false
) {
  let reservation: Record<string, unknown> | null = null;
  const reservations: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const cacheWrites: Array<Record<string, unknown>> = [];

  const cacheQueries: Array<Record<string, unknown>> = [];
  stub(t, prisma.aIResponseCache, "findFirst", async (query: Record<string, unknown>) => {
    cacheQueries.push(query);
    return cachedOutput ? { output: cachedOutput } : null;
  });
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => priorAttempt
    ? { id: "prior-reservation", status: priorAttempt }
    : null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));
  // Compatibility with the legacy generic path; guarded document generation
  // must stop consulting these aggregate-only helpers.
  stub(t, prisma.aIUsageEvent, "aggregate", async () => ({ _sum: { estimatedCostMicros: 0 } }));
  stub(t, prisma.aIUsageEvent, "count", async () => 0);
  stub(t, prisma.aIUsageEvent, "create", async () => ({}));

  const tx = {
    aIBudgetLedger: {
      upsert: async () => ({ id: "ledger-1" }),
      updateMany: async () => ({ count: 1 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        reservations.push(data);
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        reconciliations.push(data);
        if (failReconciliation) throw new Error("synthetic reconciliation failure with private detail");
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async () => ({}) },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));

  return { reservations, reconciliations, cacheWrites, cacheQueries };
}

const schema = z.object({ value: z.string() }).strict();

function documentRequest(options: {
  confirmed?: boolean;
  payload?: unknown;
  feature?: "RESUME_TAILOR" | "COVER_LETTER";
  promptVersion?: string;
} = {}) {
  const feature = options.feature ?? "RESUME_TAILOR";
  return generateJson({
    promptName: feature === "RESUME_TAILOR" ? "resumeTailorPrompt" : "coverLetterPrompt",
    systemPrompt: "Return only source-supported content.",
    payload: options.payload ?? { resume: { rawText: "Synthetic TypeScript evidence." } },
    schema,
    context: {
      userId: "synthetic-user",
      feature,
      promptVersion: options.promptVersion ?? "3",
      highCostConfirmed: options.confirmed,
      dataSharingConfirmed: options.confirmed
    }
  });
}

test("document generation requires both data and exact-cost confirmation before reservation or dispatch", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(documentRequest(), (error: unknown) =>
    error instanceof PublicApiError && error.status === 428 &&
    error.details?.code === "AI_COST_CONFIRMATION_REQUIRED" &&
    error.details.maximumCostMicros === 12_000 &&
    error.details.dataType === "application_packet" &&
    error.details.provider === "openai" &&
    error.details.model === "gpt-4o-mini" &&
    error.details.promptVersion === "3"
  );
  assert.equal(calls, 0);
  assert.equal(ledger.reservations.length, 0);
});

test("document generation preserves its existing OpenAI route when the global provider uses its Gemini default", async (t) => {
  paidEnvironment(t);
  delete process.env.AI_PROVIDER;
  delete process.env.AI_ENABLED;
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => {
    calls += 1;
    return {
      choices: [{ finish_reason: "stop", message: { content: '{"value":"supported"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }
    };
  });

  const result = await documentRequest({ confirmed: true });

  assert.equal(result.data.value, "supported");
  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.model, "gpt-4o-mini");
  assert.equal(calls, 1);
  assert.equal(ledger.reservations[0].provider, "openai");
});

test("confirmed resume tailoring reserves its exact cap, sends one capped request, and caches only validated output", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  const requests: Array<Record<string, unknown>> = [];
  const requestOptions: Array<Record<string, unknown> | undefined> = [];
  stub(t, client.chat.completions, "create", async (
    request: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => {
    requests.push(request);
    requestOptions.push(options);
    return {
      choices: [{ finish_reason: "stop", message: { content: '{"value":"supported"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }
    };
  });

  const result = await documentRequest({ confirmed: true });

  assert.equal(result.data.value, "supported");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 6_000);
  assert.equal(requestOptions[0]?.maxRetries, 0);
  assert.equal(ledger.reservations[0].maximumCostMicros, 12_000);
  assert.equal(ledger.reservations[0].promptVersion, "3");
  assert.equal(ledger.reconciliations[0].status, "SUCCEEDED");
  assert.equal(ledger.cacheWrites.length, 1);
  assert.deepEqual(ledger.cacheWrites[0].output, { value: "supported" });
});

test("confirmed cover-letter generation uses its smaller output cap and exact reservation", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  const requests: Array<Record<string, unknown>> = [];
  stub(t, client.chat.completions, "create", async (request: Record<string, unknown>) => {
    requests.push(request);
    return {
      choices: [{ finish_reason: "stop", message: { content: '{"value":"supported"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }
    };
  });

  const result = await documentRequest({ confirmed: true, feature: "COVER_LETTER" });

  assert.equal(result.data.value, "supported");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 1_500);
  assert.equal(ledger.reservations[0].maximumCostMicros, 9_300);
});

test("cache lookups are isolated by prompt version and validated without dispatch or reservation", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t, null, { value: "cached-supported" });
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => { calls += 1; throw new Error("must not call"); });

  const result = await documentRequest({ promptVersion: "3" });

  assert.equal(result.data.value, "cached-supported");
  assert.equal(calls, 0);
  assert.equal(ledger.reservations.length, 0);
  assert.equal(ledger.cacheQueries.length, 1);
  const where = ledger.cacheQueries[0].where as Record<string, unknown>;
  assert.equal(where.userId, "synthetic-user");
  assert.equal(where.provider, "openai");
  assert.equal(where.model, "gpt-4o-mini");
  assert.equal(where.promptName, "resumeTailorPrompt");
  assert.equal(where.promptVersion, "3");
  assert.equal(where.requestHash, result.meta.requestHash);
  assert.ok(Array.isArray(where.OR));
});

test("oversize document input fails before cache, reservation, or provider dispatch", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(
    documentRequest({
      confirmed: true,
      payload: { resume: { rawText: "x".repeat(170_000) } }
    }),
    /Resume text exceeds the 30,000-token AI input limit/
  );
  assert.equal(calls, 0);
  assert.equal(ledger.reservations.length, 0);
});

test("token-dense OpenAI input fails a conservative wire bound before reservation or dispatch", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(
    documentRequest({
      confirmed: true,
      payload: { resume: { rawText: "x".repeat(60_000) } }
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 413 && error.details?.code === "AI_INPUT_TOO_LARGE"
  );
  assert.equal(calls, 0);
  assert.equal(ledger.reservations.length, 0);
});

test("an uncertain document-provider outcome consumes the reservation once and never retries", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => {
    calls += 1;
    throw new Error("synthetic disconnect with private detail");
  });

  await assert.rejects(
    documentRequest({ confirmed: true }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_PROVIDER_UNCERTAIN" &&
      error.details.retryable === false &&
      !error.message.includes("private detail")
  );
  assert.equal(calls, 1);
  assert.equal(ledger.reconciliations[0].status, "UNCERTAIN");
  assert.equal(ledger.reconciliations[0].actualCostMicros, 12_000);
  assert.equal(ledger.cacheWrites.length, 0);
});

test("an OpenAI 408 remains an uncertain non-retryable billing outcome", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => {
    calls += 1;
    throw new OpenAI.APIError(408, undefined, "synthetic upstream timeout", undefined);
  });

  await assert.rejects(
    documentRequest({ confirmed: true }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_PROVIDER_UNCERTAIN" &&
      error.details?.billingStatus === "uncertain" &&
      error.details?.retryable === false
  );
  assert.equal(calls, 1);
  assert.equal(ledger.reconciliations[0].status, "UNCERTAIN");
  assert.equal(ledger.reconciliations[0].actualCostMicros, 12_000);
});

test("billing reconciliation failure is visible, non-retryable, and never swallowed", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t, null, null, true);
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => {
    calls += 1;
    return {
      choices: [{ finish_reason: "stop", message: { content: '{"value":"supported"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } }
    };
  });

  await assert.rejects(
    documentRequest({ confirmed: true }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 503 &&
      error.details?.code === "APPLICATION_DOCUMENT_RECONCILIATION_UNCERTAIN" &&
      error.details?.billingStatus === "uncertain" &&
      error.details?.retryable === false &&
      !error.message.includes("private detail")
  );
  assert.equal(calls, 1);
  assert.equal(ledger.reservations.length, 1);
  assert.equal(ledger.cacheWrites.length, 0);
  assert.equal(ledger.reconciliations.length, 2);
});

test("a prior uncertain identical document request blocks redispatch", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t, "UNCERTAIN");
  const client = getOpenAIClient()!;
  let calls = 0;
  stub(t, client.chat.completions, "create", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(
    documentRequest({ confirmed: true }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 409 && error.details?.code === "APPLICATION_DOCUMENT_PRIOR_OUTCOME_UNCERTAIN"
  );
  assert.equal(calls, 0);
  assert.equal(ledger.reservations.length, 0);
});
