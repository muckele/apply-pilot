import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  assembleAndValidateResumeV9,
  classifyResumeValidationFailure,
  decodeStoredParsedResume,
  prepareResumeParseV8Request,
  prepareResumeParseV9Request,
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_PROMPT_VERSION,
  RESUME_PARSE_V8_CACHE_VERSION,
  RESUME_PARSE_V8_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_V8_PROMPT_VERSION,
  resumeParseProviderV9Schema,
  validateParsedResumeOutput,
  type ParsedResumeV5,
  type ResumeParseProviderV9
} from "@/lib/ai/resume";
import { buildResumeSourceCatalogV9 } from "@/lib/ai/resume-source-catalog";
import { resumeParsePromptV9 } from "@/prompts/resumeParsePrompt";
import {
  resumeV9StructuralTwinCanonical,
  resumeV9StructuralTwinText
} from "@/tests/fixtures/resume-v9-structural-twin-data";

const v9Options = {
  allowLegacy: false,
  catalogVersion: "9",
  boundaryAuthority: "server_catalog"
} as const;

function structuralTwinProviderV9(): ResumeParseProviderV9 {
  const canonical = resumeV9StructuralTwinCanonical();
  const catalog = buildResumeSourceCatalogV9(resumeV9StructuralTwinText);
  const recordIds = (section: "workHistory" | "projects" | "education" | "certifications") =>
    catalog.sections
      .filter((item) => item.section === section)
      .flatMap((item) => item.records.map((record) => record.id));
  const project = <T extends { sourceText: string }>(record: T, recordId: string) => {
    const semantic: Partial<T> = { ...record };
    delete semantic.sourceText;
    return { recordId, ...semantic } as { recordId: string } & Omit<T, "sourceText">;
  };
  const contactInfo: Partial<typeof canonical.contactInfo> = { ...canonical.contactInfo };
  delete contactInfo.sourceText;
  return {
    contractVersion: "9",
    contactInfo: contactInfo as ResumeParseProviderV9["contactInfo"],
    skills: canonical.skills,
    workHistory: canonical.workHistory.map((record, index) =>
      project(record, recordIds("workHistory")[index]!)),
    projects: canonical.projects.map((record, index) =>
      project(record, recordIds("projects")[index]!)),
    education: canonical.education.map((record, index) =>
      project(record, recordIds("education")[index]!)),
    certifications: canonical.certifications.map((record, index) =>
      project(record, recordIds("certifications")[index]!)),
    warnings: canonical.warnings
  };
}

function expectPublicError(code: string, fieldPath?: string) {
  return (error: unknown) => error instanceof PublicApiError &&
    error.details?.code === code &&
    (fieldPath === undefined || error.details?.fieldPath === fieldPath);
}

test("V9 accepts the complete structural twin with two authoritative education records", () => {
  const parsed = validateParsedResumeOutput(
    resumeV9StructuralTwinText,
    resumeV9StructuralTwinCanonical(),
    v9Options
  );

  assert.equal(parsed.education.length, 2);
  assert.equal(parsed.education[0]?.details.length, 1);
  assert.equal(parsed.education[1]?.credential, "Bachelor of Arts");
  assert.equal(parsed.education[1]?.fieldOfStudy, "Business Administration");
});

test("V9 versions, prompt, catalog payload, and cache namespace are isolated from V8", () => {
  assert.equal(RESUME_PARSE_PROMPT_VERSION, "11");
  assert.equal(RESUME_PARSE_CACHE_VERSION, "12");
  assert.equal(RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION, "6");
  assert.equal(RESUME_PARSE_V8_PROMPT_VERSION, "10");
  assert.equal(RESUME_PARSE_V8_CACHE_VERSION, "11");
  assert.equal(RESUME_PARSE_V8_GEMINI_WIRE_SCHEMA_VERSION, "5");
  assert.match(resumeParsePromptV9, /boundaries are authoritative/i);
  assert.match(resumeParsePromptV9, /projections may overlap/i);

  const v8 = prepareResumeParseV8Request(resumeV9StructuralTwinText, "gemini");
  const v9 = prepareResumeParseV9Request(resumeV9StructuralTwinText, "gemini");
  const v8Education = v8.payload.sections.find((item) => item.section === "education")!;
  const v9Education = v9.payload.sections.find((item) => item.section === "education")!;
  assert.equal(v8Education.records.length, 1);
  assert.equal(v9Education.records.length, 2);
  assert.deepEqual(
    (v9.providerResponseSchema as { properties: { contractVersion: { enum: string[] } } })
      .properties.contractVersion.enum,
    ["9"]
  );
});

