import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import {
  ApplicationFormInspectionControllerError,
  createApplicationFormInspectionController
} from "@/lib/application-browser/form-inspection-controller";
import { createProtectedApplicationBrowserSession } from "@/lib/application-browser/protected-browser-session";
import { buildNormalizedApplicationFormInspection } from "@/lib/application-runs/form-inspection";
import { hostMatchesPolicyEntry, parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

import {
  ATS_FIXTURE_VERSION,
  changingSelectApplicationHtml,
  confirmationApplicationHtml,
  mixedNativeApplicationHtml,
  multiStepBarrierHtml
} from "./ats-characterization-fixtures";

const TARGET_URL = "https://synthetic.example.test/apply";
const TARGET_HOST = "synthetic.example.test";
let browser: Browser;

before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function withProtectedPage(
  html: string,
  run: (input: {
    page: Page;
    context: BrowserContext;
    controller: ReturnType<typeof createApplicationFormInspectionController>;
    unsafeCodes: string[];
  }) => Promise<void>
): Promise<void> {
  const context = await browser.newContext();
  const unsafeCodes: string[] = [];
  const targetController = createPlaywrightTargetController({
    context,
    onUnsafe: (code) => { unsafeCodes.push(code); },
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
  });
  const target = parseExecutionTargetUrl(TARGET_URL);
  assert.ok(target);
  let controller: ReturnType<typeof createApplicationFormInspectionController> | null = null;
  try {
    await targetController.open({
      target,
      policy: { effectiveEnabled: true, allowedHosts: [TARGET_HOST], blockedHosts: [] }
    }, () => undefined);
    const page = targetController.page();
    const protectedTarget = targetController.formInspectionTarget();
    assert.ok(page);
    assert.ok(protectedTarget);
    // This test-owned route handles only local synthetic requests. No request falls through to the internet.
    await page.route("**/*", async (route, request) => {
      if (request.isNavigationRequest()) { await route.fallback(); return; }
      if (new URL(request.url()).origin === new URL(TARGET_URL).origin &&
        new URL(request.url()).pathname.startsWith("/collector/")) {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
        return;
      }
      await route.abort("blockedbyclient");
    });
    controller = createApplicationFormInspectionController({
      target: protectedTarget,
      authoritativeApplyHost: TARGET_HOST
    });
    await run({ page, context, controller, unsafeCodes });
  } finally {
    await controller?.close();
    await targetController.close();
    await context.close();
  }
}

function fieldsFrom(report: Parameters<typeof buildNormalizedApplicationFormInspection>[0]["report"]) {
  return buildNormalizedApplicationFormInspection({ authoritativeApplyHost: TARGET_HOST, report });
}

test("hypothetical native form: real classification, protected Fill, manual fields, and page-owned transport", async () => {
  assert.equal(ATS_FIXTURE_VERSION, "p0.1-local-v1");
  await withProtectedPage(mixedNativeApplicationHtml(), async ({ page, context, controller, unsafeCodes }) => {
    const requestPaths: string[] = [];
    const receivedPaths: string[] = [];
    const blockedPaths: string[] = [];
    context.on("request", (request) => requestPaths.push(new URL(request.url()).pathname));
    context.on("response", (response) => {
      if (response.status() === 200) receivedPaths.push(new URL(response.url()).pathname);
    });
    context.on("requestfailed", (request) => blockedPaths.push(new URL(request.url()).pathname));
    const generation = await controller.inspect();
    const normalized = fieldsFrom(generation.inspectionReport);
    const fields = normalized.snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields));
    assert.equal(fields.length, 4);
    assert.deepEqual(fields.map((field) => field.question).sort(), [
      "Email address", "I certify this application", "LinkedIn profile URL", "Resume"
    ]);
    const byQuestion = (question: string) => {
      const found = fields.filter((field) => field.question === question);
      assert.equal(found.length, 1, question);
      return found[0];
    };
    const profile = byQuestion("LinkedIn profile URL");
    assert.deepEqual([profile.classification, profile.permittedDisposition, profile.fieldType],
      ["PROFESSIONAL_LINK", "PROPOSABLE", "URL"]);
    assert.deepEqual([byQuestion("Email address").classification, byQuestion("Email address").permittedDisposition],
      ["CONTACT", "MANUAL_ONLY"]);
    assert.deepEqual([byQuestion("Resume").classification, byQuestion("Resume").permittedDisposition, byQuestion("Resume").fieldType],
      ["DOCUMENT", "PROPOSABLE", "FILE_UPLOAD"]);
    assert.deepEqual([byQuestion("I certify this application").classification,
      byQuestion("I certify this application").permittedDisposition],
      ["LEGAL_ATTESTATION", "MANUAL_ONLY"]);
    // The document question may be proposable as a reference; FILE_UPLOAD remains unwritable.
    assert.equal(fields.filter((field) => field.permittedDisposition === "PROPOSABLE").length, 2);
    assert.equal(JSON.stringify(generation.inspectionReport).includes("SYNTHETIC-HIDDEN-DO-NOT-EXPORT"), false);

    const approved = {
      normalizedFieldKey: profile.normalizedFieldKey,
      fieldFingerprint: profile.fieldFingerprint,
      fieldType: "URL" as const,
      proposal: { kind: "SCALAR" as const, value: "https://profile.example.test/synthetic" }
    };
    controller.assertAcquiredFillAuthority(generation.generationId, {
      formFingerprint: normalized.formFingerprint,
      fields: [approved]
    });
    const result = await controller.writeApprovedField(generation.generationId, approved);
    assert.equal(result.status, "FILLED");
    await assert.rejects(controller.writeApprovedField(generation.generationId, approved),
      (error: unknown) => error instanceof ApplicationFormInspectionControllerError && error.code === "FORM_GENERATION_INVALIDATED");
    assert.equal(await page.locator("#profile").inputValue(), approved.proposal.value);
    assert.equal(await page.locator("#email").inputValue(), "");
    assert.equal(await page.locator("#legal").isChecked(), false);
    assert.equal(await page.locator("#resume").inputValue(), "");
    await page.waitForFunction(() => Object.values((window as typeof window & { transportAttempts: Record<string, number> }).transportAttempts)
      .slice(0, 3).every((count) => count === 1));
    await page.waitForFunction(() => performance.getEntriesByType("resource").length >= 1);
    const attempts = await page.evaluate(() => (window as typeof window & { transportAttempts: Record<string, number> }).transportAttempts);
    assert.deepEqual(attempts, { fetch: 1, xhr: 1, beacon: 1, submit: 0 });
    assert.equal(requestPaths.filter((path) => path.startsWith("/collector/")).length, 3);
    await page.waitForFunction(() => performance.getEntriesByType("resource").length >= 3);
    assert.deepEqual(receivedPaths.filter((path) => path.startsWith("/collector/")).sort(),
      ["/collector/beacon", "/collector/fetch", "/collector/xhr"]);
    assert.equal(blockedPaths.filter((path) => path.startsWith("/collector/")).length, 0,
      `collector failures: ${JSON.stringify(blockedPaths)}`);
    assert.equal(requestPaths.includes("/submit"), false);
    assert.deepEqual(unsafeCodes, []);
  });
});

