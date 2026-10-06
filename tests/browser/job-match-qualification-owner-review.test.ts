import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import test, { after, before } from "node:test";

import { chromium, type Browser } from "playwright";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import {
  buildQualificationPreparation,
  type QualificationTransport
} from "@/lib/ai/job-match-qualification";
import type { JobMatchModelOutput } from "@/lib/ai/job-match";
import { startJobMatchQualificationOwnerReview } from "@/lib/ai/job-match-qualification-owner-review";

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

function browserModelOutput(recommendation: "apply now" | "consider" | "skip"): JobMatchModelOutput {
  return {
    contractVersion: "3",
    recommendation,
    overallFitScore: recommendation === "apply now" ? 82 : recommendation === "consider" ? 61 : 24,
    resumeKeywordScore: 60,
    skillsMatchScore: 60,
    experienceMatchScore: 60,
    careerGoalScore: 60,
    locationWorkStyleScore: 50,
    compensationScore: 50,
    confidenceScore: 70,
    confidenceBasis: "Synthetic browser transport result for local continuation testing.",
    factualMatches: [],
    requirementGaps: [],
    advice: {
      resumeAngle: "Synthetic model angle shown only for transient review.",
      coverLetterAngle: "Synthetic model angle shown only for transient review.",
      keywordsToEmphasize: []
    }
  };
}

