import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { validateParsedResumeOutput, type ParsedResumeV5 } from "@/lib/ai/resume";
import {
  buildResumeProviderSourceInputV9,
  buildResumeSourceCatalogV8,
  buildResumeSourceCatalogV9
} from "@/lib/ai/resume-source-catalog";
import { repairPdfGluedDateRanges } from "@/lib/resumes/pdf-text";

// A common layout: "Company   Mon YYYY – Present" on one line (dates right-aligned),
// the title on the next line, then bullets. Synthetic data only.

const firstJob = [
  "Acme & Co Jan 2024 – Present",
  "Director of Operations and Strategy",
  "•Led a team of five planners across two regions and cut the weekly planning cycle from four days",
  "to two.",
  "•Rebuilt the vendor scorecard."
].join("\n");
const secondJob = [
  "Beta Labs (PE-backed portfolio company, Remote/Hybrid, New York)Feb 2020 – Dec 2023",
  "Co-Founder, Operations & Growth Lead (18 months)",
  "•Grew revenue 40% in a year.",
  "•Hired the first ten staff."
].join("\n");
const thirdJob = [
  "Gamma Group Mar 2017 – Jan 2020",
  "Operations Analyst",
  "•Built the monthly reporting pack."
].join("\n");

const source = [
  "Sample Person",
  "sample@example.com",
  "",
  "SUMMARY",
  "Operations leader.",
  "",
  "EXPERIENCE",
  firstJob,
  "",
  secondJob,
  thirdJob,
  "",
  "EDUCATION",
  "State University",
  "B.A. Economics",
  "2012 – 2016"
].join("\n");

function workRecords(catalog: ReturnType<typeof buildResumeSourceCatalogV9>) {
  return catalog.sections
    .filter((section) => section.section === "workHistory")
    .flatMap((section) => section.recordBlocks);
}

test("V9 splits company-and-date header lines into one record per job", () => {
  assert.deepEqual(workRecords(buildResumeSourceCatalogV9(source)), [firstJob, secondJob, thirdJob]);
  assert.doesNotThrow(() => buildResumeProviderSourceInputV9(source));
});

test("a wrapped bullet that ends in a date range does not start a new job", () => {
  const wrapped = [
    "Acme & Co Jan 2024 – Present",
    "Director of Operations",
    "•Ran the migration project",
    "Planning Lead Jan 2022 – Mar 2022",
    "•Closed the books."
  ].join("\n");
  const catalog = buildResumeSourceCatalogV9(`Sample Person\n\nEXPERIENCE\n${wrapped}`);
  assert.deepEqual(workRecords(catalog), [wrapped]);
});

test("V8 catalogs keep their frozen behavior for company-and-date headers", () => {
  assert.throws(
    () => buildResumeSourceCatalogV8(source),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_STRUCTURE_AMBIGUOUS"
  );
});

