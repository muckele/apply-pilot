import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { buildCorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";

const hash = (character: string) => character.repeat(64);

function input() {
  return {
    envelope: buildCorrectionFlowDocumentReviewEnvelope({
      manifestHash: hash("1"), exactHead: "a".repeat(40), payloadHash: hash("2"),
      sourceResumeHash: hash("3"), profileHash: hash("4"), jobProjectionHash: hash("5"),
      reviewedEvidenceHash: hash("6"), factCatalogHash: hash("7"), promptVersion: "7",
      model: "gemini-3.8-flash", thinkingLevel: "LOW", generationId: "browser-review",
      documents: [
        { kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: hash("9") },
        { kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: hash("b") }
      ]
    }),
    documents: [
      { kind: "resume" as const, title: "Synthetic tailored resume", text: "Taylor Boundary\nSUMMARY\nSynthetic browser resume fact.", evidence: [] },
      { kind: "cover_letter" as const, title: "Synthetic cover letter", text: "Dear Synthetic Employer\nSynthetic browser cover fact.", evidence: [] }
    ] as const,
    renderedPdfs: [
      { kind: "resume" as const, bytes: Buffer.from("%PDF-1.4\nresume browser") },
      { kind: "cover_letter" as const, bytes: Buffer.from("%PDF-1.4\ncover browser") }
    ] as const
  };
}

test("desktop and mobile local review show both documents and require complete exact decisions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const fixture = input();
    const review = await startCorrectionFlowDocumentOwnerReview(fixture);
    const page = await browser.newPage({ viewport });
    await page.goto(review.reviewUrl);
    await page.getByText("Synthetic browser resume fact.").waitFor();
    assert.equal(await page.locator("[data-document-card]").count(), 2);
    assert.equal(await page.locator("textarea, [contenteditable], a[download]").count(), 0);
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
