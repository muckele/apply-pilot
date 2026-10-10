import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { chromium } from "playwright";

import { buildCorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";
import { renderCanonicalApplicationDocumentPdfV2 } from "@/lib/documents/application-document-layout-v2";

const hash = (character: string) => character.repeat(64);

function input() {
  const resumeText = "Taylor Boundary\ntaylor.boundary@example.test | Remote\nService Operations Leader\nSUMMARY\nSynthetic browser resume fact.";
  const coverText = "Taylor Boundary\ntaylor.boundary@example.test | Remote\n\nDear Synthetic Employer,\n\nSynthetic browser cover fact.\n\nSincerely,\nTaylor Boundary";
  const resumePdf = renderCanonicalApplicationDocumentPdfV2({ artifactType: "RESUME", content: resumeText });
  const coverPdf = renderCanonicalApplicationDocumentPdfV2({ artifactType: "COVER_LETTER", content: coverText });
  const pdfHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    envelope: buildCorrectionFlowDocumentReviewEnvelope({
      manifestHash: hash("1"), exactHead: "a".repeat(40), payloadHash: hash("2"),
      sourceResumeHash: hash("3"), profileHash: hash("4"), jobProjectionHash: hash("5"),
      reviewedEvidenceHash: hash("6"), factCatalogHash: hash("7"), promptVersion: "8",
      model: "gemini-3.8-flash", thinkingLevel: "LOW", generationId: "browser-review",
      documents: [
        { kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: pdfHash(resumePdf) },
        { kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: pdfHash(coverPdf) }
      ]
    }),
    documents: [
      { kind: "resume" as const, title: "Synthetic tailored resume", text: resumeText, evidence: [] },
      { kind: "cover_letter" as const, title: "Synthetic cover letter", text: coverText, evidence: [] }
    ] as const,
    context: {
      sourceResumeText: "Taylor Boundary\nService Operations Lead\nComplete browser source résumé.",
      reviewedFacts: ["Holds a current Quenby service certification."],
      targetJob: {
        title: "Service Operations Director",
        company: "Northwind Service Cloud",
        location: "Remote",
        description: "Lead enterprise service delivery and operational governance.",
        requirements: ["Enterprise service delivery", "Incident governance"],
        preferredQualifications: ["Business education"],
        detectedTechStack: ["TypeScript", "PostgreSQL"]
      }
    },
    renderedPdfs: [
      { kind: "resume" as const, bytes: resumePdf },
      { kind: "cover_letter" as const, bytes: coverPdf }
    ] as const
  };
}

test("desktop and mobile local review show both documents and require complete exact decisions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const fixture = input();
    const review = await startCorrectionFlowDocumentOwnerReview(fixture);
    t.after(() => review.close("test_cleanup"));
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    await page.goto(review.reviewUrl);
    await page.getByText("Synthetic browser resume fact.").waitFor();
    await page.getByText("Complete browser source résumé.").waitFor();
    await page.getByRole("heading", { name: "Service Operations Director" }).waitFor();
    assert.equal(await page.locator("[data-document-card]").count(), 2);
    assert.equal(await page.locator("textarea, [contenteditable], a[download]").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (viewport.width === 1280) {
      const boxes = await page.locator("[data-document-card]").evaluateAll((cards) =>
        cards.map((card) => card.getBoundingClientRect().toJSON())
      );
      assert.ok(boxes.every((box) => box.width >= 1100));
      assert.ok(Math.abs(boxes[0]!.x - boxes[1]!.x) < 2);
    }
    const screenshot = await page.screenshot({ fullPage: true });
    assert.ok(screenshot.byteLength > 20_000);
    await page.evaluate(async (urls) => {
      for (const url of urls) {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("PDF unavailable");
        await response.arrayBuffer();
      }
    }, review.pdfUrls);
    for (const kind of ["resume", "cover_letter"]) {
      const card = page.locator(`[data-document-card="${kind}"]`);
      await card.getByLabel("Approve exact document").check();
      await card.getByLabel("Review every PDF page").check();
      await card.getByLabel("Review the writing quality").check();
      await card.getByLabel("Review the visual layout").check();
    }
    await page.getByRole("button", { name: "Submit both review decisions" }).click();
    const attestation = await review.finished;
    assert.equal(attestation.documents.every((document) => document.disposition === "approved"), true);
    await review.closed;
    assert.equal(review.hasPrivateInput(), false);
    await page.close();
  }
});
