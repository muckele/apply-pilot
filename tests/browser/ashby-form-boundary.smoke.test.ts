import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { createApplicationFormInspectionController } from "@/lib/application-browser/form-inspection-controller";
import { createProtectedApplicationBrowserSession } from "@/lib/application-browser/protected-browser-session";
import { buildNormalizedApplicationFormInspection } from "@/lib/application-runs/form-inspection";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

// Ashby's hosted application page renders no <form> element: its fields sit in one application
// panel, <div id="form" role="tabpanel">, next to an Overview/Application tab list (live case
// 2026-11-17: the reader refused the first field because it had no owning form). On that host
// only, and only when the page has no <form> at all, the panel is the form boundary. All data
// here is synthetic, and every request is answered locally: nothing reaches the internet.

const ASHBY_URL = "https://jobs.ashbyhq.com/acme-synthetic/00000000-0000-4000-8000-000000000001/application";
const OTHER_URL = "https://synthetic.example.test/apply";
let browser: Browser;

before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

type Variant = {
  outsideField?: boolean;
  secondPanel?: boolean;
  nativeForm?: boolean;
  radioOutside?: boolean;
  customInside?: boolean;
  shadowPanel?: boolean;
  hiddenPanel?: boolean;
};

function ashbyShapedHtml(options: Variant = {}): string {
  return `<!doctype html><html><head><title>Synthetic Role @ Acme</title></head><body><div id="root">
    <h1>Synthetic Role</h1>
    <div role="tablist">
      <a role="tab" id="overview" href="#overview-panel">Overview</a>
      <a role="tab" id="job-application-form" aria-selected="true" href="#form">Application</a>
    </div>
    <div tabindex="0" role="tabpanel" aria-labelledby="job-application-form" id="form"${options.hiddenPanel ? " hidden" : ""}>
      <div><p>Autofill from resume</p><input type="file" aria-label="Autofill from resume"><button type="button">Upload file</button></div>
      <div><label for="_systemfield_name">Name</label><input id="_systemfield_name" name="_systemfield_name" type="text" required></div>
      <div><label for="_systemfield_email">Email</label><input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
      <div><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" type="file"><button type="button">Upload File</button></div>
      <div><label for="q-why">Why this team?</label><textarea id="q-why" name="q-why" required></textarea></div>
      <div><label for="q-linkedin">LinkedIn</label><input id="q-linkedin" name="q-linkedin" type="text"></div>
      ${options.radioOutside ? `<fieldset><legend>Authorized to work?</legend><label><input type="radio" name="q-auth" value="yes">Yes</label><label><input type="radio" name="q-auth" value="no">No</label></fieldset>` : ""}
      ${options.customInside ? `<synthetic-widget aria-label="Custom widget"></synthetic-widget>` : ""}
      <button type="submit" id="submit-application">Submit Application</button>
    </div>
    ${options.secondPanel ? `<div id="form" role="tabpanel"><label for="q-extra">Extra</label><input id="q-extra" type="text"></div>` : ""}
    ${options.outsideField ? `<div><label for="q-outside">Outside question</label><input id="q-outside" type="text"></div>` : ""}
    ${options.nativeForm ? `<form id="newsletter"><label for="q-news">Newsletter email</label><input id="q-news" type="email"></form>` : ""}
    ${options.radioOutside ? `<input type="radio" name="q-auth" value="other" hidden>` : ""}
  </div>
  <script>
    window.submitEvents = 0;
    document.getElementById("submit-application").addEventListener("click", () => { window.submitEvents += 1; });
    ${options.shadowPanel ? `document.getElementById("form").attachShadow({ mode: "open" }).innerHTML = "<slot></slot><iframe title='hidden extra'></iframe><input aria-label='Shadow extra'>";` : ""}
  </script></body></html>`;
}

async function withProtectedPage(
  url: string,
  html: string,
  run: (input: {
    page: Page;
    context: BrowserContext;
    host: string;
    controller: ReturnType<typeof createApplicationFormInspectionController>;
    unsafeCodes: string[];
  }) => Promise<void>
): Promise<void> {
  const host = new URL(url).hostname;
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
  const target = parseExecutionTargetUrl(url);
  assert.ok(target);
  let controller: ReturnType<typeof createApplicationFormInspectionController> | null = null;
  try {
    await targetController.open({
      target,
      policy: { effectiveEnabled: true, allowedHosts: [host], blockedHosts: [] }
    }, () => undefined);
    const page = targetController.page();
    const protectedTarget = targetController.formInspectionTarget();
    assert.ok(page);
    assert.ok(protectedTarget);
    // Only the main document is served (above); every other request is refused locally.
    await page.route("**/*", async (route, request) => {
      if (request.isNavigationRequest()) { await route.fallback(); return; }
      await route.abort("blockedbyclient");
    });
    controller = createApplicationFormInspectionController({ target: protectedTarget, authoritativeApplyHost: host });
    await run({ page, context, host, controller, unsafeCodes });
  } finally {
    await controller?.close();
    await targetController.close();
    await context.close();
  }
}

function refusedAsUnmatched(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "FORM_CORRELATION_INVALID";
}

