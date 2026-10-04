import assert from "node:assert/strict";
import test from "node:test";

import * as resumeModule from "@/lib/ai/resume";
import { buildResumeProviderSourceInput } from "@/lib/ai/resume-source-catalog";
import * as promptModule from "@/prompts/resumeParsePrompt";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";

const source = `Jordan Example

SUMMARY
Builds exact source systems.

WORK EXPERIENCE
Systems Analyst | Example Labs
2022 - Present
• Built reliable workflows.`;

const providerOutput = {
  contractVersion: "7",
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
  summary: "Builds exact source systems.",
  skills: [],
  workHistory: [{
    recordId: "section-3-record-1",
    company: "Example Labs",
    title: "Systems Analyst",
    location: null,
    startDate: "2022",
    endDate: "Present",
    bullets: ["• Built reliable workflows."]
  }],
  projects: [],
  education: [],
  certifications: [],
  achievements: [],
  sectionStatus: {
    summary: "present",
    skills: "absent",
    workHistory: "present",
    projects: "absent",
    education: "absent",
    certifications: "absent",
    achievements: "absent"
  },
  warnings: []
};

test("defines a v7 provider contract with finite record references and isolated revisions", () => {
  const candidate = resumeModule as typeof resumeModule & {
    resumeParseProviderV7Schema?: { safeParse(value: unknown): { success: boolean } };
    RESUME_PARSE_PROVIDER_V7_JSON_SCHEMA?: Record<string, unknown>;
    RESUME_PARSE_GEMINI_PROVIDER_V7_JSON_SCHEMA?: Record<string, unknown>;
  };

  assert.equal(candidate.RESUME_PARSE_PROMPT_VERSION, "10");
  assert.equal(candidate.RESUME_PARSE_CACHE_VERSION, "11");
  assert.equal(candidate.RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION, "5");
  assert.equal(candidate.resumeParseProviderV7Schema?.safeParse(providerOutput).success, true);
  assert.ok(candidate.RESUME_PARSE_PROVIDER_V7_JSON_SCHEMA);
  assert.ok(candidate.RESUME_PARSE_GEMINI_PROVIDER_V7_JSON_SCHEMA);

  const schemaText = JSON.stringify(candidate.RESUME_PARSE_PROVIDER_V7_JSON_SCHEMA);
  assert.match(schemaText, /"recordId"/u);
  assert.doesNotMatch(schemaText, /recordSpans|spanIndex|startLineId|endLineId|sourceText/u);
  assert.match(schemaText, /"maxItems"/u);

  const wireText = JSON.stringify(candidate.RESUME_PARSE_GEMINI_PROVIDER_V7_JSON_SCHEMA);
  assert.doesNotMatch(wireText, /"maxItems"/u);
  assert.doesNotMatch(wireText, /recordSpans|spanIndex|startLineId|endLineId|sourceText/u);
});

test("sends source text once inside ordered server-owned records", () => {
  const input = buildResumeProviderSourceInput(source) as {
    sections: Array<{
      sectionId: string;
      section: string;
      heading: string | null;
      records: Array<{
        recordId: string;
        lines: Array<{ lineId: string; text: string }>;
      }>;
    }>;
  };

  assert.equal(Object.hasOwn(input, "resumeText"), false);
  assert.deepEqual(input.sections[2], {
    sectionId: "section-3",
    section: "workHistory",
    heading: "WORK EXPERIENCE",
    records: [{
      recordId: "section-3-record-1",
      lines: [
        { lineId: "section-3-line-1", text: "Systems Analyst | Example Labs" },
        { lineId: "section-3-line-2", text: "2022 - Present" },
        { lineId: "section-3-line-3", text: "• Built reliable workflows." }
      ]
    }]
  });
  assert.equal(JSON.stringify(input).match(/Systems Analyst \| Example Labs/gu)?.length, 1);
});

test("assembles canonical v7 source authority by exact ordered record id", () => {
  const candidate = resumeModule as typeof resumeModule & {
    assembleAndValidateResumeV7?: (rawSource: string, value: unknown) => {
      contractVersion: string;
      sourceSections: unknown;
      workHistory: Array<{ sourceText: string }>;
    };
  };
  assert.ok(candidate.assembleAndValidateResumeV7);
  const result = candidate.assembleAndValidateResumeV7(source, providerOutput);

  assert.equal(result.contractVersion, "7");
  assert.equal(result.workHistory[0]?.sourceText,
    "Systems Analyst | Example Labs\n2022 - Present\n• Built reliable workflows.");

  for (const invalid of [
    { ...providerOutput, workHistory: [] },
    {
      ...providerOutput,
      workHistory: [{ ...providerOutput.workHistory[0], recordId: "section-3-record-999" }]
    },
    {
      ...providerOutput,
      workHistory: [
        providerOutput.workHistory[0],
        { ...providerOutput.workHistory[0], recordId: "section-3-record-1" }
      ]
    }
  ]) {
    assert.throws(
      () => candidate.assembleAndValidateResumeV7!(source, invalid),
      (error) => error !== null && typeof error === "object" && "details" in error &&
        ["RESUME_PARSE_INCOMPLETE", "RESUME_PARSE_STRUCTURE_AMBIGUOUS"]
          .includes(String((error as { details?: Record<string, unknown> }).details?.code))
    );
  }
});

