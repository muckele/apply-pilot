import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  buildApplicationDocumentFactIdJsonSchema
} from "@/lib/ai/application-document-facts";
import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import { coverLetterProviderSchema, coverLetterSchema } from "@/lib/ai/documents";
import { tailoredResumeProviderSchema, tailoredResumeSchema } from "@/lib/ai/resume";

const quotedFact = 'Built "Atlas\\Edge" workflows for 12 regional teams.';
const negatedFact = "Did not own production Kubernetes administration.";
const qualifiedFact = "Assisted the director with quarterly capacity planning.";
const reviewedFact = "Completed 480 hours of supervised Quenby operations training.";

const payload: ApplicationDocumentPayload = {
  job: {
    title: "Operations Director",
    company: "Synthetic Employer",
    requirements: ["Kubernetes", "Quenby"],
    detectedTechStack: ["Kubernetes", "Quenby"]
  },
  resume: {
    rawText: [
      "Taylor Boundary",
      "Operations leader focused on evidence-safe delivery.",
      "Service Operations: Incident response, capacity planning",
      quotedFact,
      negatedFact,
      qualifiedFact,
      "Additional: Volunteer mentor for community workshops."
    ].join("\n"),
    summary: "Operations leader focused on evidence-safe delivery.",
    skills: [
      "Service Operations: Incident response, capacity planning",
      "Service Operations: Incident response, capacity planning"
    ],
    achievements: ["Reduced response time by 18%."],
    workHistory: [{
      company: "Synthetic Systems",
      title: "Service Operations Lead",
      bullets: [quotedFact, negatedFact, qualifiedFact],
      sourceText: `${quotedFact}\n${negatedFact}\n${qualifiedFact}`
    }],
    projects: [{ title: "Atlas Migration", bullets: ["Migrated 24 workflows without data loss."] }],
    education: [{ degree: "Bachelor of Arts", fieldOfStudy: "Business Administration" }],
    certifications: [{ name: "Operations Certificate", details: ["Completed 480 supervised hours."] }]
  },
  profile: {
    skillsToEmphasize: ["Service Operations: Incident response, capacity planning"]
  },
  reviewedEvidence: {
    facts: [{
      fact: reviewedFact,
      provenance: "OWNER_ATTESTED",
      sourceRef: null
    }]
  }
};

function factIdFor(excerpt: string) {
  const fact = buildApplicationDocumentFactCatalog(payload).find((entry) => entry.excerpt === excerpt);
  assert.ok(fact, `missing catalog fact: ${excerpt}`);
  return fact.factId;
}

function publicError(error: unknown, code: string, fieldPath: string) {
  return error instanceof PublicApiError &&
    error.details?.code === code &&
    error.details?.fieldPath === fieldPath;
}

test("atomic applicant fact catalog is stable, exact, deduplicated, and provenance bearing", () => {
  const first = buildApplicationDocumentFactCatalog(payload);
  const second = buildApplicationDocumentFactCatalog(structuredClone(payload));

  assert.deepEqual(second, first);
  assert.ok(first.length >= 12);
  assert.deepEqual(first.map((fact) => fact.factId), first.map((_, index) => `fact:${String(index).padStart(4, "0")}`));
  assert.equal(first.filter((fact) => fact.excerpt.includes("Service Operations: Incident response")).length, 1);
  assert.equal(first.filter((fact) => fact.excerpt === quotedFact).length, 1);
  assert.deepEqual(
    first.find((fact) => fact.excerpt === quotedFact),
    {
      factId: factIdFor(quotedFact),
      ref: "resume.workHistory[0]",
      excerpt: quotedFact,
      provenance: { kind: "resume", detail: null }
    }
  );
  assert.deepEqual(
    first.find((fact) => fact.excerpt === reviewedFact)?.provenance,
    { kind: "reviewed_evidence", detail: "OWNER_ATTESTED" }
  );
  assert.equal(
    first.find((fact) => fact.excerpt === "Additional: Volunteer mentor for community workshops.")?.ref,
    "resume.rawText"
  );
});

test("provider fact-id schema exposes no citation ref or excerpt fields", () => {
  const schema = buildApplicationDocumentFactIdJsonSchema(payload);
  const serialized = JSON.stringify(schema);
  const expectedIds = buildApplicationDocumentFactCatalog(payload).map((fact) => fact.factId);

  assert.deepEqual(schema.properties.factId.enum, expectedIds);
  assert.doesNotMatch(serialized, /"ref"|"excerpt"|claimEvidence|citations/u);
});

