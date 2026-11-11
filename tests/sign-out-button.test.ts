import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { SignOutButton } from "@/components/sign-out-button";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

test("submitting the sign-out form clears saved drafts", async () => {
  const harness = createDomHarness();
  const store = new Map<string, string>([
    ["apply-pilot:experience:u1:job-1", "x"],
    ["keep", "y"]
  ]);
  const storage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear()
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  
  try {
    await harness.render(React.createElement(SignOutButton, { action: async () => {} }));
    const form = harness.container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(store.has("apply-pilot:experience:u1:job-1"), false);
    assert.equal(store.get("keep"), "y");
    assert.match(harness.text(), /Sign out/);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    await harness.close();
  }
});