test("V9 provider assembly binds every structural record ID and server-derived evidence", () => {
  const provider = structuralTwinProviderV9();
  assert.equal(resumeParseProviderV9Schema.safeParse(provider).success, true);

  const parsed = assembleAndValidateResumeV9(resumeV9StructuralTwinText, provider);
  assert.equal(parsed.contractVersion, "9");
  assert.equal(parsed.summary, resumeV9StructuralTwinCanonical().summary);
  assert.deepEqual(parsed.achievements, resumeV9StructuralTwinCanonical().achievements);
  assert.equal(parsed.education.length, 2);
  assert.equal(parsed.sourceSections.at(-1)?.section, "additional");
});

test("V9 provider assembly rejects omitted, invented, and reordered record IDs", () => {
  const omitted = structuralTwinProviderV9();
  omitted.workHistory.pop();
  assert.throws(
    () => assembleAndValidateResumeV9(resumeV9StructuralTwinText, omitted),
    expectPublicError("RESUME_PARSE_INCOMPLETE", "workHistory")
  );

  const reordered = structuralTwinProviderV9();
  reordered.projects.reverse();
  assert.throws(
    () => assembleAndValidateResumeV9(resumeV9StructuralTwinText, reordered),
    expectPublicError("RESUME_PARSE_STRUCTURE_AMBIGUOUS", "projects[0].recordId")
  );

  const invented = structuralTwinProviderV9();
  invented.education[0]!.recordId = "section-999-record-999";
  assert.throws(
    () => assembleAndValidateResumeV9(resumeV9StructuralTwinText, invented),
    expectPublicError("RESUME_PARSE_STRUCTURE_AMBIGUOUS", "education[0].recordId")
  );
});

test("V9 provider assembly rejects a merged adjacent plain work record", () => {
  const source = [
    "Casey Structure",
    "",
    "EXPERIENCE",
    "Operations Lead",
    "Example Organization",
    "2022 - Present",
    "Managed service delivery across teams",
    "Program Manager",
    "Second Organization",
    "2020 - 2021",
    "Led service redesign"
  ].join("\n");
  const catalog = buildResumeSourceCatalogV9(source);
  const workIds = catalog.sections
    .find((section) => section.section === "workHistory")!
    .records.map((record) => record.id);
  assert.equal(workIds.length, 2);

  const merged: ResumeParseProviderV9 = {
    contractVersion: "9",
    contactInfo: {
      name: "Casey Structure",
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
      recordId: workIds[0]!,
      company: "Example Organization",
      title: "Operations Lead",
      location: null,
      startDate: "2022",
      endDate: "Present",
      bullets: [
        "Managed service delivery across teams",
        "Led service redesign"
      ]
    }],
    projects: [],
    education: [],
    certifications: [],
    warnings: []
  };

  assert.throws(
    () => assembleAndValidateResumeV9(source, merged),
    expectPublicError("RESUME_PARSE_INCOMPLETE", "workHistory")
  );
});

