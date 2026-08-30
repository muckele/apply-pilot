import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSameOriginClient,
  SameOriginClientError,
  type BrowserFormInspectionPublicationInput
} from "@/lib/application-browser/same-origin-client";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const OTHER_RUN_ID = "clz8w7m9a0003qwer1234tyui";
const ORIGIN = "https://apply.example.com";
const RUN_URL = `${ORIGIN}/api/application-runs/${RUN_ID}`;
const POLICY_URL = `${ORIGIN}/api/application-automation-policy`;
const PACKET_URL = `${RUN_URL}/answer-packet`;
const PUBLICATION_URL = `${RUN_URL}/form-inspection`;
const BACKEND_MESSAGE_SENTINEL = "backend-private-message-sentinel";
const PROPOSAL_SENTINEL = "private-proposal-sentinel";
const QUESTION_SENTINEL = "private-question-sentinel";

type TestResponse = ReturnType<typeof response>;
type RequestOptions = Record<string, unknown>;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function response(url: string, status: number, body: unknown) {
  return {
    url: () => url,
    status: () => status,
    json: async () => body
  };
}

function malformedJsonResponse(url: string, status: number) {
  return {
    url: () => url,
    status: () => status,
    async json(): Promise<unknown> {
      throw new SyntaxError("malformed response body sentinel");
    }
  };
}

function runResponse(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: RUN_ID,
      state: "READY",
      stateVersion: 0,
      applyHost: "jobs.example.test",
      applyUrlSnapshot: "https://jobs.example.test/apply",
      ...overrides
    }
  };
}

function policyResponse() {
  return {
    effectiveEnabled: true,
    allowedHosts: ["jobs.example.test"],
    blockedHosts: []
  };
}

function publicationInput(
  overrides: Partial<BrowserFormInspectionPublicationInput> = {}
): BrowserFormInspectionPublicationInput {
  return {
    runId: RUN_ID,
    freshRunState: "REVIEW_REQUIRED",
    expectedStateVersion: 7,
    expectedFormInspectionVersion: 2,
    expectedAnswerPacketVersion: 3,
    observedUrl: "https://jobs.example.test/apply#current",
    inspectionReport: { marker: "safe-report" } as unknown as BrowserFormInspectionPublicationInput["inspectionReport"],
    ...overrides
  };
}

function publicationResponse(input: {
  replayed: boolean;
  state?: string;
  stateVersion: number;
  inspectionVersion: number;
  answerPacketVersion: number;
  runId?: string;
}) {
  return {
    replayed: input.replayed,
    run: {
      id: input.runId ?? RUN_ID,
      state: input.state ?? "REVIEW_REQUIRED",
      stateVersion: input.stateVersion
    },
    current: {
      inspectionVersion: input.inspectionVersion,
      answerPacketVersion: input.answerPacketVersion,
      packetHash: "a".repeat(64),
      summary: { fieldCount: 1 },
      answers: [{ question: QUESTION_SENTINEL, proposal: { kind: "SCALAR", value: PROPOSAL_SENTINEL } }]
    }
  };
}

function makeClient(input: {
  get?: (url: string, options: RequestOptions) => Promise<TestResponse>;
  post?: (url: string, options: RequestOptions) => Promise<TestResponse>;
} = {}) {
  return createSameOriginClient({
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    requestContext: {
      async get(url, options) {
        if (!input.get) throw new Error(`Unexpected GET: ${url}`);
        return input.get(url, options);
      },
      async post(url, options) {
        if (!input.post) throw new Error(`Unexpected POST: ${url}`);
        return input.post(url, options);
      }
    }
  });
}

function hasCode(expectedCode: string, forbiddenText?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SameOriginClientError);
    assert.equal(error.code, expectedCode);
    if (forbiddenText) assert.equal(error.message.includes(forbiddenText), false);
    return true;
  };
}

async function invokeMethod(
  method: "run" | "policy" | "packet" | "publication",
  returned: TestResponse | Error
) {
  const request = async () => {
    if (returned instanceof Error) throw returned;
    return returned;
  };
  const client = makeClient({ get: request, post: request });
  if (method === "run") return client.getApplicationRun(RUN_ID);
  if (method === "policy") return client.getAutomationPolicy();
  if (method === "packet") return client.getCurrentAnswerPacket(RUN_ID);
  return client.publishFormInspection(publicationInput(), () => undefined);
}

