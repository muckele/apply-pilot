import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import mammoth from "mammoth";

import * as resumeModule from "@/lib/ai/resume";
import {
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_PROMPT_VERSION,
  RESUME_PARSE_PLANNED_JSON_BYTES,
  estimateResumeParseMaximumOutputBytes,
  parseResumeTextWithMeta,
  parsedResumeSchema,
  validateParsedResumeOutput,
  type ParsedResumeV5
} from "@/lib/ai/resume";
import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import {
  getJobMatchEvidenceReferences,
  normalizeJobMatchOutput,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { AI_FEATURE_POLICIES } from "@/lib/ai/policy";
import { PublicApiError } from "@/lib/api-errors";
import { extractResumeDocxText } from "@/lib/resume-docx-text";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "./fixtures/resume-estimator-boundary-data";
import { syntheticDocxExtractedText } from "./fixtures/resume-contract-v5-data";

export const completeSyntheticResumeText = `Jordan Example
Systems Operations Analyst
Location: Toronto, Canada | jordan@example.test | +1 (555) 010-1000

SUMMARY
Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery.

SKILLS
Data: SQL, Excel, reporting
Delivery: Agile, stakeholder communication
Platforms: TypeScript, PostgreSQL, Azure

EXPERIENCE
Operations Analyst
Northwind Services
Location: Toronto, Canada
Jan 2022 - Present
• Built TypeScript workflow checks with PostgreSQL and Azure.
• Improved monthly reporting accuracy by 18%.

Customer Support Specialist
Contoso Labs
Remote
Jun 2019 - Dec 2021
• Resolved technical onboarding issues for enterprise customers.
• Documented support patterns for product and engineering teams.

PROJECTS
Apply Pilot | Truthful Application Workflow | 2026
Technologies: TypeScript, PostgreSQL
• Built a review-first application workflow with TypeScript and PostgreSQL.

Service Health Board | Reliability Reporting Dashboard | 2025
Technologies: SQL, Azure
• Created a dashboard that summarized service health trends.

EDUCATION
Operations Analytics Certificate
Synthetic Institute
Jan 2021 - Jun 2021
• Completed a 480-hour program in operations analytics and data reporting.

Bachelor of Arts in Business Administration
Example University
Sep 2014 - Jun 2018

CERTIFICATIONS
Certified Service Operations Professional | Synthetic Board | 2024
Credential ID: SYN-12345

ACHIEVEMENTS
Operational Excellence: Received the 2024 Process Improvement Award.
Customer Impact: Recognized for clear incident communications.

ADDITIONAL INFORMATION
Volunteer: Mentored career changers through a community technology program.`;

const contact = `Jordan Example
Systems Operations Analyst
Location: Toronto, Canada | jordan@example.test | +1 (555) 010-1000`;
const summary = "Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery.";
const skills = `Data: SQL, Excel, reporting
Delivery: Agile, stakeholder communication
Platforms: TypeScript, PostgreSQL, Azure`;
const firstWork = `Operations Analyst
Northwind Services
Location: Toronto, Canada
Jan 2022 - Present
• Built TypeScript workflow checks with PostgreSQL and Azure.
• Improved monthly reporting accuracy by 18%.`;
const secondWork = `Customer Support Specialist
Contoso Labs
Remote
Jun 2019 - Dec 2021
• Resolved technical onboarding issues for enterprise customers.
• Documented support patterns for product and engineering teams.`;
const firstProject = `Apply Pilot | Truthful Application Workflow | 2026
Technologies: TypeScript, PostgreSQL
• Built a review-first application workflow with TypeScript and PostgreSQL.`;
const secondProject = `Service Health Board | Reliability Reporting Dashboard | 2025
Technologies: SQL, Azure
• Created a dashboard that summarized service health trends.`;
const certificateEducation = `Operations Analytics Certificate
Synthetic Institute
Jan 2021 - Jun 2021
• Completed a 480-hour program in operations analytics and data reporting.`;
const degreeEducation = `Bachelor of Arts in Business Administration
Example University
Sep 2014 - Jun 2018`;
const certification = `Certified Service Operations Professional | Synthetic Board | 2024
Credential ID: SYN-12345`;
const achievements = `Operational Excellence: Received the 2024 Process Improvement Award.
Customer Impact: Recognized for clear incident communications.`;
const additional = "Volunteer: Mentored career changers through a community technology program.";

export function completeSyntheticParsedResume(): ParsedResumeV5 {
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: contact, recordBlocks: [contact] },
      { section: "summary", heading: "SUMMARY", sourceText: summary, recordBlocks: [summary] },
      { section: "skills", heading: "SKILLS", sourceText: skills, recordBlocks: skills.split("\n") },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: `${firstWork}\n\n${secondWork}`, recordBlocks: [firstWork, secondWork] },
      { section: "projects", heading: "PROJECTS", sourceText: `${firstProject}\n\n${secondProject}`, recordBlocks: [firstProject, secondProject] },
      { section: "education", heading: "EDUCATION", sourceText: `${certificateEducation}\n\n${degreeEducation}`, recordBlocks: [certificateEducation, degreeEducation] },
      { section: "certifications", heading: "CERTIFICATIONS", sourceText: certification, recordBlocks: [certification] },
      { section: "achievements", heading: "ACHIEVEMENTS", sourceText: achievements, recordBlocks: achievements.split("\n") },
      { section: "additional", heading: "ADDITIONAL INFORMATION", sourceText: additional, recordBlocks: [additional] }
    ],
    contactInfo: {
      sourceText: contact,
      name: "Jordan Example",
      headline: "Systems Operations Analyst",
      email: "jordan@example.test",
      phone: "+1 (555) 010-1000",
      location: "Toronto, Canada",
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary,
    skills: ["SQL", "Excel", "reporting", "Agile", "stakeholder communication", "TypeScript", "PostgreSQL", "Azure"],
    workHistory: [{
      sourceText: firstWork,
      company: "Northwind Services",
      title: "Operations Analyst",
      location: "Toronto, Canada",
      startDate: "Jan 2022",
      endDate: "Present",
      bullets: [
        "• Built TypeScript workflow checks with PostgreSQL and Azure.",
        "• Improved monthly reporting accuracy by 18%."
      ]
    }, {
      sourceText: secondWork,
      company: "Contoso Labs",
      title: "Customer Support Specialist",
      location: "Remote",
      startDate: "Jun 2019",
      endDate: "Dec 2021",
      bullets: [
        "• Resolved technical onboarding issues for enterprise customers.",
        "• Documented support patterns for product and engineering teams."
      ]
    }],
    projects: [{
      sourceText: firstProject,
      name: "Apply Pilot",
      description: "Truthful Application Workflow",
      date: "2026",
      technologies: ["TypeScript", "PostgreSQL"],
      bullets: ["• Built a review-first application workflow with TypeScript and PostgreSQL."]
    }, {
      sourceText: secondProject,
      name: "Service Health Board",
      description: "Reliability Reporting Dashboard",
      date: "2025",
      technologies: ["SQL", "Azure"],
      bullets: ["• Created a dashboard that summarized service health trends."]
    }],
    education: [{
      sourceText: certificateEducation,
      institution: "Synthetic Institute",
      credential: "Operations Analytics Certificate",
      fieldOfStudy: "operations analytics",
      startDate: "Jan 2021",
      endDate: "Jun 2021",
      details: ["• Completed a 480-hour program in operations analytics and data reporting."]
    }, {
      sourceText: degreeEducation,
      institution: "Example University",
      credential: "Bachelor of Arts",
      fieldOfStudy: "Business Administration",
      startDate: "Sep 2014",
      endDate: "Jun 2018",
      details: []
    }],
    certifications: [{
      sourceText: certification,
      name: "Certified Service Operations Professional",
      issuer: "Synthetic Board",
      date: "2024",
      expirationDate: null,
      details: ["Credential ID: SYN-12345"]
    }],
    achievements: [
      "Operational Excellence: Received the 2024 Process Improvement Award.",
      "Customer Impact: Recognized for clear incident communications."
    ],
    sectionStatus: {
      summary: "present",
      skills: "present",
      workHistory: "present",
      projects: "present",
      education: "present",
      certifications: "present",
      achievements: "present"
    },
    warnings: []
  };
}

