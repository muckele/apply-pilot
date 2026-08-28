import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import {
  ApplicationBrowserCoordinator,
  createPlaywrightTargetController
} from "@/lib/application-browser/coordinator";
import { createSameOriginClient } from "@/lib/application-browser/same-origin-client";
import { APPLICATION_BROWSER_BINDING_NAME, type B1Command } from "@/lib/application-browser/types";
import {
  BROWSER_SMOKE_RUN_ID,
  SYNTHETIC_EMPLOYER_URL,
  startBrowserFixtureServers,
  syntheticEmployerHtml
} from "@/tests/browser/fixture-server";

type BindingWindow = Window & {
  __applyPilotB1Command?: (command: B1Command & Record<string, unknown>) => Promise<unknown>;
  __b1Trap?: { clicks: number; keys: number; inputs: number; submissions: number };
};

async function launchSmokeBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
}

async function createWorkflow(input: {
  browser: Browser;
  controlOrigin: string;
  controlUrl: string;
  mutationUrl: string;
  redirectEmployerTo?: string;
  redirectEmployer?: (requestUrl: string) => string | undefined;
}) {
  const context = await input.browser.newContext();
  const controlPage = await context.newPage();
  await controlPage.goto(input.controlUrl, { waitUntil: "domcontentloaded" });
  const targetController = createPlaywrightTargetController({
    context,
    onUnsafe: async (code) => coordinator.safeStop(code),
    testOnlyFulfillMainDocument: async (request, route) => {
      const redirectEmployerTo = input.redirectEmployer?.(request.url()) ?? input.redirectEmployerTo;
      if (redirectEmployerTo) {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><script>location.replace(${JSON.stringify(redirectEmployerTo)})</script>`
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: syntheticEmployerHtml(input.mutationUrl)
      });
    }
  });
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: input.controlOrigin,
    immutableRunId: BROWSER_SMOKE_RUN_ID,
    client: createSameOriginClient({
      configuredApplyPilotOrigin: input.controlOrigin,
      immutableRunId: BROWSER_SMOKE_RUN_ID,
      requestContext: context.request
    }),
    openTarget: (target, assertActive) => targetController.open(target, assertActive),
    closeResources: () => targetController.close()
  });
  await installControlBridge({
    controlPage,
    configuredApplyPilotOrigin: input.controlOrigin,
    immutableRunId: BROWSER_SMOKE_RUN_ID,
    getState: () => coordinator.state(),
    execute: (command, assertActive) => coordinator.handleCommand(command, assertActive),
    onTrustLost: (code) => coordinator.safeStop(code)
  });
  coordinator.markControlReady();
  return { context, controlPage, coordinator, targetController };
}

async function invoke(page: Page, command: B1Command & Record<string, unknown>) {
  return page.evaluate(
    async ({ bindingName, value }) => {
      const binding = (window as BindingWindow)[bindingName as typeof APPLICATION_BROWSER_BINDING_NAME];
      if (!binding) throw new Error("binding absent");
      return binding(value);
    },
    { bindingName: APPLICATION_BROWSER_BINDING_NAME, value: command }
  );
}

async function waitForWorkflowError(coordinator: ApplicationBrowserCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 50 && coordinator.status().state !== "ERROR"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withBrowserFixtures(
  run: (
    browser: Browser,
    fixtures: Awaited<ReturnType<typeof startBrowserFixtureServers>>
  ) => Promise<void>
): Promise<void> {
  const fixtures = await startBrowserFixtureServers();
  const browser = await launchSmokeBrowser();
  try {
    await run(browser, fixtures);
  } finally {
    await browser.close();
    await fixtures.close();
  }
}

test("real Chromium enforces the B1 control boundary and performs no employer mutation", async () => {
  const fixtures = await startBrowserFixtureServers();
  const browser = await launchSmokeBrowser();
  try {
    const success = await createWorkflow({ browser, ...fixtures });
    assert.equal(success.context.browser(), browser);
    assert.notEqual(new URL(success.controlPage.url()).origin, "https://employer.example.test");
    assert.equal(
      await success.controlPage.evaluate((name) => typeof (window as unknown as Record<string, unknown>)[name], APPLICATION_BROWSER_BINDING_NAME),
      "function"
    );
    assert.deepEqual(await invoke(success.controlPage, { type: "GET_STATUS" }), {
      state: "CONTROL_READY",
      runId: BROWSER_SMOKE_RUN_ID
    });

    const child = success.controlPage.frames().find((frame) => frame !== success.controlPage.mainFrame());
    assert.ok(child);
    await assert.rejects(
      child.evaluate(async (name) => {
        const binding = (window as unknown as Record<string, (value: unknown) => Promise<unknown>>)[name];
        return binding({ type: "GET_STATUS" });
      }, APPLICATION_BROWSER_BINDING_NAME),
      /main frame/i
    );

    await assert.rejects(
      invoke(success.controlPage, { type: "OPEN_TARGET", url: "https://attacker.example" }),
      /Invalid B1 command/i
    );
    assert.deepEqual(await invoke(success.controlPage, { type: "OPEN_TARGET" }), {
      state: "TARGET_OPEN",
      runId: BROWSER_SMOKE_RUN_ID,
      targetHost: "employer.example.test"
    });
    const employerPage = success.targetController.page();
    assert.ok(employerPage);
    assert.notEqual(new URL(employerPage.url()).origin, fixtures.controlOrigin);
    assert.equal(await employerPage.opener(), null);
    assert.equal(
      await employerPage.evaluate((name) => typeof (window as unknown as Record<string, unknown>)[name], APPLICATION_BROWSER_BINDING_NAME),
      "undefined"
    );
    assert.equal(await employerPage.locator("#name").inputValue(), "");
    assert.deepEqual(await employerPage.evaluate(() => (window as BindingWindow).__b1Trap), {
      clicks: 0,
      keys: 0,
      inputs: 0,
      submissions: 0
    });
    assert.equal(fixtures.mutationHits(), 0);
    await success.coordinator.close();
    await success.context.close();
    assert.equal(success.coordinator.status().state, "CLOSED");

    fixtures.setRunDelay(200);
    const navigationFailure = await createWorkflow({ browser, ...fixtures });
    const callback = invoke(navigationFailure.controlPage, { type: "OPEN_TARGET" }).then(
      () => ({ fulfilled: true as const, error: null }),
      (error: unknown) => ({ fulfilled: false as const, error })
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await navigationFailure.controlPage.goto(`${fixtures.alternateOrigin}/left-control`).catch(() => undefined);
    const callbackOutcome = await callback;
    assert.equal(callbackOutcome.fulfilled, false);
    assert.match(String(callbackOutcome.error), /stale|closed|Target page|Execution context/i);
    assert.equal(navigationFailure.coordinator.status().state, "ERROR");
    assert.equal(navigationFailure.coordinator.status().errorCode, "CONTROL_NAVIGATION_TRUST_LOST");
    await navigationFailure.coordinator.close();
    await navigationFailure.context.close();
    fixtures.setRunDelay(0);

    const redirectFailure = await createWorkflow({
      browser,
      ...fixtures,
      redirectEmployerTo: "https://attacker.example/steal"
    });
    let unauthorizedFinished = 0;
    redirectFailure.context.on("requestfinished", (request) => {
      if (request.url().startsWith("https://attacker.example/")) unauthorizedFinished += 1;
    });
    await invoke(redirectFailure.controlPage, { type: "OPEN_TARGET" }).then(
      () => "fulfilled",
      () => "rejected"
    );
    for (let attempt = 0; attempt < 50 && redirectFailure.coordinator.status().state !== "ERROR"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(unauthorizedFinished, 0);
    assert.equal(redirectFailure.coordinator.status().state, "ERROR");
    assert.equal(redirectFailure.coordinator.status().errorCode, "TARGET_NAVIGATION_BLOCKED");
    await redirectFailure.coordinator.close();
    await redirectFailure.context.close();

    const popupFailure = await createWorkflow({ browser, ...fixtures });
    let popup: Page | undefined;
    popupFailure.context.once("page", (page) => {
      if (page !== popupFailure.controlPage) popup = page;
    });
    await popupFailure.controlPage.evaluate((url) => window.open(url, "_blank"), fixtures.popupUrl);
    await assert.doesNotReject(async () => {
      for (let attempt = 0; attempt < 50 && popupFailure.coordinator.status().state !== "ERROR"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(popupFailure.coordinator.status().state, "ERROR");
    });
    assert.ok(popup);
    assert.equal(popup.isClosed(), true);
    assert.equal(popupFailure.coordinator.status().errorCode, "UNEXPECTED_POPUP");
    await popupFailure.coordinator.close();
    await popupFailure.context.close();
  } finally {
    await browser.close();
    await fixtures.close();
  }
});

test("real Chromium blocks a same-host different-port navigation before it can redirect back", async () => {
  await withBrowserFixtures(async (browser, fixtures) => {
    const alternatePortUrl = "https://employer.example.test:444/steal";
    const canonicalTarget = new URL(SYNTHETIC_EMPLOYER_URL);
    canonicalTarget.hash = "";
    let sentToAlternatePort = false;
    let alternatePortFulfillCalls = 0;
    let alternatePortAttempts = 0;
    let alternatePortFinished = 0;
    const workflow = await createWorkflow({
      browser,
      ...fixtures,
      redirectEmployer(requestUrl) {
        if (requestUrl === canonicalTarget.toString() && !sentToAlternatePort) {
          sentToAlternatePort = true;
          return alternatePortUrl;
        }
        if (requestUrl === alternatePortUrl) {
          alternatePortFulfillCalls += 1;
          return SYNTHETIC_EMPLOYER_URL;
        }
        return undefined;
      }
    });
    workflow.context.on("request", (request) => {
      if (request.url() === alternatePortUrl) alternatePortAttempts += 1;
    });
    workflow.context.on("requestfinished", (request) => {
      if (request.url() === alternatePortUrl) alternatePortFinished += 1;
    });

    const outcome = await invoke(workflow.controlPage, { type: "OPEN_TARGET" }).then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
    await waitForWorkflowError(workflow.coordinator);

    assert.equal(outcome, "rejected");
    assert.equal(alternatePortAttempts, 1);
    assert.equal(alternatePortFinished, 0);
    assert.equal(alternatePortFulfillCalls, 0);
    assert.equal(workflow.coordinator.status().state, "ERROR");
    assert.equal(workflow.coordinator.status().errorCode, "TARGET_NAVIGATION_BLOCKED");
    assert.equal(fixtures.mutationHits(), 0);
    await workflow.coordinator.close();
    await workflow.context.close();
  });
});

test("real Chromium safe-stops on delayed same-document path drift after TARGET_OPEN", async () => {
  await withBrowserFixtures(async (browser, fixtures) => {
    const workflow = await createWorkflow({ browser, ...fixtures });
    await invoke(workflow.controlPage, { type: "OPEN_TARGET" });
    assert.equal(workflow.coordinator.status().state, "TARGET_OPEN");
    const employerPage = workflow.targetController.page();
    assert.ok(employerPage);
    const mainFrameNavigations: string[] = [];
    employerPage.on("framenavigated", (frame) => {
      if (frame === employerPage.mainFrame()) mainFrameNavigations.push(frame.url());
    });

    await employerPage.evaluate(() => history.pushState({}, "", "/login"));
    await waitForWorkflowError(workflow.coordinator);

    assert.equal(mainFrameNavigations.includes("https://employer.example.test/login"), true);
    assert.equal(workflow.coordinator.status().state, "ERROR");
    assert.equal(workflow.coordinator.status().errorCode, "TARGET_NAVIGATION_BLOCKED");
    assert.equal(fixtures.mutationHits(), 0);
    await workflow.coordinator.close();
    await workflow.context.close();
  });
});

test("real Chromium allows fragment drift but safe-stops on delayed same-document query drift", async () => {
  await withBrowserFixtures(async (browser, fixtures) => {
    const workflow = await createWorkflow({ browser, ...fixtures });
    await invoke(workflow.controlPage, { type: "OPEN_TARGET" });
    assert.equal(workflow.coordinator.status().state, "TARGET_OPEN");
    const employerPage = workflow.targetController.page();
    assert.ok(employerPage);
    const mainFrameNavigations: string[] = [];
    employerPage.on("framenavigated", (frame) => {
      if (frame === employerPage.mainFrame()) mainFrameNavigations.push(frame.url());
    });

    await employerPage.evaluate(() => history.pushState({}, "", "/apply?posting=123#review"));
    await employerPage.waitForTimeout(25);
    assert.equal(workflow.coordinator.status().state, "TARGET_OPEN");

    await employerPage.evaluate(() => history.pushState({}, "", "/apply?posting=changed"));
    await waitForWorkflowError(workflow.coordinator);

    assert.equal(
      mainFrameNavigations.includes("https://employer.example.test/apply?posting=changed"),
      true
    );
    assert.equal(workflow.coordinator.status().state, "ERROR");
    assert.equal(workflow.coordinator.status().errorCode, "TARGET_NAVIGATION_BLOCKED");
    assert.equal(fixtures.mutationHits(), 0);
    await workflow.coordinator.close();
    await workflow.context.close();
  });
});
