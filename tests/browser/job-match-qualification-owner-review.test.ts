import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import test, { after, before } from "node:test";

import { chromium, type Browser } from "playwright";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import { buildQualificationPreparation } from "@/lib/ai/job-match-qualification";

type PreviewProcess = {
  child: PreviewChild;
  reviewUrl: string;
  output(): string;
  waitForJsonStatus(status: string): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
};

type PreviewChild = ChildProcessByStdio<null, Readable, Readable>;

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

function waitForExit(child: PreviewChild, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic owner-review command did not exit.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startReviewCommand(
  commandArguments: string[],
  startupStatus: string
): Promise<PreviewProcess> {
  const child = spawn("npm", [
    "run",
    "job-match:qualify:review",
    "--",
    ...commandArguments
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "",
      DIRECT_URL: "",
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const waiters = new Set<() => void>();
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-100_000);
    for (const waiter of waiters) waiter();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const waitForJsonStatus = async (status: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const line of output.split("\n")) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.status === status) return parsed;
        } catch {
          // npm's command banner is intentionally not JSON.
        }
      }
      if (child.exitCode !== null) throw new Error(`Owner-review command exited early.\n${output}`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, 25);
        waiters.add(wake);
      });
    }
    throw new Error(`Timed out waiting for ${status}.\n${output}`);
  };

  const started = await waitForJsonStatus(startupStatus);
  assert.equal(typeof started.reviewUrl, "string");
  return {
    child,
    reviewUrl: started.reviewUrl as string,
    output: () => output,
    waitForJsonStatus,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForExit(child).catch(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    }
  };
}

function startPreview() {
  return startReviewCommand(["--synthetic-preview", "--timeout-ms=120000"], "synthetic_preview_ready");
}

function syntheticCapturePayload() {
  return {
    master: {
      resume: {
        id: SYNTHETIC_QUALIFICATION_SNAPSHOT.masterResumeId,
        parsedAt: SYNTHETIC_QUALIFICATION_SNAPSHOT.parsedAt,
        ...SYNTHETIC_QUALIFICATION_SNAPSHOT.resume
      }
    },
    profile: { profile: SYNTHETIC_QUALIFICATION_SNAPSHOT.profile }
  };
}

