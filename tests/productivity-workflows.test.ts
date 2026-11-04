import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getAiModel, getAllowedAiModels } from "@/lib/ai/config";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import { hashAiInput } from "@/lib/ai/usage";
import { paginateResumeText, type ResumeFormat } from "@/lib/documents/resume-format";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
import { createBrowserCaptureToken } from "@/lib/security/browser-capture-token";

const modelVariables = ["AI_ALLOWED_MODELS", "GEMINI_FAST_MODEL", "GEMINI_QUALITY_MODEL", "AI_PROVIDER"] as const;
const originalModels = Object.fromEntries(modelVariables.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of modelVariables) {
    const value = originalModels[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("browser capture tokens expose a prefix but store a one-way hash", () => {
  const first = createBrowserCaptureToken();
  const second = createBrowserCaptureToken();

  assert.match(first.token, /^jmc_[A-Za-z0-9_-]{43}$/);
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.tokenHash, first.token);
  assert.equal(first.tokenPrefix.endsWith("..."), true);
  assert.notEqual(first.token, second.token);
});

test("AI input hashes are stable for the same prompt contract", () => {
  const payload = { job: { id: "job-1", title: "Solutions Engineer" } };

  assert.equal(hashAiInput("jobMatchPrompt", "2", payload), hashAiInput("jobMatchPrompt", "2", payload));
  assert.notEqual(hashAiInput("jobMatchPrompt", "2", payload), hashAiInput("jobMatchPrompt", "3", payload));
});

test("AI model overrides are limited to the server allowlist of priced Gemini models", () => {
  delete process.env.AI_PROVIDER;
  process.env.GEMINI_FAST_MODEL = "gemini-3.5-flash-lite";
  delete process.env.GEMINI_QUALITY_MODEL;
  process.env.AI_ALLOWED_MODELS = "gemini-3.5-flash,gemini-unpriced";

  assert.deepEqual(getAllowedAiModels(), ["gemini-3.5-flash-lite", "gemini-3.5-flash"]);
  assert.equal(getAiModel("RESUME_PARSE", { modelOverride: "gemini-3.5-flash" }), "gemini-3.5-flash");
  assert.equal(getAiModel("RESUME_PARSE", { modelOverride: "gemini-unpriced" }), "gemini-3.5-flash-lite");
});

test("AI cost estimation uses the registered price and separates cached input tokens", () => {
  assert.equal(
    estimateAiCostMicros({
      model: "gemini-3.5-flash",
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200
    }),
    // 600 uncached x $1.50 + 400 cached x $0.15 + 200 output x $9 per million tokens.
    900 + 60 + 1_800
  );
});

test("resume pagination produces stable additional pages as content grows", () => {
  const format: ResumeFormat = {
    template: "CLASSIC",
    pageSize: "LETTER",
    fontFamily: "ARIAL",
    accentColor: "#0F766E",
    fontSize: 10,
    lineSpacing: 115
  };
  const shortResume = "SUMMARY\nCustomer-facing technical professional.\n\nEXPERIENCE\n- Improved onboarding workflows.";
  const longResume = Array.from({ length: 90 }, (_, index) => `- Achievement ${index + 1} with measurable customer impact.`).join("\n");

  assert.equal(paginateResumeText(shortResume, format).length, 1);
  assert.ok(paginateResumeText(longResume, format).length > 1);
});

test("interview questions normalize punctuation and casing for deduplication", () => {
  assert.equal(
    normalizeInterviewQuestion("  Tell me about a difficult customer? "),
    normalizeInterviewQuestion("tell me about a difficult customer")
  );
});
