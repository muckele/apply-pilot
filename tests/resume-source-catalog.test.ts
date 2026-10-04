import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";

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
  assert.deepEqual(project.recordBlocks, []);
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
  assert.deepEqual(bySection.get("workHistory")?.recordBlocks, []);
  assert.deepEqual(bySection.get("projects")?.recordBlocks, []);
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
