import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page, Request, Route } from "playwright";

import {
  ApplicationBrowserCoordinator,
  ApplicationBrowserError,
  createSafeBrowserDiagnostic,
  createPlaywrightTargetController
} from "@/lib/application-browser/coordinator";
import {
  launchApplicationBrowserRuntimeWithLauncherForTest,
  MISSING_CHROMIUM_MESSAGE
} from "@/lib/application-browser/browser-runtime";
import { GuardedFillOrchestrationError } from "@/lib/application-browser/fill-orchestration";
import {
  BROWSER_INSPECTION_RECOVERABLE_CODES,
  isB1CommandAllowed,
  parseApplyPilotOrigin,
  parseB1Command,
  parseImmutableRunId
} from "@/lib/application-browser/types";
import type { ProtectedSessionLifecycleCode } from "@/lib/application-browser/protected-browser-session";
import { SameOriginClientError } from "@/lib/application-browser/same-origin-client";
import * as companionModule from "@/scripts/application-browser-companion";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APP_ORIGIN = "https://apply.example.com";
const CONTROL_URL = `${APP_ORIGIN}/application-runs/${RUN_ID}/browser`;

const TARGET_OPEN_INPUT = {
  target: { host: "jobs.example.com", url: new URL("https://jobs.example.com/apply") },
  policy: { allowedHosts: ["jobs.example.com"], blockedHosts: [] }
} as never;

type TargetSetupBoundary =
  | "page creation"
  | "opener lookup"
  | "protected-session creation"
  | "navigation"
  | "protected readiness";

