import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import test, { after, before } from "node:test";

import { chromium, type Browser } from "playwright";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import { hashAiInput } from "@/lib/ai/input-hash";
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

function syntheticCapturePayload(snapshot = SYNTHETIC_QUALIFICATION_SNAPSHOT) {
  return {
    master: {
      resume: {
        id: snapshot.masterResumeId,
        parsedAt: snapshot.parsedAt,
        ...snapshot.resume
      }
    },
    profile: { profile: snapshot.profile }
  };
}

function browserModelOutput(
  recommendation: "apply now" | "consider" | "skip",
  includeReadableEvidence = false,
  sourceExcerpts?: Readonly<{ applicant: string; job: string }>,
  includeEscapingProbe = false
): JobMatchModelOutput {
  const degreeRequirement = JOB_MATCH_QUALIFICATION_CASES[0].job.requirements[0];
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
    confidenceBasis: includeReadableEvidence
      ? "The cited applicant and job evidence support the match, with confidence limited by the unresolved degree requirement."
      : "Synthetic browser transport result for local continuation testing.",
    factualMatches: includeReadableEvidence ? [{
      applicantEvidence: [{ ref: "resume.skills[3]", excerpt: sourceExcerpts?.applicant ?? "Technical demonstrations" }],
      jobEvidence: [{ ref: "job.detectedTechStack[3]", excerpt: sourceExcerpts?.job ?? "proof-of-concept demonstrations" }],
      supportedKeywords: ["demonstrations"]
    }] : [],
    requirementGaps: includeReadableEvidence ? [{
      requirement: degreeRequirement,
      jobRequirement: { ref: "job.requirements[0]", excerpt: degreeRequirement },
      missingKeywords: ["STEM"]
    }] : [],
    advice: {
      resumeAngle: includeEscapingProbe
        ? "Literal markup stays text: <script data-synthetic-result-xss>not executable</script>"
        : includeReadableEvidence
          ? "Emphasize the submitted technical demonstration work without adding claims."
        : "Synthetic model angle shown only for transient review.",
      coverLetterAngle: includeEscapingProbe
        ? "LONG ADVICE START escaping probe LONG ADVICE END"
        : includeReadableEvidence
          ? "Connect the submitted demonstration experience to the cited proof-of-concept responsibility while keeping the degree gap explicit."
        : "Synthetic model angle shown only for transient review.",
      keywordsToEmphasize: includeReadableEvidence ? ["demonstrations"] : []
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

test("a rejected one-shot capture shows safe retry guidance without retaining applicant data", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES
  );
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: {
      manifestHash: preparation.safeManifest.manifestHash,
      resumeProjectionHash: preparation.safeManifest.resumeProjectionHash,
      profileProjectionHash: preparation.safeManifest.profileProjectionHash
    },
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    sessionTimeoutMs: 120_000
  });
  t.after(() => workflow.close("test_cleanup"));
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(workflow.reviewUrl, { waitUntil: "networkidle" });
  const payload = syntheticCapturePayload();
  payload.master.resume.summary += " PRIVATE MISMATCH SHOULD NOT RENDER";
  assert.ok(workflow.captureUrl);
  const rejected = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(payload)
  });
  assert.notEqual(rejected.status, 200);
  await page.getByRole("heading", { name: "Capture was not accepted." }).waitFor({ timeout: 3_000 });
  assert.match(await page.locator("#app").innerText(), /re-run the approved capture.*no applicant data was retained/i);
  assert.doesNotMatch(await page.locator("body").innerText(), /PRIVATE MISMATCH SHOULD NOT RENDER/);
  assert.equal(workflow.hasPrivateInput(), false);
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
  const applicantLocation = SYNTHETIC_QUALIFICATION_SNAPSHOT.profile.preferredLocations?.[0] ?? "Los Angeles";
  const applicantWorkPreference = SYNTHETIC_QUALIFICATION_SNAPSHOT.profile.remotePreference ?? "HYBRID";
  const jobLocation = JOB_MATCH_QUALIFICATION_CASES[0].job.location ?? "Long Beach, United States";
  const jobWorkArrangement = JOB_MATCH_QUALIFICATION_CASES[0].job.remoteStatus
    ?? "Hybrid: Tuesday through Thursday in Long Beach; remote Monday and Friday";
  const applicantWrappedSource = JSON.stringify({
    schema: "local-source/v1",
    local: { start: 0, end: 24 },
    value: "Technical demonstrations"
  });
  const applicantLocationWrappedSource = JSON.stringify({
    schema: "local-source/v1",
    local: { start: 25, end: 36 },
    value: applicantLocation
  });
  const applicantWorkPreferenceWrappedSource = JSON.stringify({
    schema: "local-source/v1",
    local: { start: 37, end: 43 },
    value: applicantWorkPreference
  });
  const jobWrappedSource = [
    "<<< LOCAL START >>>",
    JSON.stringify({
      schema: "job-source/v1",
      start: 12,
      end: 43,
      text: "proof-of-concept demonstrations"
    }),
    "<<< LOCAL END >>>"
  ].join("\n");
  const jobLocationWrappedSource = JSON.stringify({
    schema: "job-source/v1",
    start: 44,
    end: 69,
    text: jobLocation
  });
  const jobWorkArrangementWrappedSource = [
    "<<< LOCAL START >>>",
    JSON.stringify({ schema: "job-source/v1", value: jobWorkArrangement }),
    "<<< LOCAL END >>>"
  ].join("\n");
  const sourceRenderingSnapshot = {
    ...SYNTHETIC_QUALIFICATION_SNAPSHOT,
    resume: {
      ...SYNTHETIC_QUALIFICATION_SNAPSHOT.resume,
      skills: (SYNTHETIC_QUALIFICATION_SNAPSHOT.resume.skills ?? []).map((skill, index) =>
        index === 3 ? applicantWrappedSource : skill)
    },
    profile: {
      ...SYNTHETIC_QUALIFICATION_SNAPSHOT.profile,
      preferredLocations: (SYNTHETIC_QUALIFICATION_SNAPSHOT.profile.preferredLocations ?? []).map((location, index) =>
        index === 0 ? applicantLocationWrappedSource : location),
      remotePreference: applicantWorkPreferenceWrappedSource
    }
  };
  const sourceRenderingCases = JOB_MATCH_QUALIFICATION_CASES.map((entry, index) => {
    if (index !== 0) return entry;
    const job = {
      ...entry.job,
      location: jobLocationWrappedSource,
      remoteStatus: jobWorkArrangementWrappedSource,
      detectedTechStack: entry.job.detectedTechStack?.map((technology, technologyIndex) =>
        technologyIndex === 3 ? jobWrappedSource : technology)
    };
    return {
      ...entry,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
  });
  const preparation = buildQualificationPreparation(
    sourceRenderingSnapshot,
    sourceRenderingCases,
    new Date("2026-10-05T17:00:00.000Z")
  );
  let activations = 0;
  let calls = 0;
  const transport: QualificationTransport = async (request) => {
    calls += 1;
    return {
      value: browserModelOutput(
        request.expectedRecommendation,
        calls === 1,
        calls === 1 ? { applicant: '"value":"Technical demonstrations"', job: jobWrappedSource } : undefined,
        calls === 2
      ),
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
    cases: sourceRenderingCases,
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
    body: JSON.stringify(syntheticCapturePayload(sourceRenderingSnapshot))
  });
  assert.equal(capture.status, 200);

  const recommendations = ["apply now", "consider", "consider", "skip"];
  for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
    const form = page.locator("form[data-case-id]");
    await form.waitFor();
    const currentCaseId = await form.getAttribute("data-case-id");
    assert.ok(currentCaseId);
    if (caseIndex === 0) {
      assert.equal(await form.getByText("Technical demonstrations", { exact: true }).count() > 0, true);
      assert.equal(await form.getByText("proof-of-concept demonstrations", { exact: true }).count() > 0, true);
      assert.equal(await form.getByText(applicantLocation, { exact: true }).count() > 0, true);
      assert.equal(await form.getByText(applicantWorkPreference, { exact: true }).count() > 0, true);
      assert.equal(await form.getByText(jobLocation, { exact: true }).count() > 0, true);
      assert.equal(await form.getByText(jobWorkArrangement, { exact: true }).count() > 0, true);
      assert.doesNotMatch(
        await form.innerText(),
        /local-source|job-source|LOCAL START|LOCAL END|\"schema\"|\"start\"|\"end\"/i
      );
    }
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
    assert.equal(await review.getAttribute("data-provider-review-case-id"), sourceRenderingCases[caseIndex].id);
    assert.equal(await review.getByText(`Provider calls: ${caseIndex + 1}`, { exact: true }).count(), 1);
    if (caseIndex === 0) {
      await review.getByRole("heading", { name: "Source-backed factual matches" }).waitFor();
      assert.equal(await review.getByText("Submitted applicant evidence matches job evidence for demonstrations.", { exact: true }).count(), 1);
      assert.equal(await review.getByText("Technical demonstrations", { exact: true }).count(), 1);
      assert.equal(await review.getByText("proof-of-concept demonstrations", { exact: true }).count(), 1);
      assert.equal(await review.getByText("Your résumé: skills", { exact: true }).count(), 1);
      assert.equal(await review.getByText("Job listing: technologies", { exact: true }).count(), 1);
      assert.equal(await review.locator('[data-source-ref="resume.skills[3]"]').count(), 1);
      assert.equal(await review.locator('[data-source-ref="job.detectedTechStack[3]"]').count(), 1);
      assert.doesNotMatch(
        await review.innerText(),
        /local-source|job-source|LOCAL START|LOCAL END|\"schema\"|\"start\"|\"end\"|resume\.skills|job\.detectedTechStack/i
      );
      assert.equal(await review.getByRole("heading", { name: "Important gaps reported by the model" }).count(), 1);
      assert.equal(await review.getByText("Job listing: requirements", { exact: true }).count(), 1);
      assert.equal(await review.getByText("Missing keywords: STEM", { exact: true }).count(), 1);
      assert.equal(await review.getByRole("heading", { name: "Compensation and preference context" }).count(), 1);
      assert.equal(await review.getByText("Applicant salary target", { exact: true }).count(), 1);
      assert.equal(await review.getByText("Job-listed salary", { exact: true }).count(), 1);
      assert.equal(await review.getByText(`${applicantLocation}, Remote`, { exact: true }).count(), 1);
      assert.equal(await review.getByText(applicantWorkPreference, { exact: true }).count(), 1);
      assert.equal(await review.getByText(jobLocation, { exact: true }).count(), 1);
      assert.equal(await review.getByText(jobWorkArrangement, { exact: true }).count(), 1);
      assert.equal(await review.getByRole("heading", { name: "Limitations and advisory output" }).count(), 1);
      assert.equal(await review.getByRole("heading", { name: "Why this fits" }).count(), 1);
      assert.equal(await review.getByRole("heading", { name: "What is missing" }).count(), 1);
      assert.equal(await review.getByRole("heading", { name: "What needs your review" }).count(), 1);
      assert.equal(await review.locator(".advisory-list").getByText("Emphasize the submitted technical demonstration work without adding claims.", { exact: false }).count(), 1);
      assert.equal(await review.locator(".advisory-list").getByText("Connect the submitted demonstration experience to the cited proof-of-concept responsibility while keeping the degree gap explicit.", { exact: false }).count(), 1);
      assert.doesNotMatch(await review.locator(".readable-result").innerText(), /Synthetic browser|LONG ADVICE|<script|local-source|job-source|\"schema\"/i);
      assert.doesNotMatch(await review.innerText(), /Résumé skill 4|Job technology 4|Job requirement 1/i);
      assert.doesNotMatch(await review.innerText(), /\[object Object\]/);
      assert.equal(await review.getByText("Google consent", { exact: true }).count(), 0);
      assert.equal(await review.getByText("The recommendation band seems wrong for the displayed evidence and gaps.", { exact: true }).count(), 1);
      assert.equal(await review.locator("details[data-provider-technical-details]").count(), 0);
      assert.equal(await review.getByText("Technical JSON and exact source input", { exact: true }).count(), 0);
      assert.equal(await review.locator("pre").count(), 0);
      assert.doesNotMatch(await review.innerText(), /normalizedResult|exactSourceInput/);
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 768, height: 900 },
        { width: 390, height: 844 },
        { width: 375, height: 812 },
        { width: 320, height: 740 }
      ]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
        const layout = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          metrics: Array.from(document.querySelectorAll<HTMLElement>("[data-result-metric]")).map((metric) => {
            const label = metric.querySelector<HTMLElement>("span");
            const box = metric.getBoundingClientRect();
            return {
              id: metric.dataset.resultMetric,
              x: box.x,
              y: box.y,
              right: box.right,
              clientWidth: metric.clientWidth,
              scrollWidth: metric.scrollWidth,
              labelClientWidth: label?.clientWidth ?? 0,
              labelScrollWidth: label?.scrollWidth ?? 0
            };
          })
        }));
        assert.ok(layout.scroll <= layout.client, `provider result ${viewport.width}px overflowed: ${JSON.stringify(layout)}`);
        assert.deepEqual(layout.metrics.map((metric) => metric.id), ["recommendation", "fit-score", "model-confidence"]);
        for (const metric of layout.metrics) {
          assert.ok(metric.right <= layout.client, `${metric.id} escaped the ${viewport.width}px viewport: ${JSON.stringify(metric)}`);
          assert.ok(metric.scrollWidth <= metric.clientWidth, `${metric.id} clipped at ${viewport.width}px: ${JSON.stringify(metric)}`);
          assert.ok(metric.labelScrollWidth <= metric.labelClientWidth, `${metric.id} label clipped at ${viewport.width}px: ${JSON.stringify(metric)}`);
        }
        const [recommendation, fitScore, confidence] = layout.metrics;
        if (viewport.width > 520) {
          assert.equal(Math.round(recommendation.y), Math.round(fitScore.y));
          assert.equal(Math.round(fitScore.y), Math.round(confidence.y));
        } else if (viewport.width > 340) {
          assert.ok(fitScore.y > recommendation.y, `recommendation did not span the narrow row at ${viewport.width}px`);
          assert.equal(Math.round(fitScore.y), Math.round(confidence.y));
        } else {
          assert.ok(fitScore.y > recommendation.y, `fit score did not stack at ${viewport.width}px`);
          assert.ok(confidence.y > fitScore.y, `confidence did not stack at ${viewport.width}px`);
        }
        if (process.env.JOB_MATCH_PROVIDER_RESULT_SCREENSHOT_DIR) {
          await page.screenshot({
            path: `${process.env.JOB_MATCH_PROVIDER_RESULT_SCREENSHOT_DIR}/job-match-provider-result-${viewport.width}.png`,
            fullPage: true
          });
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await review.locator('input[value="advice_claim"]').check();
    } else if (caseIndex === 1) {
      assert.equal(await review.getByText("The model reported no source-backed factual matches for this job.", { exact: true }).count(), 1);
      assert.equal(await review.getByText("The model reported no requirement gaps. That does not prove every requirement is satisfied.", { exact: true }).count(), 1);
      assert.equal(await review.locator(".advisory-list").getByText("Literal markup stays text:", { exact: false }).count(), 1);
      assert.equal(await review.locator("script[data-synthetic-result-xss]").count(), 0);
      assert.match(await review.innerText(), /LONG ADVICE END/);
      assert.doesNotMatch(await review.innerText(), /\[object Object\]/);
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
  assert.equal(await page.getByRole("heading", { name: "Reviewed result summary" }).count(), 1);
  assert.equal(await page.locator(".safe-result").count(), 4);
  assert.equal(await page.getByText("Model recommendation", { exact: true }).count(), 4);
  assert.equal(await page.getByText("Recommendation agreement", { exact: true }).count(), 4);
  assert.equal(await page.getByText("Model confidence", { exact: true }).count(), 4);
  assert.equal(await page.getByText("Advice overstates the evidence", { exact: true }).count(), 1);
  assert.doesNotMatch(await page.locator("section[data-phase='execution_complete']").innerText(), /advice_claim/);
  assert.equal(await page.locator("details[data-final-technical-details]").count(), 0);
  assert.equal(await page.getByText("Technical safe-report JSON", { exact: true }).count(), 0);
  assert.equal(await page.locator("section[data-phase='execution_complete'] pre").count(), 0);
  assert.doesNotMatch(await page.locator("section[data-phase='execution_complete']").innerText(), /\[object Object\]/);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic model angle|SYNTHETIC OWNER REVIEW PREVIEW/);
});

