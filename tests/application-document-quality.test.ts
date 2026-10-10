import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FIXTURE
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog
} from "@/lib/ai/application-document-facts";
import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims
} from "@/lib/ai/application-document-claims";
import {
  validateCoverLetterQuality,
  validateTailoredResumeQuality
} from "@/lib/ai/application-document-quality";
import { PublicApiError } from "@/lib/api-errors";

test("the document qualification fixture has realistic source and target depth without diagnostic prose", () => {
  const fixture = SYNTHETIC_CORRECTION_FLOW_FIXTURE;
  assert.ok(fixture.resume.workHistory.length >= 2);
  assert.ok(fixture.resume.workHistory.every((record) => record.bullets.length >= 3));
  assert.ok(fixture.resume.projects.length >= 2);
  assert.ok(fixture.resume.education.length >= 2);
  assert.ok(fixture.resume.certifications.length >= 1);
  assert.ok(fixture.resume.achievements.length >= 2);
  assert.ok(fixture.job.requirements.length >= 6);
  assert.ok(fixture.job.preferredQualifications.length >= 3);
  assert.ok(fixture.job.description.length >= 300);
  assert.doesNotMatch(
    fixture.resume.rawText,
    /synthetic owner|source-backed|reviewed evidence|diagnostic|fixture|factId/iu
  );
});

test("the offline documents are complete relative to their available source records", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const resume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const coverLetter = assembleCoverLetterProviderOutput(payload, syntheticCoverLetterOutput());

  assert.deepEqual(validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, resume)), resume);
  assert.deepEqual(validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, coverLetter)), coverLetter);
  for (const record of payload.resume?.workHistory as Array<{ company: string }>) {
    assert.match(resume.resumeText, new RegExp(record.company, "u"));
  }
  for (const project of payload.resume?.projects as Array<{ name: string }>) {
    assert.match(resume.resumeText, new RegExp(project.name, "u"));
  }
  assert.ok(coverLetter.claimsUsed.length >= 3);
  assert.doesNotMatch(
    `${resume.resumeText}\n${coverLetter.coverLetter}`,
    /synthetic owner|source-backed|reviewed evidence|diagnostic|fixture|factId/iu
  );
});

test("resume completeness rejects omission of a source work record while preserving factual checks", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const resume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const omittedCompany = String((payload.resume?.workHistory as Array<{ company: string }>)[1]?.company);
  const incomplete = structuredClone(resume);
  incomplete.resumeText = incomplete.resumeText.split("\n")
    .filter((line) => !line.includes(omittedCompany))
    .join("\n");
  incomplete.claimEvidence = incomplete.claimEvidence.filter((entry) =>
    !entry.citations.some((citation) => citation.ref === "resume.workHistory[1]")
  );

  assert.throws(
    () => validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, incomplete)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "resume.workHistory[1]"
  );
});

test("resume completeness rejects omission of one supported bullet inside a retained work record", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const output = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const omitted = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
  const changed = {
    ...output,
    resumeText: output.resumeText.replace(`${omitted}\n`, ""),
    claimEvidence: output.claimEvidence.filter((entry) => entry.claim !== omitted)
  };
  assert.throws(
    () => validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, changed)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "resume.workHistory[1]"
  );
});

test("cover-letter completeness rejects a truthful but insubstantial one-fact letter", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const coverLetter = assembleCoverLetterProviderOutput(payload, syntheticCoverLetterOutput());
  const oneClaim = structuredClone(coverLetter);
  oneClaim.claimsUsed = oneClaim.claimsUsed.slice(0, 1);
  oneClaim.coverLetter = [
    `Dear ${String(payload.job?.company)} Hiring Team,`,
    "",
    `I am writing to apply for the ${String(payload.job?.title)} position.`,
    "",
    oneClaim.claimsUsed[0]?.claim ?? "",
    "",
    "Thank you for your time and consideration.",
    "",
    "Sincerely,",
    "Taylor Boundary"
  ].join("\n");

  assert.throws(
    () => validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, oneClaim)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "claimsUsed"
  );
});

test("cover-letter structure does not count identity and contact headers as evidence paragraphs", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const facts = buildApplicationDocumentFactCatalog(payload);
  const selectedExcerpts = [
    "Taylor Boundary",
    "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",
    "I hold current Quenby certification in enterprise service operations."
  ];
  const claimsUsed = selectedExcerpts.map((claim) => {
    const factId = facts.find((fact) => fact.excerpt === claim)?.factId;
    assert.ok(factId, `missing fixture fact for ${claim}`);
    return { claim, factId };
  });
  const output = assembleCoverLetterProviderOutput(payload, {
    title: "Northwind Service Cloud — Service Operations Director",
    angle: "Current source-backed evidence.",
    claimsUsed,
    coverLetter: [
      selectedExcerpts[0],
      "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
      "",
      "Dear Northwind Service Cloud Hiring Team,",
      "",
      "I am writing to apply for the Service Operations Director position.",
      "",
      `${selectedExcerpts[1]} ${selectedExcerpts[2]}`,
      "",
      "Thank you for your time and consideration.",
      "",
      "Sincerely,",
      selectedExcerpts[0]
    ].join("\n")
  });

  assert.throws(
    () => validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, output)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "claimsUsed"
  );
});