function targetSetupHarness(
  boundary: TargetSetupBoundary,
  onReadinessAboutToResolve?: () => void
) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const calls: string[] = [];
  const contextListeners = new Set<(page: Page) => void>();
  const pageListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let currentUrl = "about:blank";
  let pageClosed = false;
  let pageCloseCalls = 0;
  let sessionCloseCalls = 0;
  let sessionFactoryCalls = 0;

  const hold = async (candidate: TargetSetupBoundary): Promise<void> => {
    if (candidate !== boundary) return;
    entered.resolve();
    await release.promise;
  };
  const frame = { url: () => currentUrl };
  const page = {
    url: () => currentUrl,
    isClosed: () => pageClosed,
    mainFrame: () => frame,
    async opener() {
      calls.push("opener");
      await hold("opener lookup");
      return null;
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      const listeners = pageListeners.get(name) ?? new Set();
      listeners.add(listener);
      pageListeners.set(name, listeners);
      return page;
    },
    off(name: string, listener: (...args: unknown[]) => void) {
      pageListeners.get(name)?.delete(listener);
      return page;
    },
    async route() {
      calls.push("route");
    },
    async goto(target: string) {
      calls.push("goto");
      await hold("navigation");
      currentUrl = target;
    },
    async close() {
      pageCloseCalls += 1;
      pageClosed = true;
      calls.push("page-close");
    }
  } as unknown as Page;
  const session = {
    async waitUntilReady() {
      calls.push("ready");
      await hold("protected readiness");
      onReadinessAboutToResolve?.();
    },
    async extractApplicationForm() {
      calls.push("extract");
      throw new Error("not used");
    },
    async verifyCandidate() {
      calls.push("verify");
      return { status: "INVALID" as const };
    },
    async snapshot() {
      calls.push("snapshot");
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    async waitForChange() {
      calls.push("wait-for-change");
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    subscribe() {
      calls.push("subscribe");
      return () => undefined;
    },
    async close() {
      sessionCloseCalls += 1;
      calls.push("session-close");
    }
  };
  const context = {
    on(name: string, listener: (candidate: Page) => void) {
      if (name === "page") contextListeners.add(listener);
    },
    off(name: string, listener: (candidate: Page) => void) {
      if (name === "page") contextListeners.delete(listener);
    },
    async newPage() {
      calls.push("new-page");
      await hold("page creation");
      return page;
    }
  } as unknown as BrowserContext;

  return {
    calls,
    context,
    page,
    entered,
    release,
    emitPage(candidate: Page) {
      for (const listener of contextListeners) listener(candidate);
    },
    sessionFactoryCalls: () => sessionFactoryCalls,
    pageCloseCalls: () => pageCloseCalls,
    sessionCloseCalls: () => sessionCloseCalls,
    createProtectedSession: async (created: Page) => {
      sessionFactoryCalls += 1;
      assert.equal(created, page);
      calls.push("session-create");
      await hold("protected-session creation");
      return session;
    }
  };
}

function successfulTargetTeardownHarness() {
  const primaryClose = deferred<void>();
  const contextListeners = new Set<(page: Page) => void>();
  const lifecycleListeners = new Set<(
    code: ProtectedSessionLifecycleCode
  ) => void | Promise<void>>();
  let currentUrl = "about:blank";
  let pageClosed = false;
  let pageCloseCalls = 0;
  let sessionCloseCalls = 0;
  let listenerRetireCalls = 0;
  const frame = { url: () => currentUrl };
  const page = {
    url: () => currentUrl,
    isClosed: () => pageClosed,
    mainFrame: () => frame,
    async opener() {
      return null;
    },
    on() {
      return page;
    },
    off() {
      return page;
    },
    async route() {},
    async goto(target: string) {
      currentUrl = target;
    },
    async close() {
      pageCloseCalls += 1;
      pageClosed = true;
      await primaryClose.promise;
    }
  } as unknown as Page;
  const session = {
    async waitUntilReady() {},
    async extractApplicationForm() {
      throw new Error("not used");
    },
    async verifyCandidate() {
      return { status: "INVALID" as const };
    },
    async snapshot() {
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    async waitForChange() {
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    subscribe(listener: (code: ProtectedSessionLifecycleCode) => void | Promise<void>) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
    async close() {
      sessionCloseCalls += 1;
      for (const listener of lifecycleListeners) void listener("CLOSED");
    }
  };
  const context = {
    on(name: string, listener: (candidate: Page) => void) {
      if (name === "page") contextListeners.add(listener);
    },
    off(name: string, listener: (candidate: Page) => void) {
      if (name !== "page") return;
      if (contextListeners.delete(listener)) listenerRetireCalls += 1;
    },
    async newPage() {
      return page;
    }
  } as unknown as BrowserContext;

  return {
    context,
    page,
    primaryClose,
    listenerCount: () => contextListeners.size,
    listenerRetireCalls: () => listenerRetireCalls,
    pageCloseCalls: () => pageCloseCalls,
    sessionCloseCalls: () => sessionCloseCalls,
    emitPage(candidate: Page) {
      for (const listener of contextListeners) listener(candidate);
    },
    async createProtectedSession(created: Page) {
      assert.equal(created, page);
      return session;
    }
  };
}

function controlledClosePage() {
  const release = deferred<void>();
  let closeCalls = 0;
  const page = {
    async close() {
      closeCalls += 1;
      await release.promise;
    }
  } as unknown as Page;
  return { page, release, closeCalls: () => closeCalls };
}

function naturalReadinessFailureTeardownHarness() {
  const readinessEntered = deferred<void>();
  const readiness = deferred<void>();
  const primaryClose = deferred<void>();
  const contextListeners = new Set<(page: Page) => void>();
  let currentUrl = "about:blank";
  let pageClosed = false;
  let pageCloseCalls = 0;
  let sessionCloseCalls = 0;
  let sessionFactoryCalls = 0;
  let listenerRetireCalls = 0;
  const frame = { url: () => currentUrl };
  const page = {
    url: () => currentUrl,
    isClosed: () => pageClosed,
    mainFrame: () => frame,
    async opener() {
      return null;
    },
    on() {
      return page;
    },
    off() {
      return page;
    },
    async route() {},
    async goto(target: string) {
      currentUrl = target;
    },
    async close() {
      pageCloseCalls += 1;
      pageClosed = true;
      await primaryClose.promise;
    }
  } as unknown as Page;
  const session = {
    async waitUntilReady() {
      readinessEntered.resolve();
      await readiness.promise;
    },
    async extractApplicationForm() {
      throw new Error("not used");
    },
    async verifyCandidate() {
      return { status: "INVALID" as const };
    },
    async snapshot() {
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    async waitForChange() {
      return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
    },
    subscribe() {
      return () => undefined;
    },
    async close() {
      sessionCloseCalls += 1;
    }
  };
  const context = {
    on(name: string, listener: (candidate: Page) => void) {
      if (name === "page") contextListeners.add(listener);
    },
    off(name: string, listener: (candidate: Page) => void) {
      if (name !== "page") return;
      if (contextListeners.delete(listener)) listenerRetireCalls += 1;
    },
    async newPage() {
      return page;
    }
  } as unknown as BrowserContext;

  return {
    context,
    page,
    primaryClose,
    readiness,
    readinessEntered,
    listenerCount: () => contextListeners.size,
    listenerRetireCalls: () => listenerRetireCalls,
    pageCloseCalls: () => pageCloseCalls,
    sessionCloseCalls: () => sessionCloseCalls,
    sessionFactoryCalls: () => sessionFactoryCalls,
    emitPage(candidate: Page) {
      for (const listener of contextListeners) listener(candidate);
    },
    async createProtectedSession(created: Page) {
      sessionFactoryCalls += 1;
      assert.equal(created, page);
      return session;
    }
  };
}

test("natural readiness failure retains late-page ownership through a stable cleanup drain", async () => {
  const harness = naturalReadinessFailureTeardownHarness();
  const lateA = controlledClosePage();
  const lateB = controlledClosePage();
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  let openSettled = false;
  const openingOutcome = controller.open(TARGET_OPEN_INPUT, () => {}).then(
    () => {
      openSettled = true;
      return "fulfilled" as const;
    },
    () => {
      openSettled = true;
      return "rejected" as const;
    }
  );
  await harness.readinessEntered.promise;

  harness.readiness.reject(new Error("natural protected readiness failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual({
    formInspectionTarget: controller.formInspectionTarget(),
    page: controller.page(),
    listenerCount: harness.listenerCount(),
    pageCloseCalls: harness.pageCloseCalls(),
    sessionCloseCalls: harness.sessionCloseCalls()
  }, {
    formInspectionTarget: null,
    page: null,
    listenerCount: 1,
    pageCloseCalls: 1,
    sessionCloseCalls: 1
  });

  harness.emitPage(lateA.page);
  assert.equal(lateA.closeCalls(), 1);
  harness.primaryClose.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual({ openSettled, listenerCount: harness.listenerCount() }, {
    openSettled: false,
    listenerCount: 1
  });

  harness.emitPage(lateB.page);
  assert.equal(lateB.closeCalls(), 1);
  lateA.release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual({ openSettled, listenerCount: harness.listenerCount() }, {
    openSettled: false,
    listenerCount: 1
  });

  lateB.release.resolve();
  assert.equal(await openingOutcome, "rejected");
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.listenerRetireCalls(), 1);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
  assert.equal(harness.sessionFactoryCalls(), 1);
  assert.equal(lateA.closeCalls(), 1);
  assert.equal(lateB.closeCalls(), 1);
  assert.equal(controller.formInspectionTarget(), null);
  assert.equal(controller.page(), null);

  await controller.close();
  assert.equal(harness.listenerRetireCalls(), 1);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
  assert.equal(lateA.closeCalls(), 1);
  assert.equal(lateB.closeCalls(), 1);
});

test("synchronous lifecycle reentrancy shares the exact target close operation", async () => {
  const harness = successfulTargetTeardownHarness();
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  await controller.open(TARGET_OPEN_INPUT, () => {});
  const target = controller.formInspectionTarget();
  assert.ok(target);
  let reentrantClose: Promise<void> | undefined;
  target.authority.subscribe(() => {
    reentrantClose = controller.close();
  });

  const outerClose = controller.close();
  assert.ok(reentrantClose, "session close must synchronously reenter before outer close returns");
  assert.equal(reentrantClose, outerClose);
  assert.equal(controller.close(), outerClose);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
  assert.equal(harness.listenerCount(), 1);
  assert.equal(harness.listenerRetireCalls(), 0);

  harness.primaryClose.resolve();
  await Promise.all([outerClose, reentrantClose]);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.listenerRetireCalls(), 1);
  assert.equal(controller.close(), outerClose);
});

test("target opening exposes one frozen non-closing protected inspection/fill facade only for its owned lifetime", async () => {
  for (const mode of ["success", "setup-failure", "readiness-failure"] as const) {
    const calls: string[] = [];
    let protectedSessionFactoryCalls = 0;
    let url = "about:blank";
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const lifecycleListeners = new Set<(code: "CLOSED") => void>();
    const frame = { url: () => url };
    const page = {
      url: () => url, isClosed: () => false, mainFrame: () => frame, opener: async () => null,
      on(name: string, fn: (...args: unknown[]) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return page; },
      off(name: string, fn: (...args: unknown[]) => void) { listeners.get(name)?.delete(fn); return page; },
      async route() { calls.push("route"); },
      async goto(target: string) { calls.push("goto"); url = target; for (const fn of listeners.get("domcontentloaded") ?? []) fn(); },
      async close() { calls.push("page-close"); }
    };
    const context = { on() {}, off() {}, newPage: async () => page } as unknown as BrowserContext;
    const controller = createPlaywrightTargetController({
      context,
      onUnsafe() {},
      async testOnlyCreateProtectedSession(created) {
        protectedSessionFactoryCalls += 1;
        assert.equal(created, page);
        calls.push("setup");
        if (mode === "setup-failure") throw new Error("private setup failure");
        return {
          async waitUntilReady() {
            calls.push("ready");
            assert.equal(url, "https://jobs.example.com/apply");
            if (mode === "readiness-failure") throw new Error("private readiness failure");
          },
          async extractApplicationForm() { throw new Error("not used"); },
          async verifyCandidate() { return { status: "INVALID" as const }; },
          async snapshot() {
            return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
          },
          async waitForChange() {
            return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
          },
          subscribe(listener) {
            lifecycleListeners.add(listener as (code: "CLOSED") => void);
            return () => lifecycleListeners.delete(listener as (code: "CLOSED") => void);
          },
          async close() {
            calls.push("session-close");
            for (const listener of lifecycleListeners) listener("CLOSED");
          }
        };
      }
    });
    const targetController = controller as typeof controller & {
      formInspectionTarget(): {
        authority: Record<string, unknown>;
        currentTargetUrl(): string | null;
        subscribeMainFrameNavigation(listener: () => void): () => void;
      } | null;
    };
    assert.equal(
      typeof targetController.formInspectionTarget,
      "function",
      "target controller must expose the protected inspection facade accessor"
    );
    assert.equal(targetController.formInspectionTarget(), null);
    const open = controller.open({ target: { host: "jobs.example.com", url: new URL("https://jobs.example.com/apply") }, policy: { allowedHosts: ["jobs.example.com"], blockedHosts: [] } } as never, () => {});
    if (mode === "setup-failure") {
      await assert.rejects(open, (error: unknown) => error instanceof ApplicationBrowserError && !error.message.includes("private"));
      assert.deepEqual(calls, ["setup", "page-close"]);
      assert.equal(targetController.formInspectionTarget(), null);
    } else if (mode === "readiness-failure") {
      await assert.rejects(open, (error: unknown) => error instanceof ApplicationBrowserError && !error.message.includes("private"));
      assert.deepEqual(calls, ["setup", "route", "goto", "ready", "session-close", "page-close"]);
      assert.equal(targetController.formInspectionTarget(), null);
    } else {
      await open;
      assert.deepEqual(calls, ["setup", "route", "goto", "ready"]);
      const target = targetController.formInspectionTarget();
      assert.ok(target);
      assert.equal(Object.isFrozen(target), true);
      assert.equal(Object.isFrozen(target.authority), true);
      assert.deepEqual(Object.keys(target.authority).sort(), [
        "extractApplicationForm",
        "snapshot",
        "subscribe",
        "verifyCandidate",
        "waitForChange",
        "waitUntilReady",
        "writeCandidateField"
      ]);
      assert.equal("close" in target.authority, false);
      assert.equal(target.currentTargetUrl(), "https://jobs.example.com/apply");

      let navigationNotifications = 0;
      const unsubscribe = target.subscribeMainFrameNavigation(() => {
        navigationNotifications += 1;
      });
      for (const listener of listeners.get("framenavigated") ?? []) listener(frame);
      assert.equal(navigationNotifications, 1);
      unsubscribe();
      for (const listener of listeners.get("framenavigated") ?? []) listener(frame);
      assert.equal(navigationNotifications, 1);

      target.subscribeMainFrameNavigation(() => {
        navigationNotifications += 1;
      });
      await controller.close();
      await controller.close();
      assert.deepEqual(calls, ["setup", "route", "goto", "ready", "session-close", "page-close"]);
      assert.equal(targetController.formInspectionTarget(), null);
      assert.equal(target.currentTargetUrl(), null);
      for (const listener of listeners.get("framenavigated") ?? []) listener(frame);
      assert.equal(navigationNotifications, 1, "close must remove retained inspection navigation subscribers");
    }
    assert.equal(protectedSessionFactoryCalls, 1);
  }
});

test("post-success close keeps page cleanup ownership until employer teardown settles", async () => {
  const harness = successfulTargetTeardownHarness();
  const late = controlledClosePage();
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  await controller.open(TARGET_OPEN_INPUT, () => {});
  const retained = controller.formInspectionTarget();
  assert.ok(retained);
  assert.equal(harness.listenerCount(), 1);

  let closeSettled = false;
  const closing = controller.close();
  void closing.then(() => {
    closeSettled = true;
  });
  const repeatedClosuresShareOwnership =
    controller.close() === closing && controller.close() === closing;
  const synchronousRevocation = {
    formInspectionTarget: controller.formInspectionTarget(),
    page: controller.page(),
    retainedUrl: retained.currentTargetUrl(),
    listenerCount: harness.listenerCount()
  };

  harness.emitPage(late.page);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeCleanupRelease = {
    closeSettled,
    lateCloseCalls: late.closeCalls()
  };
  late.release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeSettledAfterLateCleanup = closeSettled;
  harness.primaryClose.resolve();
  await closing;

  assert.equal(repeatedClosuresShareOwnership, true);
  assert.deepEqual(synchronousRevocation, {
    formInspectionTarget: null,
    page: null,
    retainedUrl: null,
    listenerCount: 1
  });
  assert.deepEqual(beforeCleanupRelease, {
    closeSettled: false,
    lateCloseCalls: 1
  });
  assert.equal(closeSettledAfterLateCleanup, false);
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(late.closeCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);

  await controller.close();
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(late.closeCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
});

test("post-success close drains pages enrolled while an earlier cleanup drain is pending", async () => {
  const harness = successfulTargetTeardownHarness();
  const lateA = controlledClosePage();
  const lateB = controlledClosePage();
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  await controller.open(TARGET_OPEN_INPUT, () => {});

  let closeSettled = false;
  const closing = controller.close();
  void closing.then(() => {
    closeSettled = true;
  });
  harness.emitPage(lateA.page);
  assert.equal(lateA.closeCalls(), 1);

  harness.primaryClose.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(harness.listenerCount(), 1);

  harness.emitPage(lateB.page);
  assert.equal(lateB.closeCalls(), 1);
  lateA.release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const whileSecondCleanupPending = {
    closeSettled,
    listenerCount: harness.listenerCount()
  };

  lateB.release.resolve();
  await closing;

  assert.deepEqual(whileSecondCleanupPending, {
    closeSettled: false,
    listenerCount: 1
  });
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(lateA.closeCalls(), 1);
  assert.equal(lateB.closeCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
});

test("close owns setup through every late page and protected-session handoff", async (context) => {
  const boundaries: readonly TargetSetupBoundary[] = [
    "page creation",
    "opener lookup",
    "protected-session creation",
    "navigation",
    "protected readiness"
  ];

  for (const boundary of boundaries) {
    await context.test(boundary, async () => {
      const harness = targetSetupHarness(boundary);
      const controller = createPlaywrightTargetController({
        context: harness.context,
        onUnsafe() {},
        testOnlyCreateProtectedSession: harness.createProtectedSession
      });
      const opening = controller.open(TARGET_OPEN_INPUT, () => {});
      const openingOutcome = opening.then(
        () => "fulfilled" as const,
        () => "rejected" as const
      );
      await harness.entered.promise;

      let closeSettled = false;
      const closing = controller.close().then(() => {
        closeSettled = true;
      });
      assert.equal(controller.formInspectionTarget(), null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closeSettledBeforeHandoff = closeSettled;
      const pageClosesBeforeHandoff = harness.pageCloseCalls();
      const sessionClosesBeforeHandoff = harness.sessionCloseCalls();

      harness.release.resolve();
      const outcome = await openingOutcome;
      await closing;
      const expectedSessionFactoryCalls =
        boundary === "page creation" || boundary === "opener lookup" ? 0 : 1;
      const expectedSessionCloseCalls =
        boundary === "protected-session creation" ||
          boundary === "navigation" ||
          boundary === "protected readiness"
          ? 1
          : 0;
      const expectedPageClosesBeforeHandoff = boundary === "page creation" ? 0 : 1;
      const expectedSessionClosesBeforeHandoff =
        boundary === "navigation" || boundary === "protected readiness" ? 1 : 0;

      assert.equal(closeSettledBeforeHandoff, false);
      assert.equal(pageClosesBeforeHandoff, expectedPageClosesBeforeHandoff);
      assert.equal(sessionClosesBeforeHandoff, expectedSessionClosesBeforeHandoff);
      assert.equal(outcome, "rejected");
      assert.equal(controller.page(), null);
      assert.equal(controller.formInspectionTarget(), null);
      assert.equal(harness.sessionFactoryCalls(), expectedSessionFactoryCalls);
      assert.equal(harness.sessionCloseCalls(), expectedSessionCloseCalls);
      assert.equal(harness.pageCloseCalls(), 1);

      await controller.close();
      assert.equal(harness.sessionCloseCalls(), expectedSessionCloseCalls);
      assert.equal(harness.pageCloseCalls(), 1);
    });
  }
});

test("close during the final setup handoff prevents open from returning success", async () => {
  let closing: Promise<void> | undefined;
  let targetWasPublishedBeforeClose = false;
  const closeBegan = deferred<void>();
  const harness = targetSetupHarness("protected readiness", () => {
    queueMicrotask(() => {
      queueMicrotask(() => {
        targetWasPublishedBeforeClose = controller.formInspectionTarget() !== null;
        closing = controller.close();
        closeBegan.resolve(undefined);
      });
    });
  });
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const openingOutcome = controller.open(TARGET_OPEN_INPUT, () => {}).then(
    () => "fulfilled" as const,
    () => "rejected" as const
  );
  await harness.entered.promise;

  harness.release.resolve();
  await closeBegan.promise;
  const outcome = await openingOutcome;
  assert.ok(closing);
  await closing;

  assert.equal(targetWasPublishedBeforeClose, true);
  assert.equal(outcome, "rejected");
  assert.equal(controller.page(), null);
  assert.equal(controller.formInspectionTarget(), null);
  assert.equal(harness.sessionCloseCalls(), 1);
  assert.equal(harness.pageCloseCalls(), 1);
});

test("close waits for rejected setup boundaries and contains all materialized resources", async (context) => {
  const cases: ReadonlyArray<Readonly<{
    boundary: "page creation" | "protected-session creation" | "navigation";
    expectedPageCloses: number;
    expectedSessionCloses: number;
  }>> = [
    { boundary: "page creation", expectedPageCloses: 0, expectedSessionCloses: 0 },
    { boundary: "protected-session creation", expectedPageCloses: 1, expectedSessionCloses: 0 },
    { boundary: "navigation", expectedPageCloses: 1, expectedSessionCloses: 1 }
  ];

  for (const entry of cases) {
    await context.test(entry.boundary, async () => {
      const harness = targetSetupHarness(entry.boundary);
      const controller = createPlaywrightTargetController({
        context: harness.context,
        onUnsafe() {},
        testOnlyCreateProtectedSession: harness.createProtectedSession
      });
      const openingOutcome = controller.open(TARGET_OPEN_INPUT, () => {}).then(
        () => "fulfilled" as const,
        () => "rejected" as const
      );
      await harness.entered.promise;

      let closeSettled = false;
      const closing = controller.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closeSettledBeforeRejection = closeSettled;
      harness.release.reject(new Error(`late ${entry.boundary} rejection`));

      assert.equal(await openingOutcome, "rejected");
      await closing;
      assert.equal(closeSettledBeforeRejection, false);
      assert.equal(controller.page(), null);
      assert.equal(controller.formInspectionTarget(), null);
      assert.equal(harness.pageCloseCalls(), entry.expectedPageCloses);
      assert.equal(harness.sessionCloseCalls(), entry.expectedSessionCloses);

      await controller.close();
      assert.equal(harness.pageCloseCalls(), entry.expectedPageCloses);
      assert.equal(harness.sessionCloseCalls(), entry.expectedSessionCloses);
    });
  }
});

test("an unexpected context page during newPage setup is never mistaken for the employer page", async () => {
  const harness = targetSetupHarness("page creation");
  const unsafe: string[] = [];
  let unexpectedCloseCalls = 0;
  const unexpected = {
    async close() {
      unexpectedCloseCalls += 1;
    }
  } as unknown as Page;
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe(code) { unsafe.push(code); },
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const opening = controller.open(TARGET_OPEN_INPUT, () => {});
  await harness.entered.promise;

  harness.emitPage(unexpected);
  harness.release.resolve();
  await opening;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(unsafe, ["UNEXPECTED_POPUP"]);
  assert.equal(unexpectedCloseCalls, 1);
  assert.equal(controller.page(), harness.page);
  await controller.close();
  assert.equal(unexpectedCloseCalls, 1);
  assert.equal(harness.pageCloseCalls(), 1);
  assert.equal(harness.sessionCloseCalls(), 1);
});

test("failed page creation always restores unexpected-page handling", async () => {
  const harness = targetSetupHarness("page creation");
  const unsafe: string[] = [];
  let unexpectedCloseCalls = 0;
  const unexpected = {
    async close() {
      unexpectedCloseCalls += 1;
    }
  } as unknown as Page;
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe(code) { unsafe.push(code); },
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const opening = controller.open(TARGET_OPEN_INPUT, () => {});
  await harness.entered.promise;
  harness.release.reject(new Error("page creation failed"));
  await assert.rejects(opening);

  harness.emitPage(unexpected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const evidence = { unsafe, unexpectedCloseCalls };
  await controller.close();

  assert.deepEqual(evidence, {
    unsafe: ["UNEXPECTED_POPUP"],
    unexpectedCloseCalls: 1
  });
  assert.equal(unexpectedCloseCalls, 1);
});

test("a context page appearing after close during newPage setup is closed before handoff", async () => {
  const harness = targetSetupHarness("page creation");
  let latePageCloseCalls = 0;
  const latePage = {
    async close() {
      latePageCloseCalls += 1;
    }
  } as unknown as Page;
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const openingOutcome = controller.open(TARGET_OPEN_INPUT, () => {}).then(
    () => "fulfilled" as const,
    () => "rejected" as const
  );
  await harness.entered.promise;
  const closing = controller.close();

  harness.emitPage(latePage);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closesBeforeHandoff = latePageCloseCalls;
  harness.release.resolve();

  assert.equal(await openingOutcome, "rejected");
  await closing;
  assert.equal(closesBeforeHandoff, 1);
  assert.equal(latePageCloseCalls, 1);
  assert.equal(harness.pageCloseCalls(), 1);
});

test("retained inspection authority is synchronously revoked before close yields", async () => {
  const harness = targetSetupHarness("page creation");
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {},
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const opening = controller.open(TARGET_OPEN_INPUT, () => {});
  await harness.entered.promise;
  harness.release.resolve();
  await opening;
  const retained = controller.formInspectionTarget();
  assert.ok(retained);
  const protectedCallsBeforeClose = harness.calls.filter((call) =>
    ["ready", "extract", "verify", "snapshot", "wait-for-change", "subscribe"].includes(call)
  );

  const closing = controller.close();
  const asyncOutcomes = await Promise.all([
    retained.authority.waitUntilReady(),
    retained.authority.extractApplicationForm(),
    retained.authority.verifyCandidate(Object.freeze(Object.create(null)) as never),
    retained.authority.snapshot(),
    retained.authority.waitForChange({
      documentEpoch: 0,
      semanticRevision: 0,
      applicantStateEpoch: 0
    }, 1)
  ].map((operation) => operation.then(
    () => "fulfilled" as const,
    () => "rejected" as const
  )));
  let subscribeOutcome: "returned" | "threw" = "returned";
  try {
    retained.authority.subscribe(() => {});
  } catch {
    subscribeOutcome = "threw";
  }
  const protectedCallsAfterClose = harness.calls.filter((call) =>
    ["ready", "extract", "verify", "snapshot", "wait-for-change", "subscribe"].includes(call)
  );
  await closing;

  assert.equal(controller.formInspectionTarget(), null);
  assert.deepEqual(asyncOutcomes, ["rejected", "rejected", "rejected", "rejected", "rejected"]);
  assert.equal(subscribeOutcome, "threw");
  assert.deepEqual(protectedCallsAfterClose, protectedCallsBeforeClose);
});

test("a buffered context page is reported when newPage later rejects", async () => {
  const harness = targetSetupHarness("page creation");
  const unsafe: string[] = [];
  let unexpectedCloseCalls = 0;
  const unexpected = {
    async close() {
      unexpectedCloseCalls += 1;
    }
  } as unknown as Page;
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe(code) { unsafe.push(code); },
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const opening = controller.open(TARGET_OPEN_INPUT, () => {});
  await harness.entered.promise;

  harness.emitPage(unexpected);
  harness.release.reject(new Error("page creation failed"));
  await assert.rejects(opening);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const evidence = { unsafe, unexpectedCloseCalls };
  await controller.close();

  assert.deepEqual(evidence, {
    unsafe: ["UNEXPECTED_POPUP"],
    unexpectedCloseCalls: 1
  });
  assert.equal(unexpectedCloseCalls, 1);
});

test("an unsafe callback failure cannot strand buffered-page setup cleanup", async () => {
  const harness = targetSetupHarness("page creation");
  const unexpected = { async close() {} } as unknown as Page;
  const controller = createPlaywrightTargetController({
    context: harness.context,
    onUnsafe() {
      throw new Error("SECRET_UNSAFE_CALLBACK_FAILURE");
    },
    testOnlyCreateProtectedSession: harness.createProtectedSession
  });
  const openingOutcome = controller.open(TARGET_OPEN_INPUT, () => {}).then(
    () => ({ kind: "fulfilled" as const, message: "" }),
    (error: unknown) => ({
      kind: "rejected" as const,
      message: error instanceof Error ? error.message : ""
    })
  );
  await harness.entered.promise;

  harness.emitPage(unexpected);
  harness.release.reject(new Error("PRIMARY_PAGE_CREATION_FAILURE"));
  const outcome = await openingOutcome;
  let closeSettled = false;
  void controller.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(outcome, {
    kind: "rejected",
    message: "PRIMARY_PAGE_CREATION_FAILURE"
  });
  assert.equal(closeSettled, true);
});

test("protected readiness cannot retain initial redirect authority for a noncanonical navigation", async () => {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let url = "about:blank";
  let routeHandler: ((route: Route, request: Request) => Promise<void>) | null = null;
  const frame = { url: () => url };
  const requestFor = (target: string) => ({
    isNavigationRequest: () => true,
    resourceType: () => "document",
    frame: () => frame,
    url: () => target
  }) as unknown as Request;
  const routeFor = (label: string, onContinue: () => void) => ({
    async continue() { calls.push(`${label}-continue`); onContinue(); },
    async abort() { calls.push(`${label}-abort`); }
  }) as unknown as Route;
  const page = {
    url: () => url,
    mainFrame: () => frame,
    opener: async () => null,
    on(name: string, fn: (...args: unknown[]) => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(fn);
      listeners.set(name, set);
      return page;
    },
    off(name: string, fn: (...args: unknown[]) => void) {
      listeners.get(name)?.delete(fn);
      return page;
    },
    async route(_pattern: string, handler: (route: Route, request: Request) => Promise<void>) {
      routeHandler = handler;
    },
    async goto(target: string) {
      calls.push("goto");
      assert.ok(routeHandler);
      await routeHandler(routeFor("initial", () => { url = target; }), requestFor(target));
    },
    async close() { calls.push("page-close"); }
  };
  const context = { on() {}, off() {}, newPage: async () => page } as unknown as BrowserContext;
  const controller = createPlaywrightTargetController({
    context,
    onUnsafe(code) { calls.push(`unsafe:${code}`); },
    async testOnlyCreateProtectedSession() {
      calls.push("setup");
      return {
        async waitUntilReady() {
          calls.push("ready");
          assert.ok(routeHandler);
          const drifted = "https://jobs.example.com/noncanonical";
          await routeHandler(routeFor("drift", () => {
            url = drifted;
            for (const listener of listeners.get("framenavigated") ?? []) listener(frame);
          }), requestFor(drifted));
        },
        async extractApplicationForm() { throw new Error("not used"); },
        async verifyCandidate() { return { status: "INVALID" as const }; },
        async snapshot() {
          return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
        },
        async waitForChange() {
          return { documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 };
        },
        subscribe() { return () => undefined; },
        async close() { calls.push("session-close"); }
      };
    }
  });

  try {
    await assert.rejects(
      controller.open({
        target: { host: "jobs.example.com", url: new URL("https://jobs.example.com/apply") },
        policy: { allowedHosts: ["jobs.example.com"], blockedHosts: [] }
      } as never, () => {}),
      (error: unknown) => error instanceof ApplicationBrowserError &&
        error.code === "TARGET_NAVIGATION_BLOCKED"
    );
  } finally {
    await controller.close();
  }
  assert.deepEqual(calls, [
    "setup",
    "goto",
    "initial-continue",
    "ready",
    "unsafe:TARGET_NAVIGATION_BLOCKED",
    "drift-abort",
    "session-close",
    "page-close"
  ]);
});
const UNEXPECTED_B23A_CLIENT_METHODS = {
  async getCurrentAnswerPacket() {
    throw new Error("unexpected answer-packet read");
  },
  async publishFormInspection() {
    throw new Error("unexpected form-inspection publication");
  }
} as const;
const NO_FORM_INSPECTION = {
  initializeFormInspectionController() {},
  getFormInspectionPort: () => ({
    async inspect() { throw new Error("unexpected form inspection"); },
    async assertCurrent() { throw new Error("unexpected currentness assertion"); },
    currentTargetUrl: () => null
  })
} as const;

const { parseCompanionArguments } = companionModule;

type CompanionRunner = (
  args: string[],
  dependencies: Record<string, unknown>
) => Promise<void>;

function getCompanionRunner(): CompanionRunner {
  const candidate = (companionModule as unknown as Record<string, unknown>).runApplicationBrowserCompanion;
  assert.equal(typeof candidate, "function", "the companion orchestration entry point must be injectable");
  return candidate as CompanionRunner;
}

function idempotentCloseCounter() {
  let closed = false;
  let count = 0;
  return {
    async close() {
      if (closed) return;
      closed = true;
      count += 1;
    },
    count: () => count
  };
}

test("companion arguments require exactly one valid immutable run identity", () => {
  assert.throws(() => parseCompanionArguments(["--app-origin", APP_ORIGIN]), /run-id/i);
  assert.throws(
    () => parseCompanionArguments(["--app-origin", APP_ORIGIN, "--run-id", "not-a-cuid"]),
    /run ID/i
  );
  assert.throws(
    () =>
      parseCompanionArguments([
        "--app-origin",
        APP_ORIGIN,
        "--run-id",
        RUN_ID,
        "--run-id",
        "clz8w7m9a0003qwer1234tyui"
      ]),
    /exactly once/i
  );

  const parsed = parseCompanionArguments([
    "--app-origin",
    `${APP_ORIGIN}/`,
    "--run-id",
    RUN_ID
  ]);
  assert.deepEqual(parsed, { configuredApplyPilotOrigin: APP_ORIGIN, immutableRunId: RUN_ID });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(parseImmutableRunId(RUN_ID), RUN_ID);
});

test("Apply Pilot origin parsing permits HTTPS and explicit loopback HTTP only", () => {
  assert.equal(parseApplyPilotOrigin("https://apply.example.com/"), APP_ORIGIN);
  assert.equal(parseApplyPilotOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(parseApplyPilotOrigin("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  assert.equal(parseApplyPilotOrigin("http://[::1]:4100"), "http://[::1]:4100");

  for (const invalid of [
    "http://apply.example.com",
    "https://user:pass@apply.example.com",
    "https://apply.example.com/other",
    "https://apply.example.com?run=other",
    "https://apply.example.com#fragment"
  ]) {
    assert.throws(() => parseApplyPilotOrigin(invalid), /Apply Pilot origin/i, invalid);
  }
});

test("the B1 command parser accepts only the closed no-payload union", () => {
  assert.deepEqual(parseB1Command({ type: "GET_STATUS" }), { type: "GET_STATUS" });
  assert.deepEqual(parseB1Command({ type: "OPEN_TARGET" }), { type: "OPEN_TARGET" });
  assert.deepEqual(parseB1Command({ type: "CLOSE_WORKFLOW" }), { type: "CLOSE_WORKFLOW" });
  assert.deepEqual(parseB1Command({ type: "INSPECT_FORM" }), { type: "INSPECT_FORM" });
  assert.deepEqual(parseB1Command({ type: "FILL_APPROVED_FIELDS" }), {
    type: "FILL_APPROVED_FIELDS"
  });

  for (const invalid of [
    { type: "CLICK" },
    { type: "SUBMIT" },
    { type: "FILL" },
    { type: "FILL_FORM" },
    { type: "UPLOAD" },
    { type: "REQUEST" },
    { type: "KEYBOARD" },
    { type: "EVALUATE" },
    { type: "OPEN_TARGET", url: "https://attacker.example" },
    { type: "OPEN_TARGET", runId: "clz8w7m9a0003qwer1234tyui" },
    { type: "GET_STATUS", extra: true },
    { type: "INSPECT_FORM", runId: RUN_ID },
    { type: "INSPECT_FORM", url: "https://jobs.example.test/apply" },
    { type: "INSPECT_FORM", observedUrl: "https://jobs.example.test/apply" },
    { type: "INSPECT_FORM", expectedStateVersion: 1 },
    { type: "INSPECT_FORM", inspectionReport: {} },
    { type: "INSPECT_FORM", fields: [] },
    { type: "FILL_APPROVED_FIELDS", runId: RUN_ID },
    { type: "FILL_APPROVED_FIELDS", proposal: {} },
    { type: "FILL_APPROVED_FIELDS", answerIds: [] },
    { type: "FILL_APPROVED_FIELDS", packetHash: "a".repeat(64) },
    { type: "FILL_APPROVED_FIELDS", formInspectionVersion: 1 },
    { type: "FILL_APPROVED_FIELDS", selectors: [] },
    { type: 1 },
    null
  ]) {
    assert.throws(() => parseB1Command(invalid), /B1 command/i);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type AcquisitionHarnessBehavior =
  | "UNCERTAIN"
  | "DEFINITIVE_REJECTION"
  | "STALE_REJECTION"
  | "FILL_POLICY_DENIED"
  | "FILL_REVIEW_REQUIRED"
  | "FILL_ALREADY_IN_PROGRESS"
  | "FILL_NO_ELIGIBLE_FIELDS"
  | "FILL_STALE";

function acquisitionUncertaintyHarness(
  acquireBehavior: AcquisitionHarnessBehavior = "UNCERTAIN"
) {
  const targetUrl = "https://jobs.example.test/apply";
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  let generationCounter = 0;
  let currentGeneration = Symbol("unset");
  let acquisitionDispatches = 0;
  let statusReads = 0;
  let writes = 0;
  let closeCalls = 0;
  let beforeStatusReturn: (() => Promise<void>) | null = null;
  let status: Record<string, unknown> = {
    state: "READY",
    stateVersion: 7,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: []
  };
  const port = {
    async inspect() {
      generationCounter += 1;
      currentGeneration = Symbol(`generation-${generationCounter}`);
      return { generationId: currentGeneration, inspectionReport: report };
    },
    async assertCurrent(generationId: symbol) {
      assert.equal(generationId, currentGeneration);
      return { generationId, inspectionReport: report };
    },
    assertAcquiredFillAuthority() {
      throw new Error("uncertain acquisition must not yield browser authority");
    },
    async writeApprovedField(): Promise<never> {
      writes += 1;
      throw new Error("uncertain acquisition must not write");
    },
    currentTargetUrl: () => targetUrl
  };
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        return {
          id: RUN_ID,
          state: "READY" as const,
          stateVersion: 7,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: targetUrl
        };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() {
        return { runId: RUN_ID, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
      },
      async publishFormInspection(_input: unknown, assertReadyToDispatch: () => void) {
        assertReadyToDispatch();
        return {
          replayed: false,
          run: { id: RUN_ID, state: "REVIEW_REQUIRED" as const, stateVersion: 8 },
          current: { inspectionVersion: 1, answerPacketVersion: 1 }
        };
      },
      async acquireFillAttempt(_input: unknown, assertReadyToDispatch: () => void): Promise<never> {
        assertReadyToDispatch();
        acquisitionDispatches += 1;
        if (acquireBehavior !== "UNCERTAIN") {
          const code = acquireBehavior === "DEFINITIVE_REJECTION"
            ? "FILL_POLICY_DENIED"
            : acquireBehavior === "STALE_REJECTION"
              ? "FILL_STALE"
              : acquireBehavior;
          throw new SameOriginClientError(
            "bounded rejection",
            code,
            "MAY_HAVE_DISPATCHED",
            true
          );
        }
        throw new SameOriginClientError(
          "bounded uncertainty",
          "SAME_ORIGIN_REQUEST_FAILED",
          "MAY_HAVE_DISPATCHED"
        );
      },
      async getFillAttemptStatus() {
        statusReads += 1;
        await beforeStatusReturn?.();
        return structuredClone(status);
      },
      async finalizeFillAttempt(): Promise<never> {
        throw new Error("unexpected finalization");
      },
      async recoverExpiredFillAttempt(): Promise<never> {
        throw new Error("unexpected recovery");
      }
    },
    async openTarget() {
      return { finalUrl: targetUrl };
    },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => port,
    async closeResources() {
      closeCalls += 1;
    }
  } as never);

  return {
    coordinator,
    inspect: () => coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    setStatus(next: Record<string, unknown>) {
      status = next;
    },
    setBeforeStatusReturn(next: (() => Promise<void>) | null) {
      beforeStatusReturn = next;
    },
    liveAttemptStatus: {
      state: "FILLING",
      stateVersion: 8,
      fillAttemptId: attemptId,
      fillLeaseExpiresAt: "2099-09-10T20:10:00.000Z",
      leaseLive: true,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: true,
      outcome: null,
      errorCode: null,
      steps: []
    },
    counts: () => ({ acquisitionDispatches, statusReads, writes, closeCalls, generationCounter })
  };
}

test("acquisition uncertainty survives repeated reinspection and blocks every later POST", async () => {
  const value = acquisitionUncertaintyHarness();
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await value.inspect();

  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
  );
  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
  );
  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
  );

  assert.deepEqual(value.counts(), {
    acquisitionDispatches: 1,
    statusReads: 3,
    writes: 0,
    closeCalls: 0,
    generationCounter: 3
  });

  await value.coordinator.handleCommand({ type: "CLOSE_WORKFLOW" }, () => undefined);
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof ApplicationBrowserError && error.code === "FILL_INTERNAL"
  );
  assert.equal(value.counts().acquisitionDispatches, 1);
  assert.equal(value.counts().statusReads, 3);
  assert.equal(value.counts().closeCalls, 1);
});

test("a delayed uncertain acquisition is observed through GET without another POST or write", async () => {
  const value = acquisitionUncertaintyHarness();
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL"
  );

  await value.inspect();
  value.setStatus(value.liveAttemptStatus);
  const observed = await value.coordinator.fillApprovedFields(() => undefined);

  assert.equal(observed.disposition, "RECOVERY_PENDING");
  assert.deepEqual(value.counts(), {
    acquisitionDispatches: 1,
    statusReads: 2,
    writes: 0,
    closeCalls: 0,
    generationCounter: 2
  });
});

test("a definitive acquisition rejection does not create the uncertainty latch", async () => {
  const value = acquisitionUncertaintyHarness("DEFINITIVE_REJECTION");
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError &&
      error.code === "FILL_POLICY_DENIED"
  );

  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError &&
      error.code === "FILL_POLICY_DENIED"
  );

  assert.deepEqual(value.counts(), {
    acquisitionDispatches: 2,
    statusReads: 0,
    writes: 0,
    closeCalls: 0,
    generationCounter: 2
  });
});

test("a response-backed stale acquisition rejection does not create the uncertainty latch", async () => {
  const value = acquisitionUncertaintyHarness("STALE_REJECTION");
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError &&
      error.code === "FILL_STALE"
  );

  await value.inspect();
  await assert.rejects(
    value.coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof GuardedFillOrchestrationError &&
      error.code === "FILL_STALE"
  );

  assert.deepEqual(value.counts(), {
    acquisitionDispatches: 2,
    statusReads: 0,
    writes: 0,
    closeCalls: 0,
    generationCounter: 2
  });
});

test("Fill command maps only closed acquisition rejections and retains them for the consumed generation", async () => {
  for (const code of [
    "FILL_POLICY_DENIED",
    "FILL_REVIEW_REQUIRED",
    "FILL_ALREADY_IN_PROGRESS",
    "FILL_NO_ELIGIBLE_FIELDS",
    "FILL_STALE"
  ] as const) {
    const value = acquisitionUncertaintyHarness(code);
    value.coordinator.markControlReady();
    await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    await value.inspect();

    const rejected = await value.coordinator.handleCommand(
      { type: "FILL_APPROVED_FIELDS" },
      () => undefined
    );
    assert.deepEqual(rejected.fillCommand, { outcome: "REJECTED", errorCode: code }, code);

    const repeated = await value.coordinator.handleCommand(
      { type: "FILL_APPROVED_FIELDS" },
      () => undefined
    );
    assert.deepEqual(repeated.fillCommand, rejected.fillCommand, code);
    assert.equal(value.counts().acquisitionDispatches, 1, code);

    const inspected = await value.inspect();
    assert.equal(inspected.inspection?.outcome, "SUCCEEDED", code);
    assert.equal(inspected.fillCommand, undefined, code);
  }
});

test("Fill command maps uncertainty reconciliation to closed command dispositions", async () => {
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const stepKey = `fill:${attemptId}:${"a".repeat(64)}`;
  const cases = [
    {
      expected: "RECOVERY_PENDING",
      status: {
        state: "FILLING",
        stateVersion: 8,
        fillAttemptId: attemptId,
        fillLeaseExpiresAt: "2099-09-10T20:10:00.000Z",
        leaseLive: true,
        expiredRecoveryRequired: false,
        fieldOperationAllowed: true,
        outcome: null,
        errorCode: null,
        steps: []
      }
    },
    {
      expected: "CANCELLED",
      status: {
        state: "CANCELLED",
        stateVersion: 8,
        fillAttemptId: attemptId,
        fillLeaseExpiresAt: null,
        leaseLive: false,
        expiredRecoveryRequired: false,
        fieldOperationAllowed: false,
        outcome: null,
        errorCode: null,
        steps: []
      }
    },
    {
      expected: "FINALIZED",
      status: {
        state: "READY_FOR_USER_SUBMISSION",
        stateVersion: 9,
        fillAttemptId: attemptId,
        fillLeaseExpiresAt: null,
        leaseLive: false,
        expiredRecoveryRequired: false,
        fieldOperationAllowed: false,
        outcome: "COMPLETED",
        errorCode: null,
        steps: [{ stepKey, result: "FILLED", errorCode: null }]
      }
    }
  ] as const;

  for (const fixture of cases) {
    const value = acquisitionUncertaintyHarness();
    value.coordinator.markControlReady();
    await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    await value.inspect();
    value.setStatus(fixture.status);
    const result = await value.coordinator.handleCommand(
      { type: "FILL_APPROVED_FIELDS" },
      () => undefined
    );
    assert.deepEqual(result.fillCommand, { outcome: fixture.expected });
    assert.equal(value.counts().acquisitionDispatches, 1);
  }
});

test("Fill command rechecks control-page trust before accepting a late closed result", async () => {
  const value = acquisitionUncertaintyHarness();
  const statusReadEntered = deferred<void>();
  const releaseStatus = deferred<void>();
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  value.setStatus({
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 9,
    fillAttemptId: attemptId,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{
      stepKey: `fill:${attemptId}:${"a".repeat(64)}`,
      result: "FILLED",
      errorCode: null
    }]
  });
  value.setBeforeStatusReturn(async () => {
    statusReadEntered.resolve();
    await releaseStatus.promise;
  });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await value.inspect();

  let trusted = true;
  const filling = value.coordinator.handleCommand(
    { type: "FILL_APPROVED_FIELDS" },
    () => {
      if (!trusted) throw new Error("late control-page trust lost");
    }
  );
  await statusReadEntered.promise;
  trusted = false;
  releaseStatus.resolve();

  await assert.rejects(filling, /late control-page trust lost/);
  assert.deepEqual(value.coordinator.status().fillCommand, { outcome: "IN_PROGRESS" });
  assert.equal(value.counts().acquisitionDispatches, 1);
});

test("Fill command does not retain benign status without published protected authority", async () => {
  const value = acquisitionUncertaintyHarness();
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);

  await assert.rejects(
    value.coordinator.handleCommand({ type: "FILL_APPROVED_FIELDS" }, () => undefined),
    (error: unknown) => error instanceof ApplicationBrowserError && error.code === "FILL_INTERNAL"
  );
  assert.equal(value.coordinator.status().fillCommand, undefined);
  assert.equal(value.counts().acquisitionDispatches, 0);
});