test("accepts the same adjacent labeled dateless work boundary owned by the catalog", () => {
  const labelledSource = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Title: VP",
    "Company: Yahoo!",
    "• Led reliable delivery.",
    "Role: Engineer",
    "Employer: Acme Partners.",
    "• Built safe systems."
  ].join("\n");
  const labelledOutput = {
    ...providerOutput,
    summary: "",
    workHistory: [
      {
        recordId: "section-2-record-1",
        company: "Yahoo!",
        title: "VP",
        location: null,
        startDate: null,
        endDate: null,
        bullets: ["• Led reliable delivery."]
      },
      {
        recordId: "section-2-record-2",
        company: "Acme Partners.",
        title: "Engineer",
        location: null,
        startDate: null,
        endDate: null,
        bullets: ["• Built safe systems."]
      }
    ],
    sectionStatus: {
      ...providerOutput.sectionStatus,
      summary: "absent" as const
    }
  };

  const result = resumeModule.assembleAndValidateResumeV7(labelledSource, labelledOutput);
  assert.deepEqual(result.workHistory.map((record) => record.sourceText), [
    "Title: VP\nCompany: Yahoo!\n• Led reliable delivery.",
    "Role: Engineer\nEmployer: Acme Partners.\n• Built safe systems."
  ]);
});

test("keeps legacy v6 cached output readable while isolating v7 cache writes", () => {
  const canonical = fullSizeSyntheticProviderOutput();
  const legacyV6 = { ...canonical, contractVersion: "6" as const };
  const decoded = resumeModule.decodeStoredParsedResume(
    fullSizeSyntheticDocxExtractedText,
    legacyV6
  );

  assert.equal(decoded.contractVersion, "6");
  assert.deepEqual(decoded.education, canonical.education);
  assert.equal(resumeModule.RESUME_PARSE_CACHE_VERSION, "11");
});

test("provides a v7 prompt that makes record boundaries server-owned", () => {
  const prompt = (promptModule as typeof promptModule & {
    resumeParsePromptV7?: string;
  }).resumeParsePromptV7;
  assert.ok(prompt);
  assert.match(prompt, /contractVersion 7/u);
  assert.match(prompt, /recordId/u);
  assert.match(prompt, /server-owned record blocks/iu);
  assert.doesNotMatch(prompt, /startLineId|endLineId|spanIndex|recordSpans/u);
});

test("builds a request schema whose record ids are finite section-specific enums", () => {
  const candidate = resumeModule as typeof resumeModule & {
    buildResumeParseProviderV7JsonSchema?: (
      input: ReturnType<typeof buildResumeProviderSourceInput>
    ) => Record<string, unknown>;
  };
  assert.ok(candidate.buildResumeParseProviderV7JsonSchema);
  const input = buildResumeProviderSourceInput(fullSizeSyntheticDocxExtractedText);
  const schema = candidate.buildResumeParseProviderV7JsonSchema(input) as {
    properties: Record<string, { items: { properties: { recordId: { enum: string[] } } } }>;
  };

  assert.deepEqual(schema.properties.workHistory.items.properties.recordId.enum, [
    "section-4-record-1",
    "section-4-record-2",
    "section-4-record-3",
    "section-4-record-4",
    "section-4-record-5"
  ]);
  assert.deepEqual(schema.properties.projects.items.properties.recordId.enum, [
    "section-5-record-1",
    "section-5-record-2"
  ]);
  assert.deepEqual(schema.properties.education.items.properties.recordId.enum, [
    "section-6-record-1",
    "section-6-record-2"
  ]);
  assert.deepEqual(schema.properties.certifications.items.properties.recordId.enum, [
    "section-7-record-1"
  ]);
  assert.doesNotMatch(JSON.stringify(schema), /recordSpans|spanIndex|startLineId|endLineId/u);
});

test("classifies v7 record-reference failures without source or provider output", () => {
  const invalid = structuredClone(providerOutput);
  invalid.workHistory[0]!.recordId = "section-3-record-999";
  let caught: unknown;
  try {
    resumeModule.assembleAndValidateResumeV7(source, invalid);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);

  const diagnostic = resumeModule.classifyResumeValidationFailure(
    source,
    invalid,
    caught,
    "synthetic-fingerprint-key"
  );
  assert.deepEqual(diagnostic, {
    validationStage: "lossless_source_authority",
    internalErrorCode: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
    section: "workHistory",
    mismatchComponent: "recordId",
    expected: null,
    actual: null,
    fingerprintAlgorithm: null
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /Jordan Example|Systems Analyst|record-999/u);
});