async function prepareRealWorkflowForConsent(
  workflow: Awaited<ReturnType<typeof startJobMatchQualificationOwnerReview>>
) {
  assert.ok(workflow.captureUrl);
  assert.equal((await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(syntheticCapturePayload())
  })).status, 200);
  for (let index = 0; index < 4; index += 1) {
    const state = await (await fetch(workflow.stateUrl)).json() as {
      cases: Array<{
        id: string;
        proposedRecommendation: "apply now" | "consider" | "skip";
        clarificationGroups: Array<{ id: string }>;
      }>;
    };
    const current = state.cases[0];
    assert.ok(current);
    assert.equal((await fetch(workflow.reviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify({
        caseId: current.id,
        factsCurrent: true,
        clarifications: current.clarificationGroups.map((question) => ({
          questionId: question.id,
          answer: "not_sure",
          context: ""
        })),
        preferences: { location: "unknown", workStyle: "unknown", compensation: "unknown" },
        recommendation: current.proposedRecommendation,
        rationale: `Synthetic direct setup for browser execution case ${index + 1}.`
      })
    })).status, 200);
  }
  return workflow.readyForConsent;
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
  await page.locator("form[data-case-id]").waitFor({ timeout: 2_000 });
  assert.equal(await page.getByRole("heading", { name: /Author the private evidence guide/ }).count(), 0);
  assert.equal(await page.getByText("Supported qualifications (1)", { exact: true }).count(), 1);
  assert.equal(await page.locator("fieldset.requirement").count(), 0);
  assert.equal(await page.getByText("Synthetic owner evidence", { exact: false }).count() > 0, true);
  assert.equal(await page.getByRole("heading", { name: "Frozen job posting" }).count(), 1);
  assert.equal(await page.getByText("Laserfiche", { exact: true }).count() > 0, true);
  assert.equal(await page.getByText("$75,000–$85,000", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Open original posting URL" }).getAttribute("href"), JOB_MATCH_QUALIFICATION_CASES[0].provenance.sourceUrl);
  assert.match(await page.getByText("The external page may have changed since capture.", { exact: true }).innerText(), /may have changed/i);
  await page.getByText("Source résumé and profile evidence", { exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Source résumé", exact: true }).count(), 1);
  assert.equal(await page.getByText("Source evidence — not a tailored résumé", { exact: true }).count(), 1);
  assert.equal(await page.getByText("All requirements (6)", { exact: true }).count(), 1);
  await page.getByText("All requirements (6)", { exact: true }).click();
  const degreeRequirement = page.locator(".all-requirements-list .requirement-row").first();
  assert.match(await degreeRequirement.innerText(), /Relevant education source candidates \(1\)/i);
  await degreeRequirement.getByText("Relevant education source candidates (1)", { exact: true }).click();
  assert.match(await degreeRequirement.innerText(), /Bachelor of Arts in Business Administration/i);
  assert.doesNotMatch(await degreeRequirement.innerText(), /Preferred work arrangement|Skill to emphasize/i);
  await page.getByRole("button", { name: "Cancel and release memory" }).click();
  await waitForExit(command.child);
  assert.equal(command.child.exitCode, 0);
  assert.doesNotMatch(command.output(), /awaiting_separate_google_consent/);
  await page.close();
});

test("the actual real-mode command reviews only prepared exceptions before the consent stop", async (t) => {
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
  const captureMatch = String(startup.browserSnippet).match(/const handoff = await fetch\(("[^"]+")/u);
  assert.ok(captureMatch);
  const captureUrl = JSON.parse(captureMatch[1]) as string;

  const page = await browser.newPage();
  await page.goto(command.reviewUrl, { waitUntil: "networkidle" });
  const capture = await fetch(captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(syntheticCapturePayload())
  });
  assert.equal(capture.status, 200);

  for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
    const form = page.locator("form[data-case-id]");
    await form.waitFor();
    const currentCaseId = await form.getAttribute("data-case-id");
    assert.ok(currentCaseId);
    assert.equal(await page.locator("form[data-guide-case-id]").count(), 0);
    if (caseIndex === 0) {
      assert.equal(await form.getByText("Supported qualifications (1)", { exact: true }).count(), 1);
    }
    const questions = form.locator(".clarification-card");
    assert.equal(await questions.count(), [1, 1, 1, 2][caseIndex]);
    assert.ok(await questions.count() < await form.locator(".all-requirements-list .requirement-row").count());
    for (let questionIndex = 0; questionIndex < await questions.count(); questionIndex += 1) {
      await questions.nth(questionIndex).locator('input[value="not_sure"]').check();
    }
    await form.locator("#preference-location").selectOption("unknown");
    await form.locator("#preference-workStyle").selectOption("unknown");
    await form.locator("#preference-compensation").selectOption("unknown");
    await form.locator("#recommendation").selectOption("consider");
    await form.locator("#rationale").fill("Synthetic same-process review preserves unsupported facts as unknown.");
    await form.locator(".confirmation input[type=checkbox]").check();
    await form.getByRole("button", { name: "Record review and continue" }).click();
    if (caseIndex < 3) {
      await page.waitForFunction((caseId) =>
        document.querySelector("form[data-case-id]")?.getAttribute("data-case-id") !== caseId,
      currentCaseId);
    }
  }

  await page.getByRole("heading", { name: "Review complete. Google remains blocked." }).waitFor();
  const ready = await command.waitForJsonStatus("awaiting_separate_google_consent");
  assert.equal(ready.providerCallCount, 0);
  assert.equal(ready.reviewArtifactCount, 4);
  assert.equal((ready.safeManifest as Record<string, unknown>).readiness, "ready_for_separate_execution_consent");
  assert.doesNotMatch(command.output(), /gemini.*generateContent/i);

  await page.getByRole("button", { name: "End local session" }).click();
  await waitForExit(command.child);
  assert.equal(command.child.exitCode, 0);
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
  assert.equal(await page.getByText("gemini-3.8-flash / 3.2").count(), 1);
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

test("the local screen binds exact consent and pauses four mocked calls for post-response review", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let activations = 0;
  let calls = 0;
  const transport: QualificationTransport = async (request) => {
    calls += 1;
    return {
      value: browserModelOutput(request.expectedRecommendation),
      finishReason: "STOP",
      responseBytes: 500,
      elapsedMs: 10,
      requestId: `browser-mock-${calls}`,
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        visibleOutputTokens: 100,
        thinkingTokens: 0
      }
    };
  };
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now: new Date("2026-10-05T17:00:00.000Z"),
    sessionTimeoutMs: 120_000,
    execution: {
      clock: () => new Date("2026-10-05T17:00:00.000Z"),
      activateTransport: async () => {
        activations += 1;
        return transport;
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });

  assert.ok(workflow.captureUrl);
  const capture = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(syntheticCapturePayload())
  });
  assert.equal(capture.status, 200);

  const recommendations = ["apply now", "consider", "consider", "skip"];
  for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
    const form = page.locator("form[data-case-id]");
    await form.waitFor();
    const currentCaseId = await form.getAttribute("data-case-id");
    assert.ok(currentCaseId);
    const clarifications = form.locator(".clarification-card");
    for (let index = 0; index < await clarifications.count(); index += 1) {
      await clarifications.nth(index).locator('input[value="not_sure"]').check();
    }
    await form.locator("#preference-location").selectOption("unknown");
    await form.locator("#preference-workStyle").selectOption("unknown");
    await form.locator("#preference-compensation").selectOption("unknown");
    await form.locator("#recommendation").selectOption(recommendations[caseIndex]);
    await form.locator("#rationale").fill("Synthetic consent-continuation browser review.");
    await form.locator(".confirmation input[type=checkbox]").check();
    await form.getByRole("button", { name: "Record review and continue" }).click();
    if (caseIndex < 3) {
      await page.waitForFunction((caseId) =>
        document.querySelector("form[data-case-id]")?.getAttribute("data-case-id") !== caseId,
      currentCaseId);
    }
  }

  const consent = page.locator("form[data-execution-consent]");
  await consent.waitFor();
  assert.equal(activations, 0);
  assert.equal(calls, 0);
  assert.equal(await consent.getByText("$0.290880", { exact: false }).count() > 0, true);
  const consentChecks = consent.locator('input[type="checkbox"]');
  assert.equal(await consent.getByText("activating and using the existing Gemini credential", { exact: false }).count(), 1);
  assert.equal(await consentChecks.count(), 4);
  for (let index = 0; index < 4; index += 1) await consentChecks.nth(index).check();
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();

  for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
    const review = page.locator("form[data-provider-review-case-id]");
    await review.waitFor();
    assert.equal(await review.getAttribute("data-provider-review-case-id"), JOB_MATCH_QUALIFICATION_CASES[caseIndex].id);
    assert.equal(await review.getByText(`Provider calls: ${caseIndex + 1}`, { exact: true }).count(), 1);
    if (caseIndex === 0) {
      await review.getByText("Inspect complete normalized result and exact source input", { exact: true }).click();
      assert.match(await review.innerText(), /not a tailored résumé or cover letter preview/i);
      await review.locator('input[value="advice_claim"]').check();
    }
    const currentCaseId = await review.getAttribute("data-provider-review-case-id");
    await review.getByRole("button", { name: "Record result review and continue" }).click();
    if (caseIndex < 3) {
      await page.waitForFunction((caseId) =>
        document.querySelector("form[data-provider-review-case-id]")?.getAttribute("data-provider-review-case-id") !== caseId,
      currentCaseId);
    }
  }

  await page.getByRole("heading", { name: "Four-call qualification completed." }).waitFor();
  const report = await workflow.executionFinished;
  assert.equal(activations, 1);
  assert.equal(calls, 4);
  assert.equal(workflow.providerCallCount(), 4);
  assert.equal((report as { status: string }).status, "completed");
  assert.equal(await page.getByText("Only the bounded safe report remains", { exact: false }).count(), 1);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic model angle|SYNTHETIC OWNER REVIEW PREVIEW/);
});

