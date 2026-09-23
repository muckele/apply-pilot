import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";

import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { launchApplicationBrowserRuntimeWithLauncherForTest } from "@/lib/application-browser/browser-runtime";
import { createProtectedApplicationBrowserSession } from "@/lib/application-browser/protected-browser-session";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

const targetUrl = "https://synthetic.example.test/apply";
const controlOrigin = "https://apply-pilot.example.test";
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("real disposable runtime closes both contexts without cleanup uncertainty", async () => {
  const runtime = await launchApplicationBrowserRuntimeWithLauncherForTest({
    launch: () => chromium.launch({ headless: true })
  });
  await runtime.employerContext.newPage();
  await runtime.close();
  await runtime.close();
});

test("integrated target retains filled page only after protected retirement then permits human confirmation navigation", async () => {
  const context = await browser.newContext();
  const unsafe: string[] = [];
  const controller = createPlaywrightTargetController({
    context,
    onUnsafe: (code) => { unsafe.push(code); },
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(request, route) {
      const path = new URL(request.url()).pathname;
      await route.fulfill({ status: 200, contentType: "text/html", body: path === "/apply"
        ? '<form action="/confirmation" method="get"><label>Profile<input id="profile" value="synthetic-filled"></label><button>Submit</button></form>'
        : "<!doctype html><p>Synthetic confirmation</p>" });
    }
  });
  try {
    const target = parseExecutionTargetUrl(targetUrl);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
    const page = controller.page();
    assert.ok(page);
    const capturedTarget = controller.formInspectionTarget();
    assert.ok(capturedTarget);
    await controller.retireForHuman(controlOrigin, () => undefined);
    assert.equal(controller.formInspectionTarget(), null);
    await assert.rejects(capturedTarget.authority.snapshot());
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator("#profile").inputValue(), "synthetic-filled");
    // Separate simulated HUMAN actor; the companion never clicks Submit.
    await page.locator("button").click();
    assert.equal(new URL(page.url()).pathname, "/confirmation", `unsafe=${JSON.stringify(unsafe)}`);
    assert.equal(await page.locator("p").textContent(), "Synthetic confirmation");
    assert.deepEqual(unsafe, []);
  } finally {
    await controller.close();
    await context.close();
  }
});