test("on Ashby's hosted page, the application panel is the form: it is read, and Fill writes one approved field", async () => {
  await withProtectedPage(ASHBY_URL, ashbyShapedHtml(), async ({ page, host, controller, unsafeCodes }) => {
    const generation = await controller.inspect();
    const normalized = buildNormalizedApplicationFormInspection({ authoritativeApplyHost: host, report: generation.inspectionReport });
    const fields = normalized.snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields));
    assert.deepEqual(fields.map((field) => field.question).sort(), [
      "Autofill from resume", "Email", "LinkedIn", "Name", "Resume", "Why this team?"
    ]);
    const linkedIn = fields.find((field) => field.question === "LinkedIn");
    assert.ok(linkedIn);
    assert.equal(linkedIn.permittedDisposition, "PROPOSABLE");
    const approved = {
      normalizedFieldKey: linkedIn.normalizedFieldKey,
      fieldFingerprint: linkedIn.fieldFingerprint,
      fieldType: linkedIn.fieldType as "TEXT",
      proposal: { kind: "SCALAR" as const, value: "https://profile.example.test/synthetic" }
    };
    controller.assertAcquiredFillAuthority(generation.generationId, { formFingerprint: normalized.formFingerprint, fields: [approved] });
    assert.equal((await controller.writeApprovedField(generation.generationId, approved)).status, "FILLED");
    assert.equal(await page.locator("#q-linkedin").inputValue(), approved.proposal.value);
    assert.equal(await page.locator("#_systemfield_name").inputValue(), "");
    assert.equal(await page.locator("#q-why").inputValue(), "");
    assert.equal(await page.evaluate(() => (window as typeof window & { submitEvents: number }).submitEvents), 0);
    assert.deepEqual(unsafeCodes, []);
  });
});

test("the same panel on any other host still needs a real form", async () => {
  await withProtectedPage(OTHER_URL, ashbyShapedHtml(), async ({ controller }) => {
    await assert.rejects(controller.inspect(), refusedAsUnmatched);
  });
});

test("on Ashby's host, anything beyond one plain panel holding every field still stops reading", async () => {
  const variants: Variant[] = [
    { outsideField: true }, { secondPanel: true }, { nativeForm: true }, { radioOutside: true },
    { customInside: true }, { shadowPanel: true }, { hiddenPanel: true }
  ];
  for (const variant of variants) {
    await withProtectedPage(ASHBY_URL, ashbyShapedHtml(variant), async ({ controller }) => {
      await assert.rejects(controller.inspect(), refusedAsUnmatched, JSON.stringify(variant));
    });
  }
});

test("replacing the panel after reading stops Fill and types nothing", async () => {
  await withProtectedPage(ASHBY_URL, ashbyShapedHtml(), async ({ page, host, controller }) => {
    const generation = await controller.inspect();
    const normalized = buildNormalizedApplicationFormInspection({ authoritativeApplyHost: host, report: generation.inspectionReport });
    const linkedIn = normalized.snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields))
      .find((field) => field.question === "LinkedIn");
    assert.ok(linkedIn);
    const approved = {
      normalizedFieldKey: linkedIn.normalizedFieldKey,
      fieldFingerprint: linkedIn.fieldFingerprint,
      fieldType: linkedIn.fieldType as "TEXT",
      proposal: { kind: "SCALAR" as const, value: "https://profile.example.test/synthetic" }
    };
    controller.assertAcquiredFillAuthority(generation.generationId, { formFingerprint: normalized.formFingerprint, fields: [approved] });
    await page.locator("#form").evaluate((panel) => panel.replaceWith(panel.cloneNode(true)));
    // Fill re-reads the page before it types: the field now sits in a different panel.
    assert.deepEqual(await controller.writeApprovedField(generation.generationId, approved),
      { status: "FAILED", reason: "CANDIDATE_INVALID" });
    assert.equal(await page.locator("#q-linkedin").inputValue(), "");
  });
});

test("a field moved out of the panel, or a form added, after reading stops Fill and types nothing", async () => {
  const changes: Array<(page: Page) => Promise<void>> = [
    (page) => page.locator("#q-linkedin").evaluate((field) => document.getElementById("root")?.append(field)),
    (page) => page.evaluate(() => document.getElementById("root")?.append(document.createElement("form")))
  ];
  for (const change of changes) {
    await withProtectedPage(ASHBY_URL, ashbyShapedHtml(), async ({ page, host, controller }) => {
      const generation = await controller.inspect();
      const normalized = buildNormalizedApplicationFormInspection({ authoritativeApplyHost: host, report: generation.inspectionReport });
      const linkedIn = normalized.snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields))
        .find((field) => field.question === "LinkedIn");
      assert.ok(linkedIn);
      const approved = {
        normalizedFieldKey: linkedIn.normalizedFieldKey,
        fieldFingerprint: linkedIn.fieldFingerprint,
        fieldType: linkedIn.fieldType as "TEXT",
        proposal: { kind: "SCALAR" as const, value: "https://profile.example.test/synthetic" }
      };
      controller.assertAcquiredFillAuthority(generation.generationId, { formFingerprint: normalized.formFingerprint, fields: [approved] });
      await change(page);
      assert.deepEqual(await controller.writeApprovedField(generation.generationId, approved),
        { status: "FAILED", reason: "CANDIDATE_INVALID" });
      assert.equal(await page.locator("#q-linkedin").inputValue(), "");
    });
  }
});
