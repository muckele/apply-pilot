import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getAllowedAiModels, getOpenAIModel } from "@/lib/ai/client";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import { hashAiInput } from "@/lib/ai/usage";
import { paginateResumeText, type ResumeFormat } from "@/lib/documents/resume-format";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
import { createBrowserCaptureToken } from "@/lib/security/browser-capture-token";

const originalModel = process.env.OPENAI_MODEL;
const originalAllowedModels = process.env.OPENAI_ALLOWED_MODELS;
const originalAiProvider = process.env.AI_PROVIDER;
const originalAiAllowedModels = process.env.AI_ALLOWED_MODELS;

afterEach(() => {
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  if (originalAllowedModels === undefined) delete process.env.OPENAI_ALLOWED_MODELS;
  else process.env.OPENAI_ALLOWED_MODELS = originalAllowedModels;
  if (originalAiProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalAiProvider;
  if (originalAiAllowedModels === undefined) delete process.env.AI_ALLOWED_MODELS;
  else process.env.AI_ALLOWED_MODELS = originalAiAllowedModels;
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

test("AI model overrides are limited to the server allowlist", () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  process.env.AI_ALLOWED_MODELS = "gpt-4o-mini,unpriced-model";

  assert.deepEqual(getAllowedAiModels(), ["gpt-4o-mini"]);
  assert.equal(getOpenAIModel("gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(getOpenAIModel("unpriced-model"), "gpt-4o-mini");
});

test("AI cost estimation separates cached and uncached input tokens", () => {
  assert.equal(
    estimateAiCostMicros({ model: "gpt-4o-mini", inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200 }),
    240
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
