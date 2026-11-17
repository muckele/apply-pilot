import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { fetchWithAiConsent, fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

test("browser cost confirmation retries once with only the confirmation header added", async (t) => {
  const requests: RequestInit[] = [];
  stub(t, globalThis, "window", { confirm: () => true });
  stub(t, globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? new Response(JSON.stringify({
          error: "Confirm this AI request's maximum cost before continuing.",
          code: "AI_COST_CONFIRMATION_REQUIRED",
          maximumCostMicros: 72_720
        }), { status: 428, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const response = await fetchWithAiCostConfirmation("/api/jobs/job-1/match", {
    method: "POST",
    headers: { "x-synthetic": "preserved" }
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[0].headers).has("x-ai-cost-confirmed"), false);
  assert.equal(new Headers(requests[1].headers).get("x-ai-cost-confirmed"), "true");
  assert.equal(new Headers(requests[1].headers).get("x-synthetic"), "preserved");
});

test("browser cost confirmation cancellation never retries", async (t) => {
  let requests = 0;
  stub(t, globalThis, "window", { confirm: () => false });
  stub(t, globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({
      code: "AI_COST_CONFIRMATION_REQUIRED",
      maximumCostMicros: 72_720
    }), { status: 428 });
  });

  await assert.rejects(
    fetchWithAiCostConfirmation("/api/jobs/job-1/match", { method: "POST" }),
    /canceled before any provider charge/i
  );
  assert.equal(requests, 1);
});

test("resume parsing confirmation names the data recipient and retries once with both grants", async (t) => {
  const requests: RequestInit[] = [];
  let confirmation = "";
  stub(t, globalThis, "window", { confirm: (message: string) => { confirmation = message; return true; } });
  stub(t, globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? new Response(JSON.stringify({
          error: "Confirm resume data and cost.",
          code: "AI_COST_CONFIRMATION_REQUIRED",
          maximumCostMicros: 38_250,
          provider: "gemini",
          dataType: "resume_text"
        }), { status: 428, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const response = await fetchWithAiCostConfirmation("/api/resumes/parse", {
    method: "POST",
    body: new FormData()
  });

  assert.equal(response.status, 200);
  assert.match(confirmation, /complete resume text/i);
  assert.match(confirmation, /Google Gemini/);
  assert.match(confirmation, /\$0\.03825(?:\D|$)/);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[0].headers).has("x-ai-data-confirmed"), false);
  assert.equal(new Headers(requests[1].headers).get("x-ai-data-confirmed"), "true");
  assert.equal(new Headers(requests[1].headers).get("x-ai-cost-confirmed"), "true");
});

test("application packet confirmation names Gemini, projected private data, call purpose, and retries once", async (t) => {
  const requests: RequestInit[] = [];
  let confirmation = "";
  stub(t, globalThis, "window", { confirm: (message: string) => { confirmation = message; return true; } });
  stub(t, globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? new Response(JSON.stringify({
          error: "Confirm application packet data and cost.",
          code: "AI_COST_CONFIRMATION_REQUIRED",
          maximumCostMicros: 72_000,
          provider: "gemini",
          dataType: "application_packet",
          feature: "RESUME_TAILOR",
          model: "gemini-3.8-flash",
          promptVersion: "6"
        }), { status: 428, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const response = await fetchWithAiCostConfirmation("/api/jobs/job-1/tailored-resume", {
    method: "POST"
  });

  assert.equal(response.status, 200);
  assert.match(confirmation, /Google Gemini/);
  assert.match(confirmation, /job, resume, and profile/i);
  assert.match(confirmation, /tailored resume/i);
  assert.match(confirmation, /gemini-3\.8-flash/);
  assert.match(confirmation, /prompt\/cache version 6/i);
  assert.match(confirmation, /no automatic retry/i);
  assert.match(confirmation, /\$0\.072(?:\D|$)/);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1].headers).get("x-ai-data-confirmed"), "true");
  assert.equal(new Headers(requests[1].headers).get("x-ai-cost-confirmed"), "true");
});

test("an unrelated 428 response remains readable by its caller", async (t) => {
  stub(t, globalThis, "window", { confirm: () => { throw new Error("must not confirm"); } });
  stub(t, globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: "Different precondition", code: "OTHER_PRECONDITION" }),
    { status: 428, headers: { "content-type": "application/json" } }
  ));

  const response = await fetchWithAiCostConfirmation("/api/example", { method: "POST" });
  assert.deepEqual(await response.json(), {
    error: "Different precondition",
    code: "OTHER_PRECONDITION"
  });
});

function costResponse() {
  return new Response(JSON.stringify({
    error: "Confirm this AI request's maximum cost before continuing.",
    code: "AI_COST_CONFIRMATION_REQUIRED",
    maximumCostMicros: 72_720
  }), { status: 428, headers: { "content-type": "application/json" } });
}

test("an async confirm that resolves false sends exactly one request", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return costResponse(); };
  await assert.rejects(
    fetchWithAiCostConfirmation("/api/jobs/job-1/match", { method: "POST" }, { fetchImpl, confirm: async () => false }),
    /canceled/
  );
  assert.equal(requests, 1);
});

test("an async confirm that resolves true resends with the cost confirmation header", async () => {
  const requests: RequestInit[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1 ? costResponse() : new Response("{}", { status: 200 });
  };
  const messages: string[] = [];
  const response = await fetchWithAiCostConfirmation("/api/jobs/job-1/match", { method: "POST" }, {
    fetchImpl,
    confirm: async (message) => { messages.push(message); return true; }
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1].headers).get("x-ai-cost-confirmed"), "true");
  assert.match(messages[0], /could cost up to \$0\.07272/);
});

test("an AI step the user already agreed to sends both consent headers on its one request", async () => {
  const requests: RequestInit[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return new Response("{}", { status: 200 });
  };
  const response = await fetchWithAiConsent("/api/jobs/job-1/match", { method: "POST", headers: { "x-synthetic": "kept" } }, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1, "no first unconfirmed request, no second confirmed one");
  const headers = new Headers(requests[0].headers);
  assert.equal(headers.get("x-ai-cost-confirmed"), "true");
  assert.equal(headers.get("x-ai-data-confirmed"), "true");
  assert.equal(headers.get("x-synthetic"), "kept");
  assert.equal(requests[0].method, "POST");
});
