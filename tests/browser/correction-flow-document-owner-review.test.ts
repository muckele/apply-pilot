import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { chromium, type Page } from "playwright";

import { buildCorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";
import { productDocumentReviewInput } from "@/lib/documents/product-document-review";

const hash = (character: string) => character.repeat(64);

async function input() {
  const resumeText = "Taylor Boundary\ntaylor.boundary@example.test | Remote\nService Operations Leader\nSUMMARY\nSynthetic browser resume fact.";
  const coverText = "Taylor Boundary\ntaylor.boundary@example.test | Remote\n\nDear Synthetic Employer,\n\nSynthetic browser cover fact.\n\nSincerely,\nTaylor Boundary";
  const resumePdf = await renderProductDocument({ ...productDocumentReviewInput("RESUME", resumeText), format: "pdf" });
  const coverPdf = await renderProductDocument({ ...productDocumentReviewInput("COVER_LETTER", coverText), format: "pdf" });
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

async function assertNativePdfLoaded(page: Page, pdfUrl: string) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    for (const frame of page.frames().filter(frame => frame.url().startsWith("chrome-extension:"))) {
      const loaded = await frame.evaluate((expectedUrl) => {
        // Pinned native Chromium viewer: test actual completion for this exact file, not a hidden fetch.
        const viewer = document.querySelector("pdf-viewer") as HTMLElement & { loadState_?: string; originalUrl?: string };
        return viewer?.originalUrl === expectedUrl && viewer.loadState_ === "success";
      }, pdfUrl);
      if (loaded) return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("The visible PDF control did not finish loading the exact document in native Chromium.");
}

test("native Chromium PDF controls support revision feedback without hidden fetches", async (t) => {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  t.after(() => browser.close());
  const review = await startCorrectionFlowDocumentOwnerReview(await input());
  t.after(() => review.close("test_cleanup"));
  const page = await browser.newPage();
  await page.clock.install();
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to load/u.test(message.text())) violations.push(message.text());
  });
  await page.goto(review.reviewUrl);
  await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
  await page.getByRole("button", { name: "3 Tailored documents" }).click();
  for (const kind of ["resume", "cover_letter"]) {
    await page.getByRole("button", { name: kind === "resume" ? "Review résumé" : "Review cover letter", exact: true }).click();
    const card = page.locator(`[data-document-card="${kind}"]`);
    await card.locator("summary").filter({ hasText: "Embedded PDF preview" }).click();
    await assertNativePdfLoaded(page, review.pdfUrls[kind === "resume" ? 0 : 1]);
    await card.getByLabel("Needs revision").check();
    await card.locator("select").selectOption("formatting");
    await card.getByLabel("I reviewed every PDF page").check();
    await card.getByLabel("I reviewed the writing quality").check();
    await card.getByLabel("I reviewed the visual layout").check();
  }
  assert.deepEqual(violations, []);
  assert.equal(review.deliveredPdfCount(), 2);
  await page.getByRole("button", { name: "Submit both review decisions" }).click();
  const attestation = await review.finished;
  assert.equal(attestation.documents.every(document => document.disposition === "needs_revision" && document.reason === "formatting"), true);
  assert.equal((await review.closed).reason, "completed");
  await page.getByText("Review recorded. This local session is closed.", {exact:true}).waitFor();
  await page.clock.fastForward(900_001);
  assert.equal(await page.locator("#review-status").textContent(), "Review recorded. This local session is closed.");
});

