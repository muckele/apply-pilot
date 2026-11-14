import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { finalizeTailoredResume } from "@/lib/ai/application-document-quality";
import { tailoredResumeProviderSchema } from "@/lib/ai/resume";

// Live case 2026-11-14 (shape only; every name and fact here is invented): two paid résumé writes in
// a row were rejected whole (APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT, resumeTextClaims[5]) because
// one citation quoted text that is not a line of the résumé Gemini wrote. A citation is evidence for
// a line, not part of the page: one that names no rendered line is set aside, exactly as the cover
// letter already drops a claim absent from its letter. Every rendered line still needs its own
// evidence, so a line left without any is removed and its source wording restored as before.
const FIRST = "Closed ~30 deals a month at a 40–50% demo-to-close rate.";
const SECOND = "Trained 12 new sellers on the demo script.";
const HEADER = "Account Executive | Example Travel | 2019 – 2021";
const payload: ApplicationDocumentPayload = {
  job: { title: "Account Executive", company: "Example" },
  resume: {
    rawText: `Sam Sample\nEXPERIENCE\n${HEADER}\n• ${FIRST}\n• ${SECOND}`,
    summary: "Seller.",
    workHistory: [{ company: "Example Travel", title: "Account Executive", bullets: [FIRST, SECOND] }]
  }
};

function factId(excerpt: string) {
  const fact = buildApplicationDocumentFactCatalog(payload).find((entry) => entry.excerpt === excerpt);
  assert.ok(fact, excerpt);
  return fact.factId;
}

function assemble(claims: Array<{ claim: string; factId: string }>, lines: string[]) {
  return assembleTailoredResumeProviderOutput(payload, tailoredResumeProviderSchema.parse({
    professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [],
    resumeTextClaims: claims,
    unsupportedKeywords: [], formattingWarnings: [], resumeText: ["EXPERIENCE", HEADER, ...lines].join("\n")
  }));
}

test("a citation naming text absent from the résumé is set aside instead of rejecting the paid answer", () => {
  const absent = "Closed about 30 deals monthly.";
  const assembled = assemble([{ claim: absent, factId: factId(FIRST) }], [`• ${FIRST}`, `• ${SECOND}`]);
  assert.equal(assembled.claimEvidence.some((entry) => entry.claim === absent), false);
  const final = finalizeTailoredResume(payload, assembled);
  assert.ok(final.resumeText.split("\n").includes(`• ${FIRST}`));
  assert.ok(final.resumeText.split("\n").includes(`• ${SECOND}`));
});

test("a reworded line whose only citation was set aside does not keep its unsupported wording", () => {
  const reworded = "Closed about 30 deals a month at a 40–50% demo-to-close rate, beating quota every quarter.";
  const assembled = assemble(
    [{ claim: "Closed about 30 deals a month at a 40–50% demo-to-close rate.", factId: factId(FIRST) }],
    [`• ${reworded}`, `• ${SECOND}`]
  );
  const final = finalizeTailoredResume(payload, assembled);
  assert.equal(final.resumeText.includes("beating quota"), false);
  assert.ok(final.resumeText.split("\n").includes(`• ${SECOND}`));
});

test("a citation with an unknown fact ID is still rejected", () => {
  assert.throws(
    () => assemble([{ claim: "Closed about 30 deals monthly.", factId: "fact:9999" }], [`• ${FIRST}`]),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID"
  );
});
