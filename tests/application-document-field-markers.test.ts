import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
import { PublicApiError } from "@/lib/api-errors";
import {
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  getApplicationDocumentClaimOrigins,
  normalizeApplicationDocumentSourceLine,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import { validateTailoredResumeQuality } from "@/lib/ai/application-document-quality";
import { verifyCorrectionFlowDocumentExports } from "@/lib/ai/correction-flow-document-review-bundle";
import { tailoredResumeProviderSchema, tailoredResumeSchema } from "@/lib/ai/resume";

const fields = ["professionalSummary", "skillsSection", "bulletRewrites", "rolesOrProjectsToEmphasize", "resumeTextClaims"] as const;
type Field = typeof fields[number];
const markers = ["", "-", "*", "•", "▪", "◦", "–", "—"] as const;
const payload = syntheticCorrectionFlowDocumentPayload();
const catalog = buildApplicationDocumentFactCatalog(payload);
const decorate = (text: string, marker: string) => marker ? `  ${marker} ${text}` : text;

function selectField(wire: TailoredResumeProviderOutput, field: Field, text: string, factId: string) {
  switch (field) {
    case "professionalSummary":
      wire.professionalSummary = text;
      wire.professionalSummaryFactId = factId;
      return "professionalSummary";
    case "skillsSection":
      wire.skillsSection[0] = { text, factId };
      return "skillsSection[0].text";
    case "bulletRewrites":
      wire.bulletRewrites = [{ factId, rewrite: text, reason: "Synthetic field-placement regression." }];
      return "bulletRewrites[0].rewrite";
    case "rolesOrProjectsToEmphasize":
      wire.rolesOrProjectsToEmphasize = [{ text, factId }];
      return "rolesOrProjectsToEmphasize[0].text";
    case "resumeTextClaims":
      wire.resumeTextClaims.push({ claim: text, factId });
      return `resumeTextClaims[${wire.resumeTextClaims.length - 1}].claim`;
  }
}

function fieldValue(output: ReturnType<typeof assembleTailoredResumeProviderOutput>, field: Field, claim: string) {
  switch (field) {
    case "professionalSummary": return output.professionalSummary;
    case "skillsSection": return output.skillsSection[0];
    case "bulletRewrites": return output.bulletRewrites[0].rewrite;
    case "rolesOrProjectsToEmphasize": return output.rolesOrProjectsToEmphasize[0];
    case "resumeTextClaims": return output.claimEvidence.find(entry => entry.claim === claim)?.claim;
  }
}

function completeScenario(field: Field, fieldMarker: string, renderedMarker: string) {
  const wire: TailoredResumeProviderOutput = syntheticTailoredResumeOutput(payload);
  const firstBullet = wire.resumeText.split("\n").find(line => line.startsWith("• "))!;
  const claim = field === "professionalSummary" ? wire.professionalSummary
    : field === "skillsSection" ? wire.skillsSection[0].text
      : field === "rolesOrProjectsToEmphasize" ? wire.resumeTextClaims.find(entry =>
        entry.claim.includes("|") && catalog.find(fact => fact.factId === entry.factId)?.ref.startsWith("resume.workHistory["))!.claim
        : normalizeApplicationDocumentSourceLine(firstBullet);
  const fact = catalog.find(entry => entry.excerpt === claim);
  assert.ok(fact);
  // Only the selected field represents this line; a duplicate fallback cannot mask a broken association.
  wire.resumeTextClaims = wire.resumeTextClaims.filter(entry => entry.claim !== claim);
  const originFieldPath = selectField(wire, field, decorate(claim, fieldMarker), fact.factId);
  wire.resumeText = wire.resumeText.split("\n").map(line =>
    normalizeApplicationDocumentSourceLine(line) === claim ? decorate(claim, renderedMarker) : line).join("\n");
  return { wire, claim, fact, originFieldPath };
}

function validate(source: ApplicationDocumentPayload, wire: TailoredResumeProviderOutput) {
  const assembled = assembleTailoredResumeProviderOutput(source, tailoredResumeProviderSchema.parse(wire));
  validateTailoredResumeQuality(source, validateTailoredResumeClaims(source, tailoredResumeSchema.parse(assembled)));
  return assembled;
}

for (const field of fields) {
  test(`${field} supports each independent field and rendered leading-marker placement`, () => {
    for (const fieldMarker of markers) for (const renderedMarker of markers) {
      const { wire, claim, fact, originFieldPath } = completeScenario(field, fieldMarker, renderedMarker);
      const before = structuredClone(wire);
      const output = validate(payload, wire);
      assert.equal(fieldValue(output, field, claim), claim, `${fieldMarker}/${renderedMarker}`);
      assert.equal(output.resumeText, before.resumeText);
      assert.deepEqual(wire, before, "assembly must not mutate the decoded provider value");
      const index = output.claimEvidence.findIndex(entry => entry.claim === claim && entry.citations[0].ref === fact.ref);
      assert.notEqual(index, -1);
      assert.deepEqual(getApplicationDocumentClaimOrigins(output.claimEvidence)[index], { factId: fact.factId, originFieldPath });
    }
  });
}

test("marker-decorated fields traverse actual PDF and DOCX verification", async () => {
  const coverLetter = assembleCoverLetterProviderOutput(payload, syntheticCoverLetterOutput(payload));
  for (const field of fields) for (const marker of markers.slice(1)) {
    const { wire } = completeScenario(field, marker, marker);
    const result = await verifyCorrectionFlowDocumentExports({ tailoredResume: validate(payload, wire), coverLetter });
    assert.equal(result.resume.docxRoundTripExact, true, `${field}/${marker}`);
    assert.equal(result.resume.docxCriticalFactsPresent, true, `${field}/${marker}`);
    assert.equal(result.resume.pdfCriticalFactsPresent, true, `${field}/${marker}`);
  }
});

test("a decorated approved verb rewrite retains its source original and complete line association", () => {
  const wire: TailoredResumeProviderOutput = syntheticTailoredResumeOutput(payload);
  const item = wire.resumeTextClaims.find(entry => entry.claim.startsWith("Built "));
  assert.ok(item);
  const original = item.claim;
  const rewrite = original.replace(/^Built /u, "Created ");
  wire.resumeTextClaims = wire.resumeTextClaims.filter(entry => entry !== item);
  wire.resumeText = wire.resumeText.replace(original, rewrite);
  wire.bulletRewrites = [{ factId: item.factId, rewrite: `• ${rewrite}`, reason: "Existing permitted leading-action substitution." }];
  const output = validate(payload, wire);
  assert.equal(output.bulletRewrites[0].rewrite, rewrite);
  assert.equal(output.bulletRewrites[0].original, original);
});

test("decorative normalization cannot weaken factual or per-item source validation in any field", () => {
  const changes = [
    ["Assisted the director with quarterly planning.", "Led quarterly planning."],
    ["Did not own production Kubernetes administration.", "Owned production Kubernetes administration."],
    ["Reduced support time by 18%.", "Reduced support time by 81%."],
    ["Maintained C# and ASP.NET service-level tools.", "Maintained C++ and ASP-NET service level tools."],
    ["Credential ID: CSOP-24017", "Credential ID: CSOP-24071"],
    ["Built safe workflows for 12 teams.", "Built safe workflows for 12 teams. Led hiring."],
    ["Maintained service-level tools.", "Maintained service level tools."]
  ];
  for (const field of fields) for (const marker of markers.slice(1)) for (const [source, changed] of changes) {
    const sourcePayload = { resume: { rawText: source, workHistory: [{ bullets: [source] }] } };
    const fact = buildApplicationDocumentFactCatalog(sourcePayload).find(entry => entry.excerpt === source)!;
    const wire: TailoredResumeProviderOutput = {
      professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__",
      skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [], resumeTextClaims: [],
      unsupportedKeywords: [], formattingWarnings: [], resumeText: decorate(changed, marker)
    };
    selectField(wire, field, decorate(changed, marker), fact.factId);
    const output = assembleTailoredResumeProviderOutput(sourcePayload, wire);
    assert.throws(() => validateTailoredResumeClaims(sourcePayload, output), error => error instanceof PublicApiError &&
      ["APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "APPLICATION_DOCUMENT_NEGATION_REVERSAL"].includes(String(error.details?.code)), `${field}/${marker}`);
  }
  for (const field of fields) {
    const { wire, fact } = completeScenario(field, "•", "•");
    const wrong = catalog.find(entry => entry.factId !== fact.factId)!;
    selectField(wire, field, decorate(fact.excerpt, "•"), wrong.factId);
    assert.throws(() => validate(payload, wire), error => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", field);
  }
});

test("field markers cannot associate an unrelated generated line", () => {
  for (const field of fields) {
    const { wire, claim } = completeScenario(field, "•", "•");
    wire.resumeText = wire.resumeText.replace(claim, "Invented replacement absent from the selected evidence.");
    assert.throws(() => assembleTailoredResumeProviderOutput(payload, wire), error => error instanceof PublicApiError &&
      ["APPLICATION_DOCUMENT_EVIDENCE_REQUIRED", "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT"].includes(String(error.details?.code)), field);
  }
});

test("equivalent decorated rewrites deduplicate without hiding a wrong fact or losing the first provider origin", () => {
  const { wire, claim, fact } = completeScenario("bulletRewrites", "•", "•");
  wire.bulletRewrites = markers.slice(1).map(marker => ({
    factId: fact.factId, rewrite: decorate(claim, marker), reason: "Synthetic duplicate association."
  }));
  const output = validate(payload, wire);
  const matching = output.claimEvidence.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.claim === claim);
  assert.equal(matching.length, 1);
  assert.ok(output.bulletRewrites.every(item => item.rewrite === claim && item.original === fact.excerpt));
  assert.deepEqual(getApplicationDocumentClaimOrigins(output.claimEvidence)[matching[0].index], {
    factId: fact.factId, originFieldPath: "bulletRewrites[0].rewrite"
  });
  wire.bulletRewrites.push({
    factId: catalog.find(item => item.factId !== fact.factId)!.factId,
    rewrite: `• ${claim}`, reason: "Synthetic wrong-source duplicate."
  });
  assert.throws(() => validate(payload, wire), error => error instanceof PublicApiError &&
    error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM");
});