test("desktop and mobile staged review keeps complete source context and requires both exact document decisions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const fixture = await input();
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
    assert.equal(await resume.locator("svg line").count(), 1, "The review must draw the shared product section rule.");
    assert.equal(await resume.locator("svg text").first().getAttribute("font-family"), "Arial");
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
      if (kind === "cover_letter") await card.locator("summary").filter({hasText:"Embedded PDF preview"}).click();
      await card.getByLabel("Approve exact document").check();
      await card.getByLabel("I reviewed every PDF page").check();
      await card.getByLabel("I reviewed the writing quality").check();
      await card.getByLabel("I reviewed the visual layout").check();
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
    const review = await startCorrectionFlowDocumentOwnerReview(await input());
    t.after(() => review.close("test_cleanup"));
    const context = await browser.newContext({viewport,colorScheme:"dark"});
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(review.reviewUrl);
    const theme = page.getByLabel("Appearance", {exact:true});
    const resolved = () => page.locator("html").getAttribute("data-product-theme");
    await page.getByText("Settings", {exact:true}).click();
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


test("reload preserves the same review and feedback without cancelling or extending its lifetime", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const review = await startCorrectionFlowDocumentOwnerReview(await input());
  t.after(() => review.close("test_cleanup"));
  const page = await browser.newPage();
  await page.goto(review.reviewUrl);
  await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
  await page.getByRole("button", {name:"3 Tailored documents"}).click();
  const resume = page.locator('[data-document-card="resume"]');
  await resume.getByLabel("Needs revision").check();
  await resume.locator("select").selectOption("formatting");
  await page.reload();
  await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor({timeout:3_000});
  assert.equal(review.phase(), "reviewing");
  await page.getByRole("button", {name:"3 Tailored documents"}).click();
  assert.equal(await resume.getByLabel("Needs revision").isChecked(), true);
  assert.equal(await resume.locator("select").inputValue(), "formatting");
  await page.getByRole("button", {name:"Cancel local review"}).click();
  assert.equal((await review.closed).reason, "owner_cancel");
  assert.equal(review.hasPrivateInput(), false);
});


test("submission explains missing PDF delivery, unchecked fields, and connection failure without losing choices", async (t) => {
  const browser = await chromium.launch({headless:true,channel:"chromium"});
  t.after(() => browser.close());
  const review = await startCorrectionFlowDocumentOwnerReview(await input());
  t.after(() => review.close("test_cleanup"));
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(review.reviewUrl);
  await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
  await page.getByRole("button", {name:"3 Tailored documents"}).click();
  for (const kind of ["resume", "cover_letter"]) {
    await page.getByRole("button", {name:kind === "resume" ? "Review résumé" : "Review cover letter",exact:true}).click();
    const card=page.locator(`[data-document-card="${kind}"]`);
    await card.getByLabel("Needs revision").check();
    await card.locator("select").selectOption("formatting");
  }
  const submit=page.getByRole("button", {name:"Submit both review decisions"});
  await submit.click();
  await page.getByText("Résumé: open the exact PDF using its link or embedded preview and wait for it to load.", {exact:false}).waitFor();
  assert.equal(review.phase(), "reviewing");
  for (const kind of ["resume", "cover_letter"]) {
    await page.getByRole("button", {name:kind === "resume" ? "Review résumé" : "Review cover letter",exact:true}).click();
    const card=page.locator(`[data-document-card="${kind}"]`);
    const popupPromise=page.waitForEvent("popup");
    await card.locator("[data-open-pdf]").click();
    const popup=await popupPromise;
    await assertNativePdfLoaded(popup, review.pdfUrls[kind === "resume" ? 0 : 1]);
    await popup.close();
  }
  assert.equal(review.deliveredPdfCount(), 2);
  await submit.click();
  await page.getByText("Résumé: confirm you reviewed every PDF page.", {exact:false}).waitFor();
  assert.match(await page.locator("#review-status").textContent() ?? "", /Cover letter: confirm you reviewed the writing quality/);
  const draft=await page.evaluate(() => sessionStorage.getItem("apply-pilot-document-review-feedback"));
  assert.ok(draft);
  assert.doesNotMatch(draft, /browser source|browser resume|browser cover|PDF-|validatedOutputHash|example.test/);
  await page.route(review.submissionUrl, route => route.abort());
  await submit.click();
  await page.getByText("Could not confirm the review submission because the local connection failed.", {exact:false}).waitFor();
  assert.equal(await page.locator('[data-document-card="cover_letter"]').getByLabel("Needs revision").isChecked(), true);
  await page.unroute(review.submissionUrl);
  await page.getByRole("button", {name:"Cancel local review"}).click();
  await review.closed;
  await page.getByText("Review cancelled.", {exact:true}).waitFor();
  await page.clock.fastForward(900_001);
  assert.equal(await page.locator("#review-status").textContent(), "Review cancelled.");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("apply-pilot-document-review-feedback")), null);
});


