import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import {
  ApplicationFormInspectionControllerError,
  createApplicationFormInspectionController,
  type ApplicationFormInspectionController,
  type ApplicationFormInspectionInvalidationCode,
  type ProtectedFormInspectionTarget
} from "@/lib/application-browser/form-inspection-controller";
import {
  createProtectedApplicationBrowserSession,
  type ProtectedApplicationBrowserSession
} from "@/lib/application-browser/protected-browser-session";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";
import {
  privacyFixture,
  readFormInspectionTraps
} from "@/tests/browser/form-inspection-fixtures";
import {
  CSSOM_FORM_HTML,
  OPEN_SHADOW_FORM_HTML,
  SEMANTIC_SURFACE_FORM_HTML,
  STABLE_FORM_HTML
} from "@/tests/browser/form-inspection-stability-fixtures";

const TARGET_URL = "https://employer.example.test/apply";
const TARGET_HOST = "employer.example.test";

let browser: Browser;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)
    ) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});

after(async () => {
  await browser?.close();
});

type ProtectedHarness = Readonly<{
  context: BrowserContext;
  page: Page;
  session: ProtectedApplicationBrowserSession;
  targetController: ReturnType<typeof createPlaywrightTargetController>;
  controller: ApplicationFormInspectionController;
  invalidations: ApplicationFormInspectionInvalidationCode[];
  unsafeCodes: string[];
  close(): Promise<void>;
}>;

async function createProtectedHarness(
  html: string,
  options: Readonly<{
    transformTarget?(
      target: ProtectedFormInspectionTarget,
      page: Page
    ): ProtectedFormInspectionTarget;
  }> = {}
): Promise<ProtectedHarness> {
  const context = await browser.newContext();
  let session: ProtectedApplicationBrowserSession | null = null;
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  const unsafeCodes: string[] = [];
  const targetController = createPlaywrightTargetController({
    context,
    onUnsafe(code) {
      unsafeCodes.push(code);
    },
    async testOnlyCreateProtectedSession(page) {
      const created = await createProtectedApplicationBrowserSession({ page });
      session = created;
      return created;
    },
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: html
      });
    }
  });
  const target = parseExecutionTargetUrl(TARGET_URL);
  assert.ok(target);

  try {
    await targetController.open({
      target,
      policy: { effectiveEnabled: true, allowedHosts: [TARGET_HOST], blockedHosts: [] }
    }, () => undefined);
    const page = targetController.page();
    const ownedTarget = targetController.formInspectionTarget();
    assert.ok(page);
    assert.ok(ownedTarget);
    assert.ok(session);
    const controllerTarget = options.transformTarget?.(ownedTarget, page) ?? ownedTarget;
    const controller = createApplicationFormInspectionController({
      target: controllerTarget,
      authoritativeApplyHost: TARGET_HOST,
      onInvalidated(code) {
        invalidations.push(code);
      }
    });
    let closePromise: Promise<void> | null = null;
    return {
      context,
      page,
      session,
      targetController,
      controller,
      invalidations,
      unsafeCodes,
      close() {
        closePromise ??= (async () => {
          await controller.close();
          await targetController.close();
          await context.close();
        })();
        return closePromise;
      }
    };
  } catch (error) {
    await targetController.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function withHarness<T>(
  html: string,
  run: (harness: ProtectedHarness) => Promise<T>,
  options: Parameters<typeof createProtectedHarness>[1] = {}
): Promise<T> {
  const harness = await createProtectedHarness(html, options);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}

function hasControllerCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ApplicationFormInspectionControllerError && error.code === code;
}

async function waitForNoCurrent(controller: ApplicationFormInspectionController): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (controller.current() !== null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.current(), null);
}

