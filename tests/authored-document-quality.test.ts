import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { buildProductDocumentLayout } from "@/lib/documents/product-document-layout";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";
import { realisticDocumentQualityPayload } from "@/evaluation/document-quality-career-fixture";
import { authoredDocumentQualityLetter } from "@/evaluation/authored-document-quality-samples";
import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import { assembleCoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { getCoverLetterUncitedLines, validateCoverLetterClaims } from "@/lib/ai/application-document-claims";
import { validateCoverLetterQuality } from "@/lib/ai/application-document-quality";
import { defaultResumeFormat } from "@/lib/documents/resume-format";

test("supported typography keeps a project heading with its first details", () => {
  for(const [fontSize,lineSpacing] of [[11,130],[12,120]]) {
  const layout=buildProductDocumentLayout({artifactType:"RESUME",content:syntheticTailoredResumeOutput().resumeText,resumeFormat:{...defaultResumeFormat,fontSize,lineSpacing}});
  for(const page of layout.pages) {
    assert.ok(!["section_heading","record_heading"].includes(page.blocks.at(-1)!.role),`page ${page.number} ends with an orphan heading`);
  }
  }
});

test("DOCX exposes semantic section and record headings without changing source text", async () => {
  const bytes=await renderProductDocument({artifactType:"RESUME",content:syntheticTailoredResumeOutput().resumeText,resumeFormat:{...defaultResumeFormat,fontSize:11},format:"docx"});
  const xml=await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  assert.ok(xml.includes('<w:pStyle w:val="Heading1"/>'),"section headings need native Word heading structure");
  assert.ok(xml.includes('<w:pStyle w:val="Heading2"/>'),"record headings need native Word heading structure");
});


test("the C2 authored letter organizes two supported examples around distinct published job priorities", () => {
  const wire=authoredDocumentQualityLetter();
  const contexts=[
    "Your posting highlights experience leading enterprise service delivery across cross-functional teams.",
    "The role calls for demonstrated incident governance and service-level reporting improvement."
  ];
  const allowed=getCoverLetterUncitedLines(syntheticCorrectionFlowDocumentPayload());
  for(const context of contexts) {
    assert.ok(allowed.includes(context));
    assert.equal(wire.coverLetter.split(context).length-1,1);
    const paragraph=wire.coverLetter.split(/\n\s*\n/u).find(value=>value.startsWith(context));
    assert.ok(paragraph,"Each evidence paragraph needs its published role context.");
    assert.equal(wire.claimsUsed.filter(entry=>paragraph.includes(entry.claim)).length,2);
    assert.ok(!wire.claimsUsed.some(entry=>entry.claim===context));
  }
  assert.equal(new Set(wire.claimsUsed.map(entry=>entry.claim)).size,wire.claimsUsed.length);
  assert.match(wire.coverLetter,/42 enterprise accounts/u);
  assert.match(wire.coverLetter,/five business days to two/u);
  assert.match(wire.coverLetter,/18%/u);
  assert.match(wire.coverLetter,/six service coordinators/u);
  assert.match(wire.coverLetter,/Quenby/u);
});

test("the authored letter stays valid against unchanged source facts and rejects altered outcomes", () => {
  const payload=syntheticCorrectionFlowDocumentPayload();
  const output=assembleCoverLetterProviderOutput(payload,authoredDocumentQualityLetter(payload));
  assert.doesNotThrow(()=>validateCoverLetterQuality(payload,validateCoverLetterClaims(payload,output)));
  assert.throws(()=>validateCoverLetterClaims(payload,{...output,coverLetter:output.coverLetter.replace('18%','38%')}));
});


test("authored copy follows the declared multi-job source instead of freezing the short profile's years", () => {
  const payload=realisticDocumentQualityPayload();
  const output=assembleCoverLetterProviderOutput(payload,authoredDocumentQualityLetter(payload));
  assert.doesNotThrow(()=>validateCoverLetterQuality(payload,validateCoverLetterClaims(payload,output)));
  assert.match(output.coverLetter,/twelve years/u);
  assert.doesNotMatch(output.coverLetter,/nine years/u);
});
