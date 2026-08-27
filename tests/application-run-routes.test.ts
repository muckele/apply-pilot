import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { createApplicationAutomationPolicyRouteHandlers } from "@/app/api/application-automation-policy/route";
import { createReviewApplicationRunAnswerRouteHandlers } from "@/app/api/application-runs/[id]/answers/[answerId]/review/route";
import { createCancelApplicationRunRouteHandlers } from "@/app/api/application-runs/[id]/cancel/route";
import { createIssueApplicationRunExecutionTokenRouteHandlers } from "@/app/api/application-runs/[id]/execution-token/route";
import { createRevokeApplicationRunExecutionTokenRouteHandlers } from "@/app/api/application-runs/[id]/execution-tokens/[tokenId]/route";
import { createPrepareApplicationRunRouteHandlers } from "@/app/api/application-runs/[id]/prepare/route";
import { createResolveApplicationRunReviewRouteHandlers } from "@/app/api/application-runs/[id]/resolve-review/route";
import { createApplicationRunRouteHandlers } from "@/app/api/application-runs/[id]/route";
import { createApplicationRunsRouteHandlers } from "@/app/api/application-runs/route";
import { PublicApiError } from "@/lib/api-errors";
import { AUTOMATION_POLICY_DEFAULTS } from "@/lib/application-runs/policy";
import { UnauthorizedError } from "@/lib/user-context";

const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const JOB_ID = "clz8w7m9a0001qwer1234tyui";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const ANSWER_ID = "clz8w7m9a0003qwer1234tyui";
const TOKEN_ID = "clz8w7m9a0004qwer1234tyui";
const USER_ID = "user-1";
const NOW = new Date("2026-08-20T18:00:00.000Z");
const RAW_TOKEN = `aet_${"A".repeat(43)}`;
const PACKET_HASH = "a".repeat(64);