test("INSPECT_FORM is single-flight, privately sequenced, and publishes fresh authority", async () => {
  const calls: string[] = [];
  const generationId = Symbol("private-generation");
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  const inspectionGate = deferred<{ generationId: symbol; inspectionReport: never }>();
  let inspectionPort: {
    inspect(): Promise<{ generationId: symbol; inspectionReport: never }>;
    assertCurrent(id: symbol): Promise<{ generationId: symbol; inspectionReport: never }>;
    currentTargetUrl(): string | null;
  } | null = null;
  let runRead = 0;
  let published: Record<string, unknown> | undefined;
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        runRead += 1;
        calls.push(`run:${runRead}`);
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: runRead === 1 ? 7 : 8,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply?posting=123#fresh"
        };
      },
      async getAutomationPolicy() {
        calls.push("policy");
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() {
        calls.push("packet");
        return { runId: RUN_ID, current: { inspectionVersion: 4, answerPacketVersion: 6 } };
      },
      async publishFormInspection(input: Record<string, unknown>, assertReadyToDispatch: () => void) {
        calls.push("publish-callback");
        assertReadyToDispatch();
        published = input as unknown as Record<string, unknown>;
        calls.push("publish");
        return {
          replayed: false,
          run: { id: RUN_ID, state: "READY", stateVersion: 9 },
          current: { inspectionVersion: 5, answerPacketVersion: 7 }
        };
      }
    },
    async openTarget() {
      calls.push("open");
      return { finalUrl: "https://jobs.example.test/apply?posting=123#opened" };
    },
    initializeFormInspectionController({ authoritativeApplyHost }: { authoritativeApplyHost: string }) {
      calls.push(`initialize:${authoritativeApplyHost}`);
      inspectionPort = {
        async inspect() {
          calls.push("inspect");
          return inspectionGate.promise;
        },
        async assertCurrent(id) {
          calls.push("assert-current");
          assert.equal(id, generationId);
          return { generationId, inspectionReport: report };
        },
        currentTargetUrl() {
          return "https://jobs.example.test/apply?posting=123#current";
        }
      };
    },
    getFormInspectionPort: () => inspectionPort,
    async closeResources() {}
  } as never);

  coordinator.markControlReady();
  await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  calls.length = 0;
  runRead = 0;
  const primary = coordinator.handleCommand({ type: "INSPECT_FORM" } as never, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(coordinator.status().inspection, { outcome: "IN_PROGRESS" });
  const secondary = await coordinator.handleCommand({ type: "INSPECT_FORM" } as never, () => undefined);
  assert.deepEqual(secondary.inspection, {
    outcome: "FAILED",
    errorCode: "FORM_INSPECTION_IN_PROGRESS",
    retryAllowed: true
  });
  assert.deepEqual(coordinator.status().inspection, { outcome: "IN_PROGRESS" });

  inspectionGate.resolve({ generationId, inspectionReport: report });
  const result = await primary;
  assert.deepEqual(calls, [
    "run:1",
    "policy",
    "inspect",
    "run:2",
    "packet",
    "policy",
    "assert-current",
    "publish-callback",
    "publish"
  ]);
  assert.deepEqual(published, {
    runId: RUN_ID,
    freshRunState: "READY",
    expectedStateVersion: 8,
    expectedFormInspectionVersion: 4,
    expectedAnswerPacketVersion: 6,
    observedUrl: "https://jobs.example.test/apply?posting=123#current",
    inspectionReport: report
  });
  assert.deepEqual(result.inspection, {
    outcome: "SUCCEEDED",
    replayed: false,
    inspectionVersion: 5,
    answerPacketVersion: 7,
    reinspectionRequired: false
  });
  assert.equal("inspectionReport" in result, false);
  assert.equal(JSON.stringify(result).includes("posting=123"), false);
});

