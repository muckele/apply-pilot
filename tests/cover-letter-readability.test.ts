import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput
} from "@/evaluation/correction-flow-provider-stub";
import { validateCoverLetterClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, type CoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { coverLetterRemovals, finalizeCoverLetter, validateCoverLetterQuality } from "@/lib/ai/application-document-quality";
import { firstPersonCoverSentence } from "@/lib/ai/cover-letter-first-person";
import { PublicApiError } from "@/lib/api-errors";

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
  // Passive verbs with their preposition read "I was …" instead (tests/cover-letter-tense.test.ts).
  for (const sentence of [
    "Promoted Service Delivery Manager in 2019.",
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

test("a passive owner fact reads with I was, never with a bare I (D033)", () => {
  const fact = "In 2019, promoted to Service Delivery Manager.";
  const payload = withOwnerFacts(fact);
  const final = finalize(payload, letterWith(fact));
  assert.ok(final.coverLetter.includes("In 2019, I was promoted to Service Delivery Manager."), final.coverLetter);
  assert.ok(!/I promoted/u.test(final.coverLetter));
});

// Owner's live test 2026-11-06: paragraphs mixed employers, so a résumé bullet read as if it
// belonged to whichever employer the sentence before it named. The finalizer now groups the
// evidence by the source record each sentence cites: one paragraph per employer in résumé order,
// then the rest. Every sentence keeps its exact words and its citation; only the order changes,
// and Gemini's order stands whenever the grouped letter would fail any check.

const base = () => syntheticCorrectionFlowDocumentPayload();
const wire = () => syntheticCoverLetterOutput(base());
const claim = (index: number) => wire().claimsUsed[index]!.claim;
const paragraphsOf = (letter: string) => letter.split(/\n\s*\n/u).map((paragraph) => paragraph.trim());
const sentencesOf = (letter: string) => [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(letter.replace(/\s+/gu, " "))]
  .map(({ segment }) => segment.trim()).filter(Boolean).sort();
// Synthetic letter claims: 0 summary, 1-3 Contoso, 4-5 Fabrikam, 6 a project, 7 the owner's fact.
const [summary, directed, reduced, built, improved, mentored, dashboard] = [0, 1, 2, 3, 4, 5, 6].map(claim);
const intro = "I am applying for the Service Operations Director position at Northwind Service Cloud.";
// D033: the finalizer opens a paragraph whose evidence all cites one work record with its lead line.
const CONTOSO = "Since 2021, I have been Senior Service Operations Manager at Contoso Service Systems.";
const FABRIKAM = "From 2017 to 2021, I was Service Delivery Manager at Fabrikam Customer Platforms.";
const letterOf = (...body: string[]) => [
  "Taylor Boundary",
  "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
  "",
  "Dear Northwind Service Cloud Hiring Team,",
  "",
  ...body.flatMap((paragraph) => [paragraph, ""]),
  "Thank you for your time and consideration.",
  "",
  "Sincerely,",
  "Taylor Boundary"
].join("\n");

test("evidence is grouped one paragraph per employer in résumé order, then the rest", () => {
  const original = wire();
  const final = finalize(base(), original);
  assert.deepEqual(paragraphsOf(final.coverLetter).slice(2, -2), [
    `${intro}\n${summary}`,
    `${CONTOSO} ${directed} ${reduced} ${built}`,
    `${FABRIKAM} ${mentored} ${improved}`,
    `${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`
  ]);
  assert.deepEqual(sentencesOf(final.coverLetter), sentencesOf(`${CONTOSO} ${FABRIKAM} ${original.coverLetter}`));
  assert.deepEqual(final.claimsUsed.map((entry) => entry.claim).sort(), original.claimsUsed.map((entry) => entry.claim).sort());
  assert.deepEqual(coverLetterRemovals(final), []);
});

test("a letter already grouped by employer is left exactly as written", () => {
  const original = { ...wire(), coverLetter: letterOf(`${intro} ${summary}`, `${CONTOSO} ${directed} ${reduced} ${built}`, `${FABRIKAM} ${mentored} ${improved}`, `${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`) };
  assert.equal(finalize(base(), original).coverLetter, original.coverLetter);
});

test("finalizing a grouped letter again changes nothing", () => {
  const final = finalize(base(), wire());
  const replay = finalizeCoverLetter(base(), structuredClone(final));
  assert.equal(replay.coverLetter, final.coverLetter);
  assert.deepEqual(coverLetterRemovals(replay), []);
});

test("a sentence that names its employer opens that employer's paragraph", () => {
  const fact = "At Fabrikam Customer Platforms, owned renewals for 30 enterprise accounts.";
  const final = finalize(withOwnerFacts(fact), letterWith(fact));
  assert.ok(paragraphsOf(final.coverLetter).includes(
    `At Fabrikam Customer Platforms, I owned renewals for 30 enterprise accounts. ${mentored} ${improved}`
  ), final.coverLetter);
});

test("an owner fact that starts with an employer's name joins that employer's paragraph", () => {
  const fact = "Contoso Service Systems playbooks adopted by 40+ agents.";
  const final = finalize(withOwnerFacts(fact), letterWith(fact));
  const contoso = paragraphsOf(final.coverLetter).find((paragraph) => paragraph.includes(directed))!;
  assert.ok(contoso.includes("Contoso Service Systems playbooks were adopted by 40+ agents."), final.coverLetter);
  assert.ok(contoso.includes(reduced) && contoso.includes(built));
});

test("an employer fact in the opening paragraph joins its employer; the opening keeps the introduction", () => {
  const original = { ...wire(), coverLetter: letterOf(`${intro} ${directed} ${summary}`, `${reduced} ${mentored}`, `${built} ${improved} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`) };
  const paragraphs = paragraphsOf(finalize(base(), original).coverLetter).slice(2, -2);
  assert.deepEqual(paragraphs, [
    `${intro} ${summary}`,
    `${CONTOSO} ${directed} ${reduced} ${built}`,
    `${FABRIKAM} ${mentored} ${improved}`,
    `${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`
  ]);
});

test("a job-requirement lead-in moves with the sentence after it", () => {
  const leadIn = "The role calls for experience coaching service operations professionals.";
  const original = { ...wire(), coverLetter: letterOf(`${intro} ${summary}`, `${directed} ${reduced} ${leadIn} ${mentored}`, `${built} ${improved} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`) };
  const paragraphs = paragraphsOf(finalize(base(), original).coverLetter);
  assert.ok(paragraphs.includes(`${FABRIKAM} ${leadIn} ${mentored} ${improved}`), paragraphs.join("\n\n"));
});

test("Gemini's order stands when the grouped letter would fail a check", () => {
  // Four action facts, at most one per employer: grouped, no two paragraphs would hold two action
  // sentences each, which the writing check requires; Gemini's own paragraphs do.
  const evidenceConsole = "I built an evidence-review console that linked incident decisions to source records and accountable owners.";
  const original = {
    ...wire(),
    coverLetter: letterOf(`${intro} ${summary}`, `${directed} ${improved}`, `${evidenceConsole} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`)
  };
  const final = finalize(base(), original);
  assert.equal(final.coverLetter, original.coverLetter);
  const grouped = { ...final, coverLetter: letterOf(`${intro} ${summary}`, directed, improved, `${evidenceConsole} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`) };
  assert.throws(
    () => validateCoverLetterQuality(base(), validateCoverLetterClaims(base(), grouped)),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_QUALITY_REQUIRED"
  );
});

// Offline replay 2026-11-06: a claim with no closing period (a clause-level fact, cited as is)
// was last in Gemini's paragraph; grouped into the middle of its employer's paragraph it ran into
// the next sentence, so the grouped letter failed and Gemini's order was kept. Such a sentence now
// closes its paragraph.
test("a sentence with no closing period ends its employer's paragraph so grouping still applies", () => {
  const unterminated = directed.replace(/\.$/u, "");
  const original = wire();
  const changed = {
    ...original,
    coverLetter: letterOf(`${intro} ${summary}`, `${reduced} ${mentored} ${unterminated}`, `${built} ${improved} ${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`),
    claimsUsed: original.claimsUsed.map((entry) => entry.claim === directed ? { ...entry, claim: unterminated } : entry)
  };
  const paragraphs = paragraphsOf(finalize(base(), changed).coverLetter).slice(2, -2);
  assert.deepEqual(paragraphs, [
    `${intro} ${summary}`,
    `${CONTOSO} ${reduced} ${built} ${unterminated}`,
    `${FABRIKAM} ${mentored} ${improved}`,
    `${dashboard} ${SYNTHETIC_CORRECTION_FLOW_FACT}`
  ]);
});

// A one-word employer name can also be an ordinary word ("Target accounts grew …"). A sentence
// only joins that employer's paragraph when it says "At <Org>," or continues the name as a proper
// noun ("<Org> Escalation Desk playbooks …"), so placement never implies where a fact happened.
test("a sentence that merely starts with a one-word employer name stays out of that employer's paragraph", () => {
  const generic = "Fabrikam accounts renewed at 95% for two years.";
  const proper = "Fabrikam Escalation Desk playbooks adopted by 60+ coordinators.";
  const payload = withOwnerFacts(generic, proper);
  ((payload.resume as { workHistory: Array<Record<string, unknown>> }).workHistory[1]!).company = "Fabrikam";
  const paragraphs = paragraphsOf(finalize(payload, letterWith(generic, proper)).coverLetter);
  const fabrikam = paragraphs.find((paragraph) => paragraph.includes(mentored))!;
  assert.ok(fabrikam.includes("Fabrikam Escalation Desk playbooks were adopted by 60+ coordinators."), paragraphs.join("\n\n"));
  assert.ok(!fabrikam.includes(generic), paragraphs.join("\n\n"));
});