function publicError(error: unknown, code: string, fieldPath?: string) {
  return error instanceof PublicApiError && error.details?.code === code &&
    (fieldPath === undefined || error.details?.fieldPath === fieldPath);
}

test("resume parsing uses the v5 contract with coherent prompt and cache revisions", () => {
  assert.equal(RESUME_PARSE_PROMPT_VERSION, "6");
  assert.equal(RESUME_PARSE_CACHE_VERSION, "7");
  assert.equal(
    (resumeModule as typeof resumeModule & { RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION?: string })
      .RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
    "2"
  );
  assert.equal(completeSyntheticParsedResume().contractVersion, "5");
  const fixtureOutputTokens = Math.ceil(Buffer.byteLength(
    JSON.stringify(completeSyntheticParsedResume()),
    "utf8"
  ) / 3);
  assert.ok(
    AI_FEATURE_POLICIES.RESUME_PARSE.maxOutputTokens >= fixtureOutputTokens * 4,
    "lossless v5 output needs capacity for a realistically longer resume"
  );
});

test("lossless source authority accepts connector words, grouped skills, mixed contact facts, and overlapping projections", () => {
  const parsed = validateParsedResumeOutput(completeSyntheticResumeText, completeSyntheticParsedResume());

  assert.equal(parsed.education[1]?.credential, "Bachelor of Arts");
  assert.equal(parsed.education[1]?.fieldOfStudy, "Business Administration");
  assert.deepEqual(parsed.projects[0]?.technologies, ["TypeScript", "PostgreSQL"]);
  assert.match(parsed.projects[0]?.bullets[0] ?? "", /TypeScript and PostgreSQL/);
  assert.equal(parsed.sourceSections.at(-1)?.section, "additional");
  assert.equal(parsed.certifications[0]?.details[0], "Credential ID: SYN-12345");
});

test("lossless source authority treats CRLF and LF as equivalent line boundaries", () => {
  const crlfSource = completeSyntheticResumeText.replaceAll("\n", "\r\n");
  const crSource = completeSyntheticResumeText.replaceAll("\n", "\r");
  const lfOutput = completeSyntheticParsedResume();
  const crlfOutput = JSON.parse(
    JSON.stringify(completeSyntheticParsedResume()).replaceAll("\\n", "\\r\\n")
  ) as ParsedResumeV5;

  assert.equal(validateParsedResumeOutput(crlfSource, lfOutput, { allowLegacy: false }).workHistory.length, 2);
  assert.equal(validateParsedResumeOutput(crlfSource, crlfOutput, { allowLegacy: false }).projects.length, 2);
  assert.equal(validateParsedResumeOutput(crSource, lfOutput, { allowLegacy: false }).education.length, 2);
  assert.equal(
    estimateResumeParseMaximumOutputBytes(crSource),
    estimateResumeParseMaximumOutputBytes(completeSyntheticResumeText)
  );
});