test("explicit Fill command uses one published generation exactly once and retains its closed status", async () => {
  const generationId = Symbol("published-generation");
  const fieldKey = "1".repeat(64);
  const fieldFingerprint = "2".repeat(64);
  const formFingerprint = "3".repeat(64);
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const stepKey = `fill:${attemptId}:${fieldKey}`;
  const writeEntered = deferred<void>();
  const releaseWrite = deferred<void>();
  const calls: string[] = [];
  const finalized: unknown[] = [];
  let runReads = 0;
  let packetReads = 0;
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  const port = {
    async inspect() {
      calls.push("inspect");
      return { generationId, inspectionReport: report };
    },
    async assertCurrent(id: symbol) {
      calls.push("current");
      assert.equal(id, generationId);
      return { generationId, inspectionReport: report };
    },
    assertAcquiredFillAuthority(id: symbol, authority: unknown) {
      calls.push("bind");
      assert.equal(id, generationId);
      assert.deepEqual(authority, {
        formFingerprint,
        fields: [{
          normalizedFieldKey: fieldKey,
          fieldFingerprint,
          fieldType: "TEXT",
          proposal: { kind: "SCALAR", value: "private-proposal-sentinel" }
        }]
      });
    },
    async writeApprovedField(id: symbol, request: unknown) {
      calls.push("write");
      assert.equal(id, generationId);
      assert.deepEqual(request, {
        normalizedFieldKey: fieldKey,
        fieldFingerprint,
        fieldType: "TEXT",
        proposal: { kind: "SCALAR", value: "private-proposal-sentinel" }
      });
      writeEntered.resolve();
      await releaseWrite.promise;
      return { status: "FILLED" as const };
    },
    currentTargetUrl: () => "https://jobs.example.test/apply#current"
  };
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        runReads += 1;
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: runReads >= 4 ? 9 : 7,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply"
        };
      },
      async getAutomationPolicy() {
        return {
          effectiveEnabled: true,
          allowedHosts: ["jobs.example.test"],
          blockedHosts: []
        };
      },
      async getCurrentAnswerPacket() {
        packetReads += 1;
        return {
          runId: RUN_ID,
          current: packetReads === 1
            ? { inspectionVersion: 1, answerPacketVersion: 2 }
            : { inspectionVersion: 2, answerPacketVersion: 3 }
        };
      },
      async publishFormInspection(_input: unknown, assertReadyToDispatch: () => void) {
        assertReadyToDispatch();
        return {
          replayed: false,
          run: { id: RUN_ID, state: "REVIEW_REQUIRED", stateVersion: 8 },
          current: { inspectionVersion: 2, answerPacketVersion: 3 }
        };
      },
      async acquireFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
        calls.push("acquire");
        assertReadyToDispatch();
        return {
          attemptId,
          runStateVersion: 10,
          leaseExpiresAt: "2099-09-10T20:10:00.000Z",
          formInspectionVersion: 2,
          answerPacketVersion: 3,
          packetHash: "4".repeat(64),
          formFingerprint,
          eligibleFields: [{
            stepKey,
            normalizedFieldKey: fieldKey,
            fieldFingerprint,
            fieldType: "TEXT",
            proposal: { kind: "SCALAR", value: "private-proposal-sentinel" }
          }]
        };
      },
      async getFillAttemptStatus() {
        return {
          state: "FILLING",
          stateVersion: 10,
          fillAttemptId: attemptId,
          fillLeaseExpiresAt: "2099-09-10T20:10:00.000Z",
          leaseLive: true,
          expiredRecoveryRequired: false,
          fieldOperationAllowed: true,
          outcome: null,
          errorCode: null,
          steps: []
        };
      },
      async finalizeFillAttempt(input: unknown, assertReadyToDispatch: () => void) {
        calls.push("finalize");
        finalized.push(structuredClone(input));
        assertReadyToDispatch();
        return {
          state: "READY_FOR_USER_SUBMISSION",
          stateVersion: 11,
          fillAttemptId: attemptId,
          fillLeaseExpiresAt: null,
          leaseLive: false,
          expiredRecoveryRequired: false,
          fieldOperationAllowed: false,
          outcome: "COMPLETED",
          errorCode: null,
          steps: [{ stepKey, result: "FILLED", errorCode: null }]
        };
      },
      async recoverExpiredFillAttempt() {

        throw new Error("unexpected recovery");
      }
    },
    async openTarget() {
      return { finalUrl: "https://jobs.example.test/apply#opened" };
    },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => port,
    async closeResources() {}
  } as never);

  coordinator.markControlReady();
  await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
  assert.equal(calls.includes("acquire"), false, "inspection must not activate Fill");

  const filling = coordinator.handleCommand({ type: "FILL_APPROVED_FIELDS" }, () => undefined);
  await writeEntered.promise;
  const duplicate = await coordinator.handleCommand(
    { type: "FILL_APPROVED_FIELDS" },
    () => undefined
  );
  assert.deepEqual(duplicate.fillCommand, { outcome: "IN_PROGRESS" });
  const inspectionWhileFilling = await coordinator.handleCommand(
    { type: "INSPECT_FORM" },
    () => undefined
  );
  assert.equal(inspectionWhileFilling.inspection?.outcome, "FAILED");
  assert.equal(
    inspectionWhileFilling.inspection && "errorCode" in inspectionWhileFilling.inspection
      ? inspectionWhileFilling.inspection.errorCode
      : null,
    "FORM_INSPECTION_IN_PROGRESS"
  );
  await assert.rejects(
    coordinator.fillApprovedFields(() => undefined),
    (error: unknown) => error instanceof ApplicationBrowserError && error.code === "FILL_INTERNAL"
  );

  releaseWrite.resolve();
  const fillResult = await filling;
  assert.deepEqual(fillResult.fillCommand, { outcome: "FINALIZED" });
  assert.equal(calls.filter((call) => call === "acquire").length, 1);
  assert.equal(calls.filter((call) => call === "write").length, 1);
  assert.equal(calls.filter((call) => call === "finalize").length, 1);
  assert.deepEqual(finalized, [{
    runId: RUN_ID,
    fillAttemptId: attemptId,
    expectedStateVersion: 10,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{ stepKey, result: "FILLED", errorCode: null }]
  }]);
  const repeated = await coordinator.handleCommand(
    { type: "FILL_APPROVED_FIELDS" },
    () => undefined
  );
  assert.deepEqual(repeated.fillCommand, { outcome: "FINALIZED" });
  assert.equal(calls.filter((call) => call === "acquire").length, 1);
});

