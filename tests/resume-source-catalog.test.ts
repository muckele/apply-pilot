import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { fullSizeSyntheticDocxExtractedText } from "@/tests/fixtures/resume-estimator-boundary-data";

type CatalogModule = typeof import("@/lib/ai/resume-source-catalog");

async function loadCatalogModule() {
  const loaded = await import("@/lib/ai/resume-source-catalog").catch(() => null);
  assert.ok(loaded, "resume source catalog module must exist");
  return loaded as CatalogModule;
}

const catalogSource = [
  "Zoë Example",
  "Résumé Systems Architect",
  "zoe@example.test | Montréal, Canada",
  "",
  "PROFESSIONAL SUMMARY",
  "Builds source-faithful systems.",
  "",
  "CORE SKILLS",
  "Delivery: planning, communication",
  "Platforms: TypeScript, PostgreSQL",
  "",
  "WORK EXPERIENCE",
  "Systems Architect",
  "Example Labs",
  "2022 - Present",
  "• Preserved every source line.",
  "",
  "PROJECTS",
  "Repeated Evidence | Unicode Fixture | 2026",
  "Repeated evidence",
  "Repeated evidence",
  "",
  "ACHIEVEMENTS",
  "Reliability: Kept every fact reachable.",
  "",
  "ADDITIONAL INFORMATION",
  "Languages: English and French"
].join("\r\n");

test("builds stable exact source sections and line identities", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const catalog = buildResumeSourceCatalog(catalogSource);

  assert.doesNotMatch(catalog.normalizedSource, /\r/u);
  assert.deepEqual(
    catalog.sections.map((section) => [section.id, section.section, section.heading]),
    [
      ["section-1", "contactInfo", null],
      ["section-2", "summary", "PROFESSIONAL SUMMARY"],
      ["section-3", "skills", "CORE SKILLS"],
      ["section-4", "workHistory", "WORK EXPERIENCE"],
      ["section-5", "projects", "PROJECTS"],
      ["section-6", "achievements", "ACHIEVEMENTS"],
      ["section-7", "additional", "ADDITIONAL INFORMATION"]
    ]
  );

  for (const section of catalog.sections) {
    assert.equal(
      catalog.normalizedSource.slice(section.startOffset, section.endOffset),
      section.sourceText
    );
    section.lines.forEach((line, index) => {
      assert.equal(line.id, `${section.id}-line-${index + 1}`);
      assert.equal(
        catalog.normalizedSource.slice(line.startOffset, line.endOffset),
        line.sourceText
      );
    });
  }

  const project = catalog.sections.find((section) => section.section === "projects");
  assert.ok(project);
  const repeated = project.lines.filter((line) => line.sourceText === "Repeated evidence");
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0]!.id, repeated[1]!.id);
  assert.deepEqual(project.recordBlocks, [
    "Repeated Evidence | Unicode Fixture | 2026\nRepeated evidence\nRepeated evidence"
  ]);
});

test("binds only deterministic nonstructural record blocks locally", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const catalog = buildResumeSourceCatalog(catalogSource);
  const bySection = new Map(catalog.sections.map((section) => [section.section, section]));

  assert.deepEqual(bySection.get("contactInfo")?.recordBlocks, [
    "Zoë Example\nRésumé Systems Architect\nzoe@example.test | Montréal, Canada"
  ]);
  assert.deepEqual(bySection.get("summary")?.recordBlocks, ["Builds source-faithful systems."]);
  assert.deepEqual(bySection.get("skills")?.recordBlocks, [
    "Delivery: planning, communication",
    "Platforms: TypeScript, PostgreSQL"
  ]);
  assert.deepEqual(bySection.get("achievements")?.recordBlocks, [
    "Reliability: Kept every fact reachable."
  ]);
  assert.deepEqual(bySection.get("additional")?.recordBlocks, [
    "Languages: English and French"
  ]);
  assert.deepEqual(bySection.get("workHistory")?.recordBlocks, [
    "Systems Architect\nExample Labs\n2022 - Present\n• Preserved every source line."
  ]);
  assert.deepEqual(bySection.get("projects")?.recordBlocks, [
    "Repeated Evidence | Unicode Fixture | 2026\nRepeated evidence\nRepeated evidence"
  ]);
});

