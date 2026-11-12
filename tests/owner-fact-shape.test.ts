import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { assertNewOwnerFactShape, ownerFactShapeProblems } from "@/lib/jobs/owner-fact-cleanup";

// Owner decision 2026-11-11: a line has one limit, 200 characters. There is no sentence limit.
const kinds = (text: string) => ownerFactShapeProblems(text).map((problem) => problem.kind);
const TWO_SENTENCES =
  "Ran weekly product demos for synthetic IT buyers in three sales regions. Wrote the trial checklist our support team used for each new account rollout.";
const tooLong = (error: unknown) =>
  error instanceof PublicApiError &&
  error.status === 422 &&
  error.message === "Keep each line to 200 characters or fewer." &&
  error.details?.code === "OWNER_FACT_TOO_LONG";

test("length limit is 200 characters after trimming", () => {
  assert.deepEqual(ownerFactShapeProblems(`${"a".repeat(199)}.`), []);
  assert.deepEqual(ownerFactShapeProblems(`  ${"a".repeat(199)}.  `), []);
  assert.deepEqual(kinds(`${"a".repeat(200)}.`), ["too_long"]);
});

test("a two-sentence 150-character line has no problem", () => {
  assert.equal(TWO_SENTENCES.length, 150);
  assert.deepEqual(ownerFactShapeProblems(TWO_SENTENCES), []);
});

test("abbreviations such as U.S. and e.g. are fine", () => {
  assert.deepEqual(ownerFactShapeProblems("Supported U.S. customers on SAML, e.g. Okta and Entra. Ran the pilot."), []);
  assert.deepEqual(ownerFactShapeProblems("Shipped v2.1 of the API at Example Inc. in 2023."), []);
  assert.deepEqual(ownerFactShapeProblems("Worked with Dr. Rivera on St. Louis rollouts."), []);
});

test("assertNewOwnerFactShape refuses 201 characters with a characters-only message", () => {
  const line = `${"a".repeat(200)}.`;
  assert.equal(line.length, 201);
  assert.throws(() => assertNewOwnerFactShape(line), tooLong);
  assert.doesNotThrow(() => assertNewOwnerFactShape(`${"a".repeat(199)}.`));
  assert.doesNotThrow(() => assertNewOwnerFactShape(TWO_SENTENCES));
  assert.doesNotThrow(() => assertNewOwnerFactShape("Supported U.S. customers on SAML, e.g. Okta."));
});