test("a workflow stop during the final status GET synchronously revokes the active Fill operation", async () => {
  const targetUrl = "https://jobs.example.test/apply";
  const generationId = Symbol("stop-race-generation");
  const fieldKey = "1".repeat(64);
  const fieldFingerprint = "2".repeat(64);
  const formFingerprint = "3".repeat(64);
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const stepKey = `fill:${attemptId}:${fieldKey}`;
  const statusEntered = deferred<void>();
  const releaseStatus = deferred<void>();
  const releaseCleanup = deferred<void>();
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  let statusReads = 0;
  let writes = 0;
  let finalizationDispatches = 0;
  const liveStatus = {
    state: "FILLING" as const,
    stateVersion: 8,
    fillAttemptId: attemptId,
    fillLeaseExpiresAt: "2099-09-10T20:10:00.000Z",
    leaseLive: true,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: true,
    outcome: null,
    errorCode: null,
    steps: []
  };
  const port = {
    async inspect() {
      return { generationId, inspectionReport: report };
    },
    async assertCurrent(id: symbol) {
      assert.equal(id, generationId);
      return { generationId, inspectionReport: report };
    },
    assertAcquiredFillAuthority(id: symbol) {
      assert.equal(id, generationId);
    },
    async writeApprovedField() {
      writes += 1;
      return { status: "FILLED" as const };
    },
    currentTargetUrl: () => targetUrl
  };
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        return {
          id: RUN_ID,
          state: "READY" as const,
          stateVersion: 7,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: targetUrl
        };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() {
        return { runId: RUN_ID, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
      },
      async publishFormInspection(_input: unknown, assertReadyToDispatch: () => void) {
        assertReadyToDispatch();
        return {
          replayed: false,
          run: { id: RUN_ID, state: "REVIEW_REQUIRED" as const, stateVersion: 8 },
          current: { inspectionVersion: 1, answerPacketVersion: 1 }
        };
      },
      async acquireFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
        assertReadyToDispatch();
        return {
          attemptId,
          runStateVersion: 8,
          leaseExpiresAt: liveStatus.fillLeaseExpiresAt,
          formInspectionVersion: 1,
          answerPacketVersion: 1,
          packetHash: "4".repeat(64),
          formFingerprint,
          eligibleFields: [{
            stepKey,
            normalizedFieldKey: fieldKey,
            fieldFingerprint,
            fieldType: "TEXT" as const,
            proposal: { kind: "SCALAR" as const, value: "private-proposal-sentinel" }
          }]
        };
      },
      async getFillAttemptStatus() {
        statusReads += 1;
        if (statusReads === 1) {
          statusEntered.resolve();
          await releaseStatus.promise;
        }
        return structuredClone(liveStatus);
      },
      async finalizeFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
        assertReadyToDispatch();
        finalizationDispatches += 1;
        throw new Error("a stopped workflow must not finalize");
      },
      async recoverExpiredFillAttempt(): Promise<never> {
        throw new Error("unexpected recovery");
      }
    },
    async openTarget() {
      return { finalUrl: targetUrl };
    },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => port,
    async closeResources() {
      await releaseCleanup.promise;
    }
  } as never);

  coordinator.markControlReady();
  await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  await coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
  const filling = coordinator.fillApprovedFields(() => undefined);
  await statusEntered.promise;

  const stopping = coordinator.safeStop("BROWSER_WORKFLOW_FAILED");
  assert.equal(coordinator.state(), "ERROR");
  releaseStatus.resolve();
  await filling.catch(() => undefined);

  assert.equal(writes, 0);
  assert.equal(finalizationDispatches, 0);
  releaseCleanup.resolve();
  await stopping;
});
test("inspection invalidation is monotonic and PAGE_CLOSED is terminal", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() { throw new Error("unexpected"); },
      async getAutomationPolicy() { throw new Error("unexpected"); }
    },
    async openTarget() { throw new Error("unexpected"); },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => null,
    async closeResources() { await cleanup; }
  } as never);

  coordinator.handleFormInspectionInvalidation("REINSPECTION_REQUIRED");
  assert.equal(coordinator.status().inspection, undefined);
  const stopping = coordinator.handleFormInspectionInvalidation("PAGE_CLOSED");
  assert.equal(coordinator.state(), "ERROR");
  assert.equal(coordinator.status().errorCode, "TARGET_PAGE_CLOSED");
  coordinator.handleFormInspectionInvalidation("TARGET_NAVIGATED");
  assert.equal(coordinator.state(), "ERROR");
  releaseCleanup();
  await stopping;
  await coordinator.close();
  assert.equal(coordinator.state(), "CLOSED");
});