test("stable production protected wiring accepts only a verified private candidate", async () => {
  await withHarness(STABLE_FORM_HTML, async ({ controller }) => {
    const generation = await controller.inspect();

    assert.equal(controller.current(), generation);
    assert.equal(Object.isFrozen(generation), true);
    assert.deepEqual(Object.keys(generation).sort(), ["dispose", "generationId", "inspectionReport"]);
    assert.equal(
      generation.inspectionReport.forms[0].sections[0].fields[0].question,
      "Full name"
    );
    assert.equal(JSON.stringify(generation).includes("reference"), false);
    assert.equal(JSON.stringify(generation).includes("candidate"), false);
  });
});

test("a known protected advisory change retries and accepts the later stable report", async () => {
  let extractionCalls = 0;
  let verificationCalls = 0;
  const extractedQuestions: Array<string | null> = [];
  const disposalCalls: number[] = [];
  await withHarness(STABLE_FORM_HTML, async ({ controller }) => {
    const generation = await controller.inspect();
    assert.equal(extractionCalls, 2);
    assert.equal(verificationCalls, 1);
    assert.deepEqual(extractedQuestions, ["Full name", "Preferred full name"]);
    assert.equal(disposalCalls[0], 1);
    assert.equal(
      generation.inspectionReport.forms[0].sections[0].fields[0].question,
      "Preferred full name"
    );
  }, {
    transformTarget(target, page) {
      const original = target.authority;
      return Object.freeze({
        authority: Object.freeze({
          waitUntilReady: () => original.waitUntilReady(),
          extractApplicationForm: async () => {
            const attempt = extractionCalls;
            extractionCalls += 1;
            disposalCalls[attempt] = 0;
            const extraction = await original.extractApplicationForm();
            extractedQuestions.push(
              extraction.report.forms[0].sections[0].fields[0].question
            );
            let disposePromise: Promise<void> | null = null;
            const wrappedExtraction = Object.freeze({
              candidate: extraction.candidate,
              report: extraction.report,
              fields: extraction.fields,
              dispose() {
                disposalCalls[attempt] += 1;
                disposePromise ??= extraction.dispose();
                return disposePromise;
              }
            });
            if (attempt === 0) {
              await page.evaluate(() => {
                const label = document.querySelector("label[for='full-name']");
                if (label) label.textContent = "Preferred full name";
              });
            }
            return wrappedExtraction;
          },
          verifyCandidate: (candidate: Parameters<typeof original.verifyCandidate>[0]) => {
            verificationCalls += 1;
            return original.verifyCandidate(candidate);
          },
          snapshot: () => original.snapshot(),
          waitForChange: (since: Parameters<typeof original.waitForChange>[0], timeoutMs: number) =>
            original.waitForChange(since, timeoutMs),
          subscribe: (listener: Parameters<typeof original.subscribe>[0]) =>
            original.subscribe(listener)
        }),
        currentTargetUrl: () => target.currentTargetUrl(),
        subscribeMainFrameNavigation: (listener: () => void) =>
          target.subscribeMainFrameNavigation(listener)
      });
    }
  });
});

test("continual relevant protected churn reaches the one absolute stabilization deadline", { timeout: 20_000 }, async () => {
  await withHarness(STABLE_FORM_HTML, async ({ page, controller }) => {
    const interval = await page.evaluate(() => window.setInterval(() => {
      const label = document.querySelector("label[for='full-name']");
      if (label) label.textContent = label.textContent === "Name A" ? "Name B" : "Name A";
    }, 40));
    try {
      const started = Date.now();
      await assert.rejects(
        controller.inspect(),
        hasControllerCode("FORM_STABILITY_TIMEOUT")
      );
      assert.ok(Date.now() - started >= 9_500);
      assert.equal(controller.current(), null);
    } finally {
      await page.evaluate((timer) => window.clearInterval(timer), interval);
    }
  });
});