test("a stopped execution explains the failure and billing state without primary JSON", async (t) => {
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00.000Z")
  );
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
      activateTransport: async () => { throw new Error("PRIVATE CREDENTIAL DETAIL"); }
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
  await page.getByRole("heading", { name: "Qualification stopped safely." }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Why execution stopped" }).count(), 1);
  assert.match(await page.locator("section[data-phase='execution_stopped']").innerText(), /provider credential could not be activated|credential/i);
  assert.equal(await page.getByText("Known estimated cost", { exact: true }).count(), 1);
  assert.equal(await page.getByText("$0.000000", { exact: true }).count(), 1);
  assert.equal(await page.locator("details[data-final-technical-details]").count(), 0);
  assert.equal(await page.locator("section[data-phase='execution_stopped'] pre").count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /PRIVATE CREDENTIAL DETAIL|\[object Object\]/);
});

test("one delayed status poll preserves a pending provider-result review", async (t) => {
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
          requestId: `delayed-poll-${calls}`,
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
  assert.equal(calls, 1);
  await review.locator('input[value="advice_claim"]').check();

  let delayed = false;
  let stateRequests = 0;
  let releaseRetry!: () => void;
  const holdRetry = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route(workflow.stateUrl, async (route) => {
    delayed = true;
    stateRequests += 1;
    if (stateRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_750));
    if (stateRequests === 2) await holdRetry;
    await route.continue().catch(() => undefined);
  });
  await page.waitForFunction(
    (text) => document.getElementById("status")?.textContent === text,
    "Local status was briefly unavailable. Retrying before ending the review.",
    { timeout: 4_000 }
  );
  assert.equal(await page.locator("#connection-notice").isVisible(), true);
  assert.match(await page.locator("#connection-notice").innerText(), /controls are paused.*retries once/i);
  assert.equal(await review.getByRole("button", { name: "Record result review and continue" }).isDisabled(), true);
  assert.equal(await review.getByRole("button", { name: "Stop and release memory" }).isEnabled(), true);
  assert.equal(await review.locator('input[value="advice_claim"]').isChecked(), true);
  assert.equal(calls, 1);
  releaseRetry();
  await review.getByRole("button", { name: "Record result review and continue" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector('form[data-provider-review-case-id] button[type="submit"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  assert.equal(await page.locator("#connection-notice").isVisible(), false);

  assert.equal(delayed, true);
  assert.equal(calls, 1);
  assert.equal(await review.count(), 1);
  assert.equal(await review.getByRole("button", { name: "Record result review and continue" }).isEnabled(), true);
  assert.equal(await review.locator('input[value="advice_claim"]').isChecked(), true);
  assert.doesNotMatch(await page.locator("body").innerText(), /local evidence view is closed/i);

  await page.getByRole("button", { name: "Stop and release memory" }).click();
  assert.equal((await workflow.closed).trigger, "owner_cancel");
});

test("a successful retry that advances state clears the visible reconnect notice", async (t) => {
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
          requestId: `changed-state-retry-${calls}`,
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
  const firstReview = page.locator("form[data-provider-review-case-id]");
  await firstReview.waitFor();
  assert.equal(await firstReview.getAttribute("data-provider-review-case-id"), JOB_MATCH_QUALIFICATION_CASES[0].id);

  let stateRequests = 0;
  let releaseRetry!: () => void;
  const holdRetry = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route(workflow.stateUrl, async (route) => {
    stateRequests += 1;
    if (stateRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_750));
    if (stateRequests === 2) await holdRetry;
    await route.continue().catch(() => undefined);
  });
  await page.locator("#connection-notice").waitFor({ state: "visible", timeout: 4_000 });
  assert.equal((await fetch(workflow.executionReviewSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({
      caseId: JOB_MATCH_QUALIFICATION_CASES[0].id,
      disagreementCategories: []
    })
  })).status, 200);
  releaseRetry();
  const secondReview = page.locator(`form[data-provider-review-case-id="${JOB_MATCH_QUALIFICATION_CASES[1].id}"]`);
  await secondReview.waitFor({ timeout: 4_000 });
  assert.equal(calls, 2);
  assert.equal(await page.locator("#connection-notice").isVisible(), false);
  assert.equal(await secondReview.getByRole("button", { name: "Record result review and continue" }).isEnabled(), true);
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
  await page.getByText("Started or completed calls may be billable", { exact: false }).waitFor();
  assert.match(await page.locator("#app").innerText(), /terminal receipt.*final call and cost status/i);
  const receipt = await workflow.closed;
  assert.equal(receipt.reason, "navigation_or_owner_cancel");
  assert.equal(receipt.trigger, "owner_cancel");
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 0);
  assert.equal(receipt.knownInputTokens, 0);
  assert.equal(receipt.knownOutputTokens, 0);
  assert.equal(receipt.knownCachedInputTokens, 0);
  assert.equal(receipt.knownEstimatedCostMicros, 0);
  assert.equal(receipt.unknownBillingCallCount, 1);
  assert.equal(receipt.billingStatus, "unknown_for_started_calls");
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
  let stateRequests = 0;
  await page.route(workflow.stateUrl, (route) => {
    stateRequests += 1;
    return route.abort();
  });
  await consent.getByRole("button", { name: "Approve this exact four-call test" }).click();
  await page.getByText("A started request may have completed and may be billable", { exact: false }).waitFor({ timeout: 5_000 });
  assert.match(await page.locator("body").innerText(), /no later call can start after cancellation is acknowledged/i);
  assert.equal((await workflow.closed).trigger, "status_poll_failure");
  assert.equal(stateRequests, 2);
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
  assert.equal((await workflow.closed).trigger, "action_acknowledgement_lost");
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
  assert.equal((await workflow.closed).trigger, "action_acknowledgement_lost");
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
  assert.match(preview.output(), /"trigger":"pagehide"/);
  assert.doesNotMatch(preview.output(), /Synthetic owner evidence|SYNTHETIC OWNER REVIEW PREVIEW|generateContent/i);
  await page.close();
});

