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
      APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW: "true",
      ALLOW_DEMO_USER: "true",
      AUTH_SECRET: "synthetic-evidence-browser-test-secret"
    },
    readinessPath: "/synthetic-evidence-correction",
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

test("rendered correction flow saves job-only evidence, reassesses, and invalidates changed review on desktop and mobile", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const externalRequests: string[] = [];
  const apiRequests: string[] = [];
  const consoleErrors: string[] = [];
  let matchCalls = 0;
  await page.route("**/api/jobs/synthetic-job-1/evidence-snapshots", async (route) => {
    const body = route.request().postDataJSON();
    assert.deepEqual(Object.keys(body).sort(), [
      "decisions", "requestId", "resumeId", "resumeUpdatedAt", "reviewedAnalysis", "schema"
    ]);
    assert.equal(JSON.stringify(body).includes("SYNTHETIC CANDIDATE"), false);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "apply-pilot/evidence-snapshot-save-response/v1",
        snapshot: {
          id: "synthetic-snapshot-1",
          hash: "b".repeat(64),
          createdAt: "2026-10-08T12:30:00.000Z",
          isCurrent: true
        },
        replayed: false,
        invalidations: {
          assessmentIds: ["synthetic-analysis-1"],
          resumeDocumentIds: ["synthetic-resume-version-1"],
          coverLetterDocumentIds: ["synthetic-cover-letter-1"],
          totalCount: 3,
          reason: "EVIDENCE_SNAPSHOT_CHANGED"
        }
      })
    });
  });
  await page.route("**/api/jobs/synthetic-job-1/match", async (route) => {
    matchCalls += 1;
    if (matchCalls === 1) {
      await route.fulfill({
        status: 428,
        contentType: "application/json",
        body: JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 72_720 })
      });
      return;
    }
    assert.equal(route.request().headers()["x-ai-cost-confirmed"], "true");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cached: false }) });
  });
  page.on("dialog", (dialog) => void dialog.accept());
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) externalRequests.push(request.url());
    if (url.origin === origin && url.pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text());
  });

  const response = await page.goto(`${origin}/synthetic-evidence-correction`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  assert.equal(response?.status(), 200, `${await page.content()}\n${nextServer.getLogs()}`);
  await page.getByRole("heading", { name: "Review extracted evidence before rewriting" }).waitFor();
  const bodyText = await page.locator("body").innerText();
  assert.doesNotMatch(bodyText, /apply-pilot\/evidence-correction-review|sourceAuthoritative|\{\s*"schema"/i);
  assert.match(bodyText, /durable review/i);
  assert.match(bodyText, /500 candidates checked; 12 additional candidates omitted from this bounded correction view/i);

  const outcome = page.getByLabel("Review outcome");
  await outcome.selectOption("SOURCE_CORRECTION");
  const source = page.getByLabel("Extracted source");
  const sourceLabels = await source.locator("option").allTextContents();
  assert.ok(sourceLabels.some((label) => label.includes("resume.rawText")));
  assert.ok(sourceLabels.some((label) => label.includes("resume.education[0].sourceText")));
  assert.ok(!sourceLabels.some((label) => label.includes("fieldOfStudy")));
  assert.ok(!sourceLabels.some((label) => label.includes("details[0]")));

  await outcome.selectOption("OWNER_ATTESTATION");
  assert.equal(await page.getByText(/saved for this job only/i).isVisible(), true);
  await page.getByLabel("Owner-attested fact").fill("Synthetic owner-confirmed customer discovery evidence.");
  await page.getByLabel(/I attest that this fact is accurate/).check();
  await page.getByRole("button", { name: "Save reviewed evidence" }).click();
  await page.getByText(/Saved reviewed snapshot [a-f0-9]{64}/).waitFor();
  await page.getByText(/3 prior assessment\/document binding\(s\) are stale/).waitFor();
  await page.getByRole("button", { name: "Reassess fit with saved evidence" }).click();
  await page.getByText(/Reassessment saved with the reviewed evidence/i).waitFor();

  await page.getByLabel("Owner-attested fact").fill("Changed synthetic owner-confirmed evidence.");
  assert.equal(await page.getByText(/Saved reviewed snapshot [a-f0-9]{64}/).count(), 0);
  await page.getByText(/Review changed.*Save a new reviewed snapshot/).waitFor();

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `${width}px: ${JSON.stringify(dimensions)}`);
    assert.equal(await page.getByText(/saved for this job only/i).isVisible(), true);
    assert.equal(await page.getByText(/Review changed.*Save a new reviewed snapshot/).isVisible(), true);
  }

  const screenshotDir = process.env.SYNTHETIC_EVIDENCE_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "evidence-correction-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(screenshotDir, "evidence-correction-desktop.png"), fullPage: true });
  }

  assert.deepEqual(externalRequests, []);
  assert.equal(apiRequests.length, 3);
  assert.equal(matchCalls, 2);
  assert.deepEqual(consoleErrors, [
    "Failed to load resource: the server responded with a status of 428 (Precondition Required)"
  ]);
  await page.close();
});