test("typed fields remain projections when a source record contains untyped metadata", () => {
  const metadata = "Full-time\nRevenue Operations";
  const enrichedWork = firstWork.replace("Northwind Services\n", `Northwind Services\n${metadata}\n`);
  const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
  const output = completeSyntheticParsedResume();
  output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
  output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
  output.workHistory[0]!.sourceText = enrichedWork;

  assert.equal(
    validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory[0]?.title,
    "Operations Analyst"
  );
});

test("an employment type cannot excuse an arbitrary hidden role header", () => {
  const metadata = "Full-time\nRole Two";
  const enrichedWork = firstWork.replace("Northwind Services\n", `Northwind Services\n${metadata}\n`);
  const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
  const output = completeSyntheticParsedResume();
  output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
  output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
  output.workHistory[0]!.sourceText = enrichedWork;

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("one unexplained pre-narrative line cannot hide a role or organization", () => {
  for (const hiddenHeader of ["Role Two", "Org Two"]) {
    const enrichedWork = firstWork.replace("Northwind Services\n", `Northwind Services\n${hiddenHeader}\n`);
    const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
    const output = completeSyntheticParsedResume();
    output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
    output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
    output.workHistory[0]!.sourceText = enrichedWork;

    assert.throws(
      () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
      (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
    );
  }
});

test("an adjacent work record cannot hide after the final projected bullet", () => {
  for (const suffix of [
    "Role Two",
    "Role Two\nOrg Two",
    "Role Two\nOrg Two\n• Second result.",
    "Role Two | Org Two\n• Second result.",
    "Technologies Used\nRole Two | Org Two",
    "Technologies Used\nRole Two\nOrg Two",
    "Technologies Used\nReact\nRole Two\nOrg Two",
    "Technologies Used\nReact\nRole Two\nOrg Two\n• Second result."
  ]) {
    const enrichedWork = `${firstWork}\n\n${suffix}`;
    const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
    const output = completeSyntheticParsedResume();
    output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
    output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
    output.workHistory[0]!.sourceText = enrichedWork;

    assert.throws(
      () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
      (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
    );
  }
});

test("blank space between a work header and its bullets remains inside one record", () => {
  const spacedWork = firstWork.replace(
    "Jan 2022 - Present\n• Built",
    "Jan 2022 - Present\n\n• Built"
  );
  const source = completeSyntheticResumeText.replace(firstWork, spacedWork);
  const output = completeSyntheticParsedResume();
  output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, spacedWork);
  output.sourceSections[3]!.recordBlocks[0] = spacedWork;
  output.workHistory[0]!.sourceText = spacedWork;

  assert.equal(
    validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory[0]?.company,
    "Northwind Services"
  );
});

test("a blank before bullets cannot invent a second canonical work record", () => {
  const first = "Role One\nOrg One";
  const second = "• Did work.";
  const work = `${first}\n\n${second}`;
  const source = `Jordan Example\n\nEXPERIENCE\n${work}`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: work, recordBlocks: [first, second] }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: first, company: "Org One", title: "Role One", location: null,
      startDate: null, endDate: null, bullets: []
    }, {
      sourceText: second, company: second, title: second, location: null,
      startDate: null, endDate: null, bullets: []
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[1].sourceText")
  );
});

test("a pipe-delimited project bullet is not treated as a record header", () => {
  const pipeBullet = "• Pipeline stages: A | B | C";
  const enrichedProject = firstProject.replace(
    "• Built a review-first application workflow with TypeScript and PostgreSQL.",
    pipeBullet
  );
  const source = completeSyntheticResumeText.replace(firstProject, enrichedProject);
  const output = completeSyntheticParsedResume();
  output.sourceSections[4]!.sourceText = output.sourceSections[4]!.sourceText.replace(firstProject, enrichedProject);
  output.sourceSections[4]!.recordBlocks[0] = enrichedProject;
  output.projects[0]!.sourceText = enrichedProject;
  output.projects[0]!.bullets = [pipeBullet];

  assert.equal(
    validateParsedResumeOutput(source, output, { allowLegacy: false }).projects[0]?.name,
    "Apply Pilot"
  );
});

test("a minimal project record cannot hide after the final projected bullet", () => {
  const suffix = "Project Two\n• Second result.";
  const enrichedProject = `${firstProject}\n\n${suffix}`;
  const source = completeSyntheticResumeText.replace(firstProject, enrichedProject);
  const output = completeSyntheticParsedResume();
  output.sourceSections[4]!.sourceText = output.sourceSections[4]!.sourceText.replace(firstProject, enrichedProject);
  output.sourceSections[4]!.recordBlocks[0] = enrichedProject;
  output.projects[0]!.sourceText = enrichedProject;

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "projects[0].sourceText")
  );
});

test("named metadata cannot span a paragraph boundary and absorb a minimal project", () => {
  for (const suffix of [
    "Technologies Used\n\nProject Two\n• Second result.",
    "Technologies Used\n   \nProject Two\n• Second result."
  ]) {
    const enrichedProject = `${firstProject}\n\n${suffix}`;
    const source = completeSyntheticResumeText.replace(firstProject, enrichedProject);
    const output = completeSyntheticParsedResume();
    output.sourceSections[4]!.sourceText = output.sourceSections[4]!.sourceText.replace(firstProject, enrichedProject);
    output.sourceSections[4]!.recordBlocks[0] = enrichedProject;
    output.projects[0]!.sourceText = enrichedProject;

    assert.throws(
      () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
      (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "projects[0].sourceText")
    );
  }
});

