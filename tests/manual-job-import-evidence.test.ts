import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import { manualJobImportSchema } from "@/lib/validators";

const baseInput = {
  title: "Solutions Engineer",
  company: "Example Co",
  sourceUrl: "https://example.test/jobs/123",
  description: "Overview\nFour years of client-facing experience\nSQL experience and stakeholder communication.",
  runMatch: false
};

test("manual import preserves explicit zero salary and derives omitted evidence lists", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    salaryMin: 0,
    salaryMax: 0,
    datePosted: "2026-07-08"
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.equal(normalized.salaryMin, 0);
  assert.equal(normalized.salaryMax, 0);
  assert.equal(normalized.datePosted?.toISOString(), "2026-07-08T00:00:00.000Z");
  assert.deepEqual(normalized.requirements, [
    "Four years of client-facing experience",
    "SQL experience and stakeholder communication."
  ]);
  assert.deepEqual(normalized.detectedTechStack, ["SQL"]);
});

test("manual import preserves explicitly supplied requirement and preference evidence", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    requirements: ["Four years of client-facing experience"],
    preferredQualifications: ["Early-stage company experience"],
    detectedTechStack: ["SQL"]
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.deepEqual(normalized.requirements, ["Four years of client-facing experience"]);
  assert.deepEqual(normalized.preferredQualifications, ["Early-stage company experience"]);
  assert.deepEqual(normalized.detectedTechStack, ["SQL"]);
});

test("manual import preserves explicitly empty evidence arrays instead of deriving replacements", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    requirements: [],
    preferredQualifications: [],
    detectedTechStack: []
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.deepEqual(normalized.requirements, []);
  assert.deepEqual(normalized.preferredQualifications, []);
  assert.deepEqual(normalized.detectedTechStack, []);
});

test("manual import rejects a salary range whose minimum exceeds its maximum", () => {
  assert.throws(
    () => manualJobImportSchema.parse({ ...baseInput, salaryMin: 120_000, salaryMax: 90_000 }),
    /salary/i
  );
});

test("manual import keeps empty and whitespace-only salary values unknown", () => {
  for (const blank of ["", "   ", "\t"]) {
    const input = manualJobImportSchema.parse({ ...baseInput, salaryMin: blank, salaryMax: blank });
    const normalized = new ManualJobImportProvider().normalizeJob(input);

    assert.equal(normalized.salaryMin, undefined);
    assert.equal(normalized.salaryMax, undefined);
  }
});
