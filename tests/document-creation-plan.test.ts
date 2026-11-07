import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithApprovedAiCost } from "@/lib/ai/browser-request";
import {
  documentCreationConfirmation,
  documentCreationMaximumMicros,
  formatUsdCentsCeiling,
  planCoverLetterOnly,
  planDocumentCreation,
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

test("skipping every gap on a first review saves the review and generates without re-scoring", () => {
  const plan = planDocumentCreation({
    hasValidCurrentSnapshot: false, reviewable: true, includeCoverLetter: true,
    decisionKinds: ["UNRESOLVED", "UNRESOLVED"], acceptedFactActions: []
  });
  assert.deepEqual(plan, { ok: true, steps: ["save", "resume", "cover"] });
});

test("adding a line saves, re-scores once, then generates both documents", () => {
  const plan = planDocumentCreation({
    hasValidCurrentSnapshot: false, reviewable: true, includeCoverLetter: true,
    decisionKinds: ["OWNER_ATTESTATION", "UNRESOLVED"], acceptedFactActions: []
  });
  assert.deepEqual(plan, { ok: true, steps: ["save", "rescore", "resume", "cover"] });
});

test("removing or replacing a saved line counts as a fact change", () => {
  for (const action of ["REMOVE", "REPLACE_OWNER_ATTESTATION"] as const) {
    const plan = planDocumentCreation({
      hasValidCurrentSnapshot: true, reviewable: true, includeCoverLetter: false,
      decisionKinds: [], acceptedFactActions: ["RETAIN", action]
    });
    assert.deepEqual(plan, { ok: true, steps: ["save", "rescore", "resume"] });
  }
});

test("an existing saved review with no changes goes straight to generation", () => {
  const plan = planDocumentCreation({
    hasValidCurrentSnapshot: true, reviewable: false, includeCoverLetter: true,
    decisionKinds: [], acceptedFactActions: ["RETAIN"]
  });
  assert.deepEqual(plan, { ok: true, steps: ["resume", "cover"] });
});

test("an unscored job without a saved review must be scored first", () => {
  assert.deepEqual(planDocumentCreation({
    hasValidCurrentSnapshot: false, reviewable: false, includeCoverLetter: true, decisionKinds: [], acceptedFactActions: []
  }), { ok: false, reason: "SCORE_FIRST" });
});

test("fact changes against a non-reviewable estimate need a fresh check first", () => {
  assert.deepEqual(planDocumentCreation({
    hasValidCurrentSnapshot: true, reviewable: false, includeCoverLetter: true,
    decisionKinds: ["OWNER_ATTESTATION"], acceptedFactActions: []
  }), { ok: false, reason: "RECHECK_FIRST" });
});

test("the single confirmation shows the combined maximum of every paid step", () => {
  const plan = planDocumentCreation({
    hasValidCurrentSnapshot: false, reviewable: true, includeCoverLetter: true,
    decisionKinds: ["OWNER_ATTESTATION"], acceptedFactActions: []
  });
  assert.ok(plan.ok);
  assert.equal(documentCreationMaximumMicros(plan.steps, quote), 72_720 + 64_500 + 47_250);
  const message = documentCreationConfirmation(plan.steps, quote);
  assert.match(message, /Google Gemini/u);
  assert.match(message, /gemini-3\.8-flash/u);
  assert.match(message, /up to \$0\.18447/u);
  assert.match(message, /3 AI requests/u);
  assert.match(message, /update your fit estimate, write your tailored résumé, and write your cover letter/u);
  assert.match(message, /no automatic retry/iu);
});

test("the short hint rounds the maximum up to whole cents", () => {
  assert.equal(formatUsdCentsCeiling(112_125), "$0.12");
  assert.equal(formatUsdCentsCeiling(110_000), "$0.11");
  assert.equal(formatUsdCentsCeiling(1), "$0.01");
});

test("a résumé-only plan quotes only the résumé", () => {
  assert.equal(documentCreationMaximumMicros(["resume"], quote), 64_500);
  assert.match(documentCreationConfirmation(["resume"], quote), /1 AI request could cost up to \$0\.0645/u);
});

test("a ready résumé with the saved review in force and nothing changed plans the cover letter alone", () => {
  const plan = planCoverLetterOnly({
    hasCurrentResume: true, hasValidCurrentSnapshot: true,
    decisionKinds: ["UNRESOLVED", "UNRESOLVED"], acceptedFactActions: ["RETAIN"]
  });
  assert.deepEqual(plan, { ok: true, steps: ["cover"] });
  assert.ok(plan.ok);
  assert.equal(documentCreationMaximumMicros(plan.steps, quote), 47_250);
  const message = documentCreationConfirmation(plan.steps, quote);
  assert.match(message, /to write your cover letter\./u);
  assert.match(message, /1 AI request could cost up to \$0\.04725/u);
  assert.doesNotMatch(message, /tailored résumé|fit estimate/u);
});

test("the cover letter alone needs a ready tailored résumé for this job", () => {
  assert.deepEqual(planCoverLetterOnly({
    hasCurrentResume: false, hasValidCurrentSnapshot: true, decisionKinds: [], acceptedFactActions: []
  }), { ok: false, reason: "NO_CURRENT_RESUME" });
});

test("any pending line change rules out the cover letter alone", () => {
  for (const kind of ["OWNER_ATTESTATION", "SOURCE_CORRECTION"] as const) {
    assert.deepEqual(planCoverLetterOnly({
      hasCurrentResume: true, hasValidCurrentSnapshot: true, decisionKinds: ["UNRESOLVED", kind], acceptedFactActions: []
    }), { ok: false, reason: "FACTS_CHANGED" });
  }
  for (const action of ["REMOVE", "REPLACE_OWNER_ATTESTATION"] as const) {
    assert.deepEqual(planCoverLetterOnly({
      hasCurrentResume: true, hasValidCurrentSnapshot: true, decisionKinds: [], acceptedFactActions: ["RETAIN", action]
    }), { ok: false, reason: "FACTS_CHANGED" });
  }
});

test("without a saved review in force the cover letter alone is not planned", () => {
  assert.deepEqual(planCoverLetterOnly({
    hasCurrentResume: true, hasValidCurrentSnapshot: false, decisionKinds: ["UNRESOLVED"], acceptedFactActions: []
  }), { ok: false, reason: "REVIEW_NOT_SAVED" });
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