test("typed fields remain projections when untyped metadata follows the narrative", () => {
  const metadata = "Technologies Used\nReact";
  const enrichedWork = `${firstWork}\n${metadata}`;
  const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
  const output = completeSyntheticParsedResume();
  output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
  output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
  output.workHistory[0]!.sourceText = enrichedWork;

  assert.equal(
    validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory[0]?.company,
    "Northwind Services"
  );
});

test("bounded named metadata requires list markers when it has multiple values", () => {
  for (const metadata of [
    "Technologies Used\nReact",
    "Technologies Used\n• React",
    "Technologies Used\n• React\n• PostgreSQL"
  ]) {
    const enrichedWork = `${firstWork}\n\n${metadata}`;
    const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
    const output = completeSyntheticParsedResume();
    output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
    output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
    output.workHistory[0]!.sourceText = enrichedWork;

    assert.equal(
      validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory[0]?.company,
      "Northwind Services"
    );
  }
});

test("multiple unmarked metadata values are rejected because they can hide a zero-bullet record", () => {
  const metadata = "Technologies Used\nReact\nPostgreSQL";
  const enrichedWork = `${firstWork}\n\n${metadata}`;
  const source = completeSyntheticResumeText.replace(firstWork, enrichedWork);
  const output = completeSyntheticParsedResume();
  output.sourceSections[3]!.sourceText = output.sourceSections[3]!.sourceText.replace(firstWork, enrichedWork);
  output.sourceSections[3]!.recordBlocks[0] = enrichedWork;
  output.workHistory[0]!.sourceText = enrichedWork;

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("repeated canonical headings partition typed records in source order", () => {
  const source = completeSyntheticResumeText.replace(
    `${firstWork}\n\n${secondWork}`,
    `${firstWork}\n\nWORK EXPERIENCE\n${secondWork}`
  );
  const output = completeSyntheticParsedResume();
  output.sourceSections.splice(
    3,
    1,
    { section: "workHistory", heading: "EXPERIENCE", sourceText: firstWork, recordBlocks: [firstWork] },
    { section: "workHistory", heading: "WORK EXPERIENCE", sourceText: secondWork, recordBlocks: [secondWork] }
  );

  assert.equal(validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory.length, 2);
});

test("non-structural record blocks cannot invent boundaries inside one source line", () => {
  const output = fullSizeSyntheticProviderOutput();
  const additionalIndex = output.sourceSections.findIndex(
    (section) => section.section === "additional"
  );
  const additional = output.sourceSections[additionalIndex]!;
  const splitAt = additional.sourceText.indexOf(":") + 1;
  additional.recordBlocks = [
    additional.sourceText.slice(0, splitAt),
    additional.sourceText.slice(splitAt).trim()
  ];

  assert.throws(
    () => validateParsedResumeOutput(fullSizeSyntheticDocxExtractedText, output, {
      allowLegacy: false
    }),
    (error) => publicError(
      error,
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      `sourceSections[${additionalIndex}].recordBlocks`
    )
  );
});

test("lossless authority rejects an omitted source fact with a privacy-safe field path", () => {
  const omitted = completeSyntheticParsedResume();
  omitted.sourceSections[2]!.recordBlocks.pop();
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, omitted),
    (error) => publicError(error, "RESUME_PARSE_INCOMPLETE", "sourceSections[2].recordBlocks")
  );
});

test("typed projections reject invented facts without retaining raw provider output", () => {
  const invented = completeSyntheticParsedResume();
  invented.education[1]!.fieldOfStudy = "Astrophysics";
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, invented),
    (error) => publicError(error, "RESUME_PARSE_UNSUPPORTED_FACT", "education[1].fieldOfStudy")
  );
});

test("typed projection arrays cannot amplify one source occurrence through duplicates", () => {
  const duplicated = completeSyntheticParsedResume();
  duplicated.skills = ["Excel", "Excel"];

  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, duplicated),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "skills[1]")
  );
});

test("lossless authority rejects wrong record order and adjacent record merges", () => {
  const reordered = completeSyntheticParsedResume();
  reordered.sourceSections[3]!.recordBlocks.reverse();
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, reordered),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[0]")
  );

  const merged = completeSyntheticParsedResume();
  merged.sourceSections[3]!.recordBlocks = [`${firstWork}\n\n${secondWork}`];
  merged.workHistory = [{
    ...merged.workHistory[0]!,
    sourceText: `${firstWork}\n\n${secondWork}`,
    bullets: [...merged.workHistory[0]!.bullets, ...merged.workHistory[1]!.bullets]
  }];
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, merged),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[0]")
  );
});