test("keeps indented nonstructural source lines reachable in provider records", async () => {
  const { buildResumeProviderSourceInput } = await loadCatalogModule();
  const input = buildResumeProviderSourceInput([
    "Jordan Example",
    "",
    "SKILLS",
    "Visible Skill",
    "  Hidden Skill"
  ].join("\n"));
  const skills = input.sections.find((section) => section.section === "skills");

  assert.deepEqual(skills?.records.map((record) => record.lines.map((line) => line.text)), [
    ["Visible Skill"],
    ["  Hidden Skill"]
  ]);
});

test("preserves internal manual blank lines inside an exact section slice", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
    "Jordan Example",
    "",
    "SUMMARY",
    "First summary paragraph.",
    "",
    "Second summary paragraph.",
    "",
    "SKILLS",
    "Testing"
  ].join("\n");
  const catalog = buildResumeSourceCatalog(source);
  const summary = catalog.sections.find((section) => section.section === "summary");

  assert.equal(summary?.sourceText, "First summary paragraph.\n\nSecond summary paragraph.");
  assert.deepEqual(summary?.lines.map((line) => line.sourceText), [
    "First summary paragraph.",
    "",
    "Second summary paragraph."
  ]);
});

test("fails closed for unsupported unheaded structure and empty recognized sections", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();

  for (const source of [
    "Jordan Example\nOperations Analyst\nNorthwind Services\n2022 - Present",
    "Jordan Example\n\nSUMMARY\n\nSKILLS\nTypeScript"
  ]) {
    assert.throws(
      () => buildResumeSourceCatalog(source),
      (error) => error instanceof PublicApiError &&
        ["RESUME_PARSE_STRUCTURE_AMBIGUOUS", "RESUME_PARSE_INCOMPLETE"]
          .includes(String(error.details?.code))
    );
  }
});

test("builds exact server-owned structural records for the complete synthetic resume", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const catalog = buildResumeSourceCatalog(fullSizeSyntheticDocxExtractedText);
  const structural = catalog.sections.filter((section) =>
    ["workHistory", "projects", "education", "certifications"].includes(section.section));

  assert.deepEqual(
    structural.map((section) => [section.section, section.recordBlocks.length]),
    [
      ["workHistory", 5],
      ["projects", 2],
      ["education", 2],
      ["certifications", 1]
    ]
  );
  assert.deepEqual(
    structural.flatMap((section) => section.recordBlocks.map((block) =>
      [section.section, block.split("\n")[0], block.split("\n").at(-1)])),
    [
      ["workHistory", "Director of Service Operations | Northwind Systems", "• Partnered with security and engineering leaders to document access boundaries, exception handling, and release readiness with recorded evidence for scenario 5."],
      ["workHistory", "Senior Program Manager | Contoso Delivery Labs", "• Presented quarterly delivery findings with transparent assumptions, unresolved risks, and recommended follow-up experiments with recorded evidence for scenario 9."],
      ["workHistory", "Operations Analytics Manager | Fabrikam Services", "• Investigated unusual trends with reproducible queries and separated observed facts from hypotheses in leadership updates with recorded evidence for scenario 13."],
      ["workHistory", "Customer Experience Lead | Adventure Works Cloud", "• Mentored specialists on structured troubleshooting, empathetic writing, and evidence-based recommendations with recorded evidence for scenario 17."],
      ["workHistory", "Business Process Analyst | Tailspin Consulting", "• Supported change workshops with synthetic scenarios, accessible job aids, and observable adoption measures with recorded evidence for scenario 21."],
      ["projects", "Service Reliability Workbench | Auditable Operations Dashboard | 2025", "• Built a synthetic dashboard that preserved source references while highlighting service risk, ownership, and follow-up status with recorded evidence for scenario 22."],
      ["projects", "Planning Evidence Library | Decision Support Catalog | 2024", "• Created a searchable evidence catalog for synthetic plans with stable identifiers, bounded summaries, and omission tracking with recorded evidence for scenario 23."],
      ["education", "Graduate Certificate in Service Operations and Analytics", "Completed a 480-hour applied program in service design, operational measurement, responsible data use, and change leadership."],
      ["education", "Bachelor of Arts in Business Administration", "Completed interdisciplinary coursework in organizational behavior, statistics, economics, and professional communication."],
      ["certifications", "Certified Service Operations Professional | Synthetic Standards Board | 2024", "Credential ID: SYN-OPS-6403"]
    ]
  );
});

