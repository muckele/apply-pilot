import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import type { AnswerPacket } from "@/lib/application-browser/control-presentation";
import { RAW_CONTROL_PAGE_CODES } from "@/lib/assisted-apply/plain-language";
import { APPLICATION_BROWSER_BINDING_NAME, type B1Command, type B1Status } from "@/lib/application-browser/types";

const RUN_ID = "cm12345678901234567890123";
const APPLICATION_HREF = "/applications/cm00000000000000000000001";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function runAuthority(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    state: "REVIEW_REQUIRED",
    stateVersion: 7,
    completedAt: null,
    reviewReasons: ["evidence_gaps_present"],
    applicationId: "application-synthetic",
    applyHost: "jobs.example.test",
    ...overrides
  };
}

function packet(): AnswerPacket {
  return {
    inspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: "a".repeat(64),
    reviewedAt: null,
    createdAt: "2026-08-29T20:00:00.000Z",
    summary: {
      fieldCount: 3,
      observedFieldCount: 3,
      ambiguousQuestionCount: 0,
      ambiguousRequiredCount: 0,
      proposableCount: 1,
      pendingReviewCount: 1,
      approvedCount: 0,
      rejectedCount: 0,
      manualOnlyCount: 1,
      excludedCount: 1,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [
      {
        id: "answer-link",
        normalizedFieldKey: "b".repeat(64),
        question: "LinkedIn profile",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "SCALAR", value: "https://example.test/in/someone" },
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      },
      {
        id: "answer-phone",
        normalizedFieldKey: "c".repeat(64),
        question: "Phone number",
        fieldType: "TEL",
        classification: "CONTACT",
        disposition: "MANUAL_ONLY",
        dispositionReason: "UNCONFIRMED_APPLICANT_CONTACT",
        choices: [],
        proposal: null,
        required: true,
        requiresReview: false,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      },
      {
        id: "answer-sponsorship",
        normalizedFieldKey: "d".repeat(64),
        question: "Will you need sponsorship?",
        fieldType: "RADIO_GROUP",
        classification: "SPONSORSHIP",
        disposition: "EXCLUDED",
        dispositionReason: "POLICY_EXCLUDED",
        choices: [],
        proposal: null,
        required: true,
        requiresReview: false,
        sensitive: true,
        valueRedacted: true,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      }
    ]
  };
}