test("resume assembler derives exact citations and bullet originals before existing factual validation", () => {
  const output = assembleTailoredResumeProviderOutput(payload, {
    professionalSummary: "Operations leader focused on evidence-safe delivery.",
    professionalSummaryFactId: factIdFor("Operations leader focused on evidence-safe delivery."),
    skillsSection: [{
      text: "Service Operations: Incident response, capacity planning",
      factId: factIdFor("Service Operations: Incident response, capacity planning")
    }],
    bulletRewrites: [{
      factId: factIdFor(quotedFact),
      rewrite: quotedFact,
      reason: "Keep the exact supported result."
    }],
    rolesOrProjectsToEmphasize: [{
      text: "Service Operations Lead",
      factId: factIdFor("Service Operations Lead")
    }],
    resumeTextClaims: [],
    unsupportedKeywords: ["Kubernetes"],
    formattingWarnings: [],
    resumeText: [
      "SUMMARY",
      "Operations leader focused on evidence-safe delivery.",
      "SKILLS",
      "Service Operations: Incident response, capacity planning",
      "EXPERIENCE",
      quotedFact,
      "Service Operations Lead"
    ].join("\n")
  });

  assert.equal(output.bulletRewrites[0]?.original, quotedFact);
  assert.deepEqual(output.claimEvidence.find((entry) => entry.claim === quotedFact)?.citations, [{
    ref: "resume.workHistory[0]",
    excerpt: quotedFact
  }]);
  assert.deepEqual(validateTailoredResumeClaims(payload, output), output);
  assert.ok(tailoredResumeSchema.safeParse(output).success);
  assert.ok(tailoredResumeProviderSchema.safeParse(output).success === false);
});

test("wrong allowed and unknown fact IDs fail with precise safe paths", () => {
  const wrongAllowed = assembleTailoredResumeProviderOutput(payload, {
    professionalSummary: quotedFact,
    professionalSummaryFactId: factIdFor(qualifiedFact),
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: quotedFact
  });
  assert.throws(
    () => validateTailoredResumeClaims(payload, wrongAllowed),
    (error) => publicError(error, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "claimEvidence[0].claim")
  );

  assert.throws(
    () => assembleTailoredResumeProviderOutput(payload, {
      professionalSummary: "Operations leader focused on evidence-safe delivery.",
      professionalSummaryFactId: "fact:9999",
      skillsSection: [],
      bulletRewrites: [],
      rolesOrProjectsToEmphasize: [],
      resumeTextClaims: [],
      unsupportedKeywords: [],
      formattingWarnings: [],
      resumeText: "Operations leader focused on evidence-safe delivery."
    }),
    (error) => publicError(error, "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID", "professionalSummaryFactId")
  );
});

test("a correct duplicate claim cannot mask a wrong per-item fact selection", () => {
  const output = assembleTailoredResumeProviderOutput(payload, {
    professionalSummary: quotedFact,
    professionalSummaryFactId: factIdFor(quotedFact),
    skillsSection: [],
    bulletRewrites: [{
      factId: factIdFor(qualifiedFact),
      rewrite: quotedFact,
      reason: "Adversarial duplicate claim with the wrong source fact."
    }],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: quotedFact
  });
  assert.throws(
    () => validateTailoredResumeClaims(payload, output),
    (error) => publicError(error, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "claimEvidence[1].claim")
  );

  const cover = assembleCoverLetterProviderOutput(payload, {
    title: "Synthetic cover letter",
    coverLetter: `Dear Hiring Team,\n${quotedFact}\nThank you for your time and consideration.`,
    angle: "Adversarial duplicate association.",
    claimsUsed: [
      { claim: quotedFact, factId: factIdFor(quotedFact) },
      { claim: quotedFact, factId: factIdFor(qualifiedFact) }
    ]
  });
  assert.throws(
    () => validateCoverLetterClaims(payload, cover),
    (error) => publicError(error, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "claimsUsed[1].claim")
  );
});