test("protected-session loss is terminal and safe-stops with the fixed workflow code", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() { throw new Error("unexpected"); },
      async getAutomationPolicy() { throw new Error("unexpected"); }
    },
    async openTarget() { throw new Error("unexpected"); },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => null,
    async closeResources() { await cleanup; }
  } as never);

  const stopping = coordinator.handleFormInspectionInvalidation("PROTECTED_SESSION_LOST");
  assert.equal(coordinator.state(), "ERROR");
  assert.equal(coordinator.status().errorCode, "BROWSER_WORKFLOW_FAILED");
  coordinator.handleFormInspectionInvalidation("PAGE_CLOSED");
  assert.equal(coordinator.status().errorCode, "BROWSER_WORKFLOW_FAILED");
  releaseCleanup();
  await stopping;
  await coordinator.close();
});

test("INSPECT_FORM authorization is closed to TARGET_OPEN and recoverable codes are exact", () => {
  for (const state of [
    "STARTING",
    "APPLY_PILOT_AUTH_REQUIRED",
    "CONTROL_READY",
    "OPENING_TARGET",
    "ERROR",
    "CLOSED"
  ] as const) {
    assert.equal(isB1CommandAllowed({ type: "INSPECT_FORM" }, state), false, state);
  }
  assert.equal(isB1CommandAllowed({ type: "INSPECT_FORM" }, "TARGET_OPEN"), true);
  assert.deepEqual(BROWSER_INSPECTION_RECOVERABLE_CODES, [
    "FORM_INSPECTION_IN_PROGRESS",
    "FORM_STABILITY_TIMEOUT",
    "FORM_GENERATION_INVALIDATED",
    "FORM_CORRELATION_INVALID",
    "AMBIGUOUS_DUPLICATE_FIELD",
    "FORM_INSPECTION_CANCELLED",
    "FORM_INSPECTION_REQUEST_TOO_LARGE",
    "RUN_LIFECYCLE_STALE",
    "RUN_DOCUMENT_STALE",
    "SAME_ORIGIN_RATE_LIMITED",
    "SAME_ORIGIN_REQUEST_FAILED"
  ]);
});