test("structural guards reject a provider-controlled merge of adjacent dateless work records", () => {
  const source = `Jordan Example

EXPERIENCE
Operations Analyst
Northwind Services
• Improved reporting accuracy.

Customer Support Specialist
Contoso Labs
• Resolved onboarding issues.`;
  const mergedBlock = `Operations Analyst
Northwind Services
• Improved reporting accuracy.

Customer Support Specialist
Contoso Labs
• Resolved onboarding issues.`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: mergedBlock, recordBlocks: [mergedBlock] }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: mergedBlock,
      company: "Northwind Services",
      title: "Operations Analyst",
      location: null,
      startDate: null,
      endDate: null,
      bullets: ["• Improved reporting accuracy.", "• Resolved onboarding issues."]
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("punctuated pipe work headers cannot be merged into one record", () => {
  const mergedBlock = `Role 1 | Acme, Inc.
• Delivered result 1.

Role 2 | Acme, Inc.
• Delivered result 2.`;
  const source = `Jordan Example

EXPERIENCE
${mergedBlock}`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: mergedBlock, recordBlocks: [mergedBlock] }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: mergedBlock,
      company: "Acme, Inc.",
      title: "Role 1",
      location: null,
      startDate: null,
      endDate: null,
      bullets: ["• Delivered result 1.", "• Delivered result 2."]
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("a marked pipe narrative cannot establish an invented work record", () => {
  const first = `Role 1
Acme
2020 - Present
• Delivered result 1.`;
  const markedNarrative = "• Compared A | B.";
  const workSource = `${first}\n${markedNarrative}`;
  const source = `Jordan Example\n\nEXPERIENCE\n${workSource}`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      {
        section: "workHistory",
        heading: "EXPERIENCE",
        sourceText: workSource,
        recordBlocks: [first, markedNarrative]
      }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: first,
      company: "Acme",
      title: "Role 1",
      location: null,
      startDate: "2020",
      endDate: "Present",
      bullets: ["• Delivered result 1."]
    }, {
      sourceText: markedNarrative,
      company: "B.",
      title: "Compared A",
      location: null,
      startDate: null,
      endDate: null,
      bullets: []
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(
      error,
      "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
      "sourceSections[1].recordBlocks[1]"
    )
  );
});

test("structural guards reject adjacent dateless headers before the first narrative", () => {
  const mergedBlock = `Role One
Org One
Role Two
Org Two
• Did work.`;
  const source = `Jordan Example

EXPERIENCE
${mergedBlock}`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: mergedBlock, recordBlocks: [mergedBlock] }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: mergedBlock,
      company: "Org One",
      title: "Role One",
      location: null,
      startDate: null,
      endDate: null,
      bullets: ["• Did work."]
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("a labeled adjacent organization cannot hide before the first narrative", () => {
  const mergedBlock = `Role One
Org One
Role Two
Company: Org Two
• Did work.`;
  const source = `Jordan Example

EXPERIENCE
${mergedBlock}`;
  const output = completeSyntheticParsedResume();
  output.sourceSections = [
    { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
    { section: "workHistory", heading: "EXPERIENCE", sourceText: mergedBlock, recordBlocks: [mergedBlock] }
  ];
  output.contactInfo = {
    sourceText: "Jordan Example", name: "Jordan Example", headline: null,
    email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
  };
  output.summary = "";
  output.skills = [];
  output.workHistory = [{
    sourceText: mergedBlock,
    company: "Org One",
    title: "Role One",
    location: null,
    startDate: null,
    endDate: null,
    bullets: ["• Did work."]
  }];
  output.projects = [];
  output.education = [];
  output.certifications = [];
  output.achievements = [];
  output.sectionStatus = {
    summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
    education: "absent", certifications: "absent", achievements: "absent"
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("an explicit paragraph boundary prevents a one-line adjacent header from merging", () => {
  const mergedBlock = `Role One
Org One
• First result.

Role Two | Org Two
• Second result.`;
  const source = `Jordan Example

EXPERIENCE
${mergedBlock}`;
  const output = completeSyntheticParsedResume();
  output.sourceSections = [
    { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
    { section: "workHistory", heading: "EXPERIENCE", sourceText: mergedBlock, recordBlocks: [mergedBlock] }
  ];
  output.contactInfo = {
    sourceText: "Jordan Example", name: "Jordan Example", headline: null,
    email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
  };
  output.summary = "";
  output.skills = [];
  output.workHistory = [{
    sourceText: mergedBlock,
    company: "Org One",
    title: "Role One",
    location: null,
    startDate: null,
    endDate: null,
    bullets: ["• First result.", "• Second result."]
  }];
  output.projects = [];
  output.education = [];
  output.certifications = [];
  output.achievements = [];
  output.sectionStatus = {
    summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
    education: "absent", certifications: "absent", achievements: "absent"
  };

  assert.throws(
    () => validateParsedResumeOutput(source, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "workHistory[0].sourceText")
  );
});

test("an uppercase canonical project name is not inferred to be an arbitrary section", () => {
  const project = `OPEN SOURCE
• Built a tool.`;
  const source = `Jordan Example

PROJECTS

${project}`;
  const output = completeSyntheticParsedResume();
  output.sourceSections = [
    { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
    { section: "projects", heading: "PROJECTS", sourceText: project, recordBlocks: [project] }
  ];
  output.contactInfo = {
    sourceText: "Jordan Example", name: "Jordan Example", headline: null,
    email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
  };
  output.summary = "";
  output.skills = [];
  output.workHistory = [];
  output.projects = [{
    sourceText: project,
    name: "OPEN SOURCE",
    description: null,
    date: null,
    technologies: [],
    bullets: ["• Built a tool."]
  }];
  output.education = [];
  output.certifications = [];
  output.achievements = [];
  output.sectionStatus = {
    summary: "absent", skills: "absent", workHistory: "absent", projects: "present",
    education: "absent", certifications: "absent", achievements: "absent"
  };

  assert.equal(
    validateParsedResumeOutput(source, output, { allowLegacy: false }).projects[0]?.name,
    "OPEN SOURCE"
  );
});

test("a canonical role whose title looks like a section is not carved into an additional section", () => {
  const first = `Operations Analyst
Northwind Services
• Improved reporting accuracy.`;
  const second = `HEAD OF RESEARCH
Company: Contoso
• Led a research program.`;
  const source = `Jordan Example

EXPERIENCE
${first}

${second}`;
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Jordan Example", recordBlocks: ["Jordan Example"] },
      {
        section: "workHistory",
        heading: "EXPERIENCE",
        sourceText: `${first}\n\n${second}`,
        recordBlocks: [first, second]
      }
    ],
    contactInfo: {
      sourceText: "Jordan Example", name: "Jordan Example", headline: null,
      email: null, phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: first,
      company: "Northwind Services",
      title: "Operations Analyst",
      location: null,
      startDate: null,
      endDate: null,
      bullets: ["• Improved reporting accuracy."]
    }, {
      sourceText: second,
      company: "Contoso",
      title: "HEAD OF RESEARCH",
      location: null,
      startDate: null,
      endDate: null,
      bullets: ["• Led a research program."]
    }],
    projects: [],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent", skills: "absent", workHistory: "present", projects: "absent",
      education: "absent", certifications: "absent", achievements: "absent"
    },
    warnings: []
  };

  assert.equal(validateParsedResumeOutput(source, output, { allowLegacy: false }).workHistory.length, 2);
});

test("resume source admission is bounded by the lossless response capacity before provider setup", async () => {
  const escapeHeavyPayload = `• ${"\\".repeat(1_800)}.`;
  const escapeHeavyRecords = [1, 2, 3].map(
    (index) => `P${index} | D${index} | 202${index}\n${escapeHeavyPayload}`
  );
  const escapeHeavySource = `Jordan Example\n\nPROJECTS\n${escapeHeavyRecords.join("\n\n")}`;
  const tooManySkillBlocks = `Jordan Example\n\nSKILLS\n${Array.from(
    { length: 101 },
    (_, index) => `Skill ${index + 1}`
  ).join("\n")}`;
  const tooManyProjects = `Jordan Example\n\nPROJECTS\n${Array.from(
    { length: 51 },
    (_, index) => `Project ${index + 1} | Synthetic subtitle | 2025`
  ).join("\n\n")}`;
  const oneWorkRecordWithManyParagraphs = `Jordan Example\n\nEXPERIENCE\nOperations Analyst\nExample Co\n2020 - Present\n${Array.from(
    { length: 51 },
    (_, index) => `• Evidence paragraph ${index + 1}.`
  ).join("\n\n")}`;
  const tooManyPunctuatedWorkHeaders = `Jordan Example\n\nEXPERIENCE\n${Array.from(
    { length: 51 },
    (_, index) => `Role ${index + 1} | Acme, Inc.\n• Delivered result ${index + 1}.`
  ).join("\n\n")}`;
  const tooManyDatelessWorkRecords = `Jordan Example\n\nEXPERIENCE\n${Array.from(
    { length: 51 },
    (_, index) => `Role ${index + 1}\nAcme ${index + 1}\n• Delivered result ${index + 1}.`
  ).join("\n\n")}`;
  assert.ok(
    estimateResumeParseMaximumOutputBytes(completeSyntheticResumeText) <=
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(syntheticDocxExtractedText) <=
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(escapeHeavySource) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(tooManySkillBlocks) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(tooManyProjects) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(oneWorkRecordWithManyParagraphs) <=
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(tooManyPunctuatedWorkHeaders) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );
  assert.ok(
    estimateResumeParseMaximumOutputBytes(tooManyDatelessWorkRecords) >
      RESUME_PARSE_PLANNED_JSON_BYTES
  );

  await assert.rejects(
    parseResumeTextWithMeta(escapeHeavySource, "user-1"),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 413 &&
      error.details?.code === "RESUME_PARSE_SOURCE_TOO_LARGE_FOR_LOSSLESS_OUTPUT"
  );

  for (const source of [
    tooManySkillBlocks,
    tooManyProjects,
    tooManyPunctuatedWorkHeaders,
    tooManyDatelessWorkRecords
  ]) {
    await assert.rejects(
      parseResumeTextWithMeta(source, "user-1"),
      (error: unknown) => error instanceof PublicApiError &&
        error.status === 413 &&
        error.details?.code === "RESUME_PARSE_SOURCE_TOO_LARGE_FOR_LOSSLESS_OUTPUT"
    );
  }

  await assert.rejects(
    parseResumeTextWithMeta(`Jordan Example\n\nSUMMARY\n${"\0".repeat(1_100)}`, "user-1"),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 422 &&
      error.details?.code === "RESUME_PARSE_UNSUPPORTED_CONTROL_CHARACTERS" &&
      error.details?.fieldPath === "rawText"
  );
});

test("the full-size synthetic DOCX reproduces the privacy-safe source scale without private content", async () => {
  const fixture = await readFile(new URL(
    "./fixtures/synthetic-resume-estimator-boundary.docx",
    import.meta.url
  ));
  const lossyExtraction = (await mammoth.extractRawText({ buffer: fixture })).value;
  const extracted = await extractResumeDocxText(fixture);

  assert.notEqual(lossyExtraction, fullSizeSyntheticDocxExtractedText);
  assert.doesNotMatch(lossyExtraction, /• /);
  assert.equal(extracted, fullSizeSyntheticDocxExtractedText);
  assert.match(extracted, /vendor governance, R&D coordination/);
  assert.doesNotMatch(extracted, /&amp;/);
  assert.match(
    extracted,
    /Completed a 480-hour applied program[^]*\n\nBachelor of Arts in Business Administration/
  );
  assert.ok(Buffer.byteLength(extracted.trim(), "utf8") >= 6_200);
  assert.ok(Buffer.byteLength(extracted.trim(), "utf8") <= 6_800);
  assert.equal((extracted.match(/• /g) ?? []).length, 23);
  const output = fullSizeSyntheticProviderOutput();
  assert.equal(output.workHistory.flatMap((record) => record.bullets).length, 21);
  assert.equal(output.projects.flatMap((record) => record.bullets).length, 2);
  assert.match(extracted, /CERTIFICATIONS/);
  assert.match(extracted, /ACHIEVEMENTS/);
  assert.match(extracted, /ADDITIONAL INFORMATION/);
});

test("source authority recognizes Core Skills and Selected Technical Projects headings", () => {
  const parsed = validateParsedResumeOutput(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput(),
    { allowLegacy: false }
  );

  assert.equal(parsed.sourceSections[2]?.section, "skills");
  assert.equal(parsed.sourceSections[2]?.heading, "CORE SKILLS");
  assert.equal(parsed.sourceSections[4]?.section, "projects");
  assert.equal(parsed.sourceSections[4]?.heading, "SELECTED TECHNICAL PROJECTS");
  assert.deepEqual(
    parsed.sourceSections.slice(-3).map((section) => section.section),
    ["certifications", "achievements", "additional"]
  );
  assert.equal(parsed.certifications[0]?.details[0], "Credential ID: SYN-OPS-6403");
  assert.equal(parsed.achievements.length, 2);
});

test("contract-derived estimate admits a realistic lossless response and bounds its serialized bytes", () => {
  const output = fullSizeSyntheticProviderOutput();
  const serializedBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  const estimatedBytes = estimateResumeParseMaximumOutputBytes(fullSizeSyntheticDocxExtractedText);

  assert.ok(serializedBytes < RESUME_PARSE_PLANNED_JSON_BYTES);
  assert.ok(estimatedBytes >= serializedBytes);
  assert.ok(estimatedBytes <= RESUME_PARSE_PLANNED_JSON_BYTES);
});

test("contract-derived estimate rejects a realistic source whose lossless authority exceeds capacity", () => {
  const longAdditionalSection = Array.from({ length: 80 }, (_, index) =>
    `Community program ${index + 1} documented ownership, delivery evidence, review status, and follow-up decisions.`
  ).join("\n\n");
  const oversizedSource = `${fullSizeSyntheticDocxExtractedText.trim()}\n\nADDITIONAL INFORMATION\n\n${longAdditionalSection}`;

  assert.ok(
    estimateResumeParseMaximumOutputBytes(oversizedSource) > RESUME_PARSE_PLANNED_JSON_BYTES
  );
});

test("narrative year lists do not inflate the structural record envelope", () => {
  const output = fullSizeSyntheticProviderOutput();
  const originalBullet = output.workHistory[0]!.bullets[0]!;
  const yearList = Array.from({ length: 20 }, (_, index) => String(1970 + index)).join(", ");
  const replacementBullet = `• Compared annual service evidence across ${yearList}.`;
  const source = fullSizeSyntheticDocxExtractedText.replace(originalBullet, replacementBullet);
  output.workHistory[0]!.sourceText = output.workHistory[0]!.sourceText.replace(
    originalBullet,
    replacementBullet
  );
  output.workHistory[0]!.bullets[0] = replacementBullet;
  const workSection = output.sourceSections.find((section) => section.section === "workHistory")!;
  workSection.sourceText = workSection.sourceText.replace(originalBullet, replacementBullet);
  workSection.recordBlocks[0] = workSection.recordBlocks[0]!.replace(
    originalBullet,
    replacementBullet
  );

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output, { allowLegacy: false }));
  const serializedBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  const estimatedBytes = estimateResumeParseMaximumOutputBytes(source);
  assert.ok(serializedBytes < RESUME_PARSE_PLANNED_JSON_BYTES);
  assert.ok(estimatedBytes >= serializedBytes);
  assert.ok(estimatedBytes <= RESUME_PARSE_PLANNED_JSON_BYTES);
});

test("warning limits retain a byte-safe maximum for the structured-response plan", () => {
  const tooMany = fullSizeSyntheticProviderOutput();
  tooMany.warnings = Array.from({ length: 6 }, () => "Synthetic ambiguity.");
  assert.throws(
    () => validateParsedResumeOutput(fullSizeSyntheticDocxExtractedText, tooMany, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_INVALID_OUTPUT", "warnings")
  );

  const tooLong = fullSizeSyntheticProviderOutput();
  tooLong.warnings = ["x".repeat(101)];
  assert.throws(
    () => validateParsedResumeOutput(fullSizeSyntheticDocxExtractedText, tooLong, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_INVALID_OUTPUT", "warnings[0]")
  );

  const maximumEscaped = fullSizeSyntheticProviderOutput();
  maximumEscaped.warnings = Array.from({ length: 5 }, () => "\ud800".repeat(100));
  const validated = validateParsedResumeOutput(
    fullSizeSyntheticDocxExtractedText,
    maximumEscaped,
    { allowLegacy: false }
  );
  assert.equal(validated.warnings.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumEscaped), "utf8") <=
    estimateResumeParseMaximumOutputBytes(fullSizeSyntheticDocxExtractedText));
});

test("nested record projections enforce the estimator's per-record array envelope", () => {
  const output = fullSizeSyntheticProviderOutput();
  output.projects[0]!.technologies = Array.from({ length: 26 }, () => "TypeScript");

  assert.equal(parsedResumeSchema.safeParse(output).success, false);
});

test("provider warnings cannot amplify control characters outside source evidence", () => {
  const output = completeSyntheticParsedResume();
  output.warnings = ["\0".repeat(200)];

  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, output, { allowLegacy: false }),
    (error) => publicError(error, "RESUME_PARSE_INVALID_OUTPUT", "warnings[0]")
  );
});

