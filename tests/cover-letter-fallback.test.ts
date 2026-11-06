import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput
} from "@/evaluation/correction-flow-provider-stub";
import { validateCoverLetterClaims } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, type CoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { coverLetterRemovals, finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { PublicApiError } from "@/lib/api-errors";

// Live case 2026-11-06: the first cover letter ever generated live was rejected whole, and paid
// for, because one sentence had no supporting fact (APPLICATION_DOCUMENT_EVIDENCE_REQUIRED on
// coverLetter). The letter now gets the treatment the résumé got the same day: a sentence that is
// exactly a source fact is bound to it, a sentence nothing supports or whose wording fails the
// truth check is removed and reported, an owner fact that would go missing goes back in verbatim,
// and the unchanged truth and structure checks still decide.

const payload = syntheticCorrectionFlowDocumentPayload();
const wire = () => structuredClone(syntheticCoverLetterOutput(payload)) as CoverLetterProviderOutput;
const assemble = (value: CoverLetterProviderOutput) => assembleCoverLetterProviderOutput(payload, value);
const accept = (value: CoverLetterProviderOutput) => {
  const final = finalizeCoverLetter(payload, assemble(value));
  validateCoverLetterClaims(payload, final);
  return final;
};
const filler = "I am excited to bring this experience to your team.";

test("a clean letter passes through unchanged with nothing removed", () => {
  const assembled = assemble(wire());
  const final = finalizeCoverLetter(payload, assembled);
  assert.equal(final.coverLetter, assembled.coverLetter);
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("a sentence nothing supports is removed instead of rejecting the paid letter", () => {
  const original = wire();
  const padded = { ...original, coverLetter: original.coverLetter.replace("Thank you for your time and consideration.", `${filler}\n\nThank you for your time and consideration.`) };
  assert.throws(
    () => validateCoverLetterClaims(payload, assemble(padded)),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
  );
  const final = accept(padded);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.deepEqual(coverLetterRemovals(final), [{ text: filler, reason: "no_source_cited" }]);
});

test("a filler sentence inside an evidence paragraph is removed and the paragraph keeps its facts", () => {
  const original = wire();
  const sentence = original.claimsUsed[1]!.claim;
  const padded = { ...original, coverLetter: original.coverLetter.replace(sentence, `${sentence} ${filler}`) };
  const final = accept(padded);
  assert.equal(final.coverLetter, original.coverLetter);
});

test("a fact sentence Gemini left out of claimsUsed is bound to its fact and kept", () => {
  const original = wire();
  const dropped = original.claimsUsed[6]!.claim;
  const unlisted = { ...original, claimsUsed: original.claimsUsed.filter((entry) => entry.claim !== dropped) };
  const final = accept(unlisted);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.ok(final.claimsUsed.some((entry) => entry.claim === dropped));
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("a claim whose wording fails the truth check is removed with its sentence", () => {
  const original = wire();
  const sentence = original.claimsUsed[2]!.claim;
  const altered = sentence.replace("two", "one");
  assert.notEqual(altered, sentence);
  const changed = {
    ...original,
    coverLetter: original.coverLetter.replace(sentence, altered),
    claimsUsed: original.claimsUsed.map((entry) => entry.claim === sentence ? { ...entry, claim: altered } : entry)
  };
  const final = accept(changed);
  assert.ok(!final.coverLetter.includes(altered));
  assert.ok(!final.claimsUsed.some((entry) => entry.claim === altered));
  assert.deepEqual(coverLetterRemovals(final).map((entry) => entry.text), [altered]);
});

test("a claim that is not in the letter is dropped instead of rejecting the letter", () => {
  const original = wire();
  const extra = { ...original, claimsUsed: [...original.claimsUsed, { claim: "I reduced costs by 40%.", factId: original.claimsUsed[2]!.factId }] };
  const final = accept(extra);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.equal(final.claimsUsed.length, original.claimsUsed.length);
});

test("a reworded owner fact is replaced by the owner's exact wording", () => {
  const original = wire();
  const reworded = "I am certified by Quenby in enterprise service operations.";
  const changed = {
    ...original,
    coverLetter: original.coverLetter.replace(SYNTHETIC_CORRECTION_FLOW_FACT, reworded),
    claimsUsed: original.claimsUsed.filter((entry) => entry.claim !== SYNTHETIC_CORRECTION_FLOW_FACT)
  };
  const final = accept(changed);
  assert.ok(!final.coverLetter.includes(reworded));
  assert.ok(final.coverLetter.includes(SYNTHETIC_CORRECTION_FLOW_FACT));
  assert.deepEqual(coverLetterRemovals(final).map((entry) => entry.text), [reworded]);
});

test("removing what fails never launders a letter that is left too thin", () => {
  const original = wire();
  const thin = {
    ...original,
    coverLetter: original.coverLetter.split("\n\n").map((paragraph, index, all) =>
      index > 1 && index < all.length - 2 ? paragraph.split(/(?<=\.)\s+/u).map(() => filler).join(" ") : paragraph).join("\n\n"),
    claimsUsed: []
  };
  assert.throws(() => finalizeCoverLetter(payload, assemble(thin)), PublicApiError);
});

test("finalizing is idempotent, so validated-cache replays remove nothing", () => {
  const original = wire();
  const padded = { ...original, coverLetter: original.coverLetter.replace("Thank you for your time and consideration.", `${filler}\n\nThank you for your time and consideration.`) };
  const final = accept(padded);
  const replay = finalizeCoverLetter(payload, structuredClone(final));
  assert.equal(replay.coverLetter, final.coverLetter);
  assert.deepEqual(coverLetterRemovals(replay), []);
});

// Live case 2026-11-06: an owner fact written as two clauses ("At A, …; at B, …") is two catalog
// facts, so a letter sentence holding both can never cite exactly one fact. It becomes one
// sentence per clause in the owner's words, each bound to its own clause; each clause reads in
// the first person ("At <Org>, I …"), the only word the claim grammar lets it add.
test("an owner fact written as two clauses becomes two sentences, each citing its clause", () => {
  const twoClauses = "At Quenby Labs, owned onboarding through go-live; at Fabrikam, managed renewals end to end.";
  const base = syntheticCorrectionFlowDocumentPayload();
  const local = structuredClone(base);
  const reviewed = (local.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  reviewed.push({ ...reviewed[0]!, gapId: "gap:extra", fact: twoClauses });
  const original = syntheticCoverLetterOutput(base);
  const letter = original.coverLetter.replace(SYNTHETIC_CORRECTION_FLOW_FACT, `${SYNTHETIC_CORRECTION_FLOW_FACT} ${twoClauses}`);
  const final = finalizeCoverLetter(local, assembleCoverLetterProviderOutput(local, { ...original, coverLetter: letter }));
  validateCoverLetterClaims(local, final);
  assert.ok(final.coverLetter.includes("At Quenby Labs, I owned onboarding through go-live. At Fabrikam, I managed renewals end to end."), final.coverLetter);
  assert.ok(!final.coverLetter.includes(twoClauses));
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("an owner fact written as two clauses that the letter left out goes back in as two sentences", () => {
  const twoClauses = "At Quenby Labs, owned onboarding through go-live; at Fabrikam, managed renewals end to end.";
  const base = syntheticCorrectionFlowDocumentPayload();
  const local = structuredClone(base);
  const reviewed = (local.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  reviewed.push({ ...reviewed[0]!, gapId: "gap:extra", fact: twoClauses });
  const final = finalizeCoverLetter(local, assembleCoverLetterProviderOutput(local, syntheticCoverLetterOutput(base)));
  validateCoverLetterClaims(local, final);
  assert.ok(final.coverLetter.includes("At Quenby Labs, I owned onboarding through go-live. At Fabrikam, I managed renewals end to end."), final.coverLetter);
});

// Live case 2026-11-06 (second attempt): after the repair the letter was rejected with "Do not
// repeat an applicant fact to fill the letter" (claimsUsed[11]). Whether Gemini repeated a fact
// or the repair bound a second sentence to a fact already used, the first use stays and a later
// repeat is removed and reported; the same goes for a second job-requirement lead-in.
test("a fact repeated later in the letter keeps its first use and loses the repeat", () => {
  const original = wire();
  const sentence = original.claimsUsed[3]!.claim;
  const repeated = { ...original, coverLetter: original.coverLetter.replace("Thank you for your time and consideration.", `${sentence}\n\nThank you for your time and consideration.`) };
  const final = accept(repeated);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.deepEqual(coverLetterRemovals(final), [{ text: sentence, reason: "repeated_fact" }]);
});

test("a second sentence bound to a fact the letter already used is removed", () => {
  const original = wire();
  const sentence = original.claimsUsed[3]!.claim;
  // The same fact written without "I": the repair binds it to the fact the letter already used.
  const bare = sentence.replace(/^I (\p{L})/u, (_match, first: string) => first.toLocaleUpperCase());
  assert.notEqual(bare, sentence);
  const repeated = { ...original, coverLetter: original.coverLetter.replace(sentence, `${sentence} ${bare}`) };
  const final = accept(repeated);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.deepEqual(coverLetterRemovals(final).map((entry) => entry.reason), ["repeated_fact"]);
});

test("the same fact listed twice in claimsUsed is listed once", () => {
  const original = wire();
  const doubled = { ...original, claimsUsed: [...original.claimsUsed, original.claimsUsed[2]!] };
  const final = accept(doubled);
  assert.equal(final.coverLetter, original.coverLetter);
  assert.equal(final.claimsUsed.length, original.claimsUsed.length);
});

test("only the first job-requirement lead-in is kept", () => {
  const original = wire();
  const first = "The role calls for current Quenby certification in enterprise service operations.";
  const second = "Your posting highlights eight or more years of progressive service operations experience.";
  const intro = "I am applying for the Service Operations Director position at Northwind Service Cloud.";
  const withLeadIns = { ...original, coverLetter: original.coverLetter.replace(intro, `${intro} ${first}`).replace("Thank you for your time and consideration.", `${second}\n\nThank you for your time and consideration.`) };
  const final = accept(withLeadIns);
  assert.ok(final.coverLetter.includes(first));
  assert.ok(!final.coverLetter.includes(second));
  assert.deepEqual(coverLetterRemovals(final), [{ text: second, reason: "repeated_lead_in" }]);
});