test("V9 provider assembly rejects merged adjacent plain project, education, and certification records", () => {
  const contactInfo: ResumeParseProviderV9["contactInfo"] = {
    name: "Casey Structure",
    headline: null,
    email: null,
    phone: null,
    location: null,
    linkedin: null,
    github: null,
    portfolio: null
  };
  const base = () => ({
    contractVersion: "9" as const,
    contactInfo,
    skills: [],
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    warnings: []
  });
  const cases: Array<{
    section: "projects" | "education" | "certifications";
    source: string;
    project(provider: ResumeParseProviderV9, recordId: string): void;
  }> = [{
    section: "projects",
    source: [
      "Casey Structure", "", "PROJECTS", "Service Workbench", "2025",
      "Built a dashboard", "Planning Catalog", "2024", "Built an evidence library"
    ].join("\n"),
    project(provider, recordId) {
      provider.projects = [{
        recordId,
        name: "Service Workbench",
        description: null,
        date: "2025",
        technologies: [],
        bullets: ["Built a dashboard", "Built an evidence library"]
      }];
    }
  }, {
    section: "education",
    source: [
      "Casey Structure", "", "EDUCATION", "Example University", "Bachelor of Arts", "2020",
      "Completed research program", "Other University", "Master of Arts", "2024",
      "Completed graduate research"
    ].join("\n"),
    project(provider, recordId) {
      provider.education = [{
        recordId,
        institution: "Example University",
        credential: "Bachelor of Arts",
        fieldOfStudy: null,
        startDate: null,
        endDate: "2020",
        details: ["Completed research program", "Completed graduate research"]
      }];
    }
  }, {
    section: "certifications",
    source: [
      "Casey Structure", "", "CERTIFICATIONS", "Reliability Certificate", "Example Board", "2024",
      "Completed assessment", "Delivery Certificate", "Other Board", "2025",
      "Completed delivery review"
    ].join("\n"),
    project(provider, recordId) {
      provider.certifications = [{
        recordId,
        name: "Reliability Certificate",
        issuer: "Example Board",
        date: "2024",
        expirationDate: null,
        details: ["Completed assessment", "Completed delivery review"]
      }];
    }
  }];

  for (const fixture of cases) {
    const catalogSection = buildResumeSourceCatalogV9(fixture.source).sections
      .find((section) => section.section === fixture.section)!;
    assert.equal(catalogSection.records.length, 2);
    const provider: ResumeParseProviderV9 = base();
    fixture.project(provider, catalogSection.records[0]!.id);
    assert.throws(
      () => assembleAndValidateResumeV9(fixture.source, provider),
      expectPublicError("RESUME_PARSE_INCOMPLETE", fixture.section)
    );
  }
});

test("V9 validation diagnostics expose only schema and authority coordinates", () => {
  const invalidSchema = {
    ...structuralTwinProviderV9(),
    summary: "PRIVATE PROVIDER COPY MUST NOT BE RETAINED"
  };
  let schemaError: unknown;
  try {
    assembleAndValidateResumeV9(resumeV9StructuralTwinText, invalidSchema);
  } catch (error) {
    schemaError = error;
  }
  assert.deepEqual(
    classifyResumeValidationFailure(
      resumeV9StructuralTwinText,
      invalidSchema,
      schemaError,
      "synthetic-fingerprint-key"
    ),
    {
      validationStage: "resume_schema",
      internalErrorCode: "RESUME_PARSE_INVALID_OUTPUT",
      section: null,
      mismatchComponent: null,
      expected: null,
      actual: null,
      fingerprintAlgorithm: null
    }
  );

  const reordered = structuralTwinProviderV9();
  reordered.projects.reverse();
  let authorityError: unknown;
  try {
    assembleAndValidateResumeV9(resumeV9StructuralTwinText, reordered);
  } catch (error) {
    authorityError = error;
  }
  assert.deepEqual(
    classifyResumeValidationFailure(
      resumeV9StructuralTwinText,
      reordered,
      authorityError,
      "synthetic-fingerprint-key"
    ),
    {
      validationStage: "lossless_source_authority",
      internalErrorCode: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      section: "projects",
      mismatchComponent: "recordId",
      expected: null,
      actual: null,
      fingerprintAlgorithm: null
    }
  );
});

