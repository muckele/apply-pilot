import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput
} from "@/evaluation/correction-flow-provider-stub";
import { validateCoverLetterClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, type CoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { coverLetterRemovals, finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { firstPersonCoverSentence } from "@/lib/ai/cover-letter-first-person";

// Owner's live test 2026-11-06: the first cover letter that passed every check was truthful but
// read like résumé lines pasted into paragraphs. These tests cover the deterministic polish that
// stays inside the unchanged claim grammar (synthetic data only).

const withOwnerFacts = (...facts: string[]) => {
  const local = structuredClone(syntheticCorrectionFlowDocumentPayload());
  const reviewed = (local.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  facts.forEach((fact, index) => reviewed.push({ ...reviewed[0]!, gapId: `gap:extra-${index}`, fact }));
  return local;
};

const finalize = (payload: ApplicationDocumentPayload, wire: CoverLetterProviderOutput) => {
  const final = finalizeCoverLetter(payload, assembleCoverLetterProviderOutput(payload, wire));
  validateCoverLetterClaims(payload, final);
  return final;
};

// The synthetic letter with extra sentences placed right after the owner's certification fact.
const letterWith = (...sentences: string[]) => {
  const original = syntheticCoverLetterOutput(syntheticCorrectionFlowDocumentPayload());
  return {
    ...original,
    coverLetter: original.coverLetter.replace(SYNTHETIC_CORRECTION_FLOW_FACT, [SYNTHETIC_CORRECTION_FLOW_FACT, ...sentences].join(" "))
  };
};

test("an 'At <Org>,' fragment gains only an I before its verb", () => {
  assert.equal(
    firstPersonCoverSentence("At Quenby Labs, owned onboarding through go-live."),
    "At Quenby Labs, I owned onboarding through go-live."
  );
  assert.equal(
    firstPersonCoverSentence("At Quenby Labs, after closing a client, owned onboarding through go-live."),
    "At Quenby Labs, after closing a client, I owned onboarding through go-live."
  );
  assert.equal(
    firstPersonCoverSentence("For 42 enterprise accounts, directed service delivery."),
    "For 42 enterprise accounts, I directed service delivery."
  );
});

test("a fragment led by a common résumé verb outside the narrow action list reads in the first person", () => {
  assert.equal(firstPersonCoverSentence("Owned renewals for 30 enterprise accounts."), "I owned renewals for 30 enterprise accounts.");
  assert.equal(firstPersonCoverSentence("Ran quarterly business reviews with regional leaders."), "I ran quarterly business reviews with regional leaders.");
});

test("no I is added where it could change who did what or is already there", () => {
  for (const sentence of [
    "In 2019, promoted to Service Delivery Manager.",
    "Promoted to Service Delivery Manager in 2019.",
    "At Quenby Labs, selected as regional lead.",
    "At Quenby Labs, trained in incident command.",
    "At Quenby Labs, owned by the platform group.",
    "Quenby Service playbooks adopted by 40+ agents: renewals up 12% in one quarter.",
    "At Quenby Labs, the team doubled renewals.",
    "We built an escalation playbook.",
    "I owned onboarding through go-live.",
    "At Quenby Labs, I owned onboarding through go-live."
  ]) {
    assert.equal(firstPersonCoverSentence(sentence), null, sentence);
  }
});

test("a repaired letter renders an owner fact's 'At <Org>,' fragment with I and cites it", () => {
  const fact = "At Quenby Labs, after closing a client, owned onboarding through go-live.";
  const payload = withOwnerFacts(fact);
  const final = finalize(payload, letterWith(fact));
  const rendered = "At Quenby Labs, after closing a client, I owned onboarding through go-live.";
  assert.ok(final.coverLetter.includes(rendered), final.coverLetter);
  assert.ok(!final.coverLetter.includes(fact));
  assert.ok(final.claimsUsed.some((entry) => entry.claim === rendered &&
    entry.citations.some((citation) => citation.ref.startsWith("reviewedEvidence."))));
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("an owner fact the letter left out goes back in with the same first-person wording", () => {
  const fact = "At Quenby Labs, owned onboarding through go-live.";
  const payload = withOwnerFacts(fact);
  const final = finalize(payload, syntheticCoverLetterOutput(syntheticCorrectionFlowDocumentPayload()));
  assert.ok(final.coverLetter.includes("At Quenby Labs, I owned onboarding through go-live."), final.coverLetter);
});

test("a passive owner fact is kept in the owner's words", () => {
  const fact = "In 2019, promoted to Service Delivery Manager.";
  const payload = withOwnerFacts(fact);
  const final = finalize(payload, letterWith(fact));
  assert.ok(final.coverLetter.includes(fact), final.coverLetter);
  assert.ok(!/I promoted/u.test(final.coverLetter));
});
