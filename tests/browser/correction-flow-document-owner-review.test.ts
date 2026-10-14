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
      reviewedResumeFacts: ["Source-supported service delivery fact."],
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

test("desktop and mobile staged review keeps complete source context and requires both exact document decisions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const fixture = input();
    const review = await startCorrectionFlowDocumentOwnerReview(fixture);
    t.after(() => review.close("test_cleanup"));
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    await page.goto(review.reviewUrl);
    await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
    assert.equal(await page.locator("textarea, [contenteditable], a[download]").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (viewport.width >= 900) {
      const source = await page.locator("[data-source-panel]").boundingBox();
      assert.ok(source && source.width >= 550);
      assert.equal(await page.locator("[data-job-panel]").isVisible(), true);
    } else {
      await page.getByRole("button", { name: "Read target job", exact: true }).click();
    }
    await page.getByRole("heading", { name: "Service Operations Director", exact: true }).waitFor();
    await page.getByRole("button", { name: "Expand master résumé", exact: true }).click();
    const expanded = await page.locator("[data-source-panel]").boundingBox();
    assert.ok(expanded && expanded.width >= viewport.width - 70);
    await page.getByRole("button", { name: "Continue to corrections", exact: true }).click();
    const correctionIntro = page.locator('[data-review-stage="corrections"] .section-intro');
    assert.match(await correctionIntro.textContent() ?? "", /Review saved corrections/);
    assert.match(await correctionIntro.textContent() ?? "", /return to evidence correction/);
    await page.getByRole("heading", { name: "Reviewed résumé corrections" }).waitFor();
    assert.equal(await page.locator("[data-reviewed-resume-facts]").textContent(), "Source-supported service delivery fact.");
    assert.equal(await page.locator("[data-reviewed-facts]").textContent(), "Holds a current Quenby service certification.");
    await page.getByRole("button", { name: "Continue to documents", exact: true }).click();
    const resume = page.locator('[data-document-card="resume"]');
    const resumeOpening = viewport.width >= 900
      ? resume.locator("svg text").filter({hasText:"Synthetic browser resume fact."})
      : resume.locator("[data-reading-content]").getByText("Synthetic browser resume fact.");
    const openingBounds = await resumeOpening.boundingBox();
    assert.ok(openingBounds && openingBounds.y >= 0 && openingBounds.y + openingBounds.height <= viewport.height, "The document opening must be visible when entering document review.");
    await resume.getByRole("button", { name: "Readable text", exact: true }).click();
    await resume.locator("[data-reading-content]").getByText("Synthetic browser resume fact.").waitFor();
    assert.equal(await page.locator('[data-document-card="cover_letter"]').isVisible(), false);
    assert.equal(await page.locator("iframe[src]").count(), 0);
    const link = resume.locator("[data-open-pdf]");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("href"), new URL(review.pdfUrls[0]!).pathname);
    await resume.locator("summary").filter({ hasText: "Embedded PDF preview" }).click();
    await page.waitForFunction(() => !!document.querySelector('[data-document-pdf="resume"]')?.getAttribute("src"));
    assert.equal(await resume.locator('[data-document-pdf="resume"]').getAttribute("src"), new URL(review.pdfUrls[0]!).pathname);
    await page.evaluate(async (urls) => {
      for (const url of urls) {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("PDF unavailable");
        await response.arrayBuffer();
      }
    }, review.pdfUrls);
    for (const kind of ["resume", "cover_letter"]) {
      await page.getByRole("button", { name: kind === "resume" ? "Review résumé" : "Review cover letter", exact: true }).click();
      const card = page.locator(`[data-document-card="${kind}"]`);
      if (kind === "cover_letter") {
        const opening = viewport.width >= 900
          ? card.locator("svg text").filter({hasText:"Synthetic browser cover fact."})
          : card.locator("[data-reading-content]").getByText("Synthetic browser cover fact.");
        const bounds = await opening.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, "Switching documents must reveal the opening paragraph without manual scrolling.");
        assert.equal(await card.locator("[data-document-title]").evaluate(element => element === document.activeElement), true);
      }
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

test("review themes persist and System tracks actual OS preference changes on desktop and mobile", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const review = await startCorrectionFlowDocumentOwnerReview(input());
    t.after(() => review.close("test_cleanup"));
    const context = await browser.newContext({viewport,colorScheme:"dark"});
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(review.reviewUrl);
    const theme = page.getByLabel("Appearance", {exact:true});
    const resolved = () => page.locator("html").getAttribute("data-product-theme");
    await theme.selectOption("light");
    assert.equal(await resolved(),"light");
    await page.emulateMedia({colorScheme:"dark"});
    assert.equal(await resolved(),"light");
    await theme.selectOption("dark");
    await page.emulateMedia({colorScheme:"light"});
    assert.equal(await resolved(),"dark");
    await theme.selectOption("system");
    await page.emulateMedia({colorScheme:"dark"});
    await page.waitForFunction(() => document.documentElement.dataset.productTheme === "dark");
    await page.emulateMedia({colorScheme:"light"});
    await page.waitForFunction(() => document.documentElement.dataset.productTheme === "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("apply-pilot-theme")),"system");
    const second = await context.newPage();
    await second.emulateMedia({colorScheme:"light"});
    await second.goto(review.reviewUrl);
    assert.equal(await second.getByLabel("Appearance",{exact:true}).inputValue(),"system");
    assert.equal(await second.locator("html").getAttribute("data-product-theme"),"light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
    await context.close();
  }
});
