import assert from "node:assert/strict";
import test from "node:test";
import { syntheticCorrectionFlowDocumentPayload, syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { PublicApiError } from "@/lib/api-errors";
import { assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { validateTailoredResumeClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { validateTailoredResumeQuality } from "@/lib/ai/application-document-quality";
import { tailoredResumeProviderSchema, tailoredResumeSchema } from "@/lib/ai/resume";

const payload = syntheticCorrectionFlowDocumentPayload();
const work = "Contoso Service Systems | Senior Service Operations Manager | Remote | 2021–Present";
const education = "Synthetic Institute | Graduate Certificate in Service Operations and Analytics | 2020–2021";
function full(sourceLine: string, changedLine: string) {
  const wire = syntheticTailoredResumeOutput(payload);
  wire.resumeText = wire.resumeText.replace(sourceLine, changedLine);
  const entry = wire.resumeTextClaims.find(item => item.claim === sourceLine);
  assert.ok(entry);
  entry.claim = changedLine;
  return validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload,
    tailoredResumeSchema.parse(assembleTailoredResumeProviderOutput(payload, tailoredResumeProviderSchema.parse(wire)))));
}
const relationFailure = (error: unknown) => error instanceof PublicApiError &&
  error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" && error.details?.failureClass === "source_relation_mismatch";

test("equivalent source-backed year-range punctuation passes complete provider assembly and validation", () => {
  for (const [line, range] of [[work, "2021–Present"], [education, "2020–2021"]]) {
    const [start, end] = range.split("–");
    for (const separator of ["-", "–", "—", " - ", " – ", " — "]) {
      assert.doesNotThrow(() => full(line, line.replace(range, start + separator + end)), separator);
    }
  }
});

test("date punctuation equivalence cannot change endpoints, current status, ownership or qualifiers", () => {
  for (const changed of [
    work.replace("2021–Present", "2020-Present"),
    work.replace("2021–Present", "2021-2024"),
    work.replace("2021–Present", "2021-Current"),
    work.replace("2021–Present", "Present-2021"),
    work.replace("2021–Present", "2021-Present").replace("Contoso Service Systems", "Invented Employer"),
    work.replace("2021–Present", "2021-Present").replace("Senior ", ""),
    work.replace("2021–Present", "2021-Present").replace("Remote", "Onsite"),
    education.replace("2020–2021", "2021-2020"),
    education.replace("2020–2021", "2020-Present")
  ]) assert.throws(() => full(changed.includes("Synthetic Institute") ? education : work, changed), relationFailure);
});

function one(source: ApplicationDocumentPayload, excerpt: string, claim: string) {
  const fact = buildApplicationDocumentFactCatalog(source).find(item => item.excerpt === excerpt);
  assert.ok(fact, excerpt);
  return validateTailoredResumeClaims(source, {
    professionalSummary: claim, skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [], resumeText: claim,
    claimEvidence: [{ claim, citations: [{ ref: fact.ref, excerpt: fact.excerpt }] }]
  });
}

test("date equivalence does not normalize credential IDs, technology names or arbitrary internal hyphens", () => {
  for (const [source, excerpt, changed] of [
    [{ resume: { certifications: [{ name: "Credential", details: ["Credential ID: CSOP-2020–2021"] }] } }, "Credential ID: CSOP-2020–2021", "Credential ID: CSOP-2020-2021"],
    [{ resume: { skills: ["C++", "C#", ".NET", "service-level reporting"] } }, "C++", "C#"],
    [{ resume: { skills: ["ASP.NET"] } }, "ASP.NET", "ASP-NET"],
    [{ resume: { skills: ["service-level reporting"] } }, "service-level reporting", "service level reporting"],
    [{ resume: { workHistory: [{ startDate: "2020", endDate: "2021", bullets: ["Credential ID: 2020–2021"] }] } }, "Credential ID: 2020–2021", "Credential ID: 2020-2021"]
  ] as const) assert.throws(() => one(source as unknown as ApplicationDocumentPayload, excerpt, changed), relationFailure);
});

test("untyped year-looking identifiers do not gain date semantics", () => {
  const source = { resume: { rawText: "Reference 2020–2021" } };
  assert.throws(() => one(source, "Reference 2020–2021", "Reference 2020-2021"), relationFailure);
});


test("a year-looking employer is not a date component even when its endpoints equal the record dates", () => {
  const source = { resume: { workHistory: [{ company: "2020–2021", startDate: "2020", endDate: "2021" }] } };
  assert.throws(() => one(source, "2020–2021", "2020-2021"), relationFailure);
});


test("a project header range is grounded in that project's explicit date field", () => {
  const source = { resume: { projects: [{ name: "Synthetic Project", date: "2020–2021", sourceText: "Synthetic Project | 2020–2021" }] } };
  assert.doesNotThrow(() => one(source, "Synthetic Project | 2020–2021", "Synthetic Project | 2020-2021"));
  const inconsistent = { resume: { projects: [{ ...source.resume.projects[0], date: "2019–2021" }] } };
  assert.throws(() => one(inconsistent, "Synthetic Project | 2020–2021", "Synthetic Project | 2020-2021"), relationFailure);
});
