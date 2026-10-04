import assert from "node:assert/strict";
import test from "node:test";

import * as resumeModule from "@/lib/ai/resume";
import {
  buildResumeSourceCatalog,
  type ResumeSourceCatalog,
  type ResumeSourceSectionName
} from "@/lib/ai/resume-source-catalog";
import type {
  ParsedResumeV5,
  ResumeParseProviderV6,
  ResumeParseRecordSpanV6
} from "@/lib/ai/resume";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";

const structuralSections = new Set<ResumeSourceSectionName>([
  "workHistory",
  "projects",
  "education",
  "certifications"
]);

function spanForBlock(
  catalog: ResumeSourceCatalog,
  sectionIndex: number,
  block: string
): ResumeParseRecordSpanV6 {
  const section = catalog.sections[sectionIndex]!;
  const relativeStart = section.sourceText.indexOf(block);
  assert.notEqual(relativeStart, -1);
  const startOffset = section.startOffset + relativeStart;
  const endOffset = startOffset + block.length;
  const startLine = section.lines.find((line) => line.startOffset === startOffset);
  const endLine = section.lines.find((line) => line.endOffset === endOffset);
  assert.ok(startLine);
  assert.ok(endLine);
  return {
    sectionId: section.id,
    startLineId: startLine.id,
    endLineId: endLine.id
  };
}

function providerOutputFromV5(
  rawSource = fullSizeSyntheticDocxExtractedText,
  parsed: ParsedResumeV5 = fullSizeSyntheticProviderOutput()
): ResumeParseProviderV6 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const recordSpans: ResumeParseRecordSpanV6[] = [];
  const spanIndices = new Map<ResumeSourceSectionName, number[]>();

  parsed.sourceSections.forEach((section, sectionIndex) => {
    if (!structuralSections.has(section.section)) return;
    for (const block of section.recordBlocks) {
      const index = recordSpans.length;
      recordSpans.push(spanForBlock(catalog, sectionIndex, block));
      const indices = spanIndices.get(section.section) ?? [];
      indices.push(index);
      spanIndices.set(section.section, indices);
    }
  });

  const indicesFor = (section: ResumeSourceSectionName) => {
    const indices = spanIndices.get(section) ?? [];
    let cursor = 0;
    return () => indices[cursor++]!;
  };
  const workSpan = indicesFor("workHistory");
  const projectSpan = indicesFor("projects");
  const educationSpan = indicesFor("education");
  const certificationSpan = indicesFor("certifications");
  const withoutSourceText = <T extends { sourceText: string }>(record: T) => {
    const projection: Partial<T> = { ...record };
    delete projection.sourceText;
    return projection as Omit<T, "sourceText">;
  };

  return {
    contractVersion: "6",
    recordSpans,
    contactInfo: {
      name: parsed.contactInfo.name,
      headline: parsed.contactInfo.headline,
      email: parsed.contactInfo.email,
      phone: parsed.contactInfo.phone,
      location: parsed.contactInfo.location,
      linkedin: parsed.contactInfo.linkedin,
      github: parsed.contactInfo.github,
      portfolio: parsed.contactInfo.portfolio
    },
    summary: parsed.summary,
    skills: parsed.skills,
    workHistory: parsed.workHistory.map((item) => ({
      spanIndex: workSpan(),
      ...withoutSourceText(item)
    })),
    projects: parsed.projects.map((item) => ({
      spanIndex: projectSpan(),
      ...withoutSourceText(item)
    })),
    education: parsed.education.map((item) => ({
      spanIndex: educationSpan(),
      ...withoutSourceText(item)
    })),
    certifications: parsed.certifications.map((item) => ({
      spanIndex: certificationSpan(),
      ...withoutSourceText(item)
    })),
    achievements: parsed.achievements,
    sectionStatus: parsed.sectionStatus,
    warnings: parsed.warnings
  };
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