function jsonRequest(path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function runDto() {
  return {
    id: RUN_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "DRAFT" as const,
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
    createdAt: NOW,
    updatedAt: NOW
  };
}

function answerDto() {
  return {
    id: ANSWER_ID,
    runId: RUN_ID,
    status: "APPROVED" as const,
    reviewedByUser: true,
    reviewedAt: NOW,
    sensitive: false,
    valueRedacted: false
  };
}

test("policy GET authenticates, rate limits, returns a narrow no-store response", async () => {
  const calls: string[] = [];
  const expected = {
    ...AUTOMATION_POLICY_DEFAULTS,
    persisted: false,
    effectiveEnabled: false
  };
  const handlers = createApplicationAutomationPolicyRouteHandlers({
    requireUserId: async () => {
      calls.push("auth");
      return "user-1";
    },
    checkRateLimit: async () => {
      calls.push("rate");
    },
    readAutomationPolicy: async (userId: string) => {
      calls.push(`read:${userId}`);
      return expected;
    },
    updateAutomationPolicy: async () => {
      throw new Error("unexpected update");
    }
  });

  const response = await handlers.GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(calls, ["auth", "rate", "read:user-1"]);
});

test("policy PATCH validates strictly before rate limiting and service dispatch", async () => {
  let rateCalls = 0;
  let updateCalls = 0;
  const handlers = createApplicationAutomationPolicyRouteHandlers({
    requireUserId: async () => "user-1",
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    readAutomationPolicy: async () => ({
      ...AUTOMATION_POLICY_DEFAULTS,
      persisted: false,
      effectiveEnabled: false
    }),
    updateAutomationPolicy: async () => {
      updateCalls += 1;
      return {
        ...AUTOMATION_POLICY_DEFAULTS,
        enabled: true,
        persisted: true,
        effectiveEnabled: false,
        changed: true,
        revokedExecutionTokenCount: 0
      };
    }
  });

  const invalid = await handlers.PATCH(
    jsonRequest("/api/application-automation-policy", "PATCH", { enabled: true, userId: "attacker" })
  );
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  assert.equal(updateCalls, 0);

  const valid = await handlers.PATCH(
    jsonRequest("/api/application-automation-policy", "PATCH", { enabled: true })
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal((await valid.json()).changed, true);
});

test("ApplicationRun POST rejects smuggled authoritative fields before rate limiting", async () => {
  let rateCalls = 0;
  let createCalls = 0;
  const handlers = createApplicationRunsRouteHandlers({
    requireUserId: async () => "user-1",
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    createApplicationRun: async () => {
      createCalls += 1;
      return { run: runDto(), replayed: false };
    }
  });

  for (const field of ["userId", "jobPostingId", "applyHost", "state", "scope"]) {
    const response = await handlers.POST(
      jsonRequest("/api/application-runs", "POST", {
        applicationId: APPLICATION_ID,
        idempotencyKey: "request-123",
        [field]: "attacker-controlled"
      })
    );
    assert.equal(response.status, 422, field);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(createCalls, 0);
});

test("ApplicationRun POST returns 201 on creation, 200 on replay, and no-store", async () => {
  let replayed = false;
  const handlers = createApplicationRunsRouteHandlers({
    requireUserId: async () => "user-1",
    checkRateLimit: async () => undefined,
    createApplicationRun: async (userId: string, input: unknown) => {
      assert.equal(userId, "user-1");
      assert.deepEqual(input, { applicationId: APPLICATION_ID, idempotencyKey: "request-123" });
      return { run: runDto(), replayed };
    }
  });
  const request = () =>
    jsonRequest("/api/application-runs", "POST", {
      applicationId: APPLICATION_ID,
      idempotencyKey: "request-123"
    });

  const created = await handlers.POST(request());
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Object.keys((await created.json()).run).sort(), Object.keys(runDto()).sort());

  replayed = true;
  const replay = await handlers.POST(request());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});

test("ApplicationRun GET validates the CUID before rate limiting or Prisma-facing service use", async () => {
  let rateCalls = 0;
  let getCalls = 0;
  const handlers = createApplicationRunRouteHandlers({
    requireUserId: async () => "user-1",
    checkRateLimit: async () => {
      rateCalls += 1;
    },
    getApplicationRun: async () => {
      getCalls += 1;
      return runDto();
    }
  });

  const invalid = await handlers.GET(new Request("http://localhost/api/application-runs/not-a-cuid"), {
    params: Promise.resolve({ id: "not-a-cuid" })
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  assert.equal(getCalls, 0);

  const valid = await handlers.GET(new Request(`http://localhost/api/application-runs/${RUN_ID}`), {
    params: Promise.resolve({ id: RUN_ID })
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await valid.json()).run, {
    ...runDto(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
  assert.equal(rateCalls, 1);
  assert.equal(getCalls, 1);
});

test("prepare POST rejects unauthenticated callers with no-store before validation or dispatch", async () => {
  let rateCalls = 0;
  let prepareCalls = 0;
  const handlers = createPrepareApplicationRunRouteHandlers({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { rateCalls += 1; },
    aiInvocationFromRequest: () => ({ highCostConfirmed: false }),
    prepareApplicationRun: async () => {
      prepareCalls += 1;
      return runDto();
    }
  });
  const response = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/prepare`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(rateCalls, 0);
  assert.equal(prepareCalls, 0);
});

test("prepare POST validates the run CUID before body, rate limit, header, or orchestration", async () => {
  const calls: string[] = [];
  const handlers = createPrepareApplicationRunRouteHandlers({
    requireUserId: async () => {
      calls.push("auth");
      return USER_ID;
    },
    checkRateLimit: async () => { calls.push("rate"); },
    aiInvocationFromRequest: () => {
      calls.push("header");
      return { highCostConfirmed: false };
    },
    prepareApplicationRun: async () => {
      calls.push("prepare");
      return runDto();
    }
  });
  const response = await handlers.POST(
    new NextRequest("http://localhost/api/application-runs/not-a-cuid/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json"
    }),
    { params: Promise.resolve({ id: "not-a-cuid" }) }
  );
  assert.equal(response.status, 422);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, ["auth"]);
});

test("prepare POST accepts only a strict empty object before rate limiting", async () => {
  let rateCalls = 0;
  let prepareCalls = 0;
  const handlers = createPrepareApplicationRunRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    aiInvocationFromRequest: () => ({ highCostConfirmed: false }),
    prepareApplicationRun: async () => {
      prepareCalls += 1;
      return runDto();
    }
  });

  for (const field of ["userId", "state", "policy", "automation", "provider", "model"]) {
    const response = await handlers.POST(
      jsonRequest(`/api/application-runs/${RUN_ID}/prepare`, "POST", { [field]: "attacker" }),
      { params: Promise.resolve({ id: RUN_ID }) }
    );
    assert.equal(response.status, 422, field);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(prepareCalls, 0);
});

test("prepare POST uses the authenticated rate key and forwards only the cost-confirmation signal", async () => {
  const calls: string[] = [];
  const handlers = createPrepareApplicationRunRouteHandlers({
    requireUserId: async () => {
      calls.push("auth");
      return USER_ID;
    },
    checkRateLimit: async (key, limit, windowMs) => {
      calls.push("rate");
      assert.equal(key, `application-runs:prepare:${USER_ID}`);
      assert.equal(limit, 10);
      assert.equal(windowMs, 60_000);
    },
    aiInvocationFromRequest: (request) => {
      calls.push("header");
      return { highCostConfirmed: request.headers.get("x-ai-cost-confirmed") === "true" };
    },
    prepareApplicationRun: async (input) => {
      calls.push("prepare");
      assert.deepEqual(input, {
        userId: USER_ID,
        runId: RUN_ID,
        highCostConfirmed: true
      });
      return { ...runDto(), state: "READY" as const, stateVersion: 2, preparedAt: NOW };
    }
  });
  const response = await handlers.POST(
    jsonRequest(
      `/api/application-runs/${RUN_ID}/prepare`,
      "POST",
      {},
      { "x-ai-cost-confirmed": "true" }
    ),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).run.state, "READY");
  assert.deepEqual(calls, ["auth", "rate", "header", "prepare"]);
});

test("prepare POST preserves service PublicApiError status/details and adds no-store without route lifecycle effects", async () => {
  let prepareCalls = 0;
  const handlers = createPrepareApplicationRunRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => undefined,
    aiInvocationFromRequest: () => ({ highCostConfirmed: false }),
    prepareApplicationRun: async () => {
      prepareCalls += 1;
      throw new PublicApiError("This preparation result is no longer current.", 409, {
        code: "RUN_PREPARATION_STALE",
        safeDetail: "preserved"
      });
    }
  });
  const response = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/prepare`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "This preparation result is no longer current.",
    code: "RUN_PREPARATION_STALE",
    safeDetail: "preserved"
  });
  assert.equal(prepareCalls, 1);
});

test("cancel POST authenticates before validation and applies strict path/body validation before rate limiting", async () => {
  let rateCalls = 0;
  let cancelCalls = 0;
  const unauthorized = createCancelApplicationRunRouteHandlers({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { rateCalls += 1; },
    cancelApplicationRun: async () => {
      cancelCalls += 1;
      return { run: runDto(), revokedExecutionTokenCount: 0 };
    }
  });
  const unauthenticated = await unauthorized.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/cancel`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("Cache-Control"), "no-store");

  const handlers = createCancelApplicationRunRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    cancelApplicationRun: async () => {
      cancelCalls += 1;
      return { run: runDto(), revokedExecutionTokenCount: 0 };
    }
  });
  const invalidCases: Array<[string, Record<string, unknown>]> = [
    ["not-a-cuid", {}],
    [RUN_ID, { state: "CANCELLED" }]
  ];
  for (const [id, body] of invalidCases) {
    const response = await handlers.POST(jsonRequest(`/api/application-runs/${id}/cancel`, "POST", body), {
      params: Promise.resolve({ id })
    });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(cancelCalls, 0);
});

test("cancel POST uses its authenticated rate key, maps only user/run, and preserves service errors", async () => {
  const calls: string[] = [];
  let shouldFail = false;
  const handlers = createCancelApplicationRunRouteHandlers({
    requireUserId: async () => { calls.push("auth"); return USER_ID; },
    checkRateLimit: async (key, limit, windowMs) => {
      calls.push("rate");
      assert.equal(key, `application-runs:cancel:${USER_ID}`);
      assert.equal(limit, 30);
      assert.equal(windowMs, 60_000);
    },
    cancelApplicationRun: async (input) => {
      calls.push("cancel");
      assert.deepEqual(input, { userId: USER_ID, runId: RUN_ID });
      if (shouldFail) throw new PublicApiError("Cancellation conflict.", 409, { code: "RUN_INVALID_STATE" });
      return {
        run: { ...runDto(), state: "CANCELLED" as const, stateVersion: 1, cancelledAt: NOW },
        revokedExecutionTokenCount: 2
      };
    }
  });
  const success = await handlers.POST(jsonRequest(`/api/application-runs/${RUN_ID}/cancel`, "POST", {}), {
    params: Promise.resolve({ id: RUN_ID })
  });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("Cache-Control"), "no-store");
  assert.equal((await success.json()).revokedExecutionTokenCount, 2);
  assert.deepEqual(calls, ["auth", "rate", "cancel"]);

  shouldFail = true;
  const failure = await handlers.POST(jsonRequest(`/api/application-runs/${RUN_ID}/cancel`, "POST", {}), {
    params: Promise.resolve({ id: RUN_ID })
  });
  assert.equal(failure.status, 409);
  assert.equal(failure.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await failure.json(), { error: "Cancellation conflict.", code: "RUN_INVALID_STATE" });
});

test("resolve-review POST rejects malformed paths and strict body violations before rate limiting", async () => {
  let rateCalls = 0;
  let serviceCalls = 0;
  const handlers = createResolveApplicationRunReviewRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    resolveApplicationRunReview: async () => { serviceCalls += 1; return runDto(); }
  });
  const valid = {
    stateVersion: 2,
    acknowledgedReviewReasons: ["evidence_gaps_present"],
    answerPacketVersion: 0,
    packetHash: null
  };
  const invalidCases: Array<[string, unknown]> = [
    ["not-a-cuid", valid],
    [RUN_ID, { stateVersion: 2, acknowledgedReviewReasons: ["evidence_gaps_present"], packetHash: null }],
    [RUN_ID, { stateVersion: 2, acknowledgedReviewReasons: ["evidence_gaps_present"], answerPacketVersion: 0 }],
    [RUN_ID, { ...valid, stateVersion: -1 }],
    [RUN_ID, { ...valid, stateVersion: 1.5 }],
    [RUN_ID, { ...valid, answerPacketVersion: -1 }],
    [RUN_ID, { ...valid, answerPacketVersion: 1.5 }],
    [RUN_ID, { ...valid, answerPacketVersion: 0, packetHash: PACKET_HASH }],
    [RUN_ID, { ...valid, answerPacketVersion: 3, packetHash: null }],
    [RUN_ID, { ...valid, answerPacketVersion: 3, packetHash: "malformed" }],
    [RUN_ID, { ...valid, acknowledgedReviewReasons: ["not-real"] }],
    [RUN_ID, { ...valid, acknowledgedReviewReasons: ["evidence_gaps_present", "evidence_gaps_present"] }],
    [RUN_ID, { ...valid, state: "READY" }],
    [RUN_ID, { ...valid, userId: "attacker" }]
  ];
  for (const [id, body] of invalidCases) {
    const response = await handlers.POST(jsonRequest(`/api/application-runs/${id}/resolve-review`, "POST", body), {
      params: Promise.resolve({ id })
    });
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("resolve-review POST maps authenticated acknowledgment, rate limits, and returns no-store", async () => {
  const calls: string[] = [];
  let expectedBody = {
    stateVersion: 2,
    acknowledgedReviewReasons: ["evidence_gaps_present"] as const,
    answerPacketVersion: 0,
    packetHash: null as string | null
  };
  const handlers = createResolveApplicationRunReviewRouteHandlers({
    requireUserId: async () => { calls.push("auth"); return USER_ID; },
    checkRateLimit: async (key, limit, windowMs) => {
      calls.push("rate");
      assert.equal(key, `application-runs:resolve-review:${USER_ID}`);
      assert.equal(limit, 30);
      assert.equal(windowMs, 60_000);
    },
    resolveApplicationRunReview: async (input) => {
      calls.push("resolve");
      assert.deepEqual(input, { userId: USER_ID, runId: RUN_ID, ...expectedBody });
      return { ...runDto(), state: "READY" as const, stateVersion: 3, reviewAcknowledgedAt: NOW };
    }
  });
  const legacyResponse = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/resolve-review`, "POST", expectedBody),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.headers.get("Cache-Control"), "no-store");
  assert.equal((await legacyResponse.json()).run.state, "READY");

  expectedBody = {
    ...expectedBody,
    answerPacketVersion: 3,
    packetHash: PACKET_HASH
  };
  const packetResponse = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/resolve-review`, "POST", expectedBody),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(packetResponse.status, 200);
  assert.deepEqual(calls, ["auth", "rate", "resolve", "auth", "rate", "resolve"]);
});

test("answer-review POST validates both path IDs and requires a strict packet-versioned body before rate limiting", async () => {
  let rateCalls = 0;
  let reviewCalls = 0;
  const handlers = createReviewApplicationRunAnswerRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    reviewApplicationRunAnswer: async () => { reviewCalls += 1; return answerDto(); }
  });
  const invalidCases: Array<[{ id: string; answerId: string }, unknown]> = [
    [{ id: "not-a-cuid", answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0 }],
    [{ id: RUN_ID, answerId: "not-a-cuid" }, { status: "APPROVED", answerPacketVersion: 0 }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED" }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "PENDING", answerPacketVersion: 0 }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: -1 }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 1.5 }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: "0" }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, userId: "attacker" }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, runId: RUN_ID }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, answerPacketId: "attacker" }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, proposal: {} }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, proposedValue: "secret" }],
    [{ id: RUN_ID, answerId: ANSWER_ID }, { status: "APPROVED", answerPacketVersion: 0, finalValueHash: "attacker" }]
  ];
  for (const [params, body] of invalidCases) {
    const response = await handlers.POST(
      jsonRequest(`/api/application-runs/${params.id}/answers/${params.answerId}/review`, "POST", body),
      { params: Promise.resolve(params) }
    );
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(reviewCalls, 0);
});

test("answer-review POST forwards authenticated path, status, and exact packet version at 60/minute", async () => {
  let shouldFail = false;
  let expectedStatus: "APPROVED" | "REJECTED" = "REJECTED";
  let expectedPacketVersion = 0;
  const handlers = createReviewApplicationRunAnswerRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async (key, limit, windowMs) => {
      assert.equal(key, `application-runs:answers:review:${USER_ID}`);
      assert.equal(limit, 60);
      assert.equal(windowMs, 60_000);
    },
    reviewApplicationRunAnswer: async (input) => {
      assert.deepEqual(input, {
        userId: USER_ID,
        runId: RUN_ID,
        answerId: ANSWER_ID,
        status: expectedStatus,
        answerPacketVersion: expectedPacketVersion
      });
      if (shouldFail) throw new PublicApiError("Already reviewed.", 409, { code: "RUN_ANSWER_ALREADY_REVIEWED" });
      return { ...answerDto(), status: expectedStatus };
    }
  });
  const request = () => jsonRequest(
    `/api/application-runs/${RUN_ID}/answers/${ANSWER_ID}/review`,
    "POST",
    { status: expectedStatus, answerPacketVersion: expectedPacketVersion }
  );
  const context = () => ({ params: Promise.resolve({ id: RUN_ID, answerId: ANSWER_ID }) });
  const success = await handlers.POST(request(), context());
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("Cache-Control"), "no-store");
  assert.equal((await success.json()).answer.status, "REJECTED");

  expectedStatus = "APPROVED";
  expectedPacketVersion = 3;
  const packetSuccess = await handlers.POST(request(), context());
  assert.equal(packetSuccess.status, 200);
  assert.equal((await packetSuccess.json()).answer.status, "APPROVED");

  shouldFail = true;
  const failure = await handlers.POST(request(), context());
  assert.equal(failure.status, 409);
  assert.equal(failure.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await failure.json(), { error: "Already reviewed.", code: "RUN_ANSWER_ALREADY_REVIEWED" });
});

test("execution-token POST authenticates before strict path/body validation and rate limiting", async () => {
  let rateCalls = 0;
  let issueCalls = 0;
  const unauthorized = createIssueApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { rateCalls += 1; },
    issueExecutionToken: async () => {
      issueCalls += 1;
      throw new Error("unexpected issuance");
    }
  });
  const unauthenticated = await unauthorized.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/execution-token`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("Cache-Control"), "no-store");

  const handlers = createIssueApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    issueExecutionToken: async () => {
      issueCalls += 1;
      throw new Error("unexpected issuance");
    }
  });
  const invalidCases: Array<[string, unknown]> = [
    ["not-a-cuid", {}],
    [RUN_ID, { userId: "attacker" }],
    [RUN_ID, { scope: "APPLICATION_FILL" }],
    [RUN_ID, { host: "attacker.example" }],
    [RUN_ID, { singleUse: true }],
    [RUN_ID, { expiresAt: NOW.toISOString() }],
    [RUN_ID, { unknown: true }]
  ];
  for (const [id, body] of invalidCases) {
    const response = await handlers.POST(
      jsonRequest(`/api/application-runs/${id}/execution-token`, "POST", body),
      { params: Promise.resolve({ id }) }
    );
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(issueCalls, 0);
});

test("execution-token POST fixes APPLICATION_READ, returns raw token once with narrow metadata, and rate limits by user", async () => {
  const calls: string[] = [];
  const handlers = createIssueApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => { calls.push("auth"); return USER_ID; },
    checkRateLimit: async (key, limit, windowMs) => {
      calls.push("rate");
      assert.equal(key, `application-runs:execution-token:issue:${USER_ID}`);
      assert.equal(limit, 10);
      assert.equal(windowMs, 60_000);
    },
    issueExecutionToken: async (input) => {
      calls.push("issue");
      assert.deepEqual(input, { userId: USER_ID, runId: RUN_ID, scope: "APPLICATION_READ" });
      return {
        token: RAW_TOKEN,
        tokenRecord: {
          id: TOKEN_ID,
          tokenPrefix: "aet_AAAAAAAA...",
          host: "jobs.example.com",
          scope: "APPLICATION_READ",
          singleUse: false,
          expiresAt: new Date(NOW.getTime() + 15 * 60_000),
          createdAt: NOW
        }
      };
    }
  });
  const response = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/execution-token`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const bodyText = await response.text();
  assert.equal(bodyText.split(RAW_TOKEN).length - 1, 1);
  assert.deepEqual(JSON.parse(bodyText), {
    token: RAW_TOKEN,
    tokenRecord: {
      id: TOKEN_ID,
      runId: RUN_ID,
      scope: "APPLICATION_READ",
      singleUse: false,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      createdAt: NOW.toISOString()
    }
  });
  assert.equal(bodyText.includes("tokenHash"), false);
  assert.equal(bodyText.includes("tokenPrefix"), false);
  assert.equal(bodyText.includes("jobs.example.com"), false);
  assert.deepEqual(calls, ["auth", "rate", "issue"]);
});

test("execution-token POST preserves service PublicApiError status/details with no-store", async () => {
  const handlers = createIssueApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => undefined,
    issueExecutionToken: async () => {
      throw new PublicApiError("Application automation is disabled.", 403, {
        code: "AUTOMATION_DISABLED",
        safeDetail: "preserved"
      });
    }
  });
  const response = await handlers.POST(
    jsonRequest(`/api/application-runs/${RUN_ID}/execution-token`, "POST", {}),
    { params: Promise.resolve({ id: RUN_ID }) }
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "Application automation is disabled.",
    code: "AUTOMATION_DISABLED",
    safeDetail: "preserved"
  });
});

test("execution-token DELETE authenticates and validates both CUIDs before rate limiting or service use", async () => {
  let rateCalls = 0;
  let revokeCalls = 0;
  const unauthorized = createRevokeApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { rateCalls += 1; },
    revokeExecutionTokenForRun: async () => { revokeCalls += 1; return { revoked: true, alreadyRevoked: false }; }
  });
  const unauthenticated = await unauthorized.DELETE(
    new NextRequest(`http://localhost/api/application-runs/${RUN_ID}/execution-tokens/${TOKEN_ID}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: RUN_ID, tokenId: TOKEN_ID }) }
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("Cache-Control"), "no-store");

  const handlers = createRevokeApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => { rateCalls += 1; },
    revokeExecutionTokenForRun: async () => { revokeCalls += 1; return { revoked: true, alreadyRevoked: false }; }
  });
  for (const params of [
    { id: "not-a-cuid", tokenId: TOKEN_ID },
    { id: RUN_ID, tokenId: "not-a-cuid" }
  ]) {
    const response = await handlers.DELETE(
      new NextRequest(`http://localhost/api/application-runs/${params.id}/execution-tokens/${params.tokenId}`, {
        method: "DELETE"
      }),
      { params: Promise.resolve(params) }
    );
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(rateCalls, 0);
  assert.equal(revokeCalls, 0);
});

