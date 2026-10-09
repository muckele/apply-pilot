import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("resume tailoring uses prompt/cache v5 closed citations and bounded action paraphrases", () => {
  const prompt = source("prompts/resumeTailorPrompt.ts");
  const implementation = source("lib/ai/resume.ts");
  const version = source("lib/ai/application-document-version.ts");
  assert.match(prompt, /claimEvidence/);
  assert.match(prompt, /citations/);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.match(prompt, /Built\/Created\/Developed\/Engineered/);
  assert.match(prompt, /Improved\/Enhanced/);
  assert.match(prompt, /Reduced\/Decreased/);
  assert.match(prompt, /leading verb or immediately follows I/i);
  assert.match(prompt, /Do not substitute any other action verbs/i);
  assert.doesNotMatch(prompt, /atsCompatibilityScore|jobFitScore/);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "5"/);
  assert.match(implementation, /buildTailoredResumeSystemPrompt/);
  assert.match(implementation, /buildTailoredResumeGeminiJsonSchema/);
  assert.match(implementation, /feature: "RESUME_TAILOR",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  assert.match(implementation, /validateTailoredResumeClaims\(applicationPayload, value\)/);
});

test("cover generation uses an applicant-neutral v5 closed citation contract", () => {
  const prompt = source("prompts/coverLetterPrompt.ts");
  const implementation = source("lib/ai/documents.ts");
  const version = source("lib/ai/application-document-version.ts");
  assert.match(prompt, /claimsUsed/);
  assert.match(prompt, /citations/);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.match(prompt, /Built\/Created\/Developed\/Engineered/);
  assert.match(prompt, /Improved\/Enhanced/);
  assert.match(prompt, /Reduced\/Decreased/);
  assert.match(prompt, /leading verb or immediately follows I/i);
  assert.match(prompt, /Do not substitute any other action verbs/i);
  assert.match(prompt, /Do not state standalone employer or job-description facts/i);
  assert.match(prompt, /every body sentence applicant-specific/i);
  assert.doesNotMatch(prompt, /software engineering, sales, customer-facing, and operations/i);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "5"/);
  assert.match(implementation, /buildCoverLetterSystemPrompt/);
  assert.match(implementation, /buildCoverLetterGeminiJsonSchema/);
  assert.match(implementation, /feature: "COVER_LETTER",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  assert.match(implementation, /validateCoverLetterClaims\(payload, value\)/);
});