test("V9 validation accepts a parsed company-and-date record", () => {
  const job = ["Acme & Co Jan 2024 – Present", "Director of Operations", "•Rebuilt the vendor scorecard."].join("\n");
  const resume = ["Casey Structure", "", "EXPERIENCE", job].join("\n");
  const output: ParsedResumeV5 = {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Casey Structure", recordBlocks: ["Casey Structure"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: job, recordBlocks: [job] }
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
      sourceText: job,
      company: "Acme & Co",
      title: "Director of Operations",
      location: null,
      startDate: "Jan 2024",
      endDate: "Present",
      bullets: ["Rebuilt the vendor scorecard."]
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
  assert.doesNotThrow(() => validateParsedResumeOutput(resume, output, {
    allowLegacy: false,
    catalogVersion: "9",
    boundaryAuthority: "server_catalog"
  }));
});

test("PDF text repair separates a date range glued onto the preceding text", () => {
  assert.equal(repairPdfGluedDateRanges("Acme & CoJan 2024 – Present"), "Acme & Co Jan 2024 – Present");
  assert.equal(
    repairPdfGluedDateRanges("Beta Labs (New York)Feb 2020 – Dec 2023"),
    "Beta Labs (New York) Feb 2020 – Dec 2023"
  );
  assert.equal(repairPdfGluedDateRanges("Gamma GroupSeptember 2017 - 2020"), "Gamma Group September 2017 - 2020");
  // Not a glued date range: left exactly as extracted.
  for (const unchanged of [
    "Acme & Co Jan 2024 – Present",
    "Mayfield 2020 – 2021",
    "Joined Junction 2019 team",
    "WonMar 2020 award"
  ]) {
    assert.equal(repairPdfGluedDateRanges(unchanged), unchanged);
  }
});

test("common project section headings are recognized", async () => {
  const { resumeSourceSectionForHeading } = await import("@/lib/ai/resume-source-catalog");
  for (const heading of [
    "PROJECTS",
    "SELECTED TECHNICAL PROJECTS",
    "TECHNICAL PROJECTS",
    "Personal Projects",
    "SIDE PROJECTS",
    "KEY PROJECTS",
    "INDEPENDENT PROJECTS",
    "ACADEMIC PROJECTS",
    "RELEVANT PROJECTS"
  ]) {
    assert.equal(resumeSourceSectionForHeading(heading), "projects", heading);
  }
  assert.equal(resumeSourceSectionForHeading("PROJECT MANAGEMENT"), null);
});

test("titles that merely contain date words still start a job", () => {
  const body = [
    "Acme & Co Jan 2024 – Present",
    "Operations Lead",
    "•Ran the pricing model.",
    "Medical Group Jan 2010 – Dec 2012",
    "Sales Consultant and Business Development Representative",
    "•Started the regional pipeline.",
    "Knowhow Labs Mar 2008 – Dec 2009",
    "Knowledge and Concurrent Systems Analyst",
    "•Kept the books."
  ].join("\n");
  const catalog = buildResumeSourceCatalogV9(`Sample Person\n\nEXPERIENCE\n${body}`);
  assert.deepEqual(workRecords(catalog).map((record) => record.split("\n")[0]), [
    "Acme & Co Jan 2024 – Present",
    "Medical Group Jan 2010 – Dec 2012",
    "Knowhow Labs Mar 2008 – Dec 2009"
  ]);
});

test("pipe headers ending in a date range keep the pipe rule", () => {
  const body = [
    "Director of Operations | Acme & Co | Jan 2022 - Present",
    "• Led the team.",
    "",
    "Program Manager | Beta Labs | Mar 2019 - Dec 2021",
    "• Ran the roadmap."
  ].join("\n");
  assert.equal(workRecords(buildResumeSourceCatalogV9(`Sample Person\n\nEXPERIENCE\n${body}`)).length, 2);
});

test("PDF text repair rejoins lines the PDF wrapped, marked by a trailing space", async () => {
  const { normalizePdfResumeText } = await import("@/lib/resumes/pdf-text");
  assert.equal(
    normalizePdfResumeText("Leadership: planning, budgets, P&L \nmanagement, hiring\n•Led a team of five planners across \ntwo regions.\n•Next bullet."),
    "Leadership: planning, budgets, P&L management, hiring\n•Led a team of five planners across two regions.\n•Next bullet."
  );
  // A trailing space before a bullet, a blank line or the end is not a wrap.
  assert.equal(normalizePdfResumeText("First line \n•Bullet"), "First line \n•Bullet");
  assert.equal(normalizePdfResumeText("Heading \n\nBody "), "Heading \n\nBody ");
  // The glued-date repair still runs.
  assert.equal(normalizePdfResumeText("Acme & CoJan 2024 – Present"), "Acme & Co Jan 2024 – Present");
});

test("PDF text repair rejoins a hyphenated word the PDF wrapped", async () => {
  const { normalizePdfResumeText } = await import("@/lib/resumes/pdf-text");
  assert.equal(normalizePdfResumeText("Tools: Atlas (the re-\nentry MVP), Beacon"), "Tools: Atlas (the re-entry MVP), Beacon");
  // A dash before a capitalized or bulleted line is left alone.
  assert.equal(normalizePdfResumeText("Planning -\nNext Section"), "Planning -\nNext Section");
});

function singleJobOutput(job: string, location: string | null): ParsedResumeV5 {
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: "Casey Structure", recordBlocks: ["Casey Structure"] },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: job, recordBlocks: [job] }
    ],
    contactInfo: {
      sourceText: "Casey Structure", name: "Casey Structure", headline: null, email: null,
      phone: null, location: null, linkedin: null, github: null, portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [{
      sourceText: job,
      company: "Beta Labs",
      title: "Co-Founder",
      location,
      startDate: "Feb 2020",
      endDate: "Dec 2023",
      bullets: ["•Grew revenue 40% in New York and Boston."]
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
}

const v9 = { allowLegacy: false, catalogVersion: "9", boundaryAuthority: "server_catalog" } as const;

test("V9 accepts a location written in the job's header lines", () => {
  const job = [
    "Beta Labs (PE-backed, Remote/Hybrid, New York) Feb 2020 – Dec 2023",
    "Co-Founder",
    "•Grew revenue 40% in New York and Boston."
  ].join("\n");
  const resume = ["Casey Structure", "", "EXPERIENCE", job].join("\n");
  assert.doesNotThrow(() => validateParsedResumeOutput(resume, singleJobOutput(job, "New York"), v9));
});

test("V9 still rejects a location found only in a bullet", () => {
  const job = ["Beta Labs Feb 2020 – Dec 2023", "Co-Founder", "•Grew revenue 40% in New York and Boston."].join("\n");
  const resume = ["Casey Structure", "", "EXPERIENCE", job].join("\n");
  assert.throws(
    () => validateParsedResumeOutput(resume, singleJobOutput(job, "Boston"), v9),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "RESUME_PARSE_STRUCTURE_AMBIGUOUS"
  );
});

test("common achievement section headings are recognized", async () => {
  const { resumeSourceSectionForHeading } = await import("@/lib/ai/resume-source-catalog");
  for (const heading of ["ACHIEVEMENTS", "KEY ACHIEVEMENTS", "Selected Achievements", "CAREER HIGHLIGHTS", "KEY ACCOMPLISHMENTS", "Notable Accomplishments"]) {
    assert.equal(resumeSourceSectionForHeading(heading), "achievements", heading);
  }
  assert.equal(resumeSourceSectionForHeading("KEY SKILLS"), "skills");
});

test("V9 splits undated projects whose name line is followed by a bullet", () => {
  const projects = [
    "LEDGER Group",
    "•Small-business acquisition app that scores each listing against my criteria.",
    "Atlas PilotMVP complete",
    "•Job-application tool in TypeScript that stops for human review before submission."
  ];
  const catalog = buildResumeSourceCatalogV9(["Sample Person", "", "PROJECTS", ...projects].join("\n"));
  assert.deepEqual(
    catalog.sections.filter((section) => section.section === "projects").flatMap((section) => section.recordBlocks),
    [projects.slice(0, 2).join("\n"), projects.slice(2).join("\n")]
  );
});

test("an unfinished bullet's wrapped line is not mistaken for a new project", () => {
  const projects = [
    "LEDGER Group",
    "• Built the pricing model for",
    "Northwind Teams",
    "• Shipped the first release."
  ];
  const catalog = buildResumeSourceCatalogV9(["Sample Person", "", "PROJECTS", ...projects].join("\n"));
  assert.deepEqual(
    catalog.sections.filter((section) => section.section === "projects").flatMap((section) => section.recordBlocks),
    [projects.join("\n")]
  );
});

test("the V9 response schema asks for exactly one entry per server-owned record", async () => {
  const { buildResumeParseProviderV9JsonSchema, buildResumeParseGeminiProviderV9JsonSchema } = await import("@/lib/ai/resume");
  const input = buildResumeProviderSourceInputV9(source.replace(
    "EDUCATION",
    "PROJECTS\nLEDGER Group\n•Scores each listing.\nAtlas PilotMVP complete\n•Stops for human review.\n\nEDUCATION"
  ));
  type ArraySchema = { minItems?: number; maxItems?: number };
  const counts = { workHistory: 3, projects: 2, education: 1, certifications: 0 } as const;
  const canonical = buildResumeParseProviderV9JsonSchema(input) as { properties: Record<string, ArraySchema> };
  const gemini = buildResumeParseGeminiProviderV9JsonSchema(input) as { properties: Record<string, ArraySchema> };
  for (const [section, count] of Object.entries(counts)) {
    assert.equal(canonical.properties[section]!.minItems, count, `${section} minItems`);
    assert.equal(canonical.properties[section]!.maxItems, count, `${section} maxItems`);
    assert.equal(gemini.properties[section]!.minItems, count, `${section} Gemini minItems`);
  }
});
