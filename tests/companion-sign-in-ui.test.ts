import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { CompanionSignInCode } from "@/components/companion-sign-in-code";
import { CompanionSignInForm } from "@/components/companion-sign-in-form";
import { companionSignInHref } from "@/lib/companion-sign-in";

const RUN = "clz8w7m9a0004qwer1234tyui";
const CONTROL = `/application-runs/${RUN}/browser`;

type FetchHandler = (input: string, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function mount(element: ReactElement, handler: FetchHandler, navigations: string[] = []) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.example.com/start" });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window, self: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return handler(String(input), init);
    }
  });
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container, calls, navigations, window: dom.window,
    async click(selector: string) {
      const target = container.querySelector<HTMLElement>(selector);
      assert.ok(target, `missing ${selector}`);
      await act(async () => { target.click(); });
    },
    async type(selector: string, value: string) {
      const input = container.querySelector<HTMLInputElement>(selector);
      assert.ok(input, `missing ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      // react-dom was imported before this JSDOM window existed, so it uses its fallback
      // text-input listener (focus plus key events) instead of "input" events.
      await act(async () => {
        input.focus();
        setter?.call(input, value);
        input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
      });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      if (priorFetch) Object.defineProperty(globalThis, "fetch", priorFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  };
}

test("the login page offers code sign-in only on the way to a run's control page", () => {
  assert.equal(companionSignInHref(CONTROL), `/companion-sign-in?callbackUrl=${encodeURIComponent(CONTROL)}`);
  assert.equal(companionSignInHref("/dashboard"), null);
  assert.equal(companionSignInHref(undefined), null);
});

test("getting a code shows it once with how and where to use it, and requests nothing on render", async () => {
  const ui = await mount(createElement(CompanionSignInCode, { runId: RUN }), async (input, init) => {
    assert.equal(input, `/api/application-runs/${RUN}/companion-sign-in-code`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    return json({ code: "ABCD-EFGH-JKMN", expiresAt: "2026-11-10T12:05:00.000Z" });
  });
  try {
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.container.querySelector("[data-testid='companion-code']"), null);
    await ui.click("[data-testid='companion-code-button']");
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.container.querySelector("[data-testid='companion-code']")?.textContent, "ABCD-EFGH-JKMN");
    const text = ui.container.textContent ?? "";
    assert.match(text, /Chrome for Testing/);
    assert.match(text, /once/);
    assert.match(text, /5 minutes/);
    assert.match(text, /this run/);
  } finally { await ui.cleanup(); }
});

test("a refused code request explains itself and shows no code", async () => {
  const ui = await mount(createElement(CompanionSignInCode, { runId: RUN }), async () => json({ error: "Browser run not found." }, 404));
  try {
    await ui.click("[data-testid='companion-code-button']");
    assert.equal(ui.container.querySelector("[data-testid='companion-code']"), null);
    assert.match(ui.container.textContent ?? "", /couldn't get a code/i);
  } finally { await ui.cleanup(); }
});

test("entering a code posts it with the control page and goes there when accepted", async () => {
  const navigations: string[] = [];
  const navigate = (url: string) => { navigations.push(url); };
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL, navigate }), async (input, init) => {
    assert.equal(input, "/api/companion-sign-in");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { code: "abcd-efgh-jkmn", callbackUrl: CONTROL });
    return json({ redirectTo: CONTROL });
  }, navigations);
  try {
    await ui.type("input[name='code']", "abcd-efgh-jkmn");
    await ui.click("button[type='submit']");
    assert.deepEqual(ui.navigations, [CONTROL]);
  } finally { await ui.cleanup(); }
});

test("a rejected code stays on the page with a plain explanation", async () => {
  const navigations: string[] = [];
  const navigate = (url: string) => { navigations.push(url); };
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL, navigate }), async () => json({ error: "That code didn't work." }, 400), navigations);
  try {
    await ui.type("input[name='code']", "ABCD-EFGH-JKMN");
    await ui.click("button[type='submit']");
    assert.deepEqual(ui.navigations, []);
    assert.match(ui.container.textContent ?? "", /didn't work/);
    assert.match(ui.container.textContent ?? "", /new code/);
  } finally { await ui.cleanup(); }
});