test("the central legacy decoder reads v3 project records without date and upgrades to v5 authority", () => {
  const legacySource = `Jordan Example
jordan@example.test

PROJECTS
Project Alpha
Built a controlled application workflow.`;
  const legacy = {
    contractVersion: "3",
    contactInfo: {
      sourceText: "Jordan Example\njordan@example.test",
      name: "Jordan Example",
      headline: null,
      email: "jordan@example.test",
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [],
    projects: [{
      sourceText: "Project Alpha\nBuilt a controlled application workflow.",
      name: "Project Alpha",
      description: "Built a controlled application workflow.",
      technologies: [],
      bullets: []
    }],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent",
      skills: "absent",
      workHistory: "absent",
      projects: "present",
      education: "absent",
      certifications: "absent",
      achievements: "absent"
    },
    warnings: []
  };

  const parsed = validateParsedResumeOutput(legacySource, legacy);
  assert.equal(parsed.contractVersion, "5");
  assert.equal(parsed.projects[0]?.date, null);
  assert.ok(parsed.sourceSections.length > 0);

  const crlfLegacy = JSON.parse(
    JSON.stringify(legacy).replaceAll("\\n", "\\r\\n")
  );
  const crlfParsed = validateParsedResumeOutput(
    legacySource.replaceAll("\n", "\r\n"),
    crlfLegacy
  );
  assert.equal(crlfParsed.projects[0]?.sourceText, legacy.projects[0]!.sourceText);
});

