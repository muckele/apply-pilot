import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("resume tailoring uses prompt/cache v7 atomic fact IDs and the validator's exact grammar", () => {
  const prompt = source("prompts/resumeTailorPrompt.ts");
  const implementation = source("lib/ai/resume.ts");
  const version = source("lib/ai/application-document-version.ts");
  assert.match(prompt, /factId/);
  assert.match(prompt, /server derives original verbatim/i);
  assert.doesNotMatch(prompt, /claimEvidence/);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.match(prompt, /Built\/Created\/Developed\/Engineered/);
  assert.match(prompt, /Improved\/Enhanced/);
  assert.match(prompt, /Reduced\/Decreased/);
  assert.match(prompt, /leading verb or immediately follows I/i);
  assert.match(prompt, /Do not substitute any other action verbs/i);
  assert.match(prompt, /optional I, a, an, the, am, are, have, or is/i);
  assert.match(prompt, /every other factual word, preposition, and word order/i);
  assert.match(prompt, /professionalSummary.*one standalone applicant fact or an empty string/is);
  assert.match(prompt, /skillsSection.*rolesOrProjectsToEmphasize.*standalone applicant fact/is);
  assert.match(prompt, /supporting factId/is);
  assert.match(prompt, /SUMMARY.*PROFILE.*SKILLS.*EXPERIENCE.*WORK EXPERIENCE.*PROJECTS.*EDUCATION.*CERTIFICATIONS.*ACHIEVEMENTS.*ADDITIONAL INFORMATION/is);
  assert.doesNotMatch(prompt, /atsCompatibilityScore|jobFitScore/);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "7"/);
  assert.match(implementation, /buildTailoredResumeSystemPrompt/);
  assert.match(implementation, /buildTailoredResumeGeminiJsonSchema/);
  assert.match(implementation, /feature: "RESUME_TAILOR",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  assert.match(implementation, /validateTailoredResumeClaims\(applicationPayload, value\)/);
});

test("cover generation uses an applicant-neutral v7 atomic fact contract", () => {
  const prompt = source("prompts/coverLetterPrompt.ts");
  const implementation = source("lib/ai/documents.ts");
  const version = source("lib/ai/application-document-version.ts");
  assert.match(prompt, /claimsUsed/);
  assert.match(prompt, /factId/);
  assert.match(prompt, /server resolves each factId/i);
  assert.match(prompt, /exact submitted source/i);
  assert.match(prompt, /complete standalone applicant fact/i);
  assert.match(prompt, /Built\/Created\/Developed\/Engineered/);
  assert.match(prompt, /Improved\/Enhanced/);
  assert.match(prompt, /Reduced\/Decreased/);
  assert.match(prompt, /leading verb or immediately follows I/i);
  assert.match(prompt, /Do not substitute any other action verbs/i);
  assert.match(prompt, /optional I, a, an, the, am, are, have, or is/i);
  assert.match(prompt, /every other factual word, preposition, and word order/i);
  assert.match(prompt, /one complete standalone applicant fact/i);
  assert.match(prompt, /Do not freely paraphrase, summarize, combine, or reorder/i);
  assert.match(prompt, /Do not state standalone employer or job-description facts/i);
  assert.match(prompt, /Every other sentence must be one complete standalone applicant fact/i);
  assert.doesNotMatch(prompt, /software engineering, sales, customer-facing, and operations/i);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "7"/);
  assert.match(implementation, /buildCoverLetterSystemPrompt/);
  assert.match(implementation, /buildCoverLetterGeminiJsonSchema/);
  assert.match(implementation, /feature: "COVER_LETTER",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  assert.match(implementation, /validateCoverLetterClaims\(payload, value\)/);
});