function inputWithSerializedByteLength(targetBytes: number): BrowserFormInspectionPublicationInput {
  const empty = publicationInput({
    inspectionReport: { value: "" } as unknown as BrowserFormInspectionPublicationInput["inspectionReport"]
  });
  const emptyBody = JSON.stringify({
    expectedStateVersion: empty.expectedStateVersion,
    expectedFormInspectionVersion: empty.expectedFormInspectionVersion,
    expectedAnswerPacketVersion: empty.expectedAnswerPacketVersion,
    observedUrl: empty.observedUrl,
    inspectionReport: empty.inspectionReport
  });
  const emptyBytes = new TextEncoder().encode(emptyBody).byteLength;
  assert.ok(targetBytes >= emptyBytes, "target body length must fit the fixed JSON envelope");
  const value = "x".repeat(targetBytes - emptyBytes);
  const sized = publicationInput({
    inspectionReport: { value } as unknown as BrowserFormInspectionPublicationInput["inspectionReport"]
  });
  const sizedBody = JSON.stringify({
    expectedStateVersion: sized.expectedStateVersion,
    expectedFormInspectionVersion: sized.expectedFormInspectionVersion,
    expectedAnswerPacketVersion: sized.expectedAnswerPacketVersion,
    observedUrl: sized.observedUrl,
    inspectionReport: sized.inspectionReport
  });
  assert.equal(new TextEncoder().encode(sizedBody).byteLength, targetBytes);
  return sized;
}

test("same-origin client exposes only the four fixed operations", () => {
  const client = makeClient();
  assert.deepEqual(Object.keys(client).sort(), [
    "getApplicationRun",
    "getAutomationPolicy",
    "getCurrentAnswerPacket",
    "publishFormInspection"
  ]);
  for (const generic of ["request", "fetch", "get", "post", "send", "execute"]) {
    assert.equal(generic in client, false, generic);
  }
});

test("run and policy GETs use exact fixed routes and retain strict run stateVersion", async () => {
  const calls: Array<{ url: string; options: unknown }> = [];
  const client = makeClient({
    async get(url, options) {
      calls.push({ url, options });
      return url === RUN_URL
        ? response(url, 200, runResponse({ stateVersion: 12 }))
        : response(url, 200, policyResponse());
    }
  });

  assert.deepEqual(await client.getApplicationRun(RUN_ID), {
    id: RUN_ID,
    state: "READY",
    stateVersion: 12,
    applyHost: "jobs.example.test",
    applyUrlSnapshot: "https://jobs.example.test/apply"
  });
  const policy = await client.getAutomationPolicy();
  assert.deepEqual(policy, policyResponse());
  assert.deepEqual(calls, [
    { url: RUN_URL, options: { failOnStatusCode: false, maxRedirects: 0 } },
    { url: POLICY_URL, options: { failOnStatusCode: false, maxRedirects: 0 } }
  ]);

  const rawAllowed = ["jobs.example.test"];
  const cloneClient = makeClient({
    async get(url) {
      return response(url, 200, {
        effectiveEnabled: false,
        allowedHosts: rawAllowed,
        blockedHosts: []
      });
    }
  });
  const cloned = await cloneClient.getAutomationPolicy();
  rawAllowed.push("mutated.example.test");
  assert.deepEqual(cloned.allowedHosts, ["jobs.example.test"]);
});

test("run parser accepts every known state and zero or positive safe stateVersion", async () => {
  const states = [
    "DRAFT",
    "PREPARING",
    "READY",
    "FILLING",
    "REVIEW_REQUIRED",
    "READY_FOR_USER_SUBMISSION",
    "COMPLETED_BY_USER",
    "BLOCKED",
    "FAILED",
    "CANCELLED"
  ] as const;
  for (const [index, state] of states.entries()) {
    const client = makeClient({
      async get(url) {
        return response(url, 200, runResponse({ state, stateVersion: index }));
      }
    });
    const run = await client.getApplicationRun(RUN_ID);
    assert.equal(run.state, state);
    assert.equal(run.stateVersion, index);
  }
});

