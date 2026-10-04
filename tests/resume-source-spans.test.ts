import assert from "node:assert/strict";
import test from "node:test";

import * as resumeModule from "@/lib/ai/resume";
import type {
  ParsedResumeV5,
  ResumeParseProviderV6
} from "@/lib/ai/resume";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV6FromCanonical } from "@/tests/fixtures/resume-v6-provider-data";

function providerOutputFromV5(
  rawSource = fullSizeSyntheticDocxExtractedText,
  parsed: ParsedResumeV5 = fullSizeSyntheticProviderOutput()
) {
  return providerV6FromCanonical(rawSource, parsed);
}

function assembler() {
  const candidate = resumeModule as typeof resumeModule & {
    assembleAndValidateResumeV6?: (rawSource: string, value: unknown) => {
      contractVersion: string;
      sourceSections: ParsedResumeV5["sourceSections"];
      contactInfo: ParsedResumeV5["contactInfo"];
      workHistory: ParsedResumeV5["workHistory"];
      projects: ParsedResumeV5["projects"];
      education: ParsedResumeV5["education"];
      certifications: ParsedResumeV5["certifications"];
    };
  };
  assert.ok(candidate.assembleAndValidateResumeV6);
  return candidate.assembleAndValidateResumeV6;
}

function expectInvalid(
  mutate: (output: ResumeParseProviderV6) => void,
  expectedCode: string
) {
  const output = providerOutputFromV5();
  mutate(output);
  assert.throws(
    () => assembler()(fullSizeSyntheticDocxExtractedText, output),
    (error) => error !== null &&
      typeof error === "object" &&
      "details" in error &&
      String((error as { details?: Record<string, unknown> }).details?.code) === expectedCode
  );
}

test("assembles exact v6 source authority from provider spans", () => {
  const parsedV5 = fullSizeSyntheticProviderOutput();
  const result = assembler()(fullSizeSyntheticDocxExtractedText, providerOutputFromV5());

  assert.equal(result.contractVersion, "6");
  assert.deepEqual(result.sourceSections, parsedV5.sourceSections);
  assert.equal(result.contactInfo.sourceText, parsedV5.contactInfo.sourceText);
  assert.deepEqual(result.workHistory, parsedV5.workHistory);
  assert.deepEqual(result.projects, parsedV5.projects);
  assert.deepEqual(result.education, parsedV5.education);
  assert.deepEqual(result.certifications, parsedV5.certifications);
});

test("rejects unknown, reversed, and cross-section span identities", () => {
  expectInvalid(
    (output) => { output.recordSpans[0]!.startLineId = "section-4-line-999"; },
    "RESUME_PARSE_STRUCTURE_AMBIGUOUS"
  );
  expectInvalid((output) => {
    const span = output.recordSpans[0]!;
    [span.startLineId, span.endLineId] = [span.endLineId, span.startLineId];
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  expectInvalid((output) => {
    output.recordSpans[0]!.endLineId = output.recordSpans[2]!.endLineId;
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
});

test("rejects overlapping, duplicate, and reordered spans", () => {
  expectInvalid((output) => {
    output.recordSpans[1]!.startLineId = output.recordSpans[0]!.endLineId;
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  expectInvalid((output) => {
    output.recordSpans[1] = { ...output.recordSpans[0]! };
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  expectInvalid((output) => {
    [output.recordSpans[0], output.recordSpans[1]] = [
      output.recordSpans[1]!,
      output.recordSpans[0]!
    ];
    output.workHistory[0]!.spanIndex = 1;
    output.workHistory[1]!.spanIndex = 0;
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
});

test("rejects uncovered source lines and duplicate span cardinality", () => {
  expectInvalid((output) => {
    output.recordSpans[1]!.startLineId = "section-4-line-11";
  }, "RESUME_PARSE_INCOMPLETE");
  expectInvalid((output) => {
    output.workHistory[1]!.spanIndex = output.workHistory[0]!.spanIndex;
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
});

test("rejects adjacent-record merges and invented typed facts after slicing", () => {
  expectInvalid((output) => {
    output.recordSpans[0]!.endLineId = output.recordSpans[1]!.endLineId;
    output.recordSpans.splice(1, 1);
    output.workHistory.splice(1, 1);
    for (const record of [
      ...output.projects,
      ...output.education,
      ...output.certifications
    ]) record.spanIndex -= 1;
  }, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  expectInvalid((output) => {
    output.education[1]!.fieldOfStudy = "Invented Private Subject";
  }, "RESUME_PARSE_UNSUPPORTED_FACT");
});