test("keeps internal blanks and blank-before-bullets inside one work record", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Platform Lead | Example Labs",
    "2022 - Present",
    "",
    "• Built reliable systems.",
    "",
    "Expanded the program across teams.",
    "",
    "Operations Lead | Northwind",
    "2020 - 2022",
    "• Improved service quality."
  ].join("\n");

  const work = buildResumeSourceCatalog(source).sections.find((section) =>
    section.section === "workHistory");
  assert.deepEqual(work?.recordBlocks, [
    "Platform Lead | Example Labs\n2022 - Present\n\n• Built reliable systems.\n\nExpanded the program across teams.",
    "Operations Lead | Northwind\n2020 - 2022\n• Improved service quality."
  ]);
});

test("splits adjacent dateless labeled work records without model-owned boundaries", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
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

  const work = buildResumeSourceCatalog(source).sections.find((section) =>
    section.section === "workHistory");
  assert.deepEqual(work?.recordBlocks, [
    "Title: VP\nCompany: Yahoo!\n• Led reliable delivery.",
    "Role: Engineer\nEmployer: Acme Partners.\n• Built safe systems."
  ]);
});

test("splits an explicit project header after one unmarked technology value", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
    "Jordan Example",
    "",
    "PROJECTS",
    "Project One | First Fixture | 2025",
    "Technologies:",
    "React",
    "Project Two | Second Fixture | 2024",
    "• Preserved the second record."
  ].join("\n");

  const projects = buildResumeSourceCatalog(source).sections.find((section) =>
    section.section === "projects");
  assert.deepEqual(projects?.recordBlocks, [
    "Project One | First Fixture | 2025\nTechnologies:\nReact",
    "Project Two | Second Fixture | 2024\n• Preserved the second record."
  ]);
});

test("keeps a trailing work-mode location with its record before the next header", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Role One",
    "Acme One",
    "2020 - 2022",
    "Remote",
    "Role Two",
    "Acme Two",
    "2018 - 2020",
    "• Preserved the second record."
  ].join("\n");

  const work = buildResumeSourceCatalog(source).sections.find((section) =>
    section.section === "workHistory");
  assert.deepEqual(work?.recordBlocks, [
    "Role One\nAcme One\n2020 - 2022\nRemote",
    "Role Two\nAcme Two\n2018 - 2020\n• Preserved the second record."
  ]);
});

test("keeps every supported standalone country or work mode with the preceding work record", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  for (const location of ["In-person", "USA", "UK", "Canada", "United States"]) {
    const source = [
      "Jordan Example",
      "",
      "WORK EXPERIENCE",
      "Role One",
      "Acme One",
      "2020 - 2022",
      location,
      "Role Two",
      "Acme Two",
      "2018 - 2020",
      "• Preserved the second record."
    ].join("\n");

    const work = buildResumeSourceCatalog(source).sections.find((section) =>
      section.section === "workHistory");
    assert.equal(work?.recordBlocks[0]?.split("\n").at(-1), location);
    assert.equal(work?.recordBlocks[1]?.split("\n")[0], "Role Two");
  }
});

test("fails closed on an unsupported structural paragraph boundary", async () => {
  const { buildResumeSourceCatalog } = await loadCatalogModule();
  const source = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Platform Lead | Example Labs",
    "2022 - Present",
    "• Built reliable systems.",
    "",
    "Unlabelled fragment",
    "Without a record header or complete narrative"
  ].join("\n");

  assert.throws(
    () => buildResumeSourceCatalog(source),
    (error) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_STRUCTURE_AMBIGUOUS" &&
      error.details?.section === "workHistory" &&
      error.details?.fieldPath === "sourceSections[1].recordBlocks" &&
      error.details?.structureReason === "unsupported_record_boundary"
  );
});