test("every factual resume-text line requires an assembled per-item fact association", () => {
  assert.throws(
    () => assembleTailoredResumeProviderOutput(payload, {
      professionalSummary: "",
      professionalSummaryFactId: "__NO_APPLICANT_FACT__",
      skillsSection: [],
      bulletRewrites: [],
      rolesOrProjectsToEmphasize: [],
      resumeTextClaims: [],
      unsupportedKeywords: [],
      formattingWarnings: [],
      resumeText: `EXPERIENCE\n${quotedFact}`
    }),
    (error) => publicError(error, "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED", "resumeText.line[1]")
  );
});

test("raw-text-only bullets keep one selectable standalone fact for every supported glyph", () => {
  for (const glyph of ["-", "*", "•", "▪", "◦", "–", "—"]) {
    const source = "Built secure workflows.";
    const bulletPayload: ApplicationDocumentPayload = { resume: { rawText: `${glyph} ${source}` } };
    const fact = buildApplicationDocumentFactCatalog(bulletPayload).find((entry) => entry.excerpt === source);
    assert.ok(fact, glyph);
    const output = assembleCoverLetterProviderOutput(bulletPayload, {
      title: "Synthetic cover letter",
      coverLetter: `Dear Hiring Team,\n${source}\nThank you for your time and consideration.`,
      angle: "Raw bullet evidence.",
      claimsUsed: [{ claim: source, factId: fact.factId }]
    });
    assert.deepEqual(validateCoverLetterClaims(bulletPayload, output), output, glyph);
  }
});

test("provider schemas reject legacy, unused, and redundant evidence metadata", () => {
  const base = {
    professionalSummary: "",
    professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: ""
  };
  assert.ok(tailoredResumeProviderSchema.safeParse({ ...base, claimEvidence: [] }).success === false);
  assert.ok(coverLetterProviderSchema.safeParse({
    title: "Synthetic letter",
    coverLetter: "Thank you for your time and consideration.",
    angle: "Truthful",
    claimsUsed: [{ claim: "unused", factId: factIdFor(quotedFact), citations: [] }]
  }).success === false);
  assert.throws(
    () => assembleTailoredResumeProviderOutput(payload, {
      ...base,
      resumeTextClaims: [{ claim: quotedFact, factId: factIdFor(quotedFact) }]
    }),
    (error) => publicError(
      error,
      "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
      "resumeTextClaims[0].claim"
    )
  );
});

test("cover assembler resolves facts server-side and preserves negation and qualifiers", () => {
  const coverLetter = [
    "Dear Synthetic Employer Hiring Team,",
    qualifiedFact,
    negatedFact,
    reviewedFact,
    "Thank you for your time and consideration."
  ].join("\n");
  const output = assembleCoverLetterProviderOutput(payload, {
    title: "Synthetic Employer Operations Director cover letter",
    coverLetter,
    angle: "Use current evidence only.",
    claimsUsed: [
      { claim: qualifiedFact, factId: factIdFor(qualifiedFact) },
      { claim: negatedFact, factId: factIdFor(negatedFact) },
      { claim: reviewedFact, factId: factIdFor(reviewedFact) },
      { claim: reviewedFact, factId: factIdFor(reviewedFact) }
    ]
  });

  assert.equal(output.claimsUsed.length, 3);
  assert.deepEqual(validateCoverLetterClaims(payload, output), output);
  assert.ok(coverLetterSchema.safeParse(output).success);
  assert.throws(
    () => validateCoverLetterClaims(payload, {
      ...output,
      coverLetter: coverLetter.replace(negatedFact, "Owned production Kubernetes administration."),
      claimsUsed: output.claimsUsed.map((entry) => entry.claim === negatedFact
        ? { ...entry, claim: "Owned production Kubernetes administration." }
        : entry)
    }),
    (error) => error instanceof PublicApiError &&
      ["APPLICATION_DOCUMENT_NEGATION_REVERSAL", "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"].includes(
        String(error.details?.code)
      )
  );
  assert.throws(
    () => validateCoverLetterClaims(payload, {
      ...output,
      coverLetter: coverLetter.replace(qualifiedFact, "Directed quarterly capacity planning."),
      claimsUsed: output.claimsUsed.map((entry) => entry.claim === qualifiedFact
        ? { ...entry, claim: "Directed quarterly capacity planning." }
        : entry)
    }),
    (error) => publicError(error, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "claimsUsed[0].claim")
  );
});