test("execution-token DELETE forwards the exact authenticated run binding, is idempotent, private, and rate limited", async () => {
  let callCount = 0;
  const handlers = createRevokeApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async (key, limit, windowMs) => {
      assert.equal(key, `application-runs:execution-token:revoke:${USER_ID}`);
      assert.equal(limit, 20);
      assert.equal(windowMs, 60_000);
    },
    revokeExecutionTokenForRun: async (input) => {
      assert.deepEqual(input, { userId: USER_ID, runId: RUN_ID, tokenId: TOKEN_ID });
      callCount += 1;
      return callCount === 1
        ? { revoked: true, alreadyRevoked: false }
        : { revoked: false, alreadyRevoked: true };
    }
  });
  const request = () =>
    new NextRequest(`http://localhost/api/application-runs/${RUN_ID}/execution-tokens/${TOKEN_ID}`, {
      method: "DELETE"
    });
  const context = () => ({ params: Promise.resolve({ id: RUN_ID, tokenId: TOKEN_ID }) });

  const first = await handlers.DELETE(request(), context());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const firstText = await first.text();
  assert.deepEqual(JSON.parse(firstText), { revoked: true, alreadyRevoked: false });
  for (const secretField of ["token", "tokenHash", "tokenPrefix", "host", "scope"]) {
    assert.equal(firstText.includes(secretField), false, secretField);
  }

  const repeat = await handlers.DELETE(request(), context());
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { revoked: false, alreadyRevoked: true });
});

test("execution-token DELETE preserves the same non-enumerating service 404 with no-store", async () => {
  const handlers = createRevokeApplicationRunExecutionTokenRouteHandlers({
    requireUserId: async () => USER_ID,
    checkRateLimit: async () => undefined,
    revokeExecutionTokenForRun: async () => {
      throw new PublicApiError("This execution token was not found.", 404, {
        code: "EXECUTION_TOKEN_NOT_FOUND"
      });
    }
  });
  const response = await handlers.DELETE(
    new NextRequest(`http://localhost/api/application-runs/${RUN_ID}/execution-tokens/${TOKEN_ID}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: RUN_ID, tokenId: TOKEN_ID }) }
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "This execution token was not found.",
    code: "EXECUTION_TOKEN_NOT_FOUND"
  });
});