test("continual unrelated churn does not block protected inspection progress", { timeout: 10_000 }, async () => {
  await withHarness(SEMANTIC_SURFACE_FORM_HTML, async ({ page, controller }) => {
    const interval = await page.evaluate(() => window.setInterval(() => {
      const clock = document.getElementById("unrelated-clock");
      if (clock) clock.textContent = String(Date.now());
      document.querySelector("[data-unrelated-toast]")?.remove();
      const toast = document.createElement("span");
      toast.setAttribute("data-unrelated-toast", "");
      toast.textContent = "Unrelated notification";
      document.body.append(toast);
    }, 25));
    try {
      const generation = await controller.inspect();
      assert.equal(controller.current(), generation);
    } finally {
      await page.evaluate((timer) => window.clearInterval(timer), interval);
    }
  });
});

test("an unchanged advisory fence never authorizes an INVALID protected candidate", async () => {
  let extractionCalls = 0;
  let verificationCalls = 0;
  await withHarness(STABLE_FORM_HTML, async ({ controller }) => {
    const generation = await controller.inspect();
    assert.equal(controller.current(), generation);
    assert.equal(extractionCalls, 2);
    assert.equal(verificationCalls, 2);
  }, {
    transformTarget(target) {
      const original = target.authority;
      const authority = Object.freeze({
        waitUntilReady: () => original.waitUntilReady(),
        extractApplicationForm: () => {
          extractionCalls += 1;
          return original.extractApplicationForm();
        },
        verifyCandidate: (candidate: Parameters<typeof original.verifyCandidate>[0]) => {
          verificationCalls += 1;
          if (verificationCalls === 1) return Promise.resolve({ status: "INVALID" as const });
          return original.verifyCandidate(candidate);
        },
        snapshot: () => original.snapshot(),
        waitForChange: (since: Parameters<typeof original.waitForChange>[0]) =>
          Promise.resolve(since),
        subscribe: (listener: Parameters<typeof original.subscribe>[0]) =>
          original.subscribe(listener)
      });
      return Object.freeze({
        authority,
        currentTargetUrl: () => target.currentTargetUrl(),
        subscribeMainFrameNavigation: (listener: () => void) =>
          target.subscribeMainFrameNavigation(listener)
      });
    }
  });
});

test("fresh protected verification catches direct CSSOM semantic drift", async () => {
  await withHarness(CSSOM_FORM_HTML, async ({ page, controller, invalidations }) => {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const sheet = document.styleSheets[0] as CSSStyleSheet;
      sheet.insertRule(".cssom-target { display: none !important; }", sheet.cssRules.length);
    });
    assert.equal(controller.current(), generation);

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  });
});

test("fresh protected verification catches a late open-shadow semantic change", async () => {
  await withHarness(OPEN_SHADOW_FORM_HTML, async ({ page, controller, invalidations }) => {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const root = document.getElementById("existing-shadow-host")?.shadowRoot;
      const button = document.createElement("button");
      button.textContent = "Late interaction";
      root?.append(button);
    });
    assert.equal(controller.current(), generation);

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  });
});

test("a same-looking replaced field cannot rebind an accepted protected candidate", async () => {
  await withHarness(STABLE_FORM_HTML, async ({ page, controller }) => {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const oldField = document.getElementById("full-name");
      oldField?.replaceWith(oldField.cloneNode(true));
    });
    assert.equal(controller.current(), generation);

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    const replacement = await controller.inspect();
    assert.notEqual(replacement.generationId, generation.generationId);
  });
});

test("applicant input that does not affect the report remains current after fresh verification", async () => {
  await withHarness(STABLE_FORM_HTML, async ({ page, controller }) => {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const field = document.getElementById("full-name") as HTMLInputElement;
      field.value = "Ada Lovelace";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });

    assert.equal(await controller.assertCurrent(generation.generationId), generation);
    assert.equal(controller.current(), generation);
  });
});

