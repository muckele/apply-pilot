import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";

import { startNextTestServer, type NextTestServer } from "./next-test-server";

let browser: Browser;
let origin: string;
let nextServer: NextTestServer;

before(async () => {
  nextServer = await startNextTestServer({
    environment: {
      ...process.env,
      APPLY_PILOT_SYNTHETIC_ONE_JOB_PREVIEW: "true",
      ALLOW_DEMO_USER: "true",
      AUTH_SECRET: "synthetic-one-job-browser-test-secret"
    },
    readinessPath: "/synthetic-one-job",
    startupTimeoutMs: 60_000
  });
  origin = nextServer.origin;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await nextServer?.stop();
  }
});

test("rendered one-page journey approves exact documents then invalidates the approval", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const externalRequests: string[] = [];
  const apiRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) externalRequests.push(request.url());
    if (url.origin === origin && url.pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto(`${origin}/synthetic-one-job`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${await page.content()}\n${nextServer.getLogs()}`);
  await page.waitForTimeout(2_000);
  const renderedText = await page.locator("body").innerText();
  assert.match(renderedText, /Presales Engineer I/, `${await page.content()}\n${nextServer.getLogs()}`);
  assert.equal(await page.getByText(/Synthetic local review only/).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Formatted resume" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Formatted cover letter" }).count(), 1);
  assert.equal(await page.getByText("Eligibility not confirmed", { exact: true }).count(), 1);
  assert.equal(await page.getByText(/82% fit|apply now/i).count(), 0);
  assert.equal(await page.getByText(/resume\.skills\[|job\.requirements\[/i).count(), 0);
  assert.equal(await page.getByRole("link", { name: /apply/i }).count(), 0);
  const selectedDocuments = page.locator("details").filter({ hasText: "Selected packet documents" });
  const supportingEvidence = page.locator("details").filter({ hasText: "Review supporting evidence" });
  assert.equal(await selectedDocuments.evaluate((element) => (element as HTMLDetailsElement).open), false);
  assert.equal(await supportingEvidence.evaluate((element) => (element as HTMLDetailsElement).open), false);
  assert.equal(await page.getByLabel("Synthetic tailored resume").count(), 0);
  const packetSelectors = selectedDocuments.locator("select");
  assert.equal(await packetSelectors.count(), 2);
  assert.equal(await packetSelectors.nth(0).isDisabled(), true);
  assert.equal(await packetSelectors.nth(1).isDisabled(), true);

  for (const group of await page.locator("[data-synthetic-question]").all()) {
    await group.getByLabel("No", { exact: true }).check();
  }
  await page.getByText("Not eligible for this role", { exact: true }).waitFor();
  await page.getByText(/Work authorization is a required condition/).waitFor();
  await page.getByRole("button", { name: "Approve exact synthetic documents" }).click();
  await page.getByText("Exact synthetic documents approved locally.").waitFor();
  assert.equal(await page.getByText("Documents approved", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Approve exact synthetic documents" }).count(), 0);
  const screenshotDir = process.env.SYNTHETIC_ONE_JOB_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "synthetic-one-job-approved-desktop.png"),
      fullPage: true
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  async function assertCompleteMobileDocuments(width: number) {
    await page.setViewportSize({ width, height: 844 });
    for (const title of ["Formatted resume", "Formatted cover letter"]) {
      const preview = page.locator(`[data-document-preview="${title}"]`);
      const paper = preview.locator("[data-document-page]").first();
      const dimensions = await paper.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }));
      assert.ok(
        dimensions.scrollHeight <= dimensions.clientHeight + 1,
        `${title} clips at ${width}px: ${JSON.stringify(dimensions)}`
      );
      await preview.getByText(/Full document preview/i).waitFor();
    }
    const resume = page.locator('[data-document-preview="Formatted resume"]');
    for (const text of [
      "Built source-backed workflows with TypeScript and SQL.",
      "PROJECTS",
      "EDUCATION",
      "CERTIFICATIONS"
    ]) {
      assert.equal(await resume.getByText(text, { exact: true }).isVisible(), true, `${text} is hidden at ${width}px`);
    }
    const cover = page.locator('[data-document-preview="Formatted cover letter"]');
    assert.equal(await cover.getByText("Sincerely,", { exact: true }).isVisible(), true);
    assert.equal(await cover.getByText("Synthetic Candidate", { exact: true }).isVisible(), true);
  }
  await assertCompleteMobileDocuments(390);
  await assertCompleteMobileDocuments(320);
  await page.setViewportSize({ width: 390, height: 844 });
  const documentReviewTop = await page.getByRole("heading", { name: "Exact document review" }).evaluate((element) =>
    element.getBoundingClientRect().top + window.scrollY);
  assert.ok(documentReviewTop < 2_300, `document review starts at ${documentReviewTop}px`);
  const approvedMobileHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(approvedMobileHeight < 5_000, `approved mobile page is ${approvedMobileHeight}px tall`);
  const minimumInteractiveHeight = await page.locator("[data-synthetic-one-job-review] [data-synthetic-question] label, [data-synthetic-one-job-review] button").evaluateAll((elements) =>
    Math.min(...elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map((element) => element.getBoundingClientRect().height)));
  assert.ok(minimumInteractiveHeight >= 43, `smallest visible interaction is ${minimumInteractiveHeight}px tall`);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, "synthetic-one-job-approved-mobile.png"),
      fullPage: true
    });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Edit document text" }).click();
  await page.getByLabel("Synthetic tailored resume").fill("Edited after approval");
  await page.getByText("Documents changed", { exact: true }).waitFor();
  await page.getByText(/Document review changed/).waitFor();
  await page.getByRole("button", { name: "Restore validated documents" }).waitFor();
  assert.equal(await page.getByText("Exact synthetic documents approved locally.").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Approve exact synthetic documents" }).count(), 0);

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, JSON.stringify(dimensions));
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(apiRequests, []);
  assert.deepEqual(consoleErrors, []);

  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, "synthetic-one-job-invalidated-desktop.png"),
      fullPage: true
    });
  }
  await page.getByRole("button", { name: "Restore validated documents" }).click();
  await page.getByText("Exact synthetic documents approved locally.").waitFor();
  assert.equal(await page.getByText("Documents approved", { exact: true }).count(), 1);

  const firstQuestion = page.locator("[data-synthetic-question]").first();
  await firstQuestion.getByLabel("Not sure", { exact: true }).check();
  await page.getByText("Review changed", { exact: true }).waitFor();
  await page.getByText(/Recheck the updated applicant answers/).waitFor();
  assert.equal(await page.getByText("Documents changed", { exact: true }).count(), 0);
  await page.close();
});
