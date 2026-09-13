import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { PublicApiError } from "@/lib/api-errors";
import { UnauthorizedError } from "@/lib/user-context";

const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const JOB_ID = "clz8w7m9a0001qwer1234tyui";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const USER_ID = "user-1";
const NOW = new Date("2026-09-12T18:00:00.000Z");
const ATTESTATION = "USER_PERSONALLY_SUBMITTED_ON_EMPLOYER_SITE";
const PATH = `/api/application-runs/${RUN_ID}/complete-by-user`;

type RouteDependencies = {
  requireUserId(): Promise<string>;
  checkRateLimit(key: string, limit: number, windowMs: number): Promise<void>;
  completeApplicationRunByUser(input: {
    userId: unknown;
    runId: unknown;
    attestation: unknown;
  }): Promise<unknown>;
};

type RouteHandlers = {
  POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response>;
};

async function createHandlers(dependencies: RouteDependencies): Promise<RouteHandlers> {
  const routeModule = await import("@/app/api/application-runs/[id]/complete-by-user/route").catch(
    () => null
  );
  assert.ok(routeModule, "expected the complete-by-user route module to exist");
  const factory = (routeModule as Record<string, unknown>).createCompleteApplicationRunByUserRouteHandlers;
  assert.equal(typeof factory, "function", "expected the completion route handler factory");
  return (factory as (input: RouteDependencies) => RouteHandlers)(dependencies);
}

function request(body: unknown): NextRequest {
  return new NextRequest(`http://localhost${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function rawRequest(body: string): NextRequest {
  return new NextRequest(`http://localhost${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
}

function context(id = RUN_ID) {
  return { params: Promise.resolve({ id }) };
}

function completedRun(origin: "READY" | "READY_FOR_USER_SUBMISSION") {
  return {
    id: RUN_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "COMPLETED_BY_USER" as const,
    stateVersion: origin === "READY" ? 8 : 10,
    applyHost: "jobs.example.com",
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    detectedAdapter: null,
    prepareLeaseExpiresAt: null,
    reviewReasons: [],
    reviewAcknowledgedAt: null,
    blockingReason: null,
    errorCategory: null,
    preparedAt: new Date("2026-09-12T17:00:00.000Z"),
    completedAt: NOW,
    cancelledAt: null,
    createdAt: new Date("2026-09-12T16:00:00.000Z"),
    updatedAt: NOW
  };
}

test("complete-by-user authenticates, rate limits, and accepts both Human-Submit origin paths", async () => {
  for (const origin of ["READY", "READY_FOR_USER_SUBMISSION"] as const) {
    const calls: string[] = [];
    const handlers = await createHandlers({
      requireUserId: async () => {
        calls.push("auth");
        return USER_ID;
      },
      checkRateLimit: async (key, limit, windowMs) => {
        calls.push(`rate:${key}:${limit}:${windowMs}`);
      },
      completeApplicationRunByUser: async (input) => {
        calls.push("complete");
        assert.deepEqual(input, {
          userId: USER_ID,
          runId: RUN_ID,
          attestation: ATTESTATION
        });
        return completedRun(origin);
      }
    });

    const response = await handlers.POST(request({ attestation: ATTESTATION }), context());

    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get("Cache-Control"), "no-store", origin);
    assert.deepEqual(await response.json(), {
      run: {
        id: RUN_ID,
        state: "COMPLETED_BY_USER",
        stateVersion: origin === "READY" ? 8 : 10,
        completedAt: NOW.toISOString(),
      }
    });
    assert.deepEqual(calls, [
      "auth",
      `rate:application-runs:complete-by-user:${USER_ID}:10:60000`,
      "complete"
    ]);
  }
});

test("complete-by-user rejects every malformed or authority-smuggling body before rate limiting", async () => {
  let rateCalls = 0;
  let serviceCalls = 0;
  const handlers = await createHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    completeApplicationRunByUser: async () => {
      serviceCalls += 1;
      return completedRun("READY");
    }
  });
  const invalidBodies = [
    {},
    { attestation: "USER_SUBMITTED" },
    { attestation: null },
    { attestation: true },
    { attestation: [] },
    [],
    ATTESTATION,
    { attestation: ATTESTATION, extra: true },
    { attestation: ATTESTATION, completedAt: NOW.toISOString() },
    { attestation: ATTESTATION, runId: RUN_ID },
    { attestation: ATTESTATION, applicationId: APPLICATION_ID },
    { attestation: ATTESTATION, employerConfirmation: "confirmed" },
    { attestation: ATTESTATION, url: "https://jobs.example.com/confirmation" },
    { attestation: ATTESTATION, notes: "submitted" }
  ];

  for (const body of invalidBodies) {
    const response = await handlers.POST(request(body), context());
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const malformedJson = await handlers.POST(rawRequest("{"), context());
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("complete-by-user rejects unauthenticated and invalid-path requests before mutation", async () => {
  let rateCalls = 0;
  let serviceCalls = 0;
  const unauthenticated = await createHandlers({
    requireUserId: async () => {
      throw new UnauthorizedError();
    },
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    completeApplicationRunByUser: async () => {
      serviceCalls += 1;
      return completedRun("READY");
    }
  });
  const unauthenticatedResponse = await unauthenticated.POST(
    request({ attestation: ATTESTATION }),
    context()
  );
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(unauthenticatedResponse.headers.get("Cache-Control"), "no-store");

  const authenticated = await createHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    completeApplicationRunByUser: async () => {
      serviceCalls += 1;
      return completedRun("READY");
    }
  });
  const invalidPathResponse = await authenticated.POST(
    request({ attestation: ATTESTATION }),
    context("not-a-cuid")
  );
  assert.equal(invalidPathResponse.status, 422);
  assert.equal(invalidPathResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("complete-by-user projects owner isolation, state conflicts, and rate limits as bounded no-store errors", async () => {
  const cases = [
    {
      label: "not found or wrong owner",
      error: new PublicApiError("This application run was not found.", 404, { code: "RUN_NOT_FOUND" }),
      expected: { status: 404, body: { error: "This application run was not found.", code: "RUN_NOT_FOUND" } }
    },
    {
      label: "state conflict",
      error: new PublicApiError("This application run cannot be completed from its current state.", 409, {
        code: "RUN_INVALID_STATE"
      }),
      expected: {
        status: 409,
        body: {
          error: "This application run cannot be completed from its current state.",
          code: "RUN_INVALID_STATE"
        }
      }
    },
    {
      label: "rate limited",
      error: new PublicApiError("Rate limit exceeded. Try again shortly.", 429),
      expected: { status: 429, body: { error: "Rate limit exceeded. Try again shortly." } },
      fromRateLimit: true
    }
  ] as const;

  for (const testCase of cases) {
    let serviceCalls = 0;
    const handlers = await createHandlers({
      requireUserId: async () => USER_ID,
      checkRateLimit: async () => {
        if ("fromRateLimit" in testCase && testCase.fromRateLimit) throw testCase.error;
      },
      completeApplicationRunByUser: async () => {
        serviceCalls += 1;
        throw testCase.error;
      }
    });
    const response = await handlers.POST(request({ attestation: ATTESTATION }), context());
    assert.equal(response.status, testCase.expected.status, testCase.label);
    assert.equal(response.headers.get("Cache-Control"), "no-store", testCase.label);
    assert.deepEqual(await response.json(), testCase.expected.body, testCase.label);
    assert.equal(
      serviceCalls,
      "fromRateLimit" in testCase && testCase.fromRateLimit ? 0 : 1,
      testCase.label
    );
  }
});