test("a definitive invalid state response fails closed without transient retry", async (t) => {
  const preview = await startPreview();
  t.after(() => preview.stop());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(preview.reviewUrl, { waitUntil: "networkidle" });
  await page.locator("form[data-case-id]").waitFor();
  const stateUrl = await page.evaluate(() => new URL(document.body.dataset.statePath ?? "", location.href).href);
  let stateRequests = 0;
  await page.route(stateUrl, (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"synthetic closed"}' });
  });

  await waitForExit(preview.child);
  assert.equal(stateRequests, 1);
  assert.match(preview.output(), /"trigger":"status_poll_failure"/);
  assert.doesNotMatch(preview.output(), /Synthetic owner evidence|SYNTHETIC OWNER REVIEW PREVIEW/);
});

test("a malformed successful state response fails closed without transient retry", async (t) => {
  const preview = await startPreview();
  t.after(() => preview.stop());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(preview.reviewUrl, { waitUntil: "networkidle" });
  await page.locator("form[data-case-id]").waitFor();
  const stateUrl = await page.evaluate(() => new URL(document.body.dataset.statePath ?? "", location.href).href);
  let stateRequests = 0;
  await page.route(stateUrl, (route) => {
    stateRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"phase":"reviewing"}' });
  });

  await waitForExit(preview.child);
  assert.equal(stateRequests, 1);
  assert.match(preview.output(), /"trigger":"status_poll_failure"/);
  assert.doesNotMatch(preview.output(), /Synthetic owner evidence|SYNTHETIC OWNER REVIEW PREVIEW/);
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
  assert.match(command.output(), /"reason":"session_timeout","trigger":"session_timeout"/);
  assert.doesNotMatch(command.output(), /awaiting_separate_google_consent/);
  await page.close();
});
