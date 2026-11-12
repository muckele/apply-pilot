import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithApprovedAiCost } from "@/lib/ai/browser-request";
import {
  documentCreationMaximumMicros,
  formatCentsCeiling,
  formatUsdCentsCeiling,
  stepMaximumMicros,
  type DocumentCreationQuote
} from "@/lib/jobs/document-creation-plan";

const quote: DocumentCreationQuote = {
  provider: "gemini",
  model: "gemini-3.8-flash",
  promptVersion: "app-docs-v1",
  jobMatchMicros: 72_720,
  resumeMicros: 64_500,
  coverMicros: 47_250
};

test("the short hint rounds the maximum up to whole cents", () => {
  assert.equal(formatUsdCentsCeiling(112_125), "$0.12");
  assert.equal(formatUsdCentsCeiling(110_000), "$0.11");
  assert.equal(formatUsdCentsCeiling(1), "$0.01");
});

test("button labels show whole cents rounded up, and dollars from a dollar up", () => {
  assert.equal(formatCentsCeiling(72_720), "8¢");
  assert.equal(formatCentsCeiling(70_000), "7¢");
  assert.equal(formatCentsCeiling(1), "1¢");
  assert.equal(formatCentsCeiling(990_001), "$1.00");
  assert.equal(formatCentsCeiling(1_234_567), "$1.24");
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("an approved request is resent with confirmation headers without asking again", async () => {
  const calls: Array<Headers> = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers));
    return calls.length === 1
      ? jsonResponse(428, { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 64_500, dataType: "application_packet" })
      : jsonResponse(200, { ok: true });
  };
  let asked = 0;
  const response = await fetchWithApprovedAiCost("/api/jobs/job-1/tailored-resume", { method: "POST" }, 64_500, {
    fetchImpl, confirm: () => { asked += 1; return true; }
  });
  assert.equal(response.status, 200);
  assert.equal(asked, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.get("x-ai-cost-confirmed"), null);
  assert.equal(calls[1]!.get("x-ai-cost-confirmed"), "true");
  assert.equal(calls[1]!.get("x-ai-data-confirmed"), "true");
});

test("a server maximum above the approved amount asks again and stops if declined", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(428, { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 129_000 });
  };
  const prompts: string[] = [];
  await assert.rejects(
    fetchWithApprovedAiCost("/api/jobs/job-1/match", { method: "POST" }, 72_720, {
      fetchImpl, confirm: (message) => { prompts.push(message); return false; }
    }),
    /canceled before any provider charge/u
  );
  assert.equal(calls, 1);
  assert.match(prompts[0]!, /\$0\.129/u);
});

test("a response that needs no confirmation is returned as is", async () => {
  let calls = 0;
  const response = await fetchWithApprovedAiCost("/api/jobs/job-1/match", { method: "POST" }, 0, {
    fetchImpl: async () => { calls += 1; return jsonResponse(200, { ok: true }); },
    confirm: () => { throw new Error("must not ask"); }
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("the module keeps only the cost helpers the Apply page uses", async () => {
  const plan = await import("@/lib/jobs/document-creation-plan");
  // Step 3 writes documents and step 2 re-scores on their own; the combined plan is gone.
  assert.deepEqual(Object.keys(plan).sort(), [
    "documentCreationMaximumMicros", "formatCentsCeiling", "formatUsdCentsCeiling", "formatUsdMicros", "stepMaximumMicros"
  ]);
  assert.equal(stepMaximumMicros("resume", quote), 64_500);
  assert.equal(stepMaximumMicros("cover", quote), 47_250);
  assert.equal(documentCreationMaximumMicros(["resume", "cover"], quote), 64_500 + 47_250);
});