test("stored V9 decodes through V9 authority", () => {
  const current = assembleAndValidateResumeV9(
    resumeV9StructuralTwinText,
    structuralTwinProviderV9()
  );
  const decoded = decodeStoredParsedResume(resumeV9StructuralTwinText, current);
  assert.equal(decoded.contractVersion, "9");
  assert.equal(decoded.education.length, 2);
});

test("V9 accepts source-backed unpunctuated narrative inside an authoritative work record", () => {
  const source = [
    "Casey Structure",
    "",
    "EXPERIENCE",
    "Operations Lead | Example Organization | 2022 - Present",
    "Managed service delivery across teams"
  ].join("\n");
  const workSource = source.split("EXPERIENCE\n")[1]!;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Casey Structure", recordBlocks: ["Casey Structure"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: workSource, recordBlocks: [workSource] }
    ],
    contactInfo: {
      sourceText: "Casey Structure",
      name: "Casey Structure",
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
    workHistory: [{
      sourceText: workSource,
      company: "Example Organization",
      title: "Operations Lead",
      location: null,
      startDate: "2022",
      endDate: "Present",
      bullets: ["Managed service delivery across teams"]
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent",
      skills: "absent",
      workHistory: "present",
      projects: "absent",
      education: "absent",
      certifications: "absent",
      achievements: "absent"
    },
    warnings: []
  };

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output, v9Options));
});

test("V9 accepts one certification record with separate issued and expiry date lines", () => {
  const source = [
    "Casey Structure",
    "",
    "CERTIFICATIONS",
    "Synthetic Reliability Certificate | Example Board",
    "Issued: 2024",
    "Expires: 2027",
    "Completed an evidence-based assessment."
  ].join("\n");
  const record = source.split("CERTIFICATIONS\n")[1]!;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Casey Structure", recordBlocks: ["Casey Structure"] },
      { section: "certifications", heading: "CERTIFICATIONS", sourceText: record, recordBlocks: [record] }
    ],
    contactInfo: {
      sourceText: "Casey Structure",
      name: "Casey Structure",
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
    workHistory: [],
    projects: [],
    education: [],
    certifications: [{
      sourceText: record,
      name: "Synthetic Reliability Certificate",
      issuer: "Example Board",
      date: "2024",
      expirationDate: "2027",
      details: ["Completed an evidence-based assessment."]
    }],
    achievements: [],
    sectionStatus: {
      summary: "absent",
      skills: "absent",
      workHistory: "absent",
      projects: "absent",
      education: "absent",
      certifications: "present",
      achievements: "absent"
    },
    warnings: []
  };

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output, v9Options));
});

test("V9 still rejects a semantic fact copied from an adjacent authoritative record", () => {
  const output = resumeV9StructuralTwinCanonical();
  output.education[0]!.institution = "Example State University";

  assert.throws(
    () => validateParsedResumeOutput(resumeV9StructuralTwinText, output, v9Options),
    expectPublicError("RESUME_PARSE_UNSUPPORTED_FACT", "education[0].institution")
  );
});

test("V9 still rejects omitted, reordered, and changed source authority", () => {
  const omitted = resumeV9StructuralTwinCanonical();
  omitted.sourceSections[3]!.recordBlocks.pop();
  assert.throws(
    () => validateParsedResumeOutput(resumeV9StructuralTwinText, omitted, v9Options),
    expectPublicError("RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[4]")
  );

  const reordered = resumeV9StructuralTwinCanonical();
  reordered.workHistory.reverse();
  assert.throws(
    () => validateParsedResumeOutput(resumeV9StructuralTwinText, reordered, v9Options),
    expectPublicError("RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[0]")
  );

  const changed = resumeV9StructuralTwinCanonical();
  changed.sourceSections[4]!.sourceText += "\nInvented project fact.";
  assert.throws(
    () => validateParsedResumeOutput(resumeV9StructuralTwinText, changed, v9Options),
    expectPublicError("RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[4]")
  );
});