test("run parser rejects unknown state and every malformed stateVersion", async () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["unknown state", { state: "NEW_UNKNOWN_STATE" }],
    ["negative", { stateVersion: -1 }],
    ["fractional", { stateVersion: 1.5 }],
    ["NaN", { stateVersion: Number.NaN }],
    ["Infinity", { stateVersion: Number.POSITIVE_INFINITY }],
    ["unsafe", { stateVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ["numeric string", { stateVersion: "1" }],
    ["missing", { stateVersion: undefined }]
  ];
  for (const [name, overrides] of invalid) {
    const client = makeClient({
      async get(url) {
        return response(url, 200, runResponse(overrides));
      }
    });
    await assert.rejects(client.getApplicationRun(RUN_ID), hasCode("INVALID_RUN_RESPONSE"), name);
  }
});

test("run parser preserves existing immutable identity, host, and target requirements", async () => {
  for (const [name, overrides] of [
    ["wrong run", { id: OTHER_RUN_ID }],
    ["empty host", { applyHost: "" }],
    ["missing target", { applyUrlSnapshot: undefined }]
  ] as const) {
    const client = makeClient({
      async get(url) {
        return response(url, 200, runResponse(overrides));
      }
    });
    await assert.rejects(client.getApplicationRun(RUN_ID), hasCode("INVALID_RUN_RESPONSE"), name);
  }
});

test("current packet GET accepts null and returns only positive version metadata", async () => {
  const calls: Array<{ url: string; options: unknown }> = [];
  let current: unknown = null;
  const client = makeClient({
    async get(url, options) {
      calls.push({ url, options });
      return response(url, 200, { runId: RUN_ID, current });
    }
  });

  assert.deepEqual(await client.getCurrentAnswerPacket(RUN_ID), {
    runId: RUN_ID,
    current: null
  });

  current = {
    inspectionVersion: 4,
    answerPacketVersion: 9,
    packetHash: "a".repeat(64),
    reviewedAt: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    summary: { fieldCount: 1 },
    answers: [{ question: QUESTION_SENTINEL, proposal: PROPOSAL_SENTINEL }]
  };
  const parsed = await client.getCurrentAnswerPacket(RUN_ID);
  assert.deepEqual(parsed, {
    runId: RUN_ID,
    current: { inspectionVersion: 4, answerPacketVersion: 9 }
  });
  assert.equal(JSON.stringify(parsed).includes(PROPOSAL_SENTINEL), false);
  assert.equal(JSON.stringify(parsed).includes(QUESTION_SENTINEL), false);
  assert.deepEqual(calls, [
    { url: PACKET_URL, options: { failOnStatusCode: false, maxRedirects: 0 } },
    { url: PACKET_URL, options: { failOnStatusCode: false, maxRedirects: 0 } }
  ]);
});

test("current packet parser rejects wrong identity and malformed versions", async () => {
  const invalid: Array<[string, unknown]> = [
    ["wrong run", { runId: OTHER_RUN_ID, current: null }],
    ["missing current", { runId: RUN_ID }],
    ["zero inspection", { runId: RUN_ID, current: { inspectionVersion: 0, answerPacketVersion: 1 } }],
    ["zero packet", { runId: RUN_ID, current: { inspectionVersion: 1, answerPacketVersion: 0 } }],
    ["negative", { runId: RUN_ID, current: { inspectionVersion: -1, answerPacketVersion: 1 } }],
    ["fractional", { runId: RUN_ID, current: { inspectionVersion: 1.5, answerPacketVersion: 1 } }],
    ["unsafe", { runId: RUN_ID, current: { inspectionVersion: 1, answerPacketVersion: Number.MAX_SAFE_INTEGER + 1 } }],
    ["string", { runId: RUN_ID, current: { inspectionVersion: "1", answerPacketVersion: 1 } }],
    ["missing version", { runId: RUN_ID, current: { inspectionVersion: 1 } }]
  ];
  for (const [name, body] of invalid) {
    const client = makeClient({ async get(url) { return response(url, 200, body); } });
    await assert.rejects(
      client.getCurrentAnswerPacket(RUN_ID),
      hasCode("INVALID_ANSWER_PACKET_RESPONSE"),
      name
    );
  }
});

