import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { assertNewOwnerFactShape, ownerFactShapeProblems } from "@/lib/jobs/owner-fact-cleanup";

const kinds = (text: string) => ownerFactShapeProblems(text).map((problem) => problem.kind);

test("length limit is 200 characters after trimming", () => {
  assert.deepEqual(ownerFactShapeProblems(`${"a".repeat(199)}.`), []);
  assert.deepEqual(ownerFactShapeProblems(`  ${"a".repeat(199)}.  `), []);
  assert.deepEqual(kinds(`${"a".repeat(200)}.`), ["too_long"]);
});

test("more than one sentence is a problem; abbreviations do not split", () => {
  assert.deepEqual(kinds("Led demos for IT buyers. Ran trials."), ["more_than_one_sentence"]);
  assert.deepEqual(ownerFactShapeProblems("Supported U.S. customers on SAML, e.g. Okta."), []);
  assert.deepEqual(ownerFactShapeProblems("Shipped v2.1 of the API at Example Inc. in 2023."), []);
  assert.deepEqual(ownerFactShapeProblems("Worked with Dr. Rivera on St. Louis rollouts."), []);
});

test("assertNewOwnerFactShape throws OWNER_FACT_TOO_LONG with the fixed message", () => {
  assert.throws(
    () => assertNewOwnerFactShape("Led demos. Ran trials."),
    (error) => error instanceof PublicApiError && error.status === 422 && error.message === "Keep each line to one sentence of up to 200 characters."
  );
  assert.doesNotThrow(() => assertNewOwnerFactShape("Led demos for IT buyers."));
});
