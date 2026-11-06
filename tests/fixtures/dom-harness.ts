import "@/tests/fixtures/dom-globals";
import { JSDOM } from "jsdom";
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

// Minimal client-component harness: a JSDOM window installed as globals, an App Router context
// that records refresh/push calls, and helpers to click, type and wait for rendered text.
export type DomHarness = {
  container: HTMLElement;
  window: JSDOM["window"];
  refreshes: number;
  pushes: string[];
  render(element: ReactElement): Promise<void>;
  click(element: Element | null | undefined): Promise<void>;
  button(name: string | RegExp): HTMLButtonElement;
  maybeButton(name: string | RegExp): HTMLButtonElement | undefined;
  type(element: Element | null | undefined, value: string): Promise<void>;
  check(element: Element | null | undefined, checked?: boolean): Promise<void>;
  waitForText(pattern: RegExp): Promise<void>;
  text(): string;
  close(): Promise<void>;
};

export function createDomHarness(options: { url?: string; fetch?: typeof fetch; confirm?: (message: string) => boolean } = {}): DomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: options.url ?? "https://app.example.com/jobs/job-1"
  });
  if (options.confirm) dom.window.confirm = options.confirm;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const globals: Record<string, unknown> = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    IS_REACT_ACT_ENVIRONMENT: true,
    ...(options.fetch ? { fetch: options.fetch } : {})
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root: Root = createRoot(container);
  const harness: DomHarness = {
    container,
    window: dom.window,
    refreshes: 0,
    pushes: [],
    async render(element) {
      const noop = () => {};
      const router = {
        bfcacheId: "test", back: noop, forward: noop, prefetch: noop,
        push: (href: string) => { harness.pushes.push(href); },
        replace: (href: string) => { harness.pushes.push(href); },
        refresh: () => { harness.refreshes += 1; }
      };
      await act(async () => {
        root.render(React.createElement(AppRouterContext.Provider, { value: router } as never, element));
      });
    },
    async click(element) {
      if (!element) throw new Error("Nothing to click.");
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    },
    maybeButton(name) {
      return [...container.querySelectorAll("button")].find((node) => {
        const label = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
        return typeof name === "string" ? label === name : name.test(label);
      });
    },
    button(name) {
      const found = harness.maybeButton(name);
      if (!found) {
        throw new Error(`No button ${String(name)}; buttons: ${[...container.querySelectorAll("button")].map((node) => node.textContent).join(" | ")}`);
      }
      return found;
    },
    async type(element, value) {
      if (!element) throw new Error("Nothing to type into.");
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const prototype = Object.getPrototypeOf(field) as object;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      await act(async () => {
        setter?.call(field, value);
        field.dispatchEvent(new dom.window.Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      });
    },
    async check(element, checked = true) {
      if (!element) throw new Error("Nothing to check.");
      const input = element as HTMLInputElement;
      if (input.checked === checked) return;
      await harness.click(input);
    },
    async waitForText(pattern) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (pattern.test(container.textContent ?? "")) return;
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
      }
      throw new Error(`Timed out waiting for ${pattern}; text: ${(container.textContent ?? "").slice(0, 1500)}`);
    },
    text() {
      return container.textContent ?? "";
    },
    async close() {
      await act(async () => { root.unmount(); });
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  };
  return harness;
}