test("execution progress offers an acknowledged stop during a blocked call", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let calls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now: new Date("2026-10-05T17:00:00.000Z"),
    sessionTimeoutMs: 120_000,
    execution: {
      clock: () => new Date("2026-10-05T17:00:00.000Z"),
      activateTransport: async () => async (request) => {
        calls += 1;
        await blocked;
        return {
          value: browserModelOutput(request.expectedRecommendation),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: null,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => {
    unblock();
    workflow.close("test_cleanup");
  });
  await prepareRealWorkflowForConsent(workflow);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });
  const consent = page.locator("form[data-execution-consent]");
  for (let index = 0; index < 4; index += 1) await consent.locator('input[type="checkbox"]').nth(index).check();
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();
  await page.getByRole("heading", { name: "Running one consented call." }).waitFor();
  await page.getByRole("button", { name: "Stop and release memory" }).click();
  assert.equal((await workflow.closed).reason, "navigation_or_owner_cancel");
  unblock();
  await page.waitForTimeout(20);
  assert.equal(calls, 1);
  assert.equal(workflow.hasPrivateInput(), false);
});

test("loss of loopback contact during execution reports provider completion and billing as uncertain", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now: new Date("2026-10-05T17:00:00.000Z"),
    sessionTimeoutMs: 120_000,
    execution: {
      clock: () => new Date("2026-10-05T17:00:00.000Z"),
      activateTransport: async () => async (request) => {
        await blocked;
        return {
          value: browserModelOutput(request.expectedRecommendation),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: null,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => {
    unblock();
    workflow.close("test_cleanup");
  });
  await prepareRealWorkflowForConsent(workflow);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });
  const consent = page.locator("form[data-execution-consent]");
  for (let index = 0; index < 4; index += 1) await consent.locator('input[type="checkbox"]').nth(index).check();
  await page.route(workflow.stateUrl, (route) => route.abort());
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();
  await page.getByText("A started request may have completed and may be billable", { exact: false }).waitFor({ timeout: 5_000 });
  assert.match(await page.locator("body").innerText(), /no later call can start after cancellation is acknowledged/i);
  assert.equal((await workflow.closed).reason, "navigation_or_owner_cancel");
  unblock();
});

