import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplicationEffortEditor } from "@/components/application-effort-editor";
import { typeInto } from "@/tests/fixtures/react-input";

type Request = { url: string; init: RequestInit };
type Props = { applicationId: string; initialMinutes: number | null; canRecord: boolean };

async function mounted(
  props: Props,
  respond: (request: Request) => Response,
  run: (harness: { container: HTMLElement; requests: Request[]; refreshes: () => number }) => Promise<void>
) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: `http://localhost/applications/${props.applicationId}` });
  const requests: Request[] = [];
  let refreshCount = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 0,
    fetch: async (url: string, init: RequestInit) => {
      const request = { url, init };
      requests.push(request);
      return respond(request);
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const noop = () => {};
  const router = { bfcacheId: "effort", back: noop, forward: noop, push: noop, replace: noop, prefetch: noop, refresh: () => { refreshCount += 1; } };
  try {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router }, createElement(ApplicationEffortEditor, props)));
    });
    await run({ container, requests, refreshes: () => refreshCount });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

const saved = (minutes: number) => () =>
  new Response(JSON.stringify({ effort: { minutes, recordedAt: "2026-11-04T18:00:00.000Z" } }), { headers: { "content-type": "application/json" } });

function element<T extends Element = HTMLElement>(container: HTMLElement, selector: string) {
  const found = container.querySelector<T>(selector);
  assert.ok(found, `missing ${selector}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => { target.click(); });
}

test("an applied application without minutes can have them added", async () => {
  await mounted({ applicationId: "app-1", initialMinutes: null, canRecord: true }, saved(50), async ({ container, requests, refreshes }) => {
    assert.match(element(container, "[data-effort-current]").textContent ?? "", /Not recorded/u);
    await click(element(container, "[data-effort-edit]"));
    const input = element<HTMLInputElement>(container, "[data-effort-minutes]");
    assert.equal(input.value, "");
    assert.match(container.querySelector(`label[for="${input.id}"]`)?.textContent ?? "", /minutes/iu);
    assert.match(element(container, `#${input.getAttribute("aria-describedby")}`).textContent ?? "", /Insights/u);
    const save = element<HTMLButtonElement>(container, "[data-effort-save]");
    assert.equal(save.disabled, true, "nothing to save while the box is empty");

    await typeInto(input, "50");
    assert.equal(save.disabled, false);
    await click(save);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/api/applications/app-1/effort");
    assert.equal(requests[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { minutes: 50 });
    assert.equal(refreshes(), 1);
    assert.match(element(container, "[data-effort-message]").textContent ?? "", /Saved/u);
    assert.equal(container.querySelector("[data-effort-minutes]"), null, "the form closes after saving");
  });
});

test("recorded minutes show and can be corrected; an invalid value cannot be saved", async () => {
  await mounted({ applicationId: "app-2", initialMinutes: 45, canRecord: true }, saved(35), async ({ container, requests }) => {
    assert.match(element(container, "[data-effort-current]").textContent ?? "", /45 min/u);
    const edit = element(container, "[data-effort-edit]");
    assert.match(edit.textContent ?? "", /Correct/u);
    await click(edit);
    const input = element<HTMLInputElement>(container, "[data-effort-minutes]");
    assert.equal(input.value, "45", "the box starts with the recorded answer");
    const save = element<HTMLButtonElement>(container, "[data-effort-save]");

    for (const bad of ["0", "12.5", "601"]) {
      await typeInto(input, bad);
      assert.equal(save.disabled, true, bad);
      assert.match(element(container, "[data-effort-error]").textContent ?? "", /whole minutes from 1 to 600/u);
      assert.equal(input.getAttribute("aria-invalid"), "true");
    }
    await typeInto(input, "35");
    await click(save);
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { minutes: 35 });
  });
});

test("cancel closes the form without a request", async () => {
  await mounted({ applicationId: "app-3", initialMinutes: 20, canRecord: true }, saved(20), async ({ container, requests }) => {
    await click(element(container, "[data-effort-edit]"));
    await typeInto(element<HTMLInputElement>(container, "[data-effort-minutes]"), "90");
    await click(element(container, "[data-effort-cancel]"));
    assert.equal(container.querySelector("[data-effort-minutes]"), null);
    assert.match(element(container, "[data-effort-current]").textContent ?? "", /20 min/u);
    assert.equal(requests.length, 0);
  });
});

test("a refused save shows the server's reason and keeps the form open", async () => {
  const refused = () => new Response(JSON.stringify({ error: "Record this application as applied before adding the minutes it took." }), {
    status: 409,
    headers: { "content-type": "application/json" }
  });
  await mounted({ applicationId: "app-4", initialMinutes: null, canRecord: true }, refused, async ({ container, refreshes }) => {
    await click(element(container, "[data-effort-edit]"));
    await typeInto(element<HTMLInputElement>(container, "[data-effort-minutes]"), "30");
    await click(element(container, "[data-effort-save]"));
    assert.match(element(container, "[role='alert']").textContent ?? "", /Record this application as applied/u);
    assert.ok(container.querySelector("[data-effort-minutes]"));
    assert.equal(refreshes(), 0);
  });
});

test("an application not yet applied explains when minutes can be added", async () => {
  await mounted({ applicationId: "app-5", initialMinutes: null, canRecord: false }, saved(1), async ({ container }) => {
    assert.equal(container.querySelector("[data-effort-edit]"), null);
    assert.match(container.textContent ?? "", /once this application has an applied date/u);
  });
});
