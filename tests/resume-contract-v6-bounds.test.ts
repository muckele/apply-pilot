import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleAndValidateResumeV7,
  estimateResumeParseAnnotatedInputBytes,
  estimateResumeParseMaximumProviderOutputBytes,
  RESUME_PARSE_PLANNED_JSON_BYTES,
  resumeParseProviderV7Schema
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInput } from "@/lib/ai/resume-source-catalog";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV7FromCanonical } from "@/tests/fixtures/resume-v7-provider-data";

test("v7 bounds measure the exact server-record request and cover the accepted provider response", () => {
  const request = buildResumeProviderSourceInput(fullSizeSyntheticDocxExtractedText);
  const response = providerV7FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );
  response.warnings = Array.from({ length: 5 }, () => "x".repeat(100));

  const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  const estimatedBytes = estimateResumeParseMaximumProviderOutputBytes(
    fullSizeSyntheticDocxExtractedText
  );

  assert.equal(estimateResumeParseAnnotatedInputBytes(fullSizeSyntheticDocxExtractedText), requestBytes);
  assert.equal(requestBytes, 10_312);
  assert.equal(resumeParseProviderV7Schema.safeParse(response).success, true);
  assert.ok(estimatedBytes >= responseBytes);
  assert.ok(estimatedBytes <= RESUME_PARSE_PLANNED_JSON_BYTES);
});

test("v7 provider bounds reject structural cardinality and escape amplification before transport", () => {
  const tooManyProjects = `Jordan Example\n\nPROJECTS\n${Array.from(
    { length: 51 },
    (_, index) => `Project ${index + 1} | Synthetic subtitle | 2025`
  ).join("\n\n")}`;
  const escapeHeavySource = `Jordan Example\n\nPROJECTS\n${[1, 2, 3].map(
    (index) => `P${index} | D${index} | 202${index}\n${"\\".repeat(2_000)}`
  ).join("\n\n")}`;

  assert.ok(
    estimateResumeParseMaximumProviderOutputBytes(tooManyProjects) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumProviderOutputBytes(escapeHeavySource) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
});

test("v7 provider bounds use exact dateless record cardinality for the response envelope", () => {
  const records = Array.from({ length: 50 }, (_, index) => ({
    title: `Role ${index + 1}`,
    company: `Org ${index + 1}`,
    bullets: Array.from({ length: 25 }, () => "• Result éééx.")
  }));
  const source = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    ...records.flatMap((record) => [record.title, record.company, ...record.bullets])
  ].join("\n");
  const response = {
    contractVersion: "7" as const,
    contactInfo: {
      name: "Jordan Example",
      headline: null,
      email: null,
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: records.map((record, index) => ({
      recordId: `section-2-record-${index + 1}`,
      company: record.company,
      title: record.title,
      location: null,
      startDate: null,
      endDate: null,
      bullets: record.bullets
    })),
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent" as const,
      skills: "absent" as const,
      workHistory: "present" as const,
      projects: "absent" as const,
      education: "absent" as const,
      certifications: "absent" as const,
      achievements: "absent" as const
    },
    warnings: Array.from({ length: 5 }, () => "x".repeat(100))
  };
  const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  const estimatedBytes = estimateResumeParseMaximumProviderOutputBytes(source);

  assert.equal(resumeParseProviderV7Schema.safeParse(response).success, true);
  assert.doesNotThrow(() => assembleAndValidateResumeV7(source, response));
  assert.ok(responseBytes > RESUME_PARSE_PLANNED_JSON_BYTES);
  assert.ok(estimatedBytes >= responseBytes);
});

test("v7 rejects unpaired surrogate projections that can exceed source-byte estimates", () => {
  const response = providerV7FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );

  response.summary = "\uD83D";
  assert.equal(resumeParseProviderV7Schema.safeParse(response).success, false);

  response.summary = "😀";
  assert.equal(resumeParseProviderV7Schema.safeParse(response).success, true);
});
