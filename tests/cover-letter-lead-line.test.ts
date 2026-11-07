import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import { syntheticCorrectionFlowDocumentPayload, syntheticCoverLetterOutput } from "@/evaluation/correction-flow-provider-stub";
import { validateCoverLetterClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, type CoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { coverLetterRemovals, finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { getCoverLetterLeadLines } from "@/lib/ai/cover-letter-lead-lines";
import { buildCoverLetterSystemPrompt } from "@/lib/ai/documents";
import { PublicApiError } from "@/lib/api-errors";

// Owner decision 2026-11-06 (D033): each work record publishes one lead line built only from its
// own fields, allowed only as the first sentence of a paragraph whose every evidence sentence cites
// that record. Synthetic data only.

const CONTOSO = "Since 2021, I have been Senior Service Operations Manager at Contoso Service Systems.";
const FABRIKAM = "From 2017 to 2021, I was Service Delivery Manager at Fabrikam Customer Platforms.";

type WorkRecord = Record<string, unknown> & { bullets: string[] };
const base = () => structuredClone(syntheticCorrectionFlowDocumentPayload());
const records = (payload: ApplicationDocumentPayload) => (payload.resume as unknown as { workHistory: WorkRecord[] }).workHistory;

const wire = (payload = base()) => syntheticCoverLetterOutput(payload);
const claim = (index: number) => wire().claimsUsed[index]!.claim;
// Synthetic letter claims: 0 summary, 1-3 Contoso, 4-5 Fabrikam, 6 a project, 7 the owner's fact.
const [summary, directed, reduced, built, improved, mentored, dashboard] = [0, 1, 2, 3, 4, 5, 6].map(claim);
const intro = "I am applying for the Service Operations Director position at Northwind Service Cloud.";
const letterOf = (...body: string[]) => [
  "Taylor Boundary",
  "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
  "",
  "Dear Northwind Service Cloud Hiring Team,",
  "",
  `${intro} ${summary}`,
  "",
  body.join("\n\n"),
  "",
  "Thank you for your time and consideration.",
  "",
  "Sincerely,",
  "Taylor Boundary"
].join("\n");
const assembled = (payload: ApplicationDocumentPayload, coverLetter: string, provider: CoverLetterProviderOutput = wire(payload)) =>
  assembleCoverLetterProviderOutput(payload, { ...provider, coverLetter });
const paragraphsOf = (letter: string) => letter.split(/\n\s*\n/u).map((paragraph) => paragraph.trim());

function passes(payload: ApplicationDocumentPayload, coverLetter: string) {
  try {
    validateCoverLetterClaims(payload, assembled(payload, coverLetter));
    return true;
  } catch (error) {
    if (error instanceof PublicApiError) return false;
    throw error;
  }
}

test("each work record publishes one lead line built from its own title, employer and dates", () => {
  assert.deepEqual(getCoverLetterLeadLines(base()), [
    { ref: "resume.workHistory[0]", line: CONTOSO },
    { ref: "resume.workHistory[1]", line: FABRIKAM }
  ]);
});

test("a record without a title, employer, start date or a definite end publishes no lead line", () => {
  const payload = base();
  records(payload)[0]!.title = "";
  records(payload)[1]!.endDate = null;
  assert.deepEqual(getCoverLetterLeadLines(payload), []);
  const named = base();
  records(named)[1]!.company = "Fabrikam Platforms Inc.";
  assert.equal(getCoverLetterLeadLines(named)[1]!.line, "From 2017 to 2021, I was Service Delivery Manager at Fabrikam Platforms Inc.");
});

test("a lead line opens only a paragraph whose every evidence sentence cites that record", () => {
  const payload = base();
  const rest = `${built} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`;
  assert.equal(passes(payload, letterOf(`${directed} ${reduced}`, `${FABRIKAM} ${mentored} ${improved}`, rest)), true);
  assert.equal(passes(payload, letterOf(`${directed} ${reduced}`, `${mentored} ${FABRIKAM} ${improved}`, rest)), false);
  assert.equal(passes(payload, letterOf(`${directed} ${reduced}`, `${FABRIKAM} ${mentored} ${improved} ${dashboard}`, `${built} ${SYNTHETIC_CORRECTION_FLOW_FACT}`)), false);
  assert.equal(passes(payload, letterOf(`${FABRIKAM} ${directed} ${reduced}`, `${mentored} ${improved}`, rest)), false);
  assert.equal(passes(payload, letterOf(`${directed} ${reduced}`, FABRIKAM, `${mentored} ${improved}`, rest)), false);
});

test("the finalizer opens each one-record paragraph with that record's lead line", () => {
  const payload = base();
  const final = finalizeCoverLetter(payload, assembleCoverLetterProviderOutput(payload, wire(payload)));
  validateCoverLetterClaims(payload, final);
  const paragraphs = paragraphsOf(final.coverLetter);
  assert.ok(paragraphs.includes(`${CONTOSO} ${directed} ${reduced} ${built}`), final.coverLetter);
  assert.ok(paragraphs.includes(`${FABRIKAM} ${mentored} ${improved}`), final.coverLetter);
  assert.deepEqual(coverLetterRemovals(final), []);
  assert.equal(finalizeCoverLetter(payload, final).coverLetter, final.coverLetter);
});

test("a paragraph that also holds another source's fact gets no lead line", () => {
  const fact = "At Contoso Service Systems, after an incident closed, owned the corrective-action review through sign-off.";
  const payload = base();
  const reviewed = (payload.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  reviewed.push({ ...reviewed[0]!, gapId: "gap:contoso", fact });
  const final = finalizeCoverLetter(payload, assembleCoverLetterProviderOutput(payload, wire(payload)));
  validateCoverLetterClaims(payload, final);
  assert.ok(!final.coverLetter.includes(CONTOSO), final.coverLetter);
  assert.ok(paragraphsOf(final.coverLetter).some((paragraph) => paragraph.startsWith(FABRIKAM)), final.coverLetter);
});

test("a lead line out of place moves to its record's paragraph, or is removed and reported", () => {
  const payload = base();
  const rest = `${built} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`;
  const moved = finalizeCoverLetter(payload, assembled(payload, letterOf(`${directed} ${FABRIKAM} ${reduced}`, `${mentored} ${improved}`, rest)));
  validateCoverLetterClaims(payload, moved);
  assert.equal(moved.coverLetter.split(FABRIKAM).length, 2, moved.coverLetter);
  assert.ok(paragraphsOf(moved.coverLetter).some((paragraph) => paragraph.startsWith(`${FABRIKAM} ${mentored}`)), moved.coverLetter);
  assert.deepEqual(coverLetterRemovals(moved), []);

  const provider = wire(payload);
  const noFabrikam = { ...provider, claimsUsed: provider.claimsUsed.filter((_, index) => index !== 4 && index !== 5) };
  const removed = finalizeCoverLetter(payload, assembled(payload, letterOf(`${directed} ${reduced} ${FABRIKAM}`, rest), noFabrikam));
  validateCoverLetterClaims(payload, removed);
  assert.ok(!removed.coverLetter.includes(FABRIKAM), removed.coverLetter);
  assert.deepEqual(coverLetterRemovals(removed), [{ text: FABRIKAM, reason: "misplaced_lead_line" }]);

  // Also when grouping by employer is what takes it out.
  const regrouped = finalizeCoverLetter(payload, assembled(payload,
    letterOf(`${directed} ${FABRIKAM} ${SYNTHETIC_CORRECTION_FLOW_FACT}`, `${reduced} ${built}`), noFabrikam));
  validateCoverLetterClaims(payload, regrouped);
  assert.deepEqual(paragraphsOf(regrouped.coverLetter).slice(3, 5), [`${CONTOSO} ${directed} ${reduced} ${built}`, SYNTHETIC_CORRECTION_FLOW_FACT]);
  assert.deepEqual(coverLetterRemovals(regrouped), [{ text: FABRIKAM, reason: "misplaced_lead_line" }]);
});

test("a lead line whose title has an abbreviation stands on its own line so it reads as one sentence", () => {
  const payload = base();
  records(payload)[1]!.title = "Sr. Service Delivery Manager";
  const line = "From 2017 to 2021, I was Sr. Service Delivery Manager at Fabrikam Customer Platforms.";
  const final = finalizeCoverLetter(payload, assembleCoverLetterProviderOutput(payload, wire(payload)));
  validateCoverLetterClaims(payload, final);
  assert.ok(paragraphsOf(final.coverLetter).includes(`${line}\n${mentored} ${improved}`), final.coverLetter);
});

test("the cover-letter prompt shows the lead lines the server adds", () => {
  const prompt = buildCoverLetterSystemPrompt(base());
  assert.ok(prompt.includes(JSON.stringify([CONTOSO, FABRIKAM])), prompt);
});
