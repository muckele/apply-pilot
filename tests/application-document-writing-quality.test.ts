import assert from "node:assert/strict";
import test from "node:test";

import { syntheticCorrectionFlowDocumentPayload, syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { PublicApiError } from "@/lib/api-errors";
import { validateCoverLetterClaims, validateTailoredResumeClaims } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { validateCoverLetterQuality, validateTailoredResumeQuality } from "@/lib/ai/application-document-quality";
import { verifyCorrectionFlowDocumentExports } from "@/lib/ai/correction-flow-document-review-bundle";
import { applicationDocumentPriorityOpportunities } from "@/lib/ai/application-document-priorities";
import { buildTailoredResumeSystemPrompt } from "@/lib/ai/resume";
import { validateResumePriorityOrder } from "@/lib/ai/application-document-writing-quality";

const payload = syntheticCorrectionFlowDocumentPayload();
// Independently fixed prose: these are source facts, not expected score/disposition labels.
const sources = [
  "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",
  "Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.",
  "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",
  "Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.",
  "I hold current Quenby certification in enterprise service operations."
];
const firstPerson = sources.map(source => source.startsWith("I ") ? source : `I ${source[0].toLowerCase()}${source.slice(1)}`);

function letter(paragraphs: string[], claims = firstPerson, sourcePayload = payload) {
  const catalog = buildApplicationDocumentFactCatalog(sourcePayload);
  return assembleCoverLetterProviderOutput(sourcePayload, {
    title: "Service Operations Director — Northwind Service Cloud",
    angle: "Service delivery, incident review and reporting.",
    coverLetter: [
      "Taylor Boundary", "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote", "",
      "Dear Northwind Service Cloud Hiring Team,", "",
      "I am applying for the Service Operations Director position at Northwind Service Cloud.", "",
      ...paragraphs.flatMap(paragraph => [paragraph, ""]),
      "Thank you for your time and consideration.", "", "Sincerely,", "Taylor Boundary"
    ].join("\n"),
    claimsUsed: claims.map((claim, index) => ({ claim, factId: catalog.find(fact => fact.excerpt === sources[index] || fact.excerpt === firstPerson[index])!.factId }))
  });
}

function validate(output: ReturnType<typeof letter>) {
  return validateCoverLetterQuality(payload, validateCoverLetterClaims(payload, output));
}

const needsRevision = (error: unknown) => error instanceof PublicApiError &&
  error.details?.code === "APPLICATION_DOCUMENT_QUALITY_REQUIRED" && error.details?.retryable === false;

test("connected first-person paragraphs keep each complete fact and job-only attestation independently cited", () => {
  const output = letter([firstPerson.slice(0, 2).join(" "), firstPerson.slice(2).join(" ")]);
  assert.equal(validate(output), output);
  assert.equal(output.claimsUsed.at(-1)?.citations[0].ref, "reviewedEvidence.facts[0].fact");
});

test("a factually valid requirement recital fails writing quality", () => {
  const output = letter([
    `Your posting highlights experience leading enterprise service delivery across cross-functional teams. ${firstPerson.slice(0, 2).join(" ")}`,
    `The role calls for demonstrated incident governance and service-level reporting improvement. ${firstPerson.slice(2).join(" ")}`
  ]);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("source-exact resume action fragments fail letter prose without weakening factual validation", () => {
  const output = letter([sources.slice(0, 2).join(" "), sources.slice(2).join(" ")], sources);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("an optional auxiliary cannot disguise an action fragment without its first-person subject", () => {
  const claims = [...firstPerson]; claims[0] = firstPerson[0].replace(/^I /u, "Have ");
  const output = letter([claims.slice(0, 2).join(" "), claims.slice(2).join(" ")], claims);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("first-person source facts cannot lose their subject when rendered as letter evidence", () => {
  const source = JSON.parse(sources.slice(0, 4).reduce((json, fact, index) => json.replaceAll(fact, firstPerson[index]), JSON.stringify(payload)));
  const fragment = letter([sources.slice(0, 2).join(" "), sources.slice(2).join(" ")], sources, source);
  assert.doesNotThrow(() => validateCoverLetterClaims(source, fragment));
  assert.throws(() => validateCoverLetterQuality(source, fragment), needsRevision);
  const complete = letter([firstPerson.slice(0, 2).join(" "), firstPerson.slice(2).join(" ")], firstPerson, source);
  assert.doesNotThrow(() => validateCoverLetterQuality(source, validateCoverLetterClaims(source, complete)));
});

test("isolated one-sentence evidence paragraphs do not pass as a connected argument", () => {
  const output = letter(firstPerson);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("repeating an otherwise supported whole fact fails quality", () => {
  const output = letter([firstPerson.slice(0, 2).join(" "), [...firstPerson.slice(2), firstPerson[0]].join(" ")]);
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("an allowed verb synonym cannot repeat the same source fact as fresh evidence", () => {
  const output = letter([firstPerson.slice(0, 2).join(" "), firstPerson.slice(2).join(" ")]);
  const duplicate = firstPerson[2].replace("improved", "enhanced");
  output.coverLetter = output.coverLetter.replace(firstPerson[2], `${firstPerson[2]} ${duplicate}`);
  output.claimsUsed.push({ ...output.claimsUsed[2], claim: duplicate });
  assert.doesNotThrow(() => validateCoverLetterClaims(payload, output));
  assert.throws(() => validate(output), needsRevision);
});

test("complete first-person plural source ownership stays intact without forcing I", () => {
  const source = JSON.parse(JSON.stringify(payload).replaceAll(sources[0], `We ${sources[0][0].toLowerCase()}${sources[0].slice(1)}`));
  const output = letter([firstPerson.slice(0, 2).join(" "), firstPerson.slice(2).join(" ")]);
  const plural = `We ${sources[0][0].toLowerCase()}${sources[0].slice(1)}`;
  output.coverLetter = output.coverLetter.replace(firstPerson[0], plural);
  output.claimsUsed[0] = { claim: plural, citations: [{ ...output.claimsUsed[0].citations[0], excerpt: plural }] };
  assert.doesNotThrow(() => validateCoverLetterQuality(source, validateCoverLetterClaims(source, output)));
  const inventedSoleOwnership = { ...output, coverLetter: output.coverLetter.replace(plural, firstPerson[0]),
    claimsUsed: output.claimsUsed.map((entry, index) => index ? entry : { ...entry, claim: firstPerson[0] }) };
  assert.throws(() => validateCoverLetterClaims(source, inventedSoleOwnership));
});

test("fluent but fabricated ownership, quantity, credential or causal prose still fails factual checks", () => {
  for (const replacement of [
    firstPerson[0].replace("42", "420"),
    firstPerson[3].replace("mentored", "managed"),
    firstPerson[4].replace("current", "expired"),
    `${firstPerson[2].slice(0, -1)}, which increased customer retention.`
  ]) {
    const index = replacement.includes("420") ? 0 : replacement.includes("managed") ? 3 : replacement.includes("expired") ? 4 : 2;
    const claims = [...firstPerson]; claims[index] = replacement;
    const output = letter([claims.slice(0, 2).join(" "), claims.slice(2).join(" ")], claims);
    assert.throws(() => validate(output), error => error instanceof PublicApiError &&
      error.details?.code !== "APPLICATION_DOCUMENT_QUALITY_REQUIRED");
  }
});

test("connected source-safe prose survives actual PDF and DOCX export verification", async () => {
  const coverLetter = validate(letter([firstPerson.slice(0, 2).join(" "), firstPerson.slice(2).join(" ")]));
  const tailoredResume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, tailoredResume));
  const exports = await verifyCorrectionFlowDocumentExports({ tailoredResume, coverLetter });
  for (const artifact of [exports.resume, exports.coverLetter]) {
    assert.equal(artifact.docxRoundTripExact, true);
    assert.equal(artifact.docxCriticalFactsPresent, true);
    assert.equal(artifact.pdfCriticalFactsPresent, true);
  }
});

test("a complete source copy and a synonym-only copy miss a clear within-record job-priority opportunity", () => {
  const source = syntheticTailoredResumeOutput();
  // Deliberately put the general onboarding bullet before the reporting/SQL outcome.
  const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
  const onboarding = "Managed onboarding and support programs for enterprise customers across three product teams.";
  const sourceOrder = source.resumeText.replace(`• ${reporting}\n• ${onboarding}`, `• ${onboarding}\n• ${reporting}`);
  for (const synonymOnly of [false, true]) {
    const wire = structuredClone(source);
    wire.resumeText = sourceOrder;
    if (synonymOnly) {
      wire.resumeText = wire.resumeText.replace(reporting, reporting.replace("Improved", "Enhanced"));
      wire.resumeTextClaims = wire.resumeTextClaims.map(entry => entry.claim === reporting
        ? { ...entry, claim: entry.claim.replace("Improved", "Enhanced") } : entry);
    }
    const output = assembleTailoredResumeProviderOutput(payload, wire);
    assert.doesNotThrow(() => validateTailoredResumeClaims(payload, output));
    assert.throws(() => validateTailoredResumeQuality(payload, output), needsRevision);
  }
});

test("accepted date typography cannot bypass within-record job-priority validation", () => {
  const wire = syntheticTailoredResumeOutput();
  const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
  const onboarding = "Managed onboarding and support programs for enterprise customers across three product teams.";
  wire.resumeText = wire.resumeText.replace(`• ${reporting}\n• ${onboarding}`, `• ${onboarding}\n• ${reporting}`)
    .replace("2017–2021", "2017-2021");
  wire.resumeTextClaims = wire.resumeTextClaims.map(entry => entry.claim.includes("Fabrikam Customer Platforms |")
    ? { ...entry, claim: entry.claim.replace("2017–2021", "2017-2021") } : entry);
  const output = assembleTailoredResumeProviderOutput(payload, wire);
  assert.doesNotThrow(() => validateTailoredResumeClaims(payload, output));
  assert.throws(() => validateTailoredResumeQuality(payload, output), needsRevision);
});

test("duplicating an unambiguous rendered record header cannot skip its priority rule", () => {
  const wire = syntheticTailoredResumeOutput();
  const header = "Fabrikam Customer Platforms | Service Delivery Manager | Seattle, WA | 2017–2021";
  wire.resumeText = wire.resumeText.replace(header, `${header}\n${header}`);
  const output = assembleTailoredResumeProviderOutput(payload, wire);
  assert.doesNotThrow(() => validateTailoredResumeClaims(payload, output));
  assert.throws(() => validateTailoredResumeQuality(payload, output), needsRevision);
});

test("another employer's bullet cannot acquire ownership by being copied into a prioritized record", () => {
  const header = "Fabrikam Customer Platforms | Service Delivery Manager | Seattle, WA | 2017–2021";
  const foreign = "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.";
  for (const before of [true, false]) {
    const wire = syntheticTailoredResumeOutput();
    const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
    wire.resumeText = before ? wire.resumeText.replace(header, `${header}\n• ${foreign}`)
      : wire.resumeText.replace(`• ${reporting}`, `• ${reporting}\n• ${foreign}`);
    const output = assembleTailoredResumeProviderOutput(payload, wire);
    assert.doesNotThrow(() => validateTailoredResumeClaims(payload, output));
    assert.throws(() => validateTailoredResumeQuality(payload, output), needsRevision);
  }
});

test("promoting a relevant outcome preserves all facts, record chronology and source ownership", () => {
  const wire = syntheticTailoredResumeOutput();
  const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
  const onboarding = "Managed onboarding and support programs for enterprise customers across three product teams.";
  wire.resumeText = wire.resumeText.replace(`• ${onboarding}\n• ${reporting}`, `• ${reporting}\n• ${onboarding}`);
  const output = assembleTailoredResumeProviderOutput(payload, wire);
  assert.equal(validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, output)), output);
  assert.ok(output.resumeText.indexOf("Contoso Service Systems") < output.resumeText.indexOf("Fabrikam Customer Platforms"));
});

test("the model sees the same conditional fact-ID ordering opportunities that the validator enforces", () => {
  const opportunities = applicationDocumentPriorityOpportunities(payload);
  assert.ok(opportunities.some(item => item.ref === "resume.workHistory[1]"));
  const prompt = buildTailoredResumeSystemPrompt(payload);
  for (const item of opportunities) for (const factId of item.leadingFactIds) assert.ok(prompt.includes(factId));
});

test("a priority claim in a summary or another employer cannot satisfy within-record ordering", () => {
  const reporting = "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.";
  const onboarding = "Managed onboarding and support programs for enterprise customers across three product teams.";
  for (const elsewhere of ["SUMMARY", "EXPERIENCE"]) {
    const wire = syntheticTailoredResumeOutput();
    wire.resumeText = wire.resumeText.replace(`• ${reporting}\n• ${onboarding}`, `• ${onboarding}\n• ${reporting}`);
    if (elsewhere === "SUMMARY") wire.resumeText = wire.resumeText.replace("SUMMARY\n", `SUMMARY\n${reporting}\n`);
    else wire.resumeText = wire.resumeText.replace(`• ${reporting}\n`, "").replace("• Directed service delivery", `• ${reporting}\n• Directed service delivery`);
    const output = assembleTailoredResumeProviderOutput(payload, wire);
    assert.throws(() => validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, output)), needsRevision);
  }
});

test("already-prioritized, tied, low-overlap and unrelated source records need no cosmetic alteration", () => {
  for (const requirements of [["Managed onboarding support programs"], ["service delivery"], ["quantum cryptography"], ["SQL"]]) {
    const source = structuredClone(payload);
    source.job = { title: "Specialist", company: "Example", requirements };
    const output = assembleTailoredResumeProviderOutput(source, syntheticTailoredResumeOutput(source));
    assert.doesNotThrow(() => validateTailoredResumeQuality(source, validateTailoredResumeClaims(source, output)));
  }
});

test("lexical matching keeps SQL distinct from PostgreSQL and preserves C++ as one token", () => {
  const record = {
    sourceText: "Example | Engineer | 2021–Present\nManaged customer programs.\nBuilt SQL checks.\nBuilt C++ services.",
    bullets: ["Managed customer programs.", "Built SQL checks.", "Built C++ services."]
  };
  const source = { resume: { workHistory: [record] }, job: { requirements: ["PostgreSQL checks", "C++ services"] } };
  const [opportunity] = applicationDocumentPriorityOpportunities(source);
  assert.ok(opportunity);
  const selected = opportunity.bullets.filter(item => opportunity.leadingFactIds.includes(item.factId!));
  assert.deepEqual(selected.map(item => item.excerpt), ["Built C++ services."]);
});

test("an adjacent record's accepted date variant still closes the current ownership block", () => {
  const firstHeader = "First | Engineer | 2021–Present";
  const secondHeader = "Second | Engineer | 2018–2020";
  const firstBullets = ["Managed customer programs.", "Built SQL reports."];
  const secondBullet = "Maintained customer records.";
  const source = { job: { requirements: ["SQL reports"] }, resume: { workHistory: [
    { sourceText: [firstHeader, ...firstBullets].join("\n"), bullets: firstBullets },
    { sourceText: [secondHeader, secondBullet].join("\n"), bullets: [secondBullet] }
  ] } };
  const evidence = buildApplicationDocumentFactCatalog(source).map(fact => ({
    claim: fact.excerpt === secondHeader ? secondHeader.replace("–", "-") : fact.excerpt,
    citations: [{ ref: fact.ref, excerpt: fact.excerpt }]
  }));
  const misplaced = [firstHeader, firstBullets[0], secondHeader.replace("–", "-"), firstBullets[1], secondBullet].join("\n");
  assert.throws(() => validateResumePriorityOrder(source, misplaced, evidence), needsRevision);
});

test("source headers ambiguous under supported whitespace normalization acquire no priority rule", () => {
  const source = { job: { requirements: ["SQL reports"] }, resume: { workHistory: [
    { sourceText: "Example | Engineer | 2021–Present", bullets: ["Managed customer programs.", "Built SQL reports for finance."] },
    { sourceText: "Example  | Engineer | 2021–Present", bullets: ["Coordinated customer support.", "Built SQL reports for operations."] }
  ] } };
  assert.deepEqual(applicationDocumentPriorityOpportunities(source), []);
});