test("all run-scoped methods reject alternate run identity before network activity", async () => {
  let calls = 0;
  const unexpected = async () => {
    calls += 1;
    throw new Error("unexpected network call");
  };
  const client = makeClient({ get: unexpected, post: unexpected });

  await assert.rejects(client.getApplicationRun(OTHER_RUN_ID), hasCode("RUN_IDENTITY_MISMATCH"));
  await assert.rejects(client.getCurrentAnswerPacket(OTHER_RUN_ID), hasCode("RUN_IDENTITY_MISMATCH"));
  await assert.rejects(
    client.publishFormInspection(publicationInput({ runId: OTHER_RUN_ID }), () => undefined),
    hasCode("RUN_IDENTITY_MISMATCH")
  );
  assert.equal(calls, 0);
});

test("all methods apply fixed redirect, URL, auth, rate, server, transport, and unknown-client handling", async () => {
  const methods = ["run", "policy", "packet", "publication"] as const;
  for (const method of methods) {
    const expectedUrl = method === "run"
      ? RUN_URL
      : method === "policy"
        ? POLICY_URL
        : method === "packet"
          ? PACKET_URL
          : PUBLICATION_URL;
    const cases: Array<[string, TestResponse | Error, string]> = [
      ["redirect", response(`${ORIGIN}/login`, 302, {}), "SAME_ORIGIN_REDIRECT_REJECTED"],
      ["URL drift", response(`${expectedUrl}/wrong`, 200, {}), "SAME_ORIGIN_RESPONSE_MISMATCH"],
      ["auth", response(expectedUrl, 401, { error: BACKEND_MESSAGE_SENTINEL }), "APPLY_PILOT_AUTH_REQUIRED"],
      ["rate", response(expectedUrl, 429, { error: BACKEND_MESSAGE_SENTINEL }), "SAME_ORIGIN_RATE_LIMITED"],
      ["server", response(expectedUrl, 503, { error: BACKEND_MESSAGE_SENTINEL }), "SAME_ORIGIN_REQUEST_FAILED"],
      ["transport", new Error("transport-private-sentinel"), "SAME_ORIGIN_REQUEST_FAILED"],
      ["unknown 4xx", response(expectedUrl, 409, { error: BACKEND_MESSAGE_SENTINEL, code: "UNKNOWN_CODE" }), "SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR"],
      ["missing code", response(expectedUrl, 422, { error: BACKEND_MESSAGE_SENTINEL }), "SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR"]
    ];
    for (const [name, returned, code] of cases) {
      await assert.rejects(
        invokeMethod(method, returned),
        hasCode(code, BACKEND_MESSAGE_SENTINEL),
        `${method} ${name}`
      );
    }
    await assert.rejects(
      invokeMethod(method, malformedJsonResponse(expectedUrl, 422)),
      hasCode("SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR", "malformed response body sentinel"),
      `${method} malformed error JSON`
    );
  }
});