test("application planning keeps canonical education and project facts and reports every bounded omission", () => {
  const parsed = completeSyntheticParsedResume();
  const payload = buildApplicationPlanPayload({
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "TypeScript, SQL, reporting, and stakeholder communication.",
      requirements: ["TypeScript", "SQL"]
    },
    resume: {
      rawText: completeSyntheticResumeText,
      summary: parsed.summary,
      skills: [...parsed.skills, ...Array.from({ length: 35 }, (_, index) => `Extra skill ${index + 1}`)],
      achievements: parsed.achievements,
      workHistory: parsed.workHistory,
      projects: parsed.projects,
      education: parsed.education,
      certifications: parsed.certifications
    }
  });

  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "education-2" && /Business Administration/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "project-1-highlight-1" && /review-first/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "certification-1-detail-1" && /SYN-12345/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "raw-source-1" && /ADDITIONAL INFORMATION/.test(entry.text)));
  assert.deepEqual(payload.projectionOmissions.find((item) => item.sourcePath === "resume.skills"), {
    sourcePath: "resume.skills",
    omittedIds: Array.from({ length: 13 }, (_, index) => `skill-${index + 31}`),
    omittedCount: 13,
    truncatedIds: []
  });
});

test("job match exposes projects, education, and certifications as structured evidence with raw source fallback", () => {
  const parsed = completeSyntheticParsedResume();
  const input: MatchInput = {
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "Build TypeScript workflows.",
      requirements: ["TypeScript"]
    },
    resume: {
      summary: parsed.summary,
      rawText: completeSyntheticResumeText,
      skills: parsed.skills,
      achievements: parsed.achievements,
      workHistory: parsed.workHistory,
      projects: parsed.projects,
      education: parsed.education,
      certifications: parsed.certifications
    }
  };
  const refs = getJobMatchEvidenceReferences(input).applicant;
  assert.ok(refs.includes("resume.projects[0]"));
  assert.ok(refs.includes("resume.education[1]"));
  assert.ok(refs.includes("resume.certifications[0]"));
  assert.ok(refs.includes("resume.rawText"));

  const output: JobMatchModelOutput = {
    contractVersion: "3",
    overallFitScore: 80,
    resumeKeywordScore: 80,
    skillsMatchScore: 80,
    experienceMatchScore: 80,
    careerGoalScore: 70,
    locationWorkStyleScore: 70,
    compensationScore: null,
    confidenceScore: 75,
    confidenceBasis: "Structured evidence was cited.",
    factualMatches: [{
      applicantEvidence: [{ ref: "resume.projects[0]", excerpt: "TypeScript" }],
      jobEvidence: [{ ref: "job.requirements[0]", excerpt: "TypeScript" }],
      supportedKeywords: ["TypeScript"]
    }],
    requirementGaps: [],
    advice: {
      keywordsToEmphasize: ["TypeScript"],
      resumeAngle: "Use the cited project.",
      coverLetterAngle: "Discuss the cited workflow."
    },
    recommendation: "consider"
  };
  assert.equal(normalizeJobMatchOutput(input, output).factualMatches[0]?.applicantEvidence[0]?.ref, "resume.projects[0]");
});

