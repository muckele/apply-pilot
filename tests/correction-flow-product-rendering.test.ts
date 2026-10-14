import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { authoredDocumentQualityLetter } from "@/evaluation/authored-document-quality-samples";
import { syntheticCorrectionFlowDocumentPayload, syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { assembleCoverLetterProviderOutput, assembleTailoredResumeProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { buildCorrectionFlowDocumentReviewManifest } from "@/lib/ai/correction-flow-document-review";
import { buildCorrectionFlowDocumentReviewBundle, verifyCorrectionFlowDocumentExports } from "@/lib/ai/correction-flow-document-review-bundle";
import { buildCorrectionFlowDocumentReviewView } from "@/lib/ai/correction-flow-document-review-page";
import { hashAiInput } from "@/lib/ai/input-hash";
import { createDocumentExportRouteHandlers } from "@/lib/documents/document-export-route";
import { buildProductDocumentLayout, PRODUCT_DOCUMENT_LAYOUT_VERSION } from "@/lib/documents/product-document-layout";
import { defaultResumeFormat } from "@/lib/documents/resume-format";
import { PRODUCT_DOCUMENT_REVIEW_RENDERING } from "@/lib/documents/product-document-review";
import { defaultPdfFont } from "@/lib/documents/pdf-font";

const rendering: typeof PRODUCT_DOCUMENT_REVIEW_RENDERING = {
  renderer: "product-document-renderer" as const,
  layoutVersion: PRODUCT_DOCUMENT_LAYOUT_VERSION,
  resumeFormat: { ...defaultResumeFormat, fontSize: 11 },
  coverLetterFormat: { ...defaultResumeFormat },
  pdfFont: defaultPdfFont
};
function fixture() {
  const payload=syntheticCorrectionFlowDocumentPayload();
  const tailoredResume=assembleTailoredResumeProviderOutput(payload,syntheticTailoredResumeOutput());
  const coverLetter=assembleCoverLetterProviderOutput(payload,authoredDocumentQualityLetter(payload));
  return {payload,tailoredResume,coverLetter,binding:{
    manifestHash:"1".repeat(64),exactHead:"a".repeat(40),
    payloadHash:hashAiInput("correctionFlowResumeDiagnosticPayload","1",payload),
    reviewedEvidenceHash:hashAiInput("correctionFlowResumeDiagnosticReviewedEvidence","1",payload.reviewedEvidence),
    factCatalogHash:hashAiInput("applicationDocumentFactCatalog","11",buildApplicationDocumentFactCatalog(payload)),
    promptVersion:"11",model:"authored_fixture_no_provider",thinkingLevel:"LOW" as const,generationId:"offline-product-parity",
    rendering
  },expectedValidatedOutputHashes:{
    tailoredResume:hashAiInput("correctionFlowDocumentDiagnosticResume","1",tailoredResume),
    coverLetter:hashAiInput("correctionFlowDocumentDiagnosticCoverLetter","1",coverLetter)
  }};
}
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

test("the review manifest discloses the actual shared product renderer and selected formats", () => {
  const manifest=buildCorrectionFlowDocumentReviewManifest({exactHead:"a".repeat(40),providerMode:"offline_stubbed",generatedAt:new Date("2026-10-15T00:00:00Z"),payload:fixture().payload,safeLabel:"Synthetic product-rendering parity"});
  assert.equal(manifest.contractVersion,"3");
  assert.deepEqual((manifest as typeof manifest & {rendering:unknown}).rendering,rendering);
});

test("review PDF and DOCX output match the actual ordinary export route for both documents", async t => {
  // ZIP/core timestamps are metadata, not layout. Freeze only Date to compare exact DOCX bytes reliably.
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-10-15T00:00:00Z").getTime()});
  const input=fixture(),bundle=await buildCorrectionFlowDocumentReviewBundle(input),claim=bundle.claim();
  try {
    const routes=createDocumentExportRouteHandlers({requireUserId:async()=>"synthetic-parity-owner",checkRateLimit:async()=>{},
      findResumeVersion:async()=>({title:"Synthetic resume",fullText:input.tailoredResume.resumeText,...rendering.resumeFormat}),
      findGeneratedDocument:async()=>({title:"Synthetic letter",content:input.coverLetter.coverLetter})});
    for(const [index,kind] of ["resume","cover_letter"].entries())for(const format of ["pdf","docx"] as const){
      const response=await routes.POST(new NextRequest("http://127.0.0.1/api/documents/export",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[kind==="resume"?"resumeVersionId":"documentId"]:"synthetic-parity-artifact",format,pdfFont:rendering.pdfFont})}));
      assert.equal(response.status,200);
      const bytes=Buffer.from(await response.arrayBuffer());
      const verification=kind==="resume"?bundle.safe.verification.resume:bundle.safe.verification.coverLetter;
      assert.equal(format==="pdf"?verification.pdfByteHash:verification.docxByteHash,sha(bytes),`${kind} ${format} must be the same product export`);
      if(format==="pdf")assert.deepEqual(claim.renderedPdfs[index].bytes,bytes);
    }
  } finally {claim.dispose();}
});

test("the on-screen review layout matches product layout and rejects a mismatched rendering binding", async () => {
  const input=fixture(),bundle=await buildCorrectionFlowDocumentReviewBundle(input),claim=bundle.claim();
  try {
    const view=buildCorrectionFlowDocumentReviewView({envelope:claim.envelope,context:claim.context,documents:claim.documents,paths:{reviewPath:"/review/token",statePath:"/state/token",submissionPath:"/submit/token",cancelPath:"/cancel/token",resumePdfPath:"/resume/token.pdf",coverLetterPdfPath:"/letter/token.pdf"}});
    for(const [index,artifactType] of ["RESUME","COVER_LETTER"].entries()){
      const expected=buildProductDocumentLayout({artifactType:artifactType as "RESUME"|"COVER_LETTER",content:claim.documents[index].text,resumeFormat:index===0?rendering.resumeFormat:rendering.coverLetterFormat,pdfFont:rendering.pdfFont});
      assert.deepEqual(view.documents[index].layout,expected);
    }
  } finally {claim.dispose();}
  await assert.rejects(buildCorrectionFlowDocumentReviewBundle({...input,binding:{...input.binding,rendering:{...rendering,layoutVersion:"obsolete"}}} as unknown as Parameters<typeof buildCorrectionFlowDocumentReviewBundle>[0]),/rendering/i);
});


test("product export verification preserves ordered WinAnsi text instead of normalizing facts away", async () => {
  const input = fixture();
  const text = "Taylor Boundary\nSUMMARY\nCafé operations – 42 accounts — median 2 business days.\n• Maintained C# and .NET service tools; outcome €500.";
  const result = await verifyCorrectionFlowDocumentExports({
    tailoredResume: { ...input.tailoredResume, resumeText: text },
    coverLetter: { ...input.coverLetter, coverLetter: text }
  });
  assert.equal(result.resume.pdfCriticalFactsPresent, true);
  assert.equal(result.resume.docxRoundTripExact, true);
  assert.equal(result.coverLetter.pdfCriticalFactsPresent, true);
  await assert.rejects(verifyCorrectionFlowDocumentExports({
    tailoredResume: { ...input.tailoredResume, resumeText: text + "\nUnsupported 漢 glyph" },
    coverLetter: input.coverLetter
  }), /verification failed/i);
});
