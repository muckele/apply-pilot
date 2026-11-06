import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { tailoredResumeProviderSchema } from "@/lib/ai/resume";

// Live: reworded résumés failed 422 when a claim and its rendered line differed only in
// formatting. A claim now binds to the rendered line whose formatting-free form it equals,
// and the evidence describes the rendered text; any change of words or numbers still fails.
const bullet = "Closed ~30 deals a month at a 40–50% demo-to-close rate.";
const payload: ApplicationDocumentPayload = {
  job: { title: "Account Executive", company: "Example" },
  resume: {
    rawText: `Sam Sample\nEXPERIENCE\nTripadvisor\n• ${bullet}`,
    summary: "Seller.",
    workHistory: [{ company: "Tripadvisor", title: "Business Development Executive", bullets: [bullet] }]
  }
};

function factId(excerpt: string) {
  const fact = buildApplicationDocumentFactCatalog(payload).find((entry) => entry.excerpt === excerpt);
  assert.ok(fact, excerpt);
  return fact.factId;
}

function assemble(claim: string, line = `• ${bullet}`) {
  return assembleTailoredResumeProviderOutput(payload, tailoredResumeProviderSchema.parse({
    professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [{ claim, factId: factId(bullet) }],
    unsupportedKeywords: [], formattingWarnings: [], resumeText: `EXPERIENCE\n${line}`
  }));
}

test("a claim that differs from its line only in dash, quote or end punctuation binds to the rendered line", () => {
  for (const claim of [
    "Closed ~30 deals a month at a 40-50% demo-to-close rate.",
    "Closed ~30 deals a month at a 40–50% demo-to-close rate",
    "• Closed ~30 deals a month at a 40 – 50% demo‑to‑close rate."
  ]) {
    const assembled = assemble(claim);
    assert.ok(assembled.claimEvidence.some((entry) => entry.claim === bullet), claim);
  }
});

test("a claim that changes words or numbers is still rejected", () => {
  for (const claim of [
    "Closed ~30 deals a month at a 40–60% demo-to-close rate.",
    "Closed 30 deals a month at a 40–50% demo-to-close rate.",
    "Closed ~30 deals a week at a 40–50% demo-to-close rate."
  ]) {
    assert.throws(
      () => assemble(claim),
      (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
      claim
    );
  }
});