test("each fixed method preserves only its own backend error allowlist", async () => {
  const runCodes = ["RUN_NOT_FOUND"];
  const packetCodes = ["RUN_NOT_FOUND", "RUN_INSPECTION_STALE", "RUN_INSPECTION_INVALID", "RUN_PACKET_INVALID"];
  const publicationCodes = [
    "AUTOMATION_DISABLED", "RUN_NOT_FOUND", "RUN_INVALID_STATE", "RUN_LIFECYCLE_STALE",
    "RUN_TARGET_INVALID", "RUN_TARGET_STALE", "RUN_HOST_NOT_ALLOWED", "RUN_DOCUMENT_STALE",
    "RUN_INSPECTION_STALE", "RUN_INSPECTION_INVALID", "RUN_PACKET_INVALID",
    "RUN_ANSWER_SOURCE_SET_TOO_LARGE", "REQUEST_BODY_TOO_LARGE", "INVALID_CONTENT_LENGTH",
    "INVALID_JSON", "INVALID_REQUEST_BODY", "UNSUPPORTED_MEDIA_TYPE"
  ];

  for (const code of runCodes) {
    await assert.rejects(invokeMethod("run", response(RUN_URL, 404, { error: BACKEND_MESSAGE_SENTINEL, code })), hasCode(code, BACKEND_MESSAGE_SENTINEL));
  }
  for (const code of packetCodes) {
    await assert.rejects(invokeMethod("packet", response(PACKET_URL, 409, { error: BACKEND_MESSAGE_SENTINEL, code })), hasCode(code, BACKEND_MESSAGE_SENTINEL));
  }
  for (const code of publicationCodes) {
    await assert.rejects(invokeMethod("publication", response(PUBLICATION_URL, 409, { error: BACKEND_MESSAGE_SENTINEL, code })), hasCode(code, BACKEND_MESSAGE_SENTINEL));
  }

  await assert.rejects(
    invokeMethod("policy", response(POLICY_URL, 403, { error: BACKEND_MESSAGE_SENTINEL, code: "AUTOMATION_DISABLED" })),
    hasCode("SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR", BACKEND_MESSAGE_SENTINEL)
  );
  await assert.rejects(
    invokeMethod("run", response(RUN_URL, 409, { error: BACKEND_MESSAGE_SENTINEL, code: "RUN_PACKET_INVALID" })),
    hasCode("SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR", BACKEND_MESSAGE_SENTINEL)
  );
  await assert.rejects(
    invokeMethod("packet", response(PACKET_URL, 409, { error: BACKEND_MESSAGE_SENTINEL, code: "RUN_DOCUMENT_STALE" })),
    hasCode("SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR", BACKEND_MESSAGE_SENTINEL)
  );
});

test("publication sends exactly one serialized five-key body after the synchronous authority callback", async () => {
  const events: string[] = [];
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const input = publicationInput();
  const client = makeClient({
    async post(url, options) {
      events.push("post");
      calls.push({ url, options });
      return response(url, 200, publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 }));
    }
  });

  const result = await client.publishFormInspection(input, () => {
    events.push("callback");
    assert.equal(calls.length, 0);
  });

  const exactBody = "{\"expectedStateVersion\":7,\"expectedFormInspectionVersion\":2,\"expectedAnswerPacketVersion\":3,\"observedUrl\":\"https://jobs.example.test/apply#current\",\"inspectionReport\":{\"marker\":\"safe-report\"}}";
  assert.deepEqual(events, ["callback", "post"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, PUBLICATION_URL);
  assert.deepEqual(calls[0]?.options, {
    data: exactBody,
    headers: { "Content-Type": "application/json" },
    failOnStatusCode: false,
    maxRedirects: 0,
    maxRetries: 0
  });
  assert.equal("Content-Length" in (calls[0]?.options.headers as object), false);
  assert.equal(exactBody.includes("runId"), false);
  assert.equal(exactBody.includes("freshRunState"), false);
  assert.deepEqual(result, {
    replayed: true,
    run: { id: RUN_ID, state: "REVIEW_REQUIRED", stateVersion: 7 },
    current: { inspectionVersion: 2, answerPacketVersion: 3 }
  });
  assert.equal(JSON.stringify(result).includes(PROPOSAL_SENTINEL), false);
  assert.equal(JSON.stringify(result).includes(QUESTION_SENTINEL), false);
});

test("publication authority callback propagates unchanged and prevents POST", async () => {
  let posts = 0;
  let callbacks = 0;
  const sentinel = new Error("coordinator-authority-sentinel");
  const client = makeClient({ async post() { posts += 1; throw new Error("unexpected POST"); } });

  await assert.rejects(
    client.publishFormInspection(publicationInput(), () => { callbacks += 1; throw sentinel; }),
    (error: unknown) => error === sentinel
  );
  assert.equal(callbacks, 1);
  assert.equal(posts, 0);
});