test("fragment and same-document History navigation synchronously revoke protected generations", async (context) => {
  for (const operation of ["pushState", "replaceState", "fragment"] as const) {
    await context.test(operation, async () => {
      await withHarness(STABLE_FORM_HTML, async ({ page, controller, invalidations }) => {
        await controller.inspect();
        await page.evaluate((kind) => {
          if (kind === "pushState") history.pushState({}, "", "#pushed");
          if (kind === "replaceState") history.replaceState({}, "", "#replaced");
          if (kind === "fragment") location.hash = "fragment";
        }, operation);
        await waitForNoCurrent(controller);
        assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
      });
    });
  }
});

test("reload revokes protected authority while unsafe path drift remains target-guarded", async (context) => {
  await context.test("reload", async () => {
    await withHarness(STABLE_FORM_HTML, async ({ page, controller, invalidations }) => {
      await controller.inspect();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForNoCurrent(controller);
      assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
    });
  });

  await context.test("unsafe path", async () => {
    await withHarness(STABLE_FORM_HTML, async ({ page, controller, unsafeCodes }) => {
      await controller.inspect();
      await page.evaluate(() => history.pushState({}, "", "/different-path"));
      await waitForNoCurrent(controller);
      assert.deepEqual(unsafeCodes, ["TARGET_NAVIGATION_BLOCKED"]);
    });
  });
});

test("page close revokes the generation and permanently cancels inspection", async () => {
  const harness = await createProtectedHarness(STABLE_FORM_HTML);
  try {
    await harness.controller.inspect();
    await harness.page.close();
    assert.equal(harness.controller.current(), null);
    assert.deepEqual(harness.invalidations, ["PAGE_CLOSED"]);
    await assert.rejects(
      harness.controller.inspect(),
      hasControllerCode("FORM_INSPECTION_CANCELLED")
    );
  } finally {
    await harness.close();
  }
});

test("protected session loss revokes generation authority terminally", async () => {
  const harness = await createProtectedHarness(STABLE_FORM_HTML);
  try {
    await harness.controller.inspect();
    await harness.session.close();
    assert.equal(harness.controller.current(), null);
    assert.deepEqual(harness.invalidations, ["PROTECTED_SESSION_LOST"]);
    await assert.rejects(
      harness.controller.inspect(),
      hasControllerCode("FORM_INSPECTION_CANCELLED")
    );
  } finally {
    await harness.close();
  }
});

async function installEmployerEffectTraps(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Main-world observers prove shared-DOM effects and action events only.
    // Isolated-world reads are covered by the protected-source policy test.
    const traps = {
      inputValue: 0,
      textAreaValue: 0,
      selectValue: 0,
      checked: 0,
      optionSelected: 0,
      files: 0,
      hiddenValue: 0,
      passwordValue: 0,
      mutations: 0,
      submissions: 0,
      events: { click: 0, keydown: 0, beforeinput: 0, input: 0, change: 0, submit: 0, formdata: 0 }
    };
    window.__formInspectionTraps = traps;
    for (const eventName of Object.keys(traps.events) as Array<keyof typeof traps.events>) {
      document.addEventListener(eventName, () => {
        traps.events[eventName] += 1;
        if (eventName === "submit") traps.submissions += 1;
      }, true);
    }
    new MutationObserver((records) => {
      traps.mutations += records.length;
    }).observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
  });
}

test("protected inspection exports no applicant values and causes zero observable employer-side effects", async () => {
  await withHarness(privacyFixture(), async ({ page, controller }) => {
    await installEmployerEffectTraps(page);
    const generation = await controller.inspect();
    assert.equal(await controller.assertCurrent(generation.generationId), generation);
    assert.equal(JSON.stringify(generation.inspectionReport).includes("SECRET-"), false);
    await generation.dispose();

    const traps = await readFormInspectionTraps(page);
    assert.equal(traps.mutations, 0);
    assert.equal(traps.submissions, 0);
    assert.deepEqual(traps.events, {
      click: 0,
      keydown: 0,
      beforeinput: 0,
      input: 0,
      change: 0,
      submit: 0,
      formdata: 0
    });
  });
});