test("a held real route callback refuses retirement before navigation policy changes", async () => {
  const context = await browser.newContext();
  let entered!: () => void;
  let release!: () => void;
  const routeEntered = new Promise<void>((resolve) => { entered = resolve; });
  const heldRoute = new Promise<void>((resolve) => { release = resolve; });
  const controller = createPlaywrightTargetController({
    context,
    onUnsafe: () => undefined,
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Frozen target</p>" });
    },
    async testOnlyBeforeRouteContinue(request) {
      if (!request.url().includes("/collector/pending")) return;
      entered();
      await heldRoute;
    }
  });
  try {
    const target = parseExecutionTargetUrl(targetUrl);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
    const page = controller.page();
    assert.ok(page);
    void page.evaluate(() => fetch("/collector/pending").catch(() => undefined)).catch(() => undefined);
    await Promise.race([routeEntered, new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Route callback was not held.")), 1_000))]);
    await assert.rejects(controller.retireForHuman(controlOrigin, () => undefined));
    assert.equal(controller.formInspectionTarget(), null);
    await controller.close();
  } finally {
    release();
    await context.close();
  }
});

test("resolved CDP disposal errors cannot complete handoff or retain a live employer page", async () => {
  for (const disposalResponse of [
    { result: { type: "string", value: "WRONG" } },
    { result: { type: "string", value: "DISPOSED" }, exceptionDetails: { text: "synthetic failure" } }
  ]) {
    const context = await browser.newContext();
    const originalNewCdp = context.newCDPSession.bind(context);
    context.newCDPSession = async (page: Page): Promise<CDPSession> => {
      const real = await originalNewCdp(page);
      return new Proxy(real, {
        get(target, property) {
          if (property === "send") return (method: string, params?: { functionDeclaration?: string }) =>
            method === "Runtime.callFunctionOn" && params?.functionDeclaration === "function () { return this.dispose(); }"
              ? Promise.resolve(disposalResponse)
              : target.send(method as Parameters<CDPSession["send"]>[0], params as never);
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as CDPSession;
    };
    const controller = createPlaywrightTargetController({
      context, onUnsafe: () => undefined,
      testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
      async testOnlyFulfillMainDocument(_request, route) {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Synthetic form</p>" });
      }
    });
    try {
      const target = parseExecutionTargetUrl(targetUrl);
      assert.ok(target);
      await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
      const page = controller.page();
      assert.ok(page);
      await assert.rejects(controller.retireForHuman(controlOrigin, () => undefined));
      assert.equal(controller.formInspectionTarget(), null);
      await controller.close();
      assert.equal(page.isClosed(), true);
    } finally {
      await controller.close();
      await context.close();
    }
  }
});

test("an unsettled policy-CDP decision during setup refuses the human-only switch", async () => {
  const context = await browser.newContext();
  let decisionEntered!: () => void;
  let releaseDecision!: () => void;
  const entered = new Promise<void>((resolve) => { decisionEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseDecision = resolve; });
  const controller = createPlaywrightTargetController({
    context, onUnsafe: () => undefined,
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Synthetic form</p>" });
    },
    async testOnlyCreateHumanPolicySession(page) {
      const real = await context.newCDPSession(page);
      return new Proxy(real, {
        get(target, property) {
          if (property === "send") return async (method: string, params?: Record<string, unknown>) => {
            const response = await target.send(method as Parameters<CDPSession["send"]>[0], params as never);
            if (method === "Fetch.failRequest") { decisionEntered(); await held; }
            return response;
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as CDPSession;
    },
    async testOnlyBeforeHumanPolicySwitch() {
      const page = controller.page();
      assert.ok(page);
      void page.evaluate(() => { location.href = new URL("/late-navigation", location.href).toString(); }).catch(() => undefined);
      await Promise.race([entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No CDP decision.")), 2_000))]);
    }
  });
  try {
    const target = parseExecutionTargetUrl(targetUrl);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
    const page = controller.page();
    assert.ok(page);
    await assert.rejects(controller.retireForHuman(controlOrigin, () => undefined));
    releaseDecision();
    await controller.close();
    assert.equal(page.isClosed(), true);
  } finally {
    releaseDecision();
    await controller.close();
    await context.close();
  }
});

test("retirement ingress blocks a new page-owned route during policy setup", async () => {
  const context = await browser.newContext();
  let routeContinued = false;
  const controller = createPlaywrightTargetController({
    context, onUnsafe: () => undefined,
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Synthetic form</p>" });
    },
    async testOnlyBeforeRouteContinue(request) {
      if (request.url().endsWith("/late-fetch")) routeContinued = true;
    },
    async testOnlyBeforeHumanPolicySwitch() {
      const page = controller.page();
      assert.ok(page);
      const failed = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/late-fetch"));
      void page.evaluate(() => fetch("/late-fetch").catch(() => undefined));
      await failed;
    }
  });
  try {
    const target = parseExecutionTargetUrl(targetUrl);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
    await controller.retireForHuman(controlOrigin, () => undefined);
    assert.equal(routeContinued, false);
  } finally {
    await controller.close();
    await context.close();
  }
});

test("a page-script popup after handoff closes the unexpected page and exact-owned target", async () => {
  const context = await browser.newContext();
  const unexpectedPages: import("playwright").Page[] = [];
  context.on("page", (page) => { unexpectedPages.push(page); });
  const unsafe: string[] = [];
  const controller = createPlaywrightTargetController({
    context,
    onUnsafe(code) { unsafe.push(code); void controller.close(); },
    testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({ status: 200, contentType: "text/html", body:
        '<!doctype html><button id="popup" onclick="window.open(\'/popup\')">Popup</button>' });
    }
  });
  try {
    const target = parseExecutionTargetUrl(targetUrl);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
    await controller.retireForHuman(controlOrigin, () => undefined);
    const page = controller.page();
    assert.ok(page);
    await page.locator("#popup").click(); // HUMAN test click causes untrusted page script to open the popup.
    const deadline = Date.now() + 2000;
    while (!unsafe.includes("UNEXPECTED_POPUP") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unsafe, ["UNEXPECTED_POPUP"]);
    await controller.close();
    assert.equal(page.isClosed(), true);
    assert.equal(unexpectedPages.every((candidate) => candidate.isClosed()), true);
  } finally {
    await controller.close();
    await context.close();
  }
});