test("the actual real-mode command advances an already-open waiting screen only after exact recapture", async (t) => {
  const manifest = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES
  ).safeManifest;
  const command = await startReviewCommand([
    "--origin=https://apply.example.test",
    `--expected-manifest=${manifest.manifestHash}`,
    `--expected-resume=${manifest.resumeProjectionHash}`,
    `--expected-profile=${manifest.profileProjectionHash}`,
    "--timeout-ms=120000"
  ], "awaiting_exact_recapture");
  t.after(() => command.stop());
  const startup = await command.waitForJsonStatus("awaiting_exact_recapture");
  const snippet = String(startup.browserSnippet);
  const captureMatch = snippet.match(/const handoff = await fetch\(("[^"]+")/u);
  assert.ok(captureMatch);
  const captureUrl = JSON.parse(captureMatch[1]) as string;

  const page = await browser.newPage();
  await page.goto(command.reviewUrl, { waitUntil: "networkidle" });
  assert.match(await page.locator("#app").innerText(), /waiting for the approved one-shot capture/i);

  const capture = await fetch(captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(syntheticCapturePayload())
  });
  assert.equal(capture.status, 200);
  await page.locator("form[data-case-id]").waitFor();
  assert.equal(await page.getByText("Synthetic owner evidence", { exact: false }).count() > 0, true);
  assert.equal(await page.getByRole("heading", { name: "Frozen job posting" }).count(), 1);
  assert.equal(await page.getByText("Laserfiche", { exact: true }).count() > 0, true);
  assert.equal(await page.getByText("$75,000–$85,000", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Open original posting URL" }).getAttribute("href"), JOB_MATCH_QUALIFICATION_CASES[0].provenance.sourceUrl);
  assert.match(await page.getByText("The external page may have changed since capture.", { exact: true }).innerText(), /may have changed/i);
  await page.getByText("Source résumé and profile evidence", { exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Source résumé", exact: true }).count(), 1);
  assert.equal(await page.getByText("Source evidence — not a tailored résumé", { exact: true }).count(), 1);
  assert.match(await page.getByText("Application-document approval is a separate gate", { exact: true }).locator("..").innerText(), /does not generate or approve a tailored résumé or cover letter/i);
  await page.getByRole("button", { name: "Cancel and release memory" }).click();
  await waitForExit(command.child);
  assert.equal(command.child.exitCode, 0);
  assert.doesNotMatch(command.output(), /awaiting_separate_google_consent/);
  await page.close();
});

test("the actual synthetic command completes four owner reviews and stops at Google consent", async (t) => {
  const preview = await startPreview();
  t.after(() => preview.stop());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const requests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  await page.goto(preview.reviewUrl, { waitUntil: "networkidle" });

  assert.equal(await page.getByRole("heading", {
    name: "Resolve only the qualifications that could change the decision."
  }).count(), 1);
  assert.match(await page.locator("#memory-notice").innerText(), /loopback server's memory.*browser tab/i);
  assert.equal(await page.getByText("Synthetic owner evidence", { exact: false }).count() > 0, true);
  assert.equal(await page.getByText("Synthetic preview", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Evidence-backed fit summary" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Questions that could change the decision" }).count(), 1);
  assert.equal(await page.locator(".clarification-card").count(), 2);
  assert.equal(await page.getByText("Supported qualifications (4)", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Unresolved requirements", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Grouped questions", { exact: true }).count(), 1);
  assert.equal(await page.locator("details.supported-details").getAttribute("open"), null);
  assert.equal(await page.getByText("All requirements (6)", { exact: true }).count(), 1);
  assert.equal(await page.locator("details.all-requirements").getAttribute("open"), null);
  await page.getByText("All requirements (6)", { exact: true }).click();
  assert.equal(await page.locator("details.all-requirements").getByText("must-have", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Application document approval: unavailable", { exact: true }).count(), 1);
  assert.equal(await page.locator('[aria-label="Job preference evidence"]').getByText("Job location", { exact: true }).count(), 1);
  const primaryReviewText = await page.locator("form[data-case-id]").innerText();
  assert.doesNotMatch(
    primaryReviewText,
    /resume\.(?:skills|workHistory|projects|education|certifications|summary|rawText)|profile\.(?:careerGoals|preferredRoles|preferredLocations|skillsToEmphasize)|job\.(?:requirements|preferredQualifications)|\{\s*"/u
  );
  await page.getByText("Source résumé and profile evidence", { exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Synthetic source résumé" }).count(), 1);
  assert.equal(await page.getByText("Do not use as supporting evidence", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Programmatic advertising", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Original captured résumé text", { exact: true }).count(), 1);
  await page.getByText("Original captured résumé text", { exact: true }).click();
  assert.equal(await page.getByText("SYNTHETIC OWNER REVIEW PREVIEW", { exact: true }).count(), 1);
  await page.getByText("Supported qualifications (4)", { exact: true }).click();
  assert.equal(await page.locator("details.supported-details").getByText("TypeScript", { exact: true }).count() > 0, true);
  assert.doesNotMatch(await page.locator("details.supported-details").innerText(), /resume\.|profile\.|job\./u);
  if (process.env.JOB_MATCH_REVIEW_SCREENSHOT_DIR) {
    await page.locator(".fit-summary").evaluate((node) => {
      window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 16, behavior: "auto" });
    });
    await page.screenshot({
      path: `${process.env.JOB_MATCH_REVIEW_SCREENSHOT_DIR}/job-match-owner-review-supported.png`,
      fullPage: false
    });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  const browserStorage = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length
  }));
  assert.equal(browserStorage.local, 0);
  assert.equal(browserStorage.session, 0);

  for (const viewport of [
    { width: 320, height: 700 },
    { width: 768, height: 900 },
    { width: 1024, height: 900 },
    { width: 1440, height: 1000 }
  ]) {
    await page.setViewportSize(viewport);
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }));
    assert.ok(widths.scroll <= widths.client, `review ${viewport.width}px overflowed: ${JSON.stringify(widths)}`);
    if (viewport.width === 320) {
      const banner = await page.getByText("Synthetic preview", { exact: true }).boundingBox();
      assert.ok(banner && banner.y >= 0 && banner.y + banner.height <= viewport.height, "synthetic banner must be visible in the initial mobile viewport");
    }
    if (process.env.JOB_MATCH_REVIEW_SCREENSHOT_DIR && (viewport.width === 320 || viewport.width === 1440)) {
      await page.screenshot({
        path: `${process.env.JOB_MATCH_REVIEW_SCREENSHOT_DIR}/job-match-owner-review-${viewport.width}.png`,
        fullPage: false
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const recommendations = ["apply now", "consider", "consider", "skip"];
  const preferenceValues = ["aligned", "conflict", "unknown", "not_applicable"];
  for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
    const form = page.locator("form[data-case-id]");
    await form.waitFor();
    const currentCaseId = await form.getAttribute("data-case-id");
    assert.ok(currentCaseId);
    const clarificationCards = form.locator(".clarification-card");
    for (let index = 0; index < await clarificationCards.count(); index += 1) {
      const card = clarificationCards.nth(index);
      const answer = caseIndex === 0 && index === 0 ? "yes" : index % 2 === 0 ? "not_sure" : "no";
      await card.locator(`input[type=radio][value="${answer}"]`).check();
      if (answer === "yes") {
        await card.locator("textarea").fill("Synthetic owner context for this job-specific review only.");
      }
    }
    await form.locator("#preference-location").selectOption(preferenceValues[caseIndex]);
    await form.locator("#preference-workStyle").selectOption(preferenceValues[(caseIndex + 1) % 4]);
    await form.locator("#preference-compensation").selectOption(preferenceValues[(caseIndex + 2) % 4]);
    await form.locator("#recommendation").selectOption(recommendations[caseIndex]);
    await form.locator("#rationale").fill(`Synthetic review rationale for case ${caseIndex + 1}.`);
    await form.locator(".confirmation input[type=checkbox]").check();
    await form.getByRole("button", { name: "Record review and continue" }).click();
    if (caseIndex < 3) {
      await page.waitForFunction((caseId) =>
        document.querySelector("form[data-case-id]")?.getAttribute("data-case-id") !== caseId,
      currentCaseId);
    }
  }

  await page.getByRole("heading", { name: "Review complete. Google remains blocked." }).waitFor();
  assert.equal(await page.getByText("No provider action is available on this screen.").count(), 1);
  assert.equal(await page.getByText("gemini-3.8-flash / 3.1").count(), 1);
  assert.equal(await page.getByText("4 sequential; retry disabled").count(), 1);
  assert.equal(await page.getByText("290880 micros").count(), 1);
  assert.equal(await page.getByText("Disabled", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /approve|consent|google/i }).count(), 0);
  const technicalDetails = page.getByText("Technical run details", { exact: true });
  assert.equal(await technicalDetails.count(), 1);
  assert.equal(await page.locator("details.technical-details").getAttribute("open"), null);
  assert.equal(await page.getByText("Final manifest hash", { exact: true }).count(), 1);

  const ready = await preview.waitForJsonStatus("awaiting_separate_google_consent");
  assert.equal(ready.providerCallCount, 0);
  assert.equal(ready.reviewArtifactCount, 4);
  const manifest = ready.safeManifest as Record<string, unknown>;
  assert.equal(manifest.readiness, "ready_for_separate_execution_consent");
  assert.equal(manifest.caseCount, 4);
  assert.equal(manifest.noRetry, true);
  assert.equal(manifest.noDatabaseWrites, true);

  for (const viewport of [
    { width: 320, height: 700 },
    { width: 768, height: 900 },
    { width: 1024, height: 900 },
    { width: 1440, height: 1000 }
  ]) {
    await page.setViewportSize(viewport);
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }));
    assert.ok(widths.scroll <= widths.client, `${viewport.width}px overflowed: ${JSON.stringify(widths)}`);
  }

  const loopbackOrigin = new URL(preview.reviewUrl).origin;
  assert.equal(requests.every((url) => new URL(url).origin === loopbackOrigin), true);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.doesNotMatch(preview.output(), /Synthetic owner evidence|SYNTHETIC OWNER REVIEW PREVIEW|gemini.*generateContent/i);

  await page.getByRole("button", { name: "End local session" }).click();
  await waitForExit(preview.child);
  assert.equal(preview.child.exitCode, 0);
  await context.close();
});

test("navigation loss closes the actual command before any review or consent artifact", async (t) => {
  const preview = await startPreview();
  t.after(() => preview.stop());
  const page = await browser.newPage();
  await page.goto(preview.reviewUrl, { waitUntil: "networkidle" });
  await page.locator("form[data-case-id]").waitFor();
  await page.goto("about:blank");
  await waitForExit(preview.child);

  assert.doesNotMatch(preview.output(), /awaiting_separate_google_consent/);
  assert.match(preview.output(), /navigation_or_owner_cancel/);
  assert.doesNotMatch(preview.output(), /Synthetic owner evidence|SYNTHETIC OWNER REVIEW PREVIEW|generateContent/i);
  await page.close();
});

test("server timeout clears applicant evidence from the still-open browser tab", async (t) => {
  const command = await startReviewCommand(
    ["--synthetic-preview", "--timeout-ms=1000"],
    "synthetic_preview_ready"
  );
  t.after(() => command.stop());
  const page = await browser.newPage();
  await page.goto(command.reviewUrl, { waitUntil: "networkidle" });
  assert.equal(await page.getByText("Synthetic owner evidence", { exact: false }).count() > 0, true);
  await waitForExit(command.child);
  await page.waitForTimeout(4_000);
  assert.match(await page.locator("body").innerText(), /This tab cleared its rendered applicant evidence/);
  assert.equal(await page.getByText("Synthetic owner evidence", { exact: false }).count(), 0);
  assert.match(command.output(), /session_timeout/);
  assert.doesNotMatch(command.output(), /awaiting_separate_google_consent/);
  await page.close();
});