const noAttemptFillStatus = {
  state: "REVIEW_REQUIRED",
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

type Mounted = {
  container: HTMLElement;
  window: JSDOM["window"];
  bindingCalls: B1Command[];
  setBinding(binding: ((command: B1Command) => Promise<B1Status>) | undefined): void;
  cleanup(): Promise<void>;
};

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(options: {
  binding?: (command: B1Command) => Promise<B1Status>;
  run?: Record<string, unknown>;
  packet?: AnswerPacket | null;
  waitMs?: number;
}): Promise<Mounted> {
  const dom = new JSDOM("<!doctype html><html><head><title>Apply Pilot</title></head><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/application-runs/test/browser"
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const globals = [
    ["window", dom.window],
    ["document", dom.window.document],
    ["navigator", dom.window.navigator],
    ["HTMLElement", dom.window.HTMLElement],
    ["Node", dom.window.Node],
    ["Event", dom.window.Event],
    ["MouseEvent", dom.window.MouseEvent],
    ["MutationObserver", dom.window.MutationObserver],
    ["IS_REACT_ACT_ENVIRONMENT", true]
  ] as const;
  const saved = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [key, value] of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/application-runs/${RUN_ID}`) return json({ run: runAuthority(options.run) });
      if (url === `/api/application-runs/${RUN_ID}/answer-packet`) {
        return json({ runId: RUN_ID, current: options.packet === undefined ? null : options.packet });
      }
      if (url === `/api/application-runs/${RUN_ID}/fill-attempt`) return json(noAttemptFillStatus);
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const bindingCalls: B1Command[] = [];
  const setBinding = (binding: ((command: B1Command) => Promise<B1Status>) | undefined) => {
    if (binding === undefined) {
      Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
      return;
    }
    Object.defineProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME, {
      configurable: true,
      writable: true,
      value: async (command: B1Command) => {
        bindingCalls.push(command);
        return binding(command);
      }
    });
  };
  setBinding(options.binding);

  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(ApplicationBrowserControl, {
      runId: RUN_ID,
      authenticatedOwnerPage: true,
      detectCompanionWindow: true,
      companionWindowWaitMs: options.waitMs ?? 60,
      applicationHref: APPLICATION_HREF
    }));
  });
  await settle();

  return {
    container,
    window: dom.window,
    bindingCalls,
    setBinding,
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      if (savedFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
      else Object.defineProperty(globalThis, "fetch", savedFetch);
      for (const [key] of [...globals].reverse()) {
        const descriptor = saved.get(key);
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
    }
  };
}

function buttonTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
}

// Text nodes joined with spaces, so neighbouring elements can't hide a code ("boxPENDING").
function visibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const technical of clone.querySelectorAll("details[data-technical]")) technical.remove();
  const walker = clone.ownerDocument.createTreeWalker(clone, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue ?? "");
  return parts.join(" ");
}

const targetOpen = async (): Promise<B1Status> => ({ state: "TARGET_OPEN", runId: RUN_ID, targetHost: "jobs.example.test" });

test("in a browser without the companion, the page says it is the wrong window and shows no controls", async () => {
  const mounted = await mount({});
  try {
    assert.equal(mounted.container.querySelector('[data-testid="wrong-window"]') === null, true, "not before the wait");
    await settle(120);
    const text = mounted.container.textContent ?? "";
    assert.equal(text.includes("This page only works inside the Apply Pilot browser"), true);
    assert.equal(text.includes("UNKNOWN"), false);
    assert.equal(text.includes("UNAVAILABLE"), false);
    const buttons = buttonTexts(mounted.container);
    for (const name of ["Refresh status", "Open frozen target", "Inspect form", "Close workflow", "Fill approved fields"]) {
      assert.equal(buttons.includes(name), false, `${name} should not render`);
    }
    assert.equal(buttons.includes("Check again"), true);
    const back = mounted.container.querySelector<HTMLAnchorElement>('[data-testid="wrong-window"] a');
    assert.equal(back?.getAttribute("href"), APPLICATION_HREF);
    assert.equal(mounted.bindingCalls.length, 0);
  } finally {
    await mounted.cleanup();
  }
});

test("Check again finds a companion connection that arrived later", async () => {
  const mounted = await mount({});
  try {
    await settle(120);
    assert.equal(mounted.container.querySelector('[data-testid="wrong-window"]') !== null, true);
    mounted.setBinding(targetOpen);
    const checkAgain = [...mounted.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Check again");
    assert.ok(checkAgain);
    await act(async () => checkAgain.click());
    await settle(30);
    assert.equal(mounted.container.querySelector('[data-testid="wrong-window"]') === null, true);
    assert.equal(mounted.container.querySelector('[data-testid="apply-pilot-browser-banner"]') !== null, true);
  } finally {
    await mounted.cleanup();
  }
});

test("a connection that arrives during the wait never shows the wrong-window card", async () => {
  const mounted = await mount({ waitMs: 400 });
  try {
    await settle(30);
    assert.equal(mounted.container.querySelector('[data-testid="wrong-window"]') === null, true);
    assert.equal((mounted.container.textContent ?? "").includes("Connecting to the Apply Pilot browser"), true);
    mounted.setBinding(targetOpen);
    await settle(300);
    assert.equal(mounted.container.querySelector('[data-testid="wrong-window"]') === null, true);
    assert.equal(mounted.container.querySelector('[data-testid="apply-pilot-browser-banner"]') !== null, true);
  } finally {
    await mounted.cleanup();
  }
});

test("inside the Apply Pilot browser: banner, title and one automatic status read", async () => {
  const mounted = await mount({ binding: targetOpen });
  try {
    await settle(20);
    assert.equal(mounted.container.querySelector('[data-testid="apply-pilot-browser-banner"]') !== null, true);
    assert.deepEqual(mounted.bindingCalls, [{ type: "GET_STATUS" }]);
    assert.equal(mounted.window.document.title, "Apply Pilot browser — Employer's form is open");
    assert.equal(
      mounted.container.querySelector('[data-testid="companion-status"]')?.textContent?.trim(),
      "Employer's form is open."
    );
  } finally {
    await mounted.cleanup();
  }
});

test("a submission can still be recorded from the usual browser", async () => {
  const mounted = await mount({ run: { state: "READY", reviewReasons: [] } });
  try {
    await settle(120);
    const buttons = buttonTexts(mounted.container);
    assert.equal(buttons.includes("I personally submitted this application"), true);
    assert.equal(buttons.includes("Fill approved fields"), false);
  } finally {
    await mounted.cleanup();
  }
});

test("no state code is visible outside Details", async () => {
  const mounted = await mount({ binding: targetOpen, packet: packet() });
  try {
    await settle(30);
    const text = visibleText(mounted.container);
    assert.equal(text.includes("LinkedIn profile"), true, "answers render");
    const leaked = RAW_CONTROL_PAGE_CODES.filter((code) => new RegExp(`(^|[^A-Za-z_])${code}([^A-Za-z_]|$)`).test(text));
    assert.deepEqual(leaked, []);
    const all = mounted.container.textContent ?? "";
    assert.equal(all.includes("TARGET_OPEN"), true, "codes stay available under Details");
  } finally {
    await mounted.cleanup();
  }
});
