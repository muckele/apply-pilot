import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("resume tailoring uses prompt/cache v3 citations and excludes model self-scores", () => {
  const prompt = source("prompts/resumeTailorPrompt.ts");
  const implementation = source("lib/ai/resume.ts");
  assert.match(prompt, /claimEvidence/);
  assert.match(prompt, /citations/);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.doesNotMatch(prompt, /atsCompatibilityScore|jobFitScore/);
  assert.match(implementation, /feature: "RESUME_TAILOR", promptVersion: "3"/);
  assert.match(implementation, /validateTailoredResumeClaims\(payload[^,]*, value\)/);
});

test("cover generation uses an applicant-neutral v3 citation contract", () => {
  const prompt = source("prompts/coverLetterPrompt.ts");
  const implementation = source("lib/ai/documents.ts");
  assert.match(prompt, /claimsUsed/);
  assert.match(prompt, /citations/);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.match(prompt, /Do not state standalone employer or job-description facts/i);
  assert.match(prompt, /every body sentence applicant-specific/i);
  assert.doesNotMatch(prompt, /software engineering, sales, customer-facing, and operations/i);
  assert.match(implementation, /feature: "COVER_LETTER", promptVersion: "3"/);
  assert.match(implementation, /validateCoverLetterClaims\(payload, value\)/);
});
