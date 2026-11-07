import assert from "node:assert/strict";
import test from "node:test";

import { syntheticCorrectionFlowDocumentPayload, syntheticCoverLetterOutput } from "@/evaluation/correction-flow-provider-stub";
import { validateCoverLetterClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { coverLetterRemovals, finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { firstPersonCoverSentence, pastPassiveCoverSentence } from "@/lib/ai/cover-letter-first-person";
import { PublicApiError } from "@/lib/api-errors";

// Owner decisions 2026-11-06 (D033): the cover-letter grammar may add a past-tense was or were
// before a passive participle; am, is and are need a present-tense source; and an added I stands
// only where the verb rule puts it. Synthetic data only.

const PLAYBOOKS = "Escalation playbooks adopted by 60+ coordinators.";
const RECOGNIZED = "Recognized for clear executive communications during a multi-team service recovery.";
const PROMOTED = "Promoted to Service Delivery Manager in 2019.";
const MANAGED = "Managed onboarding and support programs for enterprise customers across three product teams.";

type Records = { workHistory: Array<{ bullets: string[] }>; achievements: string[] };

function tensePayload() {
  const payload = structuredClone(syntheticCorrectionFlowDocumentPayload());
  const resume = payload.resume as unknown as Records;
  resume.achievements[1] = RECOGNIZED;
  resume.workHistory[0]!.bullets.push(PLAYBOOKS);
  resume.workHistory[1]!.bullets.push(PLAYBOOKS);
  const reviewed = (payload.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  reviewed.push({ ...reviewed[0]!, gapId: "gap:promotion", fact: PROMOTED });
  return payload;
}

const PROMOTED_REF = "reviewedEvidence.facts[1].fact";

function passes(payload: ApplicationDocumentPayload, claim: string, ref: string, excerpt: string) {
  try {
    validateCoverLetterClaims(payload, {
      coverLetter: `Dear Northwind Service Cloud Hiring Team,\n\n${claim}\n\nSincerely,\nTaylor Boundary`,
      claimsUsed: [{ claim, citations: [{ ref, excerpt }] }]
    });
    return true;
  } catch (error) {
    if (error instanceof PublicApiError) return false;
    throw error;
  }
}

test("a past-tense was or were may introduce a passive participle", () => {
  const payload = tensePayload();
  assert.equal(passes(payload, "I was recognized for clear executive communications during a multi-team service recovery.", "resume.achievements[1]", RECOGNIZED), true);
  assert.equal(passes(payload, "I was promoted to Service Delivery Manager in 2019.", PROMOTED_REF, PROMOTED), true);
  assert.equal(passes(payload, "Escalation playbooks were adopted by 60+ coordinators.", "resume.workHistory[1]", PLAYBOOKS), true);
});

test("was or were never turns an action, or a title, into something else", () => {
  const payload = tensePayload();
  assert.equal(passes(payload, `I was ${MANAGED[0]!.toLowerCase()}${MANAGED.slice(1)}`, "resume.workHistory[1]", MANAGED), false);
  assert.equal(passes(payload, "I were recognized for clear executive communications during a multi-team service recovery.", "resume.achievements[1]", RECOGNIZED), false);
  assert.equal(passes(payload, "I was a Service Delivery Manager.", "resume.workHistory[1]", "Service Delivery Manager"), false);
});

test("an added I stands only before the fact's own verb", () => {
  const payload = tensePayload();
  assert.equal(passes(payload, "I managed onboarding and support programs for enterprise customers across three product teams.", "resume.workHistory[1]", MANAGED), true);
  assert.equal(passes(payload, "I promoted to Service Delivery Manager in 2019.", PROMOTED_REF, PROMOTED), false);
  assert.equal(passes(payload, "I recognized for clear executive communications during a multi-team service recovery.", "resume.achievements[1]", RECOGNIZED), false);
  assert.equal(passes(payload, "Managed onboarding and I support programs for enterprise customers across three product teams.", "resume.workHistory[1]", MANAGED), false);
});

test("am, is and are need a present-tense source: the summary or a current role", () => {
  const payload = tensePayload();
  assert.equal(passes(payload, "I am a Senior Service Operations Manager.", "resume.workHistory[0]", "Senior Service Operations Manager"), true);
  assert.equal(passes(payload, "I am a Service Delivery Manager.", "resume.workHistory[1]", "Service Delivery Manager"), false);
  const summary = payload.resume!.summary as string;
  assert.equal(passes(payload, `I am a ${summary[0]!.toLowerCase()}${summary.slice(1)}`, "resume.summary", summary), true);
  assert.equal(passes(payload, "Escalation playbooks are adopted by 60+ coordinators.", "resume.workHistory[0]", PLAYBOOKS), true);
  assert.equal(passes(payload, "Escalation playbooks are adopted by 60+ coordinators.", "resume.workHistory[1]", PLAYBOOKS), false);
});

test("a passive fragment reads with was or I was, never with a bare I", () => {
  assert.equal(firstPersonCoverSentence(RECOGNIZED), `I was ${RECOGNIZED[0]!.toLowerCase()}${RECOGNIZED.slice(1)}`);
  assert.equal(firstPersonCoverSentence("In 2019, promoted to Service Delivery Manager."), "In 2019, I was promoted to Service Delivery Manager.");
  assert.equal(firstPersonCoverSentence("At Quenby Labs, selected as regional lead."), "At Quenby Labs, I was selected as regional lead.");
  assert.equal(firstPersonCoverSentence("Selected vendors for the renewal program."), null);
  assert.equal(firstPersonCoverSentence("At Quenby Labs, trained in incident command."), null);
  assert.equal(pastPassiveCoverSentence(PLAYBOOKS), "Escalation playbooks were adopted by 60+ coordinators.");
  assert.equal(pastPassiveCoverSentence("Quenby Sales playbook adopted by 40+ agents: renewals up 12% in one quarter."),
    "Quenby Sales playbook was adopted by 40+ agents: renewals up 12% in one quarter.");
  assert.equal(pastPassiveCoverSentence(MANAGED), null);
  assert.equal(pastPassiveCoverSentence("At Quenby Labs, owned by the platform group."), null);
});

// The synthetic letter, built from the given payload, with extra sentences (each cited by the
// listed fact, or left uncited for the repair to bind) after its last evidence sentence.
function letterWith(payload: ApplicationDocumentPayload, extra: Array<{ sentence: string; excerpt?: string }>) {
  const wire = syntheticCoverLetterOutput(payload);
  const facts = buildApplicationDocumentFactCatalog(payload);
  const sentences = extra.map(({ sentence }) => sentence).join(" ");
  return assembleCoverLetterProviderOutput(payload, {
    ...wire,
    coverLetter: wire.coverLetter.replace("\n\nThank you for your time", ` ${sentences}\n\nThank you for your time`),
    claimsUsed: [...wire.claimsUsed, ...extra.flatMap(({ sentence, excerpt }) => {
      const fact = excerpt ? facts.find((value) => value.excerpt === excerpt) : undefined;
      return fact ? [{ claim: sentence, factId: fact.factId }] : [];
    })]
  });
}

test("the repair writes a passive fact with was or were instead of forcing I before it", () => {
  const payload = tensePayload();
  (payload.resume as unknown as Records).workHistory[0]!.bullets.pop();
  const final = finalizeCoverLetter(payload, letterWith(payload, [
    { sentence: RECOGNIZED },
    { sentence: PLAYBOOKS }
  ]));
  validateCoverLetterClaims(payload, final);
  assert.match(final.coverLetter, /I was recognized for clear executive communications during a multi-team service recovery\./u);
  assert.match(final.coverLetter, /Escalation playbooks were adopted by 60\+ coordinators\./u);
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("a claim the tighter grammar rejects is rewritten from its own fact when it can be, else removed and reported", () => {
  const payload = tensePayload();
  const final = finalizeCoverLetter(payload, letterWith(payload, [
    { sentence: "I recognized for clear executive communications during a multi-team service recovery.", excerpt: RECOGNIZED },
    { sentence: "I am a Service Delivery Manager.", excerpt: "Service Delivery Manager" }
  ]));
  validateCoverLetterClaims(payload, final);
  assert.match(final.coverLetter, /I was recognized for clear executive communications/u);
  assert.doesNotMatch(final.coverLetter, /I recognized for|I am a Service Delivery Manager/u);
  assert.deepEqual(coverLetterRemovals(final), [{ text: "I am a Service Delivery Manager.", reason: "tense_or_subject" }]);
});
