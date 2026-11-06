import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { tailoredResumeProviderSchema } from "@/lib/ai/resume";

// Live case: the résumé rendered the full source skills line
//   "Technical: …, REST API integrations; AI tools including Claude, ChatGPT and OpenAI Codex"
// and cited only its first semicolon part, which is itself a catalog fact. The assembler
// rejected the paid result because a claim had to equal a whole line.
const skillsLine = "Technical: TypeScript, SQL; AI tools including Claude and ChatGPT";
const payload: ApplicationDocumentPayload = {
  job: { title: "Account Executive", company: "Example" },
  resume: { rawText: `Sam Sample\nSKILLS\n${skillsLine}`, summary: "Seller.", skills: [skillsLine] }
};

function factId(excerpt: string) {
  const fact = buildApplicationDocumentFactCatalog(payload).find((entry) => entry.excerpt === excerpt);
  assert.ok(fact, excerpt);
  return fact.factId;
}

function wire(claim: string, resumeText = `SKILLS\n${skillsLine}`) {
  return tailoredResumeProviderSchema.parse({
    professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [{ claim, factId: factId("Technical: TypeScript, SQL") }],
    unsupportedKeywords: [], formattingWarnings: [], resumeText
  });
}

test("a claim may be one semicolon part of a rendered line", () => {
  const assembled = assembleTailoredResumeProviderOutput(payload, wire("Technical: TypeScript, SQL"));
  assert.ok(assembled.claimEvidence.some((entry) => entry.claim === "Technical: TypeScript, SQL"));
});

test("a claim that is only part of a semicolon part is still rejected", () => {
  for (const claim of ["Technical: TypeScript", "TypeScript, SQL", "Technical: TypeScript, SQL; AI tools"]) {
    assert.throws(
      () => assembleTailoredResumeProviderOutput(payload, wire(claim)),
      (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
      claim
    );
  }
});

test("a partly cited line that is not verbatim source still needs full evidence", () => {
  assert.throws(
    () => assembleTailoredResumeProviderOutput(payload, wire("Technical: TypeScript, SQL", "SKILLS\nTechnical: TypeScript, SQL; Kubernetes administration")),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
  );
});

test("a verbatim source line is bound to the catalog facts it contains", () => {
  const assembled = assembleTailoredResumeProviderOutput(payload, wire("Technical: TypeScript, SQL"));
  const whole = assembled.claimEvidence.find((entry) => entry.claim === skillsLine);
  assert.ok(whole, "the whole source line carries evidence");
  assert.deepEqual(whole!.citations.map((citation) => citation.excerpt).sort(), ["AI tools including Claude and ChatGPT", "Technical: TypeScript, SQL"]);
});

test("a verbatim source line the model cited nothing of is still rejected", () => {
  assert.throws(
    () => assembleTailoredResumeProviderOutput(payload, tailoredResumeProviderSchema.parse({
      professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__",
      skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [],
      resumeTextClaims: [], unsupportedKeywords: [], formattingWarnings: [], resumeText: `SKILLS\n${skillsLine}`
    })),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
  );
});
