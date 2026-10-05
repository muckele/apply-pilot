import assert from "node:assert/strict";
import test from "node:test";

import * as resumeModule from "@/lib/ai/resume";
import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import * as promptModule from "@/prompts/resumeParsePrompt";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV8FromCanonical } from "@/tests/fixtures/resume-v8-provider-data";

type ProviderV8 = ReturnType<typeof providerV8FromCanonical>;

function providerV8Fixture(): ProviderV8 {
  return providerV8FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );
}

type V8Candidate = typeof resumeModule & {
  assembleAndValidateResumeV8?: (rawSource: string, value: unknown) => {
    contractVersion: string;
    sourceSections: Array<{
      section: string;
      sourceText: string;
      recordBlocks: string[];
    }>;
    summary: string;
    skills: string[];
    achievements: string[];
    sectionStatus: Record<string, "present" | "absent">;
  };
  resumeParseProviderV8Schema?: {
    safeParse(value: unknown): { success: boolean };
  };
  RESUME_PARSE_PROVIDER_V8_JSON_SCHEMA?: Record<string, unknown>;
  RESUME_PARSE_GEMINI_PROVIDER_V8_JSON_SCHEMA?: Record<string, unknown>;
};

test("v8 provider owns only semantic projections and uses isolated revisions", () => {
  const candidate = resumeModule as V8Candidate;
  const output = providerV8Fixture();

  assert.equal(resumeModule.RESUME_PARSE_PROMPT_VERSION, "11");
  assert.equal(resumeModule.RESUME_PARSE_CACHE_VERSION, "12");
  assert.equal(resumeModule.RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION, "6");
  assert.equal(resumeModule.RESUME_PARSE_V8_PROMPT_VERSION, "10");
  assert.equal(resumeModule.RESUME_PARSE_V8_CACHE_VERSION, "11");
  assert.equal(resumeModule.RESUME_PARSE_V8_GEMINI_WIRE_SCHEMA_VERSION, "5");
  assert.equal(candidate.resumeParseProviderV8Schema?.safeParse(output).success, true);

  const schemaText = JSON.stringify(candidate.RESUME_PARSE_PROVIDER_V8_JSON_SCHEMA);
  assert.match(schemaText, /"contractVersion"[^]*"8"/u);
  assert.match(schemaText, /"recordId"/u);
  assert.doesNotMatch(schemaText, /"summary"|"achievements"|"sectionStatus"/u);
  assert.ok(candidate.RESUME_PARSE_GEMINI_PROVIDER_V8_JSON_SCHEMA);
});

test("v8 derives the complete summary, exact ordered achievements, and statuses from source authority", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);

  const result = candidate.assembleAndValidateResumeV8(
    fullSizeSyntheticDocxExtractedText,
    providerV8Fixture()
  );
  const canonical = fullSizeSyntheticProviderOutput();

  assert.equal(result.contractVersion, "8");
  assert.equal(result.summary, canonical.summary);
  assert.deepEqual(result.achievements, [
    "Operational Excellence: Received a synthetic 2025 service-quality award for measurable delivery improvements.",
    "Community Impact: Recognized for clear incident education and respectful cross-team coordination."
  ]);
  assert.deepEqual(result.sectionStatus, canonical.sectionStatus);
});

test("v8 rejects provider attempts to truncate summary, empty achievements, or spoof section status", () => {
  const candidate = resumeModule as V8Candidate;
  const output = providerV8Fixture() as ProviderV8 & Record<string, unknown>;

  for (const injected of [
    { summary: "Operations and delivery leader" },
    { achievements: [] },
    { sectionStatus: { achievements: "absent" } }
  ]) {
    assert.equal(
      candidate.resumeParseProviderV8Schema?.safeParse({ ...output, ...injected }).success,
      false
    );
  }
});

test("v8 derives absent summary and achievements without provider-owned status", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const source = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Systems Analyst | Example Labs",
    "2022 - Present",
    "• Built reliable workflows."
  ].join("\n");
  const output = {
    contractVersion: "8",
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
    skills: [],
    workHistory: [{
      recordId: "section-2-record-1",
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
    warnings: []
  };

  const result = candidate.assembleAndValidateResumeV8(source, output);
  assert.equal(result.summary, "");
  assert.deepEqual(result.achievements, []);
  assert.equal(result.sectionStatus.summary, "absent");
  assert.equal(result.sectionStatus.achievements, "absent");
  assert.equal(result.sectionStatus.workHistory, "present");
});