test("resume completeness permits duplicate indexed values that intentionally share one catalog fact", () => {
  const payload = {
    resume: {
      rawText: "Taylor Boundary\ntaylor@example.test",
      skills: ["TypeScript", "TypeScript"]
    }
  };
  const output = {
    resumeText: "Taylor Boundary\ntaylor@example.test\nTypeScript",
    claimEvidence: [{
      claim: "TypeScript",
      citations: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }]
    }]
  };
  assert.equal(buildApplicationDocumentFactCatalog(payload).some((fact) => fact.ref === "resume.skills[1]"), false);
  assert.equal(validateTailoredResumeQuality(payload, output), output);
});

test("resume completeness does not treat SQL as present inside PostgreSQL", () => {
  const payload = {
    resume: {
      rawText: "Taylor Boundary\ntaylor@example.test",
      workHistory: [{ technologies: ["SQL", "PostgreSQL"] }]
    }
  };
  const output = {
    resumeText: "Taylor Boundary\ntaylor@example.test\nPostgreSQL",
    claimEvidence: [{
      claim: "PostgreSQL",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "PostgreSQL" }]
    }]
  };
  assert.throws(
    () => validateTailoredResumeQuality(payload, output),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "resume.workHistory[0]"
  );
});

test("cover-letter structure does not count one repeated body fact as varied evidence", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const facts = buildApplicationDocumentFactCatalog(payload);
  const selectedExcerpts = [
    "Taylor Boundary",
    "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
    "I hold current Quenby certification in enterprise service operations."
  ];
  const claimsUsed = selectedExcerpts.map((claim) => {
    const factId = facts.find((fact) => fact.excerpt === claim)?.factId;
    assert.ok(factId, `missing fixture fact for ${claim}`);
    return { claim, factId };
  });
  const output = assembleCoverLetterProviderOutput(payload, {
    title: "Northwind Service Cloud — Service Operations Director",
    angle: "Current source-backed evidence.",
    claimsUsed,
    coverLetter: [
      selectedExcerpts[0],
      selectedExcerpts[1],
      "",
      "Dear Northwind Service Cloud Hiring Team,",
      "",
      "I am writing to apply for the Service Operations Director position.",
      "",
      selectedExcerpts[2],
      "",
      selectedExcerpts[2],
      "",
      "Thank you for your time and consideration.",
      "",
      "Sincerely,",
      selectedExcerpts[0]
    ].join("\n")
  });

  assert.throws(
    () => validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, output)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_INCOMPLETE" &&
      error.details?.fieldPath === "claimsUsed"
  );
});

test("quality checks accept reviewed evidence de-duplicated against the same resume fact", () => {
  const payload = {
    job: { title: "Engineer", company: "Contoso" },
    resume: {
      rawText: "Taylor Boundary\ntaylor@example.test",
      skills: ["TypeScript", "SQL", "API integrations"]
    },
    reviewedEvidence: {
      facts: [{ fact: "TypeScript", provenance: "OWNER_ATTESTED" }]
    }
  };
  const facts = buildApplicationDocumentFactCatalog(payload);
  assert.equal(facts.some((fact) => fact.ref === "reviewedEvidence.facts[0].fact"), false);
  const resumeOutput = {
    resumeText: "Taylor Boundary\ntaylor@example.test\nTypeScript\nSQL\nAPI integrations",
    claimEvidence: facts.filter((fact) => fact.ref.startsWith("resume.skills[")).map((fact) => ({
      claim: fact.excerpt,
      citations: [{ ref: fact.ref, excerpt: fact.excerpt }]
    }))
  };
  assert.equal(validateTailoredResumeQuality(payload, resumeOutput), resumeOutput);

  const coverOutput = {
    coverLetter: [
      "Dear Contoso Hiring Team,",
      "",
      "I am writing to apply for the Engineer position.",
      "",
      "TypeScript and SQL",
      "",
      "API integrations",
      "",
      "Sincerely,",
      "Taylor Boundary"
    ].join("\n"),
    claimsUsed: resumeOutput.claimEvidence
  };
  assert.equal(validateCoverLetterQuality(payload, coverOutput), coverOutput);
});