test("FILL_APPROVED_FIELDS authorization is closed to TARGET_OPEN", () => {
  for (const state of [
    "STARTING",
    "APPLY_PILOT_AUTH_REQUIRED",
    "CONTROL_READY",
    "OPENING_TARGET",
    "ERROR",
    "CLOSED"
  ] as const) {
    assert.equal(isB1CommandAllowed({ type: "FILL_APPROVED_FIELDS" }, state), false, state);
  }
  assert.equal(
    isB1CommandAllowed({ type: "FILL_APPROVED_FIELDS" }, "TARGET_OPEN"),
    true
  );
});

function createInspectionErrorFixture(publicationError?: Error, publicationWait?: Promise<void>) {
  const generationId = Symbol("fixture-generation");
  let assertedGenerationId = generationId;
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  let cleanupCalls = 0;
  let publicationCalls = 0;
  let currentUrl = "https://jobs.example.test/apply#current";
  const port = {
    async inspect() { return { generationId, inspectionReport: report }; },
    async assertCurrent() { return { generationId: assertedGenerationId, inspectionReport: report }; },
    currentTargetUrl: () => currentUrl
  };
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        return { id: RUN_ID, state: "READY", stateVersion: 3, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply#fresh" };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() { return { runId: RUN_ID, current: null }; },
      async publishFormInspection(_input, assertReadyToDispatch) {
        publicationCalls += 1;
        assertReadyToDispatch();
        if (publicationError) throw publicationError;
        await publicationWait;
        return { replayed: true, run: { id: RUN_ID, state: "READY", stateVersion: 4 }, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
      }
    },
    async openTarget() { return { finalUrl: "https://jobs.example.test/apply#opened" }; },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => port,
    async closeResources() { cleanupCalls += 1; }
  });
  return {
    coordinator,
    cleanupCalls: () => cleanupCalls,
    publicationCalls: () => publicationCalls,
    returnGenerationFromAssertCurrent(value: symbol) { assertedGenerationId = value; },
    setCurrentUrl(value: string) { currentUrl = value; }
  };
}

test("the closed recoverable error set remains TARGET_OPEN without throwing", async () => {
  for (const code of BROWSER_INSPECTION_RECOVERABLE_CODES.slice(1)) {
    const fixture = createInspectionErrorFixture(Object.assign(new Error("bounded failure"), { code }));
    fixture.coordinator.markControlReady();
    await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    const result = await fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
    assert.equal(result.state, "TARGET_OPEN", code);
    assert.equal(result.inspection?.outcome, code === "FORM_GENERATION_INVALIDATED" ? "REINSPECTION_REQUIRED" : "FAILED", code);
    assert.equal(result.inspection && "errorCode" in result.inspection ? result.inspection.errorCode : null, code);
    assert.equal(fixture.cleanupCalls(), 0, code);
  }
});

test("terminal and unknown inspection errors synchronously establish ERROR and preserve first code", async () => {
  for (const [thrownCode, expectedCode] of [
    ["APPLY_PILOT_AUTH_REQUIRED", "APPLY_PILOT_AUTH_REQUIRED"],
    ["EMPLOYER_AUTH_REQUIRED_UNSUPPORTED", "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"],
    ["SAME_ORIGIN_REDIRECT_REJECTED", "SAME_ORIGIN_REDIRECT_REJECTED"],
    ["CALLER_SUPPLIED_ARBITRARY_CODE", "BROWSER_WORKFLOW_FAILED"],
    [undefined, "BROWSER_WORKFLOW_FAILED"]
  ] as const) {
    const error = thrownCode
      ? Object.assign(new Error("terminal"), { code: thrownCode })
      : new Error("unknown implementation failure");
    const fixture = createInspectionErrorFixture(error);
    fixture.coordinator.markControlReady();
    await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    await assert.rejects(
      fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
      (rejected: unknown) => {
        assert.ok(rejected instanceof ApplicationBrowserError);
        assert.equal(rejected.code, expectedCode);
        assert.equal(rejected.message, "The form inspection command failed safely.");
        assert.notEqual(rejected, error);
        assert.doesNotMatch(rejected.message, /terminal|unknown implementation failure/);
        return true;
      }
    );
    assert.equal(fixture.coordinator.state(), "ERROR");
    assert.equal(fixture.coordinator.status().errorCode, expectedCode);
    assert.equal(fixture.cleanupCalls(), 1);
    await fixture.coordinator.safeStop("LATER_ERROR");
    assert.equal(fixture.coordinator.status().errorCode, expectedCode);
  }
});

