import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateResumeParseAnnotatedInputBytes,
  estimateResumeParseMaximumProviderOutputBytes,
  RESUME_PARSE_PLANNED_JSON_BYTES,
  resumeParseProviderV6Schema
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInput } from "@/lib/ai/resume-source-catalog";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV6FromCanonical } from "@/tests/fixtures/resume-v6-provider-data";

test("v6 bounds measure the exact annotated request and cover the accepted provider response", () => {
  const request = buildResumeProviderSourceInput(fullSizeSyntheticDocxExtractedText);
  const response = providerV6FromCanonical(
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
  assert.equal(requestBytes, 9_745);
  assert.equal(resumeParseProviderV6Schema.safeParse(response).success, true);
  assert.ok(estimatedBytes >= responseBytes);
  assert.ok(estimatedBytes <= RESUME_PARSE_PLANNED_JSON_BYTES);
});

test("v6 provider bounds reject structural cardinality and escape amplification before transport", () => {
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

test("v6 rejects unpaired surrogate projections that can exceed source-byte estimates", () => {
  const response = providerV6FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );

  response.summary = "\uD83D";
  assert.equal(resumeParseProviderV6Schema.safeParse(response).success, false);

  response.summary = "😀";
  assert.equal(resumeParseProviderV6Schema.safeParse(response).success, true);
});
