import assert from "node:assert/strict";

// Provider outputs are fixed independently of the corpus's human expected-band
// labels so the transport/acceptance path cannot grade a response it generated
// from those labels.
const RECOMMENDATIONS_BY_CASE = Object.freeze({
  "laserfiche-presales-engineer-i": "apply now",
  "sentry-solutions-engineer": "consider",
  "flint-customer-success-engineer": "consider",
  "roku-technical-account-manager-10909": "skip"
} as const);

export function fixedSyntheticProviderRecommendation(caseId: string) {
  assert.ok(Object.prototype.hasOwnProperty.call(RECOMMENDATIONS_BY_CASE, caseId),
    `Unknown synthetic qualification case: ${caseId}`);
  return RECOMMENDATIONS_BY_CASE[caseId as keyof typeof RECOMMENDATIONS_BY_CASE];
}