test("deceptive provider-looking host strings do not gain exact-host authority", () => {
  assert.equal(hostMatchesPolicyEntry("boards.greenhouse.io.evil.example", "boards.greenhouse.io"), false);
  assert.equal(hostMatchesPolicyEntry("notgreenhouse.io", "greenhouse.io"), false);
  assert.equal(hostMatchesPolicyEntry("tenant.boards.greenhouse.io", "boards.greenhouse.io"), true);
  assert.equal(parseExecutionTargetUrl("http://127.0.0.1:3100/apply"), null);
});

test("hypothetical multi-step login and CAPTCHA barrier is not an inspectable native form", async () => {
  await withProtectedPage(multiStepBarrierHtml(), async ({ page, controller }) => {
    await assert.rejects(controller.inspect(), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED");
    assert.equal(await page.locator("#password").inputValue(), "SYNTHETIC-NOT-A-CREDENTIAL");
    assert.equal(await page.locator("#captcha").isChecked(), false);
    assert.equal(await page.locator("#next").evaluate((element) => (element as HTMLButtonElement).disabled), false);
  });
});

test("hypothetical async select and duplicate labels invalidate old authority and preserve occupied values", async () => {
  await withProtectedPage(changingSelectApplicationHtml(), async ({ page, controller }) => {
    await assert.rejects(controller.inspect(), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "AMBIGUOUS_DUPLICATE_FIELD");
    await page.locator("#duplicate-b").evaluate((element) => element.remove());
    const oldGeneration = await controller.inspect();
    const oldFields = fieldsFrom(oldGeneration.inspectionReport).snapshot.forms.flatMap((form) =>
      form.sections.flatMap((section) => section.fields));
    assert.equal(oldFields.filter((field) => field.question === "Portfolio URL").length, 1);
    assert.equal(JSON.stringify(oldGeneration.inspectionReport).includes("SYNTHETIC-TRACKING"), false);
    await page.locator("#availability").evaluate((select) => {
      const option = document.createElement("option");
      option.value = "soon";
      option.textContent = "Within two weeks";
      select.append(option);
    });
    await assert.rejects(controller.assertCurrent(oldGeneration.generationId),
      (error: unknown) => error instanceof ApplicationFormInspectionControllerError && error.code === "FORM_GENERATION_INVALIDATED");
    const generation = await controller.inspect();
    const normalized = fieldsFrom(generation.inspectionReport);
    const fields = normalized.snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields));
    const select = fields.find((field) => field.question === "Availability");
    const occupied = fields.find((field) => field.question === "LinkedIn profile URL");
    assert.ok(select);
    assert.ok(occupied);
    assert.equal(select.fieldType, "SELECT_ONE");
    assert.equal(select.choices.length, 2);
    assert.equal(occupied.permittedDisposition, "PROPOSABLE");
    const request = {
      normalizedFieldKey: occupied.normalizedFieldKey,
      fieldFingerprint: occupied.fieldFingerprint,
      fieldType: "URL" as const,
      proposal: { kind: "SCALAR" as const, value: "https://replacement.example.test" }
    };
    controller.assertAcquiredFillAuthority(generation.generationId, {
      formFingerprint: normalized.formFingerprint, fields: [request]
    });
    const outcome = await controller.writeApprovedField(generation.generationId, request);
    assert.equal(outcome.status, "PRESERVED_EXISTING");
    assert.equal(await page.locator("#existing").inputValue(), "https://existing.example.test/profile");
  });
});

test("only the separate simulated HUMAN actor confirms in place; frozen target blocks confirmation navigation", async () => {
  await withProtectedPage(confirmationApplicationHtml(), async ({ page, controller, unsafeCodes }) => {
    await controller.inspect();
    assert.equal(await page.locator("#confirmation").textContent(), "");
    assert.equal(await page.evaluate(() => (window as typeof window & { humanActions: number }).humanActions), 0);
    assert.equal(await page.evaluate(() => (window as typeof window & { submitEvents: number }).submitEvents), 0);
    // The test actor is explicitly separate from the companion and acts only after this handoff point.
    await page.locator("#in-place").click();
    assert.equal(await page.locator("#confirmation").textContent(), "Application received");
    assert.equal(await page.evaluate(() => (window as typeof window & { submitEvents: number }).submitEvents), 1);
    await page.locator("#navigate").click({ noWaitAfter: true });
    const deadline = Date.now() + 2_000;
    while (!unsafeCodes.includes("TARGET_NAVIGATION_BLOCKED") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(new URL(page.url()).pathname, "/apply", `observed ${page.url()} after HUMAN navigation`);
    assert.equal(unsafeCodes.includes("TARGET_NAVIGATION_BLOCKED"), true);
  });
});
