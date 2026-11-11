import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ApplicationDetailsForm } from "@/components/application-details-form";
import { buildApplicationDetailsView } from "@/lib/application-details";

type FetchHandler = (input: string, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const INITIAL = buildApplicationDetailsView({
  contactInfo: { name: "Alex Rivera", email: "alex@example.test", linkedin: "linkedin.com/in/alex-example" },
  rows: []
});

async function mount(handler: FetchHandler) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.example.com/settings/application-details" });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  // react-dom's fallback input listener calls the IE-only attachEvent/detachEvent. In JSDOM they
  // throw, which leaves the previous test's input watched and this test's typing unseen.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
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
  await act(async () => { root.render(createElement(ApplicationDetailsForm, { initialDetails: INITIAL })); });
  return {
    container, calls,
    text(selector: string) {
      return container.querySelector(selector)?.textContent ?? "";
    },
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

test("the page shows résumé values to confirm and names what is missing", async () => {
  const page = await mount(async () => json({}));
  try {
    assert.equal(page.container.querySelector<HTMLInputElement>("input[name=email]")?.value, "alex@example.test");
    assert.equal(page.text("[data-status-for=email]").includes("From your résumé"), true);
    assert.equal(page.text("[data-missing]").includes("Phone number"), true);
    assert.equal(page.text("[data-summary]").includes("0 of"), true);
  } finally {
    await page.cleanup();
  }
});

test("saving sends every detail and shows what Fill will now use", async () => {
  const saved = buildApplicationDetailsView({
    contactInfo: null,
    rows: [{
      id: "r-phone", category: "CONTACT", question: "Phone number", normalizedQuestion: "phone number",
      answer: "+1 555 0100", sensitive: false, isActive: true, updatedAt: new Date("2026-11-10T10:00:00.000Z")
    }]
  });
  const page = await mount(async () => json({ details: saved }));
  try {
    await page.type("input[name=phone]", "+1 555 0100");
    assert.equal(page.text("[data-status-for=phone]").includes("Not saved yet"), true);
    await page.click("button[data-action=save]");

    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].input, "/api/application-details");
    assert.equal(page.calls[0].init?.method, "PUT");
    const body = JSON.parse(String(page.calls[0].init?.body)) as Record<string, string>;
    assert.equal(body.phone, "+1 555 0100");
    assert.equal(body.email, "alex@example.test");
    assert.equal(Object.keys(body).length, 10);
    assert.equal(page.text("[data-save-status]").includes("Saved"), true);
    assert.equal(page.text("[data-status-for=phone]").includes("Fill uses this"), true);
  } finally {
    await page.cleanup();
  }
});

test("a rejected save keeps the typed values and says why", async () => {
  const page = await mount(async () => json({ error: "Enter a valid email address." }, 400));
  try {
    await page.type("input[name=email]", "not-an-email");
    await page.click("button[data-action=save]");
    assert.equal(page.text("[data-save-status]").includes("Enter a valid email address."), true);
    assert.equal(page.container.querySelector<HTMLInputElement>("input[name=email]")?.value, "not-an-email");
  } finally {
    await page.cleanup();
  }
});