test("publication reads each caller-owned property once and retains the initial READY authority", async () => {
  const base = publicationInput({ freshRunState: "READY" });
  const reads = {
    runId: 0,
    freshRunState: 0,
    expectedStateVersion: 0,
    expectedFormInspectionVersion: 0,
    expectedAnswerPacketVersion: 0,
    observedUrl: 0,
    inspectionReport: 0
  };
  const input = Object.defineProperties({}, {
    runId: { get() { reads.runId += 1; return base.runId; } },
    freshRunState: {
      get() {
        reads.freshRunState += 1;
        return reads.freshRunState === 1 ? "READY" : "ARBITRARY_RUNTIME_STATE";
      }
    },
    expectedStateVersion: {
      get() { reads.expectedStateVersion += 1; return base.expectedStateVersion; }
    },
    expectedFormInspectionVersion: {
      get() {
        reads.expectedFormInspectionVersion += 1;
        return base.expectedFormInspectionVersion;
      }
    },
    expectedAnswerPacketVersion: {
      get() {
        reads.expectedAnswerPacketVersion += 1;
        return base.expectedAnswerPacketVersion;
      }
    },
    observedUrl: { get() { reads.observedUrl += 1; return base.observedUrl; } },
    inspectionReport: {
      get() { reads.inspectionReport += 1; return base.inspectionReport; }
    }
  }) as BrowserFormInspectionPublicationInput;
  const client = makeClient({
    async post(url) {
      return response(url, 201, publicationResponse({
        replayed: false,
        stateVersion: 7,
        inspectionVersion: 2,
        answerPacketVersion: 4
      }));
    }
  });

  await assert.rejects(
    client.publishFormInspection(input, () => undefined),
    hasCode("INVALID_FORM_INSPECTION_RESPONSE")
  );
  assert.deepEqual(reads, {
    runId: 1,
    freshRunState: 1,
    expectedStateVersion: 1,
    expectedFormInspectionVersion: 1,
    expectedAnswerPacketVersion: 1,
    observedUrl: 1,
    inspectionReport: 1
  });
});

test("publication response authority ignores callback mutation of freshRunState", async () => {
  const input = publicationInput({ freshRunState: "READY" }) as Mutable<
    BrowserFormInspectionPublicationInput
  >;
  const client = makeClient({
    async post(url) {
      return response(url, 201, publicationResponse({
        replayed: false,
        stateVersion: 7,
        inspectionVersion: 2,
        answerPacketVersion: 4
      }));
    }
  });

  await assert.rejects(
    client.publishFormInspection(input, () => { input.freshRunState = "REVIEW_REQUIRED"; }),
    hasCode("INVALID_FORM_INSPECTION_RESPONSE")
  );
});

test("publication response authority ignores callback mutation of expectedStateVersion", async () => {
  const input = publicationInput() as Mutable<BrowserFormInspectionPublicationInput>;
  const client = makeClient({
    async post(url) {
      return response(url, 201, publicationResponse({
        replayed: false,
        stateVersion: 6,
        inspectionVersion: 2,
        answerPacketVersion: 4
      }));
    }
  });

  await assert.rejects(
    client.publishFormInspection(input, () => { input.expectedStateVersion = 6; }),
    hasCode("INVALID_FORM_INSPECTION_RESPONSE")
  );
});

test("publication replay authority ignores callback mutation of artifact versions", async () => {
  const input = publicationInput() as Mutable<BrowserFormInspectionPublicationInput>;
  let transmittedBody = "";
  const client = makeClient({
    async post(url, options) {
      transmittedBody = String(options.data);
      return response(url, 200, publicationResponse({
        replayed: true,
        stateVersion: 7,
        inspectionVersion: 1,
        answerPacketVersion: 2
      }));
    }
  });

  await assert.rejects(
    client.publishFormInspection(input, () => {
      input.expectedFormInspectionVersion = 1;
      input.expectedAnswerPacketVersion = 2;
    }),
    hasCode("INVALID_FORM_INSPECTION_RESPONSE")
  );
  assert.equal(
    transmittedBody,
    "{\"expectedStateVersion\":7,\"expectedFormInspectionVersion\":2,\"expectedAnswerPacketVersion\":3,\"observedUrl\":\"https://jobs.example.test/apply#current\",\"inspectionReport\":{\"marker\":\"safe-report\"}}"
  );
});