test("a lost consent acknowledgement is treated as possibly accepted and billable", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let calls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now: new Date("2026-10-05T17:00:00.000Z"),
    sessionTimeoutMs: 120_000,
    execution: {
      clock: () => new Date("2026-10-05T17:00:00.000Z"),
      activateTransport: async () => async (request) => {
        calls += 1;
        await blocked;
        return {
          value: browserModelOutput(request.expectedRecommendation),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: null,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => {
    unblock();
    workflow.close("test_cleanup");
  });
  await prepareRealWorkflowForConsent(workflow);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });
  const consent = page.locator("form[data-execution-consent]");
  for (let index = 0; index < 4; index += 1) await consent.locator('input[type="checkbox"]').nth(index).check();
  await page.evaluate((target) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(String(args[0]), window.location.href).href === target) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new TypeError("Synthetic lost consent acknowledgement");
      }
      return response;
    };
  }, workflow.consentSubmissionUrl);
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();
  await page.locator("#app").getByText("The action may have been accepted", { exact: false }).waitFor();
  assert.match(await page.locator("body").innerText(), /may have started, completed, and may be billable/i);
  assert.equal((await workflow.closed).reason, "navigation_or_owner_cancel");
  unblock();
  assert.equal(calls, 1);
});

test("a lost provider-review acknowledgement does not claim the next call was blocked", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let calls = 0;
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now: new Date("2026-10-05T17:00:00.000Z"),
    sessionTimeoutMs: 120_000,
    execution: {
      clock: () => new Date("2026-10-05T17:00:00.000Z"),
      activateTransport: async () => async (request) => {
        calls += 1;
        return {
          value: browserModelOutput(request.expectedRecommendation),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: `lost-provider-review-${calls}`,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  await prepareRealWorkflowForConsent(workflow);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });
  const consent = page.locator("form[data-execution-consent]");
  for (let index = 0; index < 4; index += 1) await consent.locator('input[type="checkbox"]').nth(index).check();
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();
  const review = page.locator("form[data-provider-review-case-id]");
  await review.waitFor();
  await page.evaluate((target) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(String(args[0]), window.location.href).href === target) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new TypeError("Synthetic lost provider-review acknowledgement");
      }
      return response;
    };
  }, workflow.executionReviewSubmissionUrl);
  await review.getByRole("button", { name: "Record result review and continue" }).click();
  await page.locator("#app").getByText("The action may have been accepted", { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /No later provider call was started/i);
  assert.equal((await workflow.closed).reason, "navigation_or_owner_cancel");
  assert.equal(calls, 2);
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
