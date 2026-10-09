import assert from "node:assert/strict";
import test from "node:test";

import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";

type ReferenceContract = Readonly<{
  applicant: string[];
  job: string[];
  all: string[];
}>;

type CitationCollection = {
  items: { properties: { citations: { items: { properties: { ref: { enum: string[] } } } } } };
};

type SchemaView = {
  properties: {
    claimEvidence?: CitationCollection;
    claimsUsed?: CitationCollection;
  };
};

const expectedApplicantReferences = [
  "resume.rawText",
  "resume.summary",
  "resume.skills[0]",
  "resume.skills[1]",
  "resume.skills[2]",
  "resume.achievements[0]",
  "resume.workHistory[0]",
  "resume.projects[0]",
  "resume.education[0]",
  "resume.certifications[0]",
  "profile.skillsToEmphasize[0]",
  "profile.skillsToEmphasize[1]",
  "profile.skillsToEmphasize[2]",
  "reviewedEvidence.facts[0].fact"
];

const expectedJobReferences = [
  "job.title",
  "job.company",
  "job.location",
  "job.remoteStatus",
  "job.description",
  "job.requirements[0]",
  "job.requirements[1]",
  "job.preferredQualifications[0]",
  "job.detectedTechStack[0]",
  "job.detectedTechStack[1]"
];

test("application-document provider contracts publish the exact resolver namespace and close citation refs", async () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const claimsModule = await import("@/lib/ai/application-document-claims") as Record<string, unknown>;
  const resumeModule = await import("@/lib/ai/resume") as Record<string, unknown>;
  const documentsModule = await import("@/lib/ai/documents") as Record<string, unknown>;

  assert.equal(typeof claimsModule.getApplicationDocumentEvidenceReferences, "function");
  assert.equal(typeof resumeModule.buildTailoredResumeSystemPrompt, "function");
  assert.equal(typeof resumeModule.buildTailoredResumeGeminiJsonSchema, "function");
  assert.equal(typeof documentsModule.buildCoverLetterSystemPrompt, "function");
  assert.equal(typeof documentsModule.buildCoverLetterGeminiJsonSchema, "function");

  const references = (claimsModule.getApplicationDocumentEvidenceReferences as
    (value: typeof payload) => ReferenceContract)(payload);
  assert.deepEqual(references.applicant, expectedApplicantReferences);
  assert.deepEqual(references.job, expectedJobReferences);
  assert.deepEqual(references.all, [...expectedApplicantReferences, ...expectedJobReferences]);
  assert.ok(!references.all.some((ref) => ref.includes(".bullets[") || ref === "reviewedEvidence.facts[0]"));

  const resumePrompt = (resumeModule.buildTailoredResumeSystemPrompt as
    (value: typeof payload) => string)(payload);
  const coverPrompt = (documentsModule.buildCoverLetterSystemPrompt as
    (value: typeof payload) => string)(payload);
  for (const prompt of [resumePrompt, coverPrompt]) {
    assert.match(prompt, /Allowed applicant evidence references \(exact strings only\)/u);
    assert.match(prompt, /Allowed contextual job references \(exact strings only\)/u);
    assert.match(prompt, /reviewedEvidence\.facts\[0\]\.fact/u);
    assert.match(prompt, /Never append child paths/u);
    assert.doesNotMatch(prompt, /resume\.workHistory\[0\]\.bullets\[0\]/u);
  }

  const resumeSchema = (resumeModule.buildTailoredResumeGeminiJsonSchema as
    (value: typeof payload) => SchemaView)(payload);
  const coverSchema = (documentsModule.buildCoverLetterGeminiJsonSchema as
    (value: typeof payload) => SchemaView)(payload);
  assert.deepEqual(
    resumeSchema.properties.claimEvidence?.items.properties.citations.items.properties.ref.enum,
    references.all
  );
  assert.deepEqual(
    coverSchema.properties.claimsUsed?.items.properties.citations.items.properties.ref.enum,
    references.all
  );
});

test("application-document prompt/cache identity advances for the closed reference contract", async () => {
  const version = await import("@/lib/ai/application-document-version");
  assert.equal(version.APPLICATION_DOCUMENT_PROMPT_VERSION, "4");
});