test("publication enforces the exact UTF-8 byte limit before callback and network", async () => {
  let callbacks = 0;
  let posts = 0;
  const client = makeClient({
    async post(url) {
      posts += 1;
      return response(url, 200, publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 }));
    }
  });

  await client.publishFormInspection(inputWithSerializedByteLength(262_144), () => { callbacks += 1; });
  assert.equal(callbacks, 1);
  assert.equal(posts, 1);

  await assert.rejects(
    client.publishFormInspection(inputWithSerializedByteLength(262_145), () => { callbacks += 1; }),
    hasCode("FORM_INSPECTION_REQUEST_TOO_LARGE")
  );
  assert.equal(callbacks, 1);
  assert.equal(posts, 1);

  const multibyte = publicationInput({
    inspectionReport: { value: "é".repeat(131_000) } as unknown as BrowserFormInspectionPublicationInput["inspectionReport"]
  });
  const serialized = JSON.stringify({
    expectedStateVersion: multibyte.expectedStateVersion,
    expectedFormInspectionVersion: multibyte.expectedFormInspectionVersion,
    expectedAnswerPacketVersion: multibyte.expectedAnswerPacketVersion,
    observedUrl: multibyte.observedUrl,
    inspectionReport: multibyte.inspectionReport
  });
  assert.ok(serialized.length < 262_144);
  assert.ok(new TextEncoder().encode(serialized).byteLength > 262_144);
  await assert.rejects(
    client.publishFormInspection(multibyte, () => { callbacks += 1; }),
    hasCode("FORM_INSPECTION_REQUEST_TOO_LARGE")
  );
  assert.equal(callbacks, 1);
  assert.equal(posts, 1);
});

test("200 replay accepts equal, concurrently newer, and unbounded monotonic artifact versions", async () => {
  for (const [inspectionVersion, answerPacketVersion] of [[2, 3], [2, 4], [3, 4], [2_000, 3_000]] as const) {
    const client = makeClient({
      async post(url) {
        return response(url, 200, publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion, answerPacketVersion }));
      }
    });
    const result = await client.publishFormInspection(publicationInput(), () => undefined);
    assert.equal(result.replayed, true);
    assert.equal(result.current.inspectionVersion, inspectionVersion);
    assert.equal(result.current.answerPacketVersion, answerPacketVersion);
  }
});

test("200 replay rejects artifact regression and run-authority mismatches", async () => {
  const invalid = [
    ["inspection regression", publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 1, answerPacketVersion: 3 })],
    ["packet regression", publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 2 })],
    ["wrong state", publicationResponse({ replayed: true, state: "READY", stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 })],
    ["unknown state", publicationResponse({ replayed: true, state: "UNKNOWN", stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 })],
    ["wrong stateVersion", publicationResponse({ replayed: true, stateVersion: 8, inspectionVersion: 2, answerPacketVersion: 3 })],
    ["wrong run", publicationResponse({ replayed: true, runId: OTHER_RUN_ID, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 })],
    ["zero version", publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 0, answerPacketVersion: 3 })],
    ["unsafe version", publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: Number.MAX_SAFE_INTEGER + 1 })],
    ["material flag", publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 })]
  ] as const;
  for (const [name, body] of invalid) {
    const client = makeClient({ async post(url) { return response(url, 200, body); } });
    await assert.rejects(client.publishFormInspection(publicationInput(), () => undefined), hasCode("INVALID_FORM_INSPECTION_RESPONSE"), name);
  }
});

test("201 material publication accepts READY first publication and REVIEW_REQUIRED same or changed form", async () => {
  const cases: Array<{ input: BrowserFormInspectionPublicationInput; inspectionVersion: number; answerPacketVersion: number; stateVersion: number }> = [
    { input: publicationInput({ freshRunState: "READY", expectedStateVersion: 4, expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0 }), inspectionVersion: 1, answerPacketVersion: 1, stateVersion: 5 },
    { input: publicationInput(), inspectionVersion: 2, answerPacketVersion: 4, stateVersion: 7 },
    { input: publicationInput(), inspectionVersion: 3, answerPacketVersion: 4, stateVersion: 7 },
    { input: publicationInput({ freshRunState: "READY" }), inspectionVersion: 3, answerPacketVersion: 4, stateVersion: 8 }
  ];
  for (const entry of cases) {
    const client = makeClient({
      async post(url) {
        return response(url, 201, publicationResponse({ replayed: false, stateVersion: entry.stateVersion, inspectionVersion: entry.inspectionVersion, answerPacketVersion: entry.answerPacketVersion }));
      }
    });
    const result = await client.publishFormInspection(entry.input, () => undefined);
    assert.equal(result.replayed, false);
    assert.equal(result.current.inspectionVersion, entry.inspectionVersion);
    assert.equal(result.current.answerPacketVersion, entry.answerPacketVersion);
  }
});