test("v8 keeps skills as an ordered source-backed subset with complete raw fallback", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const output = providerV8Fixture();
  output.skills = ["SQL", "TypeScript", "stakeholder communication"];

  const parsed = candidate.assembleAndValidateResumeV8(
    fullSizeSyntheticDocxExtractedText,
    output
  );
  assert.deepEqual(parsed.skills, output.skills);
  assert.deepEqual(
    parsed.sourceSections.find((section) => section.section === "skills")?.recordBlocks,
    fullSizeSyntheticProviderOutput().sourceSections
      .find((section) => section.section === "skills")?.recordBlocks
  );

  const plan = buildApplicationPlanPayload({
    job: {
      title: "Synthetic role",
      company: "Synthetic employer",
      description: "Uses SQL and TypeScript for reliable operations."
    },
    resume: { ...parsed, rawText: fullSizeSyntheticDocxExtractedText }
  });
  assert.ok(plan.evidenceCatalog.some((entry) => entry.id === "raw-source-1"));
});

test("v8 schema rejects missing semantic projections and unknown properties", () => {
  const candidate = resumeModule as V8Candidate;
  const output = providerV8Fixture();
  const missingSkills = { ...output } as Partial<ProviderV8>;
  delete missingSkills.skills;

  assert.equal(candidate.resumeParseProviderV8Schema?.safeParse(missingSkills).success, false);
  assert.equal(candidate.resumeParseProviderV8Schema?.safeParse({
    ...output,
    unknownProjection: "not allowed"
  }).success, false);
});

test("v8 prompt states the server-owned and semantic-projection split", () => {
  const prompt = (promptModule as typeof promptModule & {
    resumeParsePromptV8?: string;
  }).resumeParsePromptV8;
  assert.ok(prompt);
  assert.match(prompt, /contractVersion 8/u);
  assert.match(prompt, /server derives the complete summary/iu);
  assert.match(prompt, /server derives.*achievements/iu);
  assert.match(prompt, /server derives.*section status/iu);
  assert.match(prompt, /skills.*semantic.*subset/iu);
});

test("central cache decoding preserves v8 and legacy v7, v6, v5, and v3 canonical reads", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const canonical = fullSizeSyntheticProviderOutput();
  const current = candidate.assembleAndValidateResumeV8(
    fullSizeSyntheticDocxExtractedText,
    providerV8Fixture()
  );
  const legacyV3Source = [
    "Jordan Example",
    "",
    "SUMMARY",
    "Builds reliable source systems.",
    "",
    "SKILLS",
    "SQL"
  ].join("\n");
  const legacyV3 = {
    contractVersion: "3" as const,
    contactInfo: {
      sourceText: "Jordan Example",
      name: "Jordan Example",
      headline: null,
      email: null,
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "Builds reliable source systems.",
    skills: ["SQL"],
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "present" as const,
      skills: "present" as const,
      workHistory: "absent" as const,
      projects: "absent" as const,
      education: "absent" as const,
      certifications: "absent" as const,
      achievements: "absent" as const
    },
    warnings: []
  };

  const versions = [
    resumeModule.decodeStoredParsedResume(fullSizeSyntheticDocxExtractedText, current),
    resumeModule.decodeStoredParsedResume(fullSizeSyntheticDocxExtractedText, {
      ...canonical,
      contractVersion: "7"
    }),
    resumeModule.decodeStoredParsedResume(fullSizeSyntheticDocxExtractedText, {
      ...canonical,
      contractVersion: "6"
    }),
    resumeModule.decodeStoredParsedResume(fullSizeSyntheticDocxExtractedText, canonical)
  ];

  assert.deepEqual(versions.map((resume) => resume.contractVersion), ["8", "7", "6", "5"]);
  versions.forEach((resume) => {
    assert.equal(resume.summary, canonical.summary);
    assert.deepEqual(resume.achievements, canonical.achievements);
  });
  const decodedV3 = resumeModule.decodeStoredParsedResume(legacyV3Source, legacyV3);
  assert.equal(decodedV3.contractVersion, "5");
  assert.equal(decodedV3.summary, legacyV3.summary);
  assert.deepEqual(decodedV3.skills, legacyV3.skills);
});

test("stored v8 reads restore every server-owned field from raw source", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const canonical = candidate.assembleAndValidateResumeV8(
    fullSizeSyntheticDocxExtractedText,
    providerV8Fixture()
  );
  const weakened = {
    ...canonical,
    summary: canonical.summary.slice(0, 32),
    achievements: canonical.achievements.slice(0, 1),
    sectionStatus: { ...canonical.sectionStatus, achievements: "present" as const }
  };

  const decoded = resumeModule.decodeStoredParsedResume(
    fullSizeSyntheticDocxExtractedText,
    weakened
  );
  assert.equal(decoded.contractVersion, "8");
  assert.equal(decoded.summary, canonical.summary);
  assert.deepEqual(decoded.achievements, canonical.achievements);
  assert.deepEqual(decoded.sectionStatus, canonical.sectionStatus);
  assert.deepEqual(decoded.sourceSections, canonical.sourceSections);
});