test("assertCurrent returning a different generation is a terminal integrity failure", async () => {
  const fixture = createInspectionErrorFixture();
  fixture.returnGenerationFromAssertCurrent(Symbol("impossible-returned-generation"));
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);

  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationBrowserError);
      assert.equal(error.code, "BROWSER_WORKFLOW_FAILED");
      assert.equal(error.message, "The form inspection command failed safely.");
      return true;
    }
  );
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.coordinator.state(), "ERROR");
  assert.equal(fixture.coordinator.status().errorCode, "BROWSER_WORKFLOW_FAILED");
  assert.equal(fixture.coordinator.status().inspection, undefined);
  assert.equal(fixture.cleanupCalls(), 1);
  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => error instanceof ApplicationBrowserError && error.code === "COMMAND_NOT_ALLOWED"
  );
});

test("target drift prevents publication and safe-stops before inspecting", async () => {
  const fixture = createInspectionErrorFixture();
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  fixture.setCurrentUrl("https://jobs.example.test/other?posting=changed");
  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_TARGET_STALE"
  );
  assert.equal(fixture.coordinator.state(), "ERROR");
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.cleanupCalls(), 1);
});

test("invalidation during publication wins persisted status without hiding safe replay metadata", async () => {
  const publicationGate = deferred<void>();
  const fixture = createInspectionErrorFixture(undefined, publicationGate.promise);
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  const pending = fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.coordinator.handleFormInspectionInvalidation("TARGET_NAVIGATED");
  publicationGate.resolve();
  const result = await pending;
  assert.deepEqual(result.inspection, {
    outcome: "SUCCEEDED",
    replayed: true,
    inspectionVersion: 1,
    answerPacketVersion: 1,
    reinspectionRequired: true
  });
  assert.deepEqual(fixture.coordinator.status().inspection, {
    outcome: "REINSPECTION_REQUIRED",
    errorCode: "FORM_GENERATION_INVALIDATED",
    retryAllowed: true
  });
});

test("coordinator opens only the immutable run's frozen, policy-allowed READY target", async () => {
  const calls: string[] = [];
  let openedTarget = "";
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun(runId) {
        calls.push(`run:${runId}`);
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: 0,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply?posting=123#intro"
        };
      },
      async getAutomationPolicy() {
        calls.push("policy");
        return {
          effectiveEnabled: true,
          allowedHosts: ["jobs.example.test"],
          blockedHosts: []
        };
      }
    },
    async openTarget(input, assertActive) {
      assertActive();
      openedTarget = input.target.url.toString();
      calls.push(`open:${input.target.host}`);
      return { finalUrl: "https://jobs.example.test/apply?posting=123#finished" };
    },
    async closeResources() {
      calls.push("close");
    }
  });

  coordinator.markControlReady();
  const result = await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);

  assert.deepEqual(calls, [`run:${RUN_ID}`, "policy", "open:jobs.example.test"]);
  assert.equal(openedTarget, "https://jobs.example.test/apply?posting=123#intro");
  assert.deepEqual(result, {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    targetHost: "jobs.example.test"
  });
});

test("coordinator rejects alternate run data, invalid state, disabled policy, and stale guards", async () => {
  const scenarios = [
    {
      name: "alternate run",
      run: { id: "clz8w7m9a0003qwer1234tyui", state: "READY", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "RUN_IDENTITY_MISMATCH"
    },
    {
      name: "invalid state",
      run: { id: RUN_ID, state: "DRAFT", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "RUN_INVALID_STATE"
    },
    {
      name: "disabled policy",
      run: { id: RUN_ID, state: "READY", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: false, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "AUTOMATION_DISABLED"
    }
  ] as const;

  for (const scenario of scenarios) {
    let openCalls = 0;
    const coordinator = new ApplicationBrowserCoordinator({
      ...NO_FORM_INSPECTION,
      configuredApplyPilotOrigin: APP_ORIGIN,
      immutableRunId: RUN_ID,
      client: {
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun() {
          return scenario.run;
        },
        async getAutomationPolicy() {
          return scenario.policy;
        }
      },
      async openTarget() {
        openCalls += 1;
        return { finalUrl: "https://jobs.example.test/apply" };
      },
      async closeResources() {}
    });
    coordinator.markControlReady();
    await assert.rejects(
      coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === scenario.code,
      scenario.name
    );
    assert.equal(openCalls, 0);
  }

  let clientCalls = 0;
  const stale = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() {
        clientCalls += 1;
        throw new Error("unexpected");
      },
      async getAutomationPolicy() {
        throw new Error("unexpected");
      }
    },
    async openTarget() {
      throw new Error("unexpected");
    },
    async closeResources() {}
  });
  stale.markControlReady();
  await assert.rejects(
    stale.handleCommand({ type: "OPEN_TARGET" }, () => {
      throw new Error("Bridge generation is stale.");
    }),
    /stale/i
  );
  assert.equal(clientCalls, 0);
});

test("coordinator enforces command state and idempotent close", async () => {
  let closeCalls = 0;
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() {
        throw new Error("unexpected");
      },
      async getAutomationPolicy() {
        throw new Error("unexpected");
      }
    },
    async openTarget() {
      throw new Error("unexpected");
    },
    async closeResources() {
      closeCalls += 1;
    }
  });

  await assert.rejects(
    coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_NOT_ALLOWED"
  );
  coordinator.markControlReady();
  assert.equal((await coordinator.handleCommand({ type: "GET_STATUS" }, () => undefined)).state, "CONTROL_READY");
  await coordinator.close();
  await coordinator.close();
  assert.equal(closeCalls, 1);
  assert.equal(coordinator.status().state, "CLOSED");
});

test("production runtime always requests headed non-persistent Chromium and normalizes missing-browser errors", async () => {
  const launchOptions: Array<Record<string, unknown>> = [];
  let newContextCalls = 0;
  let closeCalls = 0;
  const runtime = await launchApplicationBrowserRuntimeWithLauncherForTest({
    async launch(options) {
      launchOptions.push(options as Record<string, unknown>);
      return {
        async newContext() {
          newContextCalls += 1;
          return {
            async newPage() {
              return { close: async () => undefined };
            },
            async close() {
              closeCalls += 1;
            }
          };
        },
        async close() {
          closeCalls += 1;
        }
      };
    }
  });

  assert.deepEqual(launchOptions, [{ headless: false }]);
  assert.equal("executablePath" in launchOptions[0], false);
  assert.equal(newContextCalls, 1);
  await runtime.close();
  await runtime.close();
  assert.equal(closeCalls, 2);

  await assert.rejects(
    launchApplicationBrowserRuntimeWithLauncherForTest({
      async launch() {
        throw new Error("Executable doesn't exist at /missing/chromium");
      }
    }),
    (error: unknown) => error instanceof Error && error.message === MISSING_CHROMIUM_MESSAGE
  );
  assert.equal(MISSING_CHROMIUM_MESSAGE, "Apply Pilot Chromium is not installed. Run: npm run browser:install");
});

test("companion closes the target controller and runtime when control navigation fails after launch", async () => {
  const runCompanion = getCompanionRunner();
  const runtimeClose = idempotentCloseCounter();
  const targetClose = idempotentCloseCounter();
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() {
      throw new Error("synthetic control navigation failure");
    }
  };

  await assert.rejects(
    runCompanion(["--app-origin", APP_ORIGIN, "--run-id", RUN_ID], {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          close: runtimeClose.close
        };
      },
      createClient: () => ({
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun() { throw new Error("unexpected owner read"); },
        async getAutomationPolicy() { throw new Error("unexpected policy read"); }
      }),
      createTargetController: () => ({
        async open() { throw new Error("unexpected target open"); },
        close: targetClose.close
      }),
      async installBridge() {
        throw new Error("unexpected bridge install");
      },
      writeOutput: () => undefined
    }),
    /synthetic control navigation failure/
  );

  assert.equal(targetClose.count(), 1);
  assert.equal(runtimeClose.count(), 1);
});

test("companion proves run ownership before installing a bridge on an exact control URL", async () => {
  const runCompanion = getCompanionRunner();
  const runtimeClose = idempotentCloseCounter();
  const targetClose = idempotentCloseCounter();
  const calls: string[] = [];
  let bindingInstallations = 0;
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() {
      return null;
    }
  };
  const ownerFailure = Object.assign(new Error("owner-safe run was not found"), {
    code: "SAME_ORIGIN_REQUEST_FAILED"
  });

  await assert.rejects(
    runCompanion(["--app-origin", APP_ORIGIN, "--run-id", RUN_ID], {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          close: async () => {
            calls.push("runtime-close");
            await runtimeClose.close();
          }
        };
      },
      createClient: () => ({
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun(runId: string) {
          calls.push(`owner:${runId}`);
          throw ownerFailure;
        },
        async getAutomationPolicy() { throw new Error("unexpected policy read"); }
      }),
      createTargetController: () => ({
        async open() { throw new Error("unexpected target open"); },
        close: async () => {
          calls.push("target-close");
          await targetClose.close();
        }
      }),
      async installBridge() {
        bindingInstallations += 1;
        throw new Error("bridge installation must not be reached");
      },
      writeOutput: () => undefined
    }),
    /owner-safe run was not found/
  );

  assert.deepEqual(calls, [`owner:${RUN_ID}`, "target-close", "runtime-close"]);
  assert.equal(bindingInstallations, 0);
  assert.equal(targetClose.count(), 1);
  assert.equal(runtimeClose.count(), 1);
});

test("safe browser diagnostics exclude URLs, response bodies, credentials, and plaintext", () => {
  const diagnostic = createSafeBrowserDiagnostic({
    runId: RUN_ID,
    state: "ERROR",
    operation: "OPEN_TARGET",
    code: "TARGET_NAVIGATION_FAILED",
    host: "jobs.example.test",
    elapsedMs: 25,
    count: 1,
    ignored: "https://jobs.example.test/apply?token=secret resume plaintext password cookie"
  });
  assert.deepEqual(diagnostic, {
    runId: RUN_ID,
    state: "ERROR",
    operation: "OPEN_TARGET",
    code: "TARGET_NAVIGATION_FAILED",
    host: "jobs.example.test",
    elapsedMs: 25,
    count: 1
  });
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
});
