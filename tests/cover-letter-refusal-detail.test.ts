import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import { syntheticCorrectionFlowDocumentPayload, syntheticCoverLetterOutput } from "@/evaluation/correction-flow-provider-stub";
import { assembleCoverLetterProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { PublicApiError } from "@/lib/api-errors";

// Live case 2026-11-15 (shape only; synthetic data): a cover letter was refused twice with "Cover
// letter evidence is not varied across the available source context." A refused letter is never
// saved, so nothing showed which sources the letter used or what the repair had removed. The
// refusal now says so: per paragraph, whether the check counts it and which source families its
// sentences cite, and each removed sentence with its reason. (Since the same day a letter that
// cites only the owner's lines gains résumé facts instead of being refused as not varied, see
// cover-letter-resume-evidence.test.ts, so this letter is refused for leaving out the company.)

const OWNER_TICKETS = "I answer escalated customer tickets within one business day.";
const OWNER_SUMMARY = "I write the weekly incident summary for the support team.";
const RESUME_FACT = "Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.";
const MISQUOTED = "I reduced median incident review time from five business days to one by standardizing evidence capture and ownership.";

function payloadWithOwnerLines() {
  const payload = structuredClone(syntheticCorrectionFlowDocumentPayload());
  const reviewed = (payload.reviewedEvidence as { facts: Array<Record<string, unknown>> }).facts;
  reviewed.push({ ...reviewed[0]!, gapId: "gap:tickets", fact: OWNER_TICKETS });
  reviewed.push({ ...reviewed[0]!, gapId: "gap:summary", fact: OWNER_SUMMARY });
  return payload;
}

test("a refused cover letter reports the sources each paragraph used and what was removed", () => {
  const payload = payloadWithOwnerLines();
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factId = (excerpt: string) => {
    const fact = facts.find((value) => value.excerpt === excerpt);
    assert.ok(fact, `synthetic fact: ${excerpt}`);
    return fact.factId;
  };
  // Only the owner's lines carry the body; the one résumé sentence misquotes its number.
  const coverLetter = [
    "Taylor Boundary",
    "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
    "",
    "Dear Hiring Team,",
    "",
    "I am applying for the Service Operations Director position.",
    "",
    `${OWNER_TICKETS} ${MISQUOTED}`,
    "",
    `${OWNER_SUMMARY} ${SYNTHETIC_CORRECTION_FLOW_FACT}`,
    "",
    "Thank you for your time and consideration.",
    "",
    "Sincerely,",
    "Taylor Boundary"
  ].join("\n");
  const provider = {
    ...syntheticCoverLetterOutput(payload),
    coverLetter,
    claimsUsed: [
      { claim: OWNER_TICKETS, factId: factId(OWNER_TICKETS) },
      { claim: MISQUOTED, factId: factId(RESUME_FACT) },
      { claim: OWNER_SUMMARY, factId: factId(OWNER_SUMMARY) },
      { claim: SYNTHETIC_CORRECTION_FLOW_FACT, factId: factId(SYNTHETIC_CORRECTION_FLOW_FACT) }
    ]
  };

  let refusal: unknown;
  try {
    finalizeCoverLetter(payload, assembleCoverLetterProviderOutput(payload, provider));
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof PublicApiError, "the letter is refused");
  assert.equal(refusal.message, "Cover letter omitted the target company.");
  assert.equal(refusal.details?.code, "APPLICATION_DOCUMENT_INCOMPLETE");
  assert.equal(refusal.details?.fieldPath, "coverLetter");

  const checked = refusal.details?.checked as {
    paragraphs: Array<{ counted: boolean; sources: string[] }>;
    removed: Array<{ reason: string; sources: string[] }>;
  };
  assert.ok(checked, "the refusal describes the letter it checked");
  // Header and salutation are not counted; the repair's résumé paragraph comes first, then both
  // body paragraphs Gemini wrote, which cite only the owner's lines.
  assert.deepEqual(checked.paragraphs.slice(0, 2).map((paragraph) => paragraph.counted), [false, false]);
  assert.deepEqual(
    checked.paragraphs.filter((paragraph) => paragraph.sources.length),
    [
      { counted: true, sources: ["resume.workHistory"] },
      { counted: true, sources: ["reviewedEvidence.facts"] },
      { counted: true, sources: ["reviewedEvidence.facts"] }
    ]
  );
  // The misquoted résumé sentence was removed by the repair; the refusal says why and what it cited.
  assert.equal(checked.removed.length, 1);
  assert.equal(typeof checked.removed[0]!.reason, "string");
  assert.deepEqual(checked.removed[0]!.sources, ["resume.workHistory"]);
  // An error never echoes generated text.
  assert.doesNotMatch(JSON.stringify(refusal.details), /to one by|escalated customer tickets/u);
});
