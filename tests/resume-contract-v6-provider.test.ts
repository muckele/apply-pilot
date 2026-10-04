import assert from "node:assert/strict";
import test from "node:test";

import * as resumeModule from "@/lib/ai/resume";
import * as catalogModule from "@/lib/ai/resume-source-catalog";
import * as promptModule from "@/prompts/resumeParsePrompt";

const source = `Jordan Example

SUMMARY
Builds exact source systems.

SKILLS
Delivery: planning, communication

WORK EXPERIENCE
Systems Analyst
Example Labs
2022 - Present
• Built reliable workflows.`;

const providerOutput = {
  contractVersion: "6",
  recordSpans: [{
    sectionId: "section-4",
    startLineId: "section-4-line-1",
    endLineId: "section-4-line-4"
  }],
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
  skills: ["planning", "communication"],
  workHistory: [{
    spanIndex: 0,
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
    skills: "present",
    workHistory: "present",
    projects: "absent",
    education: "absent",
    certifications: "absent",
    achievements: "absent"
  },
  warnings: []
};

test("retains the legacy v6 span-only provider decoder after live revision isolation", () => {
  const candidate = resumeModule as typeof resumeModule & {
    resumeParseProviderV6Schema?: { safeParse(value: unknown): { success: boolean } };
    RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA?: Record<string, unknown>;
    RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA?: Record<string, unknown>;
    RESUME_PARSE_PROMPT_VERSION?: string;
    RESUME_PARSE_CACHE_VERSION?: string;
    RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION?: string;
  };

  assert.equal(candidate.RESUME_PARSE_PROMPT_VERSION, "11");
  assert.equal(candidate.RESUME_PARSE_CACHE_VERSION, "12");
  assert.equal(candidate.RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION, "6");
  assert.equal(candidate.resumeParseProviderV6Schema?.safeParse(providerOutput).success, true);
  assert.ok(candidate.RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA);
  assert.ok(candidate.RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA);

  const schemaText = JSON.stringify(candidate.RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA);
  assert.match(schemaText, /"recordSpans"/u);
  assert.match(schemaText, /"spanIndex"/u);
  assert.doesNotMatch(schemaText, /"sourceSections"|"sourceText"/u);
  assert.match(schemaText, /"maxItems"/u);

  const wireText = JSON.stringify(candidate.RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA);
  assert.doesNotMatch(wireText, /"maxItems"/u);
  assert.doesNotMatch(wireText, /"sourceSections"|"sourceText"/u);
});

test("rejects model-copied source and malformed span projections", () => {
  const schema = (resumeModule as typeof resumeModule & {
    resumeParseProviderV6Schema?: { safeParse(value: unknown): { success: boolean } };
  }).resumeParseProviderV6Schema;
  assert.ok(schema);

  assert.equal(schema.safeParse({ ...providerOutput, sourceSections: [] }).success, false);
  assert.equal(schema.safeParse({
    ...providerOutput,
    workHistory: [{ ...providerOutput.workHistory[0], sourceText: "must not be copied" }]
  }).success, false);
  assert.equal(schema.safeParse({
    ...providerOutput,
    recordSpans: [{ ...providerOutput.recordSpans[0], startLineId: "" }]
  }).success, false);
  assert.equal(schema.safeParse({
    ...providerOutput,
    workHistory: [{ ...providerOutput.workHistory[0], spanIndex: -1 }]
  }).success, false);
});

test("builds one annotated provider source representation without a raw-text duplicate", () => {
  const buildInput = (catalogModule as typeof catalogModule & {
    buildResumeProviderSourceInput?: (rawSource: string) => unknown;
  }).buildResumeProviderSourceInput;
  assert.ok(buildInput);

  const input = buildInput(source) as {
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
  assert.equal(Object.hasOwn(input, "rawText"), false);
  assert.deepEqual(input.sections[3], {
    sectionId: "section-4",
    section: "workHistory",
    heading: "WORK EXPERIENCE",
    records: [{
      recordId: "section-4-record-1",
      lines: [
        { lineId: "section-4-line-1", text: "Systems Analyst" },
        { lineId: "section-4-line-2", text: "Example Labs" },
        { lineId: "section-4-line-3", text: "2022 - Present" },
        { lineId: "section-4-line-4", text: "• Built reliable workflows." }
      ]
    }]
  });
});

test("provides a v6 prompt that assigns text authority to the server", () => {
  const prompt = (promptModule as typeof promptModule & {
    resumeParsePromptV6?: string;
  }).resumeParsePromptV6;
  assert.ok(prompt);
  assert.match(prompt, /contractVersion 6/u);
  assert.match(prompt, /sectionId/u);
  assert.match(prompt, /startLineId/u);
  assert.match(prompt, /endLineId/u);
  assert.match(prompt, /spanIndex/u);
  assert.match(prompt, /server.*source|source.*server/iu);
  assert.doesNotMatch(prompt, /copy.*complete section body/iu);
});