test("terminal submission responses clear feedback, while pending admission preserves it", async (t) => {
  const browser=await chromium.launch({headless:true});
  t.after(() => browser.close());
  for (const code of ["REVIEW_SUBMISSION_PENDING", "REVIEW_IDENTITY_MISMATCH", "REVIEW_UNAVAILABLE"]) {
    const review=await startCorrectionFlowDocumentOwnerReview(await input());
    t.after(() => review.close("test_cleanup"));
    const page=await browser.newPage();
    await page.clock.install();
    await page.goto(review.reviewUrl);
    await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
    await page.getByRole("button",{name:"3 Tailored documents"}).click();
    await page.getByLabel("Needs revision",{exact:true}).first().check();
    await page.route(review.submissionUrl, route => route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:code})}));
    await page.getByRole("button",{name:"Submit both review decisions"}).click();
    await page.waitForFunction(() => (document.getElementById("review-status")?.textContent?.length||0)>0);
    const draft=await page.evaluate(() => sessionStorage.getItem("apply-pilot-document-review-feedback"));
    assert.equal(draft!==null, code === "REVIEW_SUBMISSION_PENDING");
    if (code !== "REVIEW_SUBMISSION_PENDING") {
      const terminalMessage=await page.locator("#review-status").textContent();
      await page.clock.fastForward(900_001);
      assert.equal(await page.locator("#review-status").textContent(),terminalMessage);
    }
    review.close("test_cleanup");
    await review.closed;
    await page.close();
  }
});

test("late network failures cannot overwrite confirmed cancellation, expiry, or a recorded review", async (t) => {
  const browser=await chromium.launch({headless:true});
  t.after(() => browser.close());
  for (const outcome of ["cancelled", "expired", "recorded", "accepted_after_expiry"] as const) {
    const review=await startCorrectionFlowDocumentOwnerReview(await input());
    t.after(() => review.close("test_cleanup"));
    const page=await browser.newPage();
    await page.clock.install();
    await page.goto(review.reviewUrl);
    await page.locator("[data-source-resume]").getByText("Complete browser source résumé.").waitFor();
    await page.getByRole("button",{name:"3 Tailored documents"}).click();
    let release!: () => Promise<void>;
    let captured!: () => void;
    const pending=new Promise<void>(resolve=>{captured=resolve;});
    await page.route(outcome === "recorded" ? review.cancelUrl : review.submissionUrl, route => {
      release=()=>outcome === "accepted_after_expiry" ? route.fulfill({status:200,contentType:"application/json",body:'{"status":"review_recorded"}'}) : route.abort();captured();
    });
    await page.getByRole("button",{name:outcome === "recorded" ? "Cancel local review" : "Submit both review decisions"}).click();
    await pending;
    if(outcome === "cancelled") {
      await page.getByRole("button",{name:"Cancel local review"}).click();
      await page.getByText("Review cancelled.",{exact:true}).waitFor();
    } else if(outcome === "expired" || outcome === "accepted_after_expiry") {
      await page.clock.fastForward(900_001);
    } else {
      // UI transport race only: actual document acceptance is covered by native-viewer tests above.
      await page.route(review.submissionUrl,route=>route.fulfill({status:200,contentType:"application/json",body:'{"status":"review_recorded"}'}));
      await page.getByRole("button",{name:"Submit both review decisions"}).click();
      await page.getByText("Review recorded. This local session is closed.",{exact:true}).waitFor();
    }
    const terminalMessage=await page.locator("#review-status").textContent();
    await release();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#review-status").textContent(),outcome === "accepted_after_expiry" ? "Review recorded. This local session is closed." : terminalMessage);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem("apply-pilot-document-review-feedback")),null);
    review.close("test_cleanup");
    await review.closed;
    await page.close();
  }
});
