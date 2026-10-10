import assert from "node:assert/strict";
import test from "node:test";

import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";

type ReferenceContract = Readonly<{
  applicant: string[];
  job: string[];
  all: string[];
}>;

type SchemaView = {
  properties: {
    professionalSummaryFactId?: { enum: string[] };
    claimsUsed?: { items: { properties: { factId: { enum: string[] } } } };
  };
};

const expectedApplicantReferences = [
  "resume.rawText",
  "resume.summary",
  "resume.skills[0]",
  "resume.skills[1]",
  "resume.skills[2]",
  "resume.achievements[0]",
  "resume.achievements[1]",
  "resume.workHistory[0]",
  "resume.workHistory[1]",
  "resume.projects[0]",
  "resume.projects[1]",
  "resume.education[0]",
  "resume.education[1]",
  "resume.certifications[0]",
  "profile.skillsToEmphasize[0]",
  "profile.skillsToEmphasize[1]",
  "profile.skillsToEmphasize[2]",
  "profile.skillsToEmphasize[3]",
  "profile.skillsToEmphasize[4]",
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
  "job.requirements[2]",
  "job.requirements[3]",
  "job.requirements[4]",
  "job.requirements[5]",
  "job.preferredQualifications[0]",
  "job.preferredQualifications[1]",
  "job.preferredQualifications[2]",
  "job.detectedTechStack[0]",
  "job.detectedTechStack[1]",
  "job.detectedTechStack[2]",
  "job.detectedTechStack[3]"
];

test("application-document provider contracts keep refs server-side and close the wire to atomic fact IDs", async () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const claimsModule = await import("@/lib/ai/application-document-claims") as Record<string, unknown>;
  const resumeModule = await import("@/lib/ai/resume") as Record<string, unknown>;
  const documentsModule = await import("@/lib/ai/documents") as Record<string, unknown>;
  const factsModule = await import("@/lib/ai/application-document-facts") as Record<string, unknown>;

  assert.equal(typeof claimsModule.getApplicationDocumentEvidenceReferences, "function");
  assert.equal(typeof resumeModule.buildTailoredResumeSystemPrompt, "function");
  assert.equal(typeof resumeModule.buildTailoredResumeGeminiJsonSchema, "function");
  assert.equal(typeof documentsModule.buildCoverLetterSystemPrompt, "function");
  assert.equal(typeof documentsModule.buildCoverLetterGeminiJsonSchema, "function");
  assert.equal(typeof factsModule.buildApplicationDocumentFactCatalog, "function");

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
    assert.match(prompt, /Allowed applicant atomic facts \(select factId only\)/u);
    assert.match(prompt, /Contextual job references \(never applicant evidence\)/u);
    assert.match(prompt, /OWNER_ATTESTED/u);
    assert.match(prompt, /Never return source references/u);
    assert.doesNotMatch(prompt, /resume\.workHistory\[0\]\.bullets\[0\]/u);
  }
  assert.match(coverPrompt, /Allowed uncited cover-letter lines \(exact strings only\)/u);
  for (const exactLine of [
    "Dear Northwind Service Cloud Hiring Team,",
    "I am writing to apply for the Service Operations Director position.",
    "Thank you for your time and consideration.",
    "Sincerely,",
    "Taylor Boundary",
    "[Your name]"
  ]) {
    assert.ok(coverPrompt.includes(JSON.stringify(exactLine)), exactLine);
  }

  const resumeSchema = (resumeModule.buildTailoredResumeGeminiJsonSchema as
    (value: typeof payload) => SchemaView)(payload);
  const coverSchema = (documentsModule.buildCoverLetterGeminiJsonSchema as
    (value: typeof payload) => SchemaView)(payload);
  const facts = (factsModule.buildApplicationDocumentFactCatalog as
    (value: typeof payload) => Array<{ factId: string }>)(payload);
  const factIds = facts.map((fact) => fact.factId);
  assert.deepEqual(
    resumeSchema.properties.professionalSummaryFactId?.enum.filter(
      (value) => value !== "__NO_APPLICANT_FACT__"
    ),
    factIds
  );
  assert.deepEqual(
    coverSchema.properties.claimsUsed?.items.properties.factId.enum,
    factIds
  );
  assert.doesNotMatch(JSON.stringify(resumeSchema), /"ref"|"excerpt"|claimEvidence|citations/u);
  assert.doesNotMatch(JSON.stringify(coverSchema), /"ref"|"excerpt"|citations/u);
});

test("application-document prompt/cache identity advances for the full deterministic writing contract", async () => {
  const version = await import("@/lib/ai/application-document-version");
  assert.equal(version.APPLICATION_DOCUMENT_PROMPT_VERSION, "8");
});

test("cover uncited-line projection collapses source whitespace into one physical line", async () => {
  const claimsModule = await import("@/lib/ai/application-document-claims");
  const payload = syntheticCorrectionFlowDocumentPayload();
  payload.job = {
    ...payload.job,
    company: "Synthetic\nEmployer",
    title: "Sr.\nService Operations Director"
  };
  const lines = claimsModule.getCoverLetterUncitedLines(payload);
  assert.ok(lines.includes("Dear Synthetic Employer Hiring Team,"));
  assert.ok(lines.includes("I am writing to apply for the Sr. Service Operations Director position."));
  assert.ok(lines.every((line) => !line.includes("\n")));
});