test("201 material publication rejects impossible state and version combinations", async () => {
  const invalid: Array<[string, BrowserFormInspectionPublicationInput, ReturnType<typeof publicationResponse>]> = [
    ["wrong result state", publicationInput(), publicationResponse({ replayed: false, state: "READY", stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["wrong review stateVersion", publicationInput(), publicationResponse({ replayed: false, stateVersion: 8, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["wrong ready stateVersion", publicationInput({ freshRunState: "READY" }), publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["packet does not increment", publicationInput(), publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 3 })],
    ["packet skips", publicationInput(), publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 5 })],
    ["inspection regresses", publicationInput(), publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 1, answerPacketVersion: 4 })],
    ["inspection skips", publicationInput(), publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 4, answerPacketVersion: 4 })],
    ["first inspection not one", publicationInput({ freshRunState: "READY", expectedStateVersion: 4, expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0 }), publicationResponse({ replayed: false, stateVersion: 5, inspectionVersion: 0, answerPacketVersion: 1 })],
    ["first packet not one", publicationInput({ freshRunState: "READY", expectedStateVersion: 4, expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0 }), publicationResponse({ replayed: false, stateVersion: 5, inspectionVersion: 1, answerPacketVersion: 2 })],
    ["replay flag", publicationInput(), publicationResponse({ replayed: true, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["wrong run", publicationInput(), publicationResponse({ replayed: false, runId: OTHER_RUN_ID, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["unknown state", publicationInput(), publicationResponse({ replayed: false, state: "UNKNOWN", stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 })],
    ["unsafe stateVersion", publicationInput(), publicationResponse({ replayed: false, stateVersion: Number.MAX_SAFE_INTEGER + 1, inspectionVersion: 2, answerPacketVersion: 4 })]
  ];
  for (const [name, input, body] of invalid) {
    const client = makeClient({ async post(url) { return response(url, 201, body); } });
    await assert.rejects(client.publishFormInspection(input, () => undefined), hasCode("INVALID_FORM_INSPECTION_RESPONSE"), name);
  }
});

test("publication rejects every success status other than exact 200 replay or 201 material", async () => {
  for (const status of [202, 204, 206, 299]) {
    const client = makeClient({
      async post(url) {
        return response(url, status, publicationResponse({ replayed: false, stateVersion: 7, inspectionVersion: 2, answerPacketVersion: 4 }));
      }
    });
    await assert.rejects(client.publishFormInspection(publicationInput(), () => undefined), hasCode("SAME_ORIGIN_RESPONSE_MISMATCH"), String(status));
  }
});

test("malformed successful responses never expose raw packet proposal or question text", async () => {
  const client = makeClient({
    async post(url) {
      return response(url, 200, {
        replayed: true,
        run: { id: RUN_ID, state: "REVIEW_REQUIRED", stateVersion: "bad" },
        current: { inspectionVersion: 2, answerPacketVersion: 3, answers: [{ question: QUESTION_SENTINEL, proposal: PROPOSAL_SENTINEL }] }
      });
    }
  });
  await assert.rejects(client.publishFormInspection(publicationInput(), () => undefined), (error: unknown) => {
    assert.ok(error instanceof SameOriginClientError);
    assert.equal(error.code, "INVALID_FORM_INSPECTION_RESPONSE");
    assert.equal(error.message.includes(PROPOSAL_SENTINEL), false);
    assert.equal(error.message.includes(QUESTION_SENTINEL), false);
    return true;
  });
});
