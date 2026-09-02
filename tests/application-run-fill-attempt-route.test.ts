import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import * as routeModule from "@/app/api/application-runs/[id]/fill-attempt/route";
import { createApplicationRunFillAttemptRouteHandlers } from "@/app/api/application-runs/[id]/fill-attempt/route";
import { PublicApiError } from "@/lib/api-errors";
import { UnauthorizedError } from "@/lib/user-context";

const USER_ID = "user-1";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const FILL_ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const STEP_KEY = `fill:${FILL_ATTEMPT_ID}:${"a".repeat(64)}`;

function request(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/application-runs/${RUN_ID}/fill-attempt`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
}

function context(id = RUN_ID) {
  return { params: Promise.resolve({ id }) };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => undefined,
    acquireFillAttempt: async () => ({ operation: "acquire" }) as never,
    getFillAttemptStatus: async () => ({ operation: "status" }) as never,
    finalizeFillAttempt: async () => ({ operation: "finalize" }) as never,
    recoverExpiredFillAttempt: async () => ({ operation: "recover" }) as never,
    ...overrides
  };
}

test("fill-attempt route exposes only POST, GET, and PATCH", () => {
  assert.equal(typeof routeModule.POST, "function");
  assert.equal(typeof routeModule.GET, "function");
  assert.equal(typeof routeModule.PATCH, "function");
  assert.equal("PUT" in routeModule, false);
  assert.equal("DELETE" in routeModule, false);
});

test("POST authenticates, validates, rate limits, and delegates exact acquisition authority", async () => {
  const calls: unknown[] = [];
  const expected = { attemptId: FILL_ATTEMPT_ID, runStateVersion: 8 };
  const handlers = createApplicationRunFillAttemptRouteHandlers(dependencies({
    requireUserId: async () => { calls.push("auth"); return USER_ID; },
    checkRateLimit: async (key: string, limit: number, windowMs: number) => {
      calls.push(["rate", key, limit, windowMs]);
    },
    acquireFillAttempt: async (input: unknown) => {
      calls.push(["acquire", input]);
      return expected as never;
    }
  }));

  const response = await handlers.POST(request("POST", { expectedStateVersion: 7 }), context());

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(calls, [
    "auth",
    ["rate", `application-runs:fill-attempt:acquire:${USER_ID}`, 10, 60_000],
    ["acquire", { userId: USER_ID, runId: RUN_ID, expectedStateVersion: 7 }]
  ]);
});

test("GET validates and delegates an owner-only read with a per-field-safe rate limit", async () => {
  const calls: unknown[] = [];
  const expected = { state: "FILLING", fieldOperationAllowed: true };
  const handlers = createApplicationRunFillAttemptRouteHandlers(dependencies({
    requireUserId: async () => { calls.push("auth"); return USER_ID; },
    checkRateLimit: async (key: string, limit: number, windowMs: number) => {
      calls.push(["rate", key, limit, windowMs]);
    },
    getFillAttemptStatus: async (input: unknown) => {
      calls.push(["status", input]);
      return expected as never;
    }
  }));

  const response = await handlers.GET(request("GET"), context());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(calls, [
    "auth",
    ["rate", `application-runs:fill-attempt:status:${USER_ID}`, 300, 60_000],
    ["status", { userId: USER_ID, runId: RUN_ID }]
  ]);
});

test("PATCH explicitly dispatches exact FINALIZE and RECOVER_EXPIRED inputs", async () => {
  const calls: unknown[] = [];
  const handlers = createApplicationRunFillAttemptRouteHandlers(dependencies({
    checkRateLimit: async (key: string, limit: number, windowMs: number) => {
      calls.push(["rate", key, limit, windowMs]);
    },
    finalizeFillAttempt: async (input: unknown) => {
      calls.push(["finalize", input]);
      return { operation: "finalize" } as never;
    },
    recoverExpiredFillAttempt: async (input: unknown) => {
      calls.push(["recover", input]);
      return { operation: "recover" } as never;
    }
  }));
  const finalization = {
    action: "FINALIZE",
    fillAttemptId: FILL_ATTEMPT_ID,
    expectedStateVersion: 8,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{ stepKey: STEP_KEY, result: "FILLED", errorCode: null }]
  };

  const finalized = await handlers.PATCH(request("PATCH", finalization), context());
  assert.equal(finalized.status, 200);
  assert.equal(finalized.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await finalized.json(), { operation: "finalize" });
  assert.deepEqual(calls.at(-1), ["finalize", { userId: USER_ID, runId: RUN_ID, ...finalization }]);

  const recovered = await handlers.PATCH(request("PATCH", {
    action: "RECOVER_EXPIRED",
    fillAttemptId: FILL_ATTEMPT_ID,
    expectedStateVersion: 8
  }), context());
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await recovered.json(), { operation: "recover" });
  assert.deepEqual(calls.at(-1), ["recover", {
    userId: USER_ID,
    runId: RUN_ID,
    fillAttemptId: FILL_ATTEMPT_ID,
    expectedStateVersion: 8
  }]);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "finalize").length, 1);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "recover").length, 1);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "rate"), [
    ["rate", `application-runs:fill-attempt:mutate:${USER_ID}`, 30, 60_000],
    ["rate", `application-runs:fill-attempt:mutate:${USER_ID}`, 30, 60_000]
  ]);
});

test("authentication, path, and strict Zod failures are no-store and never call Fill services", async () => {
  let serviceCalls = 0;
  let rateCalls = 0;
  const serviceFailure = async () => { serviceCalls += 1; throw new Error("unexpected service call"); };
  const handlers = createApplicationRunFillAttemptRouteHandlers(dependencies({
    checkRateLimit: async () => { rateCalls += 1; },
    acquireFillAttempt: serviceFailure,
    getFillAttemptStatus: serviceFailure,
    finalizeFillAttempt: serviceFailure,
    recoverExpiredFillAttempt: serviceFailure
  }));

  const invalidPath = await handlers.POST(request("POST", { expectedStateVersion: 7 }), context("not-a-cuid"));
  assert.equal(invalidPath.status, 422);
  assert.equal(invalidPath.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  const invalidGetPath = await handlers.GET(request("GET"), context("not-a-cuid"));
  assert.equal(invalidGetPath.status, 422);
  assert.equal(invalidGetPath.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);

  for (const body of [
    {},
    { expectedStateVersion: "7" },
    { expectedStateVersion: 7, userId: "attacker" }
  ]) {
    const response = await handlers.POST(request("POST", body), context());
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }

  for (const body of [
    { action: "COMPLETE", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 8 },
    { action: "RECOVER_EXPIRED", fillAttemptId: FILL_ATTEMPT_ID, expectedStateVersion: 8, steps: [] },
    { action: "RECOVER_EXPIRED", fillAttemptId: "not-a-uuid", expectedStateVersion: 8 },
    {
      action: "FINALIZE",
      fillAttemptId: FILL_ATTEMPT_ID,
      expectedStateVersion: 8,
      outcome: "COMPLETED",
      steps: [{ stepKey: STEP_KEY, result: "FILLED", errorCode: null }]
    },
    {
      action: "FINALIZE",
      fillAttemptId: FILL_ATTEMPT_ID,
      expectedStateVersion: 8,
      outcome: "STOPPED_EARLY",
      errorCode: "UNKNOWN",
      steps: [{ stepKey: STEP_KEY, result: "FAILED", errorCode: "FILL_INTERNAL" }]
    },
    {
      action: "FINALIZE",
      fillAttemptId: FILL_ATTEMPT_ID,
      expectedStateVersion: 8,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [{ stepKey: STEP_KEY, result: "FILLED", errorCode: null, private: true }]
    },
    {
      action: "FINALIZE",
      fillAttemptId: FILL_ATTEMPT_ID,
      expectedStateVersion: 8,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [{ stepKey: STEP_KEY, result: "UNKNOWN", errorCode: null }]
    }
  ]) {
    const response = await handlers.PATCH(request("PATCH", body), context());
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(serviceCalls, 0);

  const unauthorized = createApplicationRunFillAttemptRouteHandlers(dependencies({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { throw new Error("unexpected rate call"); },
    acquireFillAttempt: serviceFailure
  }));
  const unauthorizedResponse = await unauthorized.POST(
    request("POST", { expectedStateVersion: 7, userId: "attacker" }),
    context()
  );
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(unauthorizedResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(serviceCalls, 0);
});

test("non-Zod Fill service errors preserve their public status", async () => {
  const handlers = createApplicationRunFillAttemptRouteHandlers(dependencies({
    getFillAttemptStatus: async () => {
      throw new PublicApiError("The fill attempt was not found.", 404, { code: "RUN_NOT_FOUND" });
    }
  }));

  const response = await handlers.GET(request("GET"), context());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "The fill attempt was not found.",
    code: "RUN_NOT_FOUND"
  });
});