test("server-owned summary and achievement entries may exceed semantic field bounds", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const longSummary = `Summary ${"s".repeat(2_010)}`;
  const longAchievement = `Impact: ${"a".repeat(2_010)}.`;
  const source = [
    "Jordan Example",
    "",
    "SUMMARY",
    longSummary,
    "",
    "ACHIEVEMENTS",
    longAchievement
  ].join("\n");
  const provider = {
    contractVersion: "8",
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
    skills: [],
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    warnings: []
  };

  const parsed = candidate.assembleAndValidateResumeV8(source, provider);
  assert.equal(parsed.summary, longSummary);
  assert.deepEqual(parsed.achievements, [longAchievement]);
});

test("server-owned achievement records preserve source indentation", () => {
  const candidate = resumeModule as V8Candidate;
  assert.ok(candidate.assembleAndValidateResumeV8);
  const source = [
    "Jordan Example",
    "",
    "ACHIEVEMENTS",
    "Impact: First exact entry.",
    "  • Second exact entry."
  ].join("\n");
  const provider = {
    contractVersion: "8",
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
    skills: [],
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    warnings: []
  };

  const parsed = candidate.assembleAndValidateResumeV8(source, provider);
  assert.deepEqual(parsed.achievements, [
    "Impact: First exact entry.",
    "  • Second exact entry."
  ]);
  assert.deepEqual(
    parsed.sourceSections.find((section) => section.section === "achievements")?.recordBlocks,
    parsed.achievements
  );
});

test("v8 preflight rejects aggregate server-owned fields that exceed final bounds", () => {
  const longSummary = "s".repeat(10_001);
  const summarySource = [
    "Jordan Example",
    "",
    "SUMMARY",
    longSummary,
    "",
    "SUMMARY",
    longSummary
  ].join("\n");
  const achievementsSource = [
    "Jordan Example",
    "",
    "ACHIEVEMENTS",
    ...Array.from({ length: 51 }, (_, index) => `Achievement A${index + 1}.`),
    "",
    "ACHIEVEMENTS",
    ...Array.from({ length: 50 }, (_, index) => `Achievement B${index + 1}.`)
  ].join("\n");

  for (const source of [summarySource, achievementsSource]) {
    assert.throws(
      () => resumeModule.prepareResumeParseV8Request(source, "gemini"),
      (error: unknown) => {
        const details = typeof error === "object" && error !== null && "details" in error
          ? (error as { details?: { code?: string } }).details
          : undefined;
        return details?.code === "RESUME_PARSE_SOURCE_TOO_LARGE_FOR_LOSSLESS_OUTPUT";
      }
    );
  }
});

test("stored legacy versions rebuild exact indented source authority", () => {
  const source = [
    "Jordan Example",
    "",
    "SKILLS",
    "Technical",
    "  SQL",
    "",
    "ACHIEVEMENTS",
    "Impact: First source entry.",
    "  • Preserved exact source evidence."
  ].join("\n");
  const sourceSections = [
    { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
    {
      section: "skills",
      heading: "SKILLS",
      sourceText: "Technical\n  SQL",
      recordBlocks: ["Technical", "SQL"]
    },
    {
      section: "achievements",
      heading: "ACHIEVEMENTS",
      sourceText: "Impact: First source entry.\n  • Preserved exact source evidence.",
      recordBlocks: ["Impact: First source entry.", "• Preserved exact source evidence."]
    }
  ];
  const canonical = {
    contactInfo: {
      sourceText: "Jordan Example",
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
    skills: ["SQL"],
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    achievements: ["• Preserved exact source evidence."],
    sectionStatus: {
      summary: "absent" as const,
      skills: "present" as const,
      workHistory: "absent" as const,
      projects: "absent" as const,
      education: "absent" as const,
      certifications: "absent" as const,
      achievements: "present" as const
    },
    warnings: []
  };

  for (const version of ["5", "6", "7"] as const) {
    const decoded = resumeModule.decodeStoredParsedResume(source, {
      ...canonical,
      contractVersion: version,
      sourceSections
    });
    assert.deepEqual(
      decoded.sourceSections.find((section) => section.section === "skills")?.recordBlocks,
      ["Technical", "  SQL"]
    );
    assert.deepEqual(
      decoded.sourceSections.find((section) => section.section === "achievements")?.recordBlocks,
      ["Impact: First source entry.", "  • Preserved exact source evidence."]
    );
  }

  const decodedV3 = resumeModule.decodeStoredParsedResume(source, {
    ...canonical,
    contractVersion: "3"
  });
  assert.deepEqual(
    decodedV3.sourceSections.find((section) => section.section === "skills")?.recordBlocks,
    ["Technical", "  SQL"]
  );
  assert.deepEqual(
    decodedV3.sourceSections.find((section) => section.section === "achievements")?.recordBlocks,
    ["Impact: First source entry.", "  • Preserved exact source evidence."]
  );
});
