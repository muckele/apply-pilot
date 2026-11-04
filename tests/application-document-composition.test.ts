import assert from "node:assert/strict";
import test from "node:test";
import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import { PublicApiError } from "@/lib/api-errors";
import {
  assembleCoverLetterProviderOutput,
  buildApplicationDocumentFactCatalog
} from "@/lib/ai/application-document-facts";
import {
  validateCoverLetterClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";

const payload = syntheticCorrectionFlowDocumentPayload();
const delivery = "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.";
const incident = "Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.";
const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
const coaching = "Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.";
const attributed = "At Contoso Service Systems, I directed service delivery across support, engineering, and customer success for 42 enterprise accounts.";

function outputFor(source: ApplicationDocumentPayload, text: string, entries: Array<{ claim: string; excerpt: string }>) {
  const catalog = buildApplicationDocumentFactCatalog(source);
  return assembleCoverLetterProviderOutput(source, {
    title: "Synthetic composition regression",
    angle: "Preserve one complete fact per claim",
    coverLetter: text,
    claimsUsed: entries.map(({ claim, excerpt }) => {
      const fact = catalog.find(value => value.excerpt === excerpt);
      assert.ok(fact, `Missing declared synthetic source: ${excerpt}`);
      return { claim, factId: fact.factId };
    })
  });
}

const relationFailure = (error: unknown) => error instanceof PublicApiError &&
  error.status === 422 && error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
  error.details?.failureClass === "source_relation_mismatch";

test("correct employer metadata does not authorize composing a prefix onto a standalone bullet", () => {
  for (const [source, bullet, company, claim] of [
    [{ resume: { workHistory: [{ company: "Contoso", bullets: ["Managed 42 accounts."] }] } }, "Managed 42 accounts.", "Contoso", "At Contoso, I managed 42 accounts."],
    [payload, delivery, "Contoso Service Systems", attributed]
  ] as const) {
    assert.doesNotThrow(() => validateCoverLetterClaims(source,
      outputFor(source, "I " + bullet[0].toLowerCase() + bullet.slice(1), [{ claim: "I " + bullet[0].toLowerCase() + bullet.slice(1), excerpt: bullet }])));
    const one = outputFor(source, claim, [{ claim, excerpt: bullet }]);
    assert.throws(() => validateCoverLetterClaims(source, one), relationFailure);
    const repeated = outputFor(source, claim, [{ claim, excerpt: company }, { claim, excerpt: bullet }]);
    assert.throws(() => validateCoverLetterClaims(source, repeated), relationFailure);
    const merged = { ...repeated, claimsUsed: [{ claim, citations: repeated.claimsUsed.flatMap(entry => entry.citations) }] };
    assert.throws(() => validateCoverLetterClaims(source, merged), relationFailure);
  }
});

test("an attributed sentence is accepted when its complete wording is genuinely one source fact", () => {
  const source = { resume: { summary: attributed } };
  const output = outputFor(source, attributed, [{ claim: attributed, excerpt: attributed }]);
  assert.doesNotThrow(() => validateCoverLetterClaims(source, output));
});

test("two complete sentences in one paragraph retain independent atomic fact mappings", () => {
  const text = delivery + " " + incident;
  const separate = outputFor(payload, text, [{ claim: delivery, excerpt: delivery }, { claim: incident, excerpt: incident }]);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, separate));
  const whole = outputFor(payload, text, [{ claim: text, excerpt: delivery }, { claim: text, excerpt: incident }]);
  const merged = { ...whole, claimsUsed: [{ claim: text, citations: whole.claimsUsed.flatMap(entry => entry.citations) }] };
  assert.throws(() => validateCoverLetterClaims(payload, merged), relationFailure);
});

test("repeating or merging fact IDs cannot validate a synthesized whole claim", () => {
  const claim = "My experience offers two concrete examples of that combination: improving incident reviews across a large account portfolio and strengthening the reporting and coaching behind service operations.";
  const repeated = outputFor(payload, claim, [delivery, incident, reporting, coaching].map(excerpt => ({ claim, excerpt })));
  assert.equal(repeated.claimsUsed.length, 4);
  assert.throws(() => validateCoverLetterClaims(payload, repeated), relationFailure);
  const merged = { ...repeated, claimsUsed: [{ claim, citations: repeated.claimsUsed.flatMap(entry => entry.citations) }] };
  assert.throws(() => validateCoverLetterClaims(payload, merged), relationFailure);
});

test("new generic connective prose remains covered while the published exact connective is exempt", () => {
  const allowed = "My experience most relevant to this role includes the following.";
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, outputFor(payload, allowed, [])));
  assert.throws(() => validateCoverLetterClaims(payload, outputFor(payload, "Two examples are especially relevant.", [])),
    error => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" && error.details?.fieldPath === "coverLetter");
});

test("C2 source outcomes keep every numeric and time qualifier through the real fact-ID assembler", () => {
  for (const [source, changed] of [
    [delivery, delivery.replace("42", "420")],
    [incident, incident.replace("median ", "")],
    [incident, incident.replace("business ", "")],
    [incident, incident.replace("five business days to two", "two business days to five")],
    [reporting, reporting.replace("18%", "38%")]
  ]) {
    assert.throws(() => validateCoverLetterClaims(payload, outputFor(payload, changed, [{ claim: changed, excerpt: source }])), relationFailure);
  }
});

test("joint citations cannot transfer employer ownership or manufacture a causal relationship", () => {
  for (const [claim, sources] of [
    ["At Fabrikam Customer Platforms, I directed service delivery across support, engineering, and customer success for 42 enterprise accounts.", ["Fabrikam Customer Platforms", delivery]],
    ["I improved monthly service-level reporting accuracy by 18% by mentoring six service coordinators.", [reporting, coaching]]
  ] as const) {
    const output = outputFor(payload, claim, sources.map(excerpt => ({ claim, excerpt })));
    const merged = { ...output, claimsUsed: [{ claim, citations: output.claimsUsed.flatMap(entry => entry.citations) }] };
    assert.throws(() => validateCoverLetterClaims(payload, merged), relationFailure);
  }
});

test("a genuine excerpt cannot be reassigned to an adjacent work record", () => {
  const output = outputFor(payload, delivery, [{ claim: delivery, excerpt: delivery }]);
  output.claimsUsed[0].citations[0].ref = "resume.workHistory[1]";
  assert.throws(() => validateCoverLetterClaims(payload, output),
    error => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_EXCERPT");
});
