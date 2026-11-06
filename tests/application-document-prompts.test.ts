import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("resume tailoring uses prompt/cache v14 fact IDs with faithful rewording under the validator's truth rules", () => {
  const prompt = source("prompts/resumeTailorPrompt.ts");
  const implementation = source("lib/ai/resume.ts");
  const version = source("lib/ai/application-document-version.ts");
  assert.match(prompt, /factIds/);
  assert.match(prompt, /server derives original verbatim/i);
  assert.doesNotMatch(prompt, /claimEvidence/);
  assert.match(prompt, /exact submitted source/i);
  // Faithful rewording (owner-approved 2026-11-05): reorder, re-inflect, condense, lead with job words
  // that are in the facts; nothing new and no dropped qualifiers.
  assert.match(prompt, /faithful rewording: reorder clauses and words, change word forms, condense, and lead with words the job also uses/i);
  assert.match(prompt, /use only words from the cited facts plus a, an, the, and, I/i);
  assert.match(prompt, /never add a metric, employer, tool, job term, scope, or seniority/i);
  assert.match(prompt, /Keep each number with its unit and relation word/i);
  assert.match(prompt, /Never drop a negation or a qualifier, ownership, or status word/i);
  assert.match(prompt, /Built\/Created\/Developed\/Engineered/);
  assert.match(prompt, /Improved\/Enhanced/);
  assert.match(prompt, /Reduced\/Decreased/);
  assert.match(prompt, /Copy record headers \(title, company, dates\), skill names, and credential IDs exactly/i);
  assert.match(prompt, /combine facts of the same bullet, job, project, summary, or achievement only/i);
  assert.match(prompt, /Keep each source item whole/i);
  assert.match(prompt, /never rename one/i);
  assert.match(prompt, /grouped like the source/i);
  assert.match(prompt, /most job-relevant roles the most bullets/i);
  assert.match(prompt, /3 achievements most relevant to the job/i);
  assert.match(prompt, /Use every owner-attested reviewed fact at least once/i);
  assert.match(prompt, /professionalSummary.*one standalone applicant fact or an empty string/is);
  assert.match(prompt, /skillsSection.*rolesOrProjectsToEmphasize.*standalone applicant fact/is);
  assert.match(prompt, /supporting factId/is);
  assert.doesNotMatch(prompt, /use only these section headings/i);
  assert.doesNotMatch(prompt, /atsCompatibilityScore|jobFitScore/);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "14"/);
  assert.match(implementation, /buildTailoredResumeSystemPrompt/);
  assert.match(implementation, /buildTailoredResumeGeminiJsonSchema/);
  assert.match(implementation, /feature: "RESUME_TAILOR",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  // The truth checks run inside the shared finalizer, after unverifiable lines revert to source
  // wording (owner decision 2026-11-06), and again on the completed résumé.
  assert.match(implementation, /validate: \(value\) => finalizeTailoredResume\(applicationPayload, value\)/);
  const finalizer = source("lib/ai/application-document-quality.ts");
  assert.match(finalizer, /validateTailoredResumeQuality\(payload, validateTailoredResumeClaims\(payload, reverted\)\)/);
});

test("cover generation uses an applicant-neutral v14 atomic fact contract", () => {
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
  assert.match(prompt, /prioritize.*stated requirements/iu);
  assert.match(prompt, /evidence determine.*length/iu);
  assert.match(version, /APPLICATION_DOCUMENT_PROMPT_VERSION = "14"/);
  assert.match(implementation, /buildCoverLetterSystemPrompt/);
  assert.match(implementation, /buildCoverLetterGeminiJsonSchema/);
  assert.match(implementation, /feature: "COVER_LETTER",[\s\S]*promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION/);
  assert.match(implementation, /validateCoverLetterClaims\(payload, value\)/);
});

test("cover paragraph planning selects relevant responsibility/result facts without composing new claims", () => {
  const prompt = source("prompts/coverLetterPrompt.ts");
  assert.match(prompt, /two distinct job priorities/iu);
  assert.match(prompt, /use at most one in the entire letter/iu);
  assert.match(prompt, /complete first-person sentences/iu);
  assert.match(prompt, /Do not change We to I/iu);
  assert.match(prompt, /responsibility and.*result/iu);
  assert.match(prompt, /Do not repeat.*whole claim.*different fact IDs/iu);
  assert.match(prompt, /Each complete sentence.*own factId/iu);
  assert.match(prompt, /Do not add an employer prefix/iu);
});