test("tailoring receives only canonical career fields plus the raw source fallback", () => {
  const parsed = completeSyntheticParsedResume();
  const payload = buildResumeTailoringPayload({ id: "job-1", title: "Operations Engineer", description: "TypeScript" }, {
    id: "resume-1",
    filePath: "/private/resume.docx",
    contactInfo: parsed.contactInfo,
    rawText: completeSyntheticResumeText,
    summary: parsed.summary,
    skills: parsed.skills,
    achievements: parsed.achievements,
    workHistory: parsed.workHistory.map((item) => ({ ...item, privateNote: "nested secret" })),
    projects: parsed.projects.map((item) => ({
      ...item,
      contactInfo: { email: "nested@example.test" }
    })),
    education: parsed.education,
    certifications: parsed.certifications
  }, { careerGoals: "Reliable operations", email: "private@example.test" });

  assert.ok(payload.resume);
  assert.ok(payload.profile);
  assert.equal(payload.resume.rawText, completeSyntheticResumeText);
  assert.deepEqual(payload.resume.projects, parsed.projects);
  assert.deepEqual(payload.resume.education, parsed.education);
  assert.deepEqual(payload.resume.certifications, parsed.certifications);
  assert.ok(!("filePath" in payload.resume));
  assert.ok(!("contactInfo" in payload.resume));
  assert.ok(!("email" in payload.profile));
  assert.ok(!JSON.stringify(payload).includes("nested secret"));
  assert.ok(!JSON.stringify(payload).includes("nested@example.test"));
});
