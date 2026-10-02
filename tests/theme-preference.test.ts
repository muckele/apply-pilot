import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";

import { ThemePreferenceControl } from "@/components/theme-preference-control";
import { ThemePreferenceSync } from "@/components/theme-preference-sync";
import {
  isProductThemePreference,
  PRODUCT_THEME_BOOTSTRAP_SCRIPT,
  PRODUCT_THEME_STORAGE_KEY,
  resolveProductTheme
} from "@/lib/theme-preference";

const repositoryRoot = process.cwd();

function source(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function runBootstrap(stored: string | null, systemPrefersDark: boolean) {
  const dataset: Record<string, string> = {};
  vm.runInNewContext(PRODUCT_THEME_BOOTSTRAP_SCRIPT, {
    document: { documentElement: { dataset } },
    localStorage: { getItem: (key: string) => key === PRODUCT_THEME_STORAGE_KEY ? stored : null },
    window: { matchMedia: () => ({ matches: systemPrefersDark }) }
  });
  return dataset;
}

test("theme preference validates and resolves explicit and system choices", () => {
  assert.equal(isProductThemePreference("light"), true);
  assert.equal(isProductThemePreference("dark"), true);
  assert.equal(isProductThemePreference("system"), true);
  assert.equal(isProductThemePreference("sepia"), false);
  assert.equal(resolveProductTheme("light", true), "light");
  assert.equal(resolveProductTheme("dark", false), "dark");
  assert.equal(resolveProductTheme("system", false), "light");
  assert.equal(resolveProductTheme("system", true), "dark");
});

test("pre-paint bootstrap defaults to System and honors an explicit browser-local choice", () => {
  assert.deepEqual(runBootstrap(null, false), {
    productThemePreference: "system",
    productTheme: "light"
  });
  assert.deepEqual(runBootstrap(null, true), {
    productThemePreference: "system",
    productTheme: "dark"
  });
  assert.deepEqual(runBootstrap("light", true), {
    productThemePreference: "light",
    productTheme: "light"
  });
  assert.deepEqual(runBootstrap("dark", false), {
    productThemePreference: "dark",
    productTheme: "dark"
  });
  assert.deepEqual(runBootstrap("invalid", true), {
    productThemePreference: "system",
    productTheme: "dark"
  });
});

test("root bootstrap, shell synchronization, and settings control share the local preference contract", () => {
  const layout = source("app/layout.tsx");
  const shell = source("components/app-shell.tsx");
  const sync = source("components/theme-preference-sync.tsx");
  const control = source("components/theme-preference-control.tsx");
  const settings = source("app/(product)/settings/profile/page.tsx");

  assert.match(layout, /suppressHydrationWarning/);
  assert.match(layout, /PRODUCT_THEME_BOOTSTRAP_SCRIPT/);
  assert.match(shell, /ThemePreferenceSync/);
  assert.match(sync, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(sync, /addEventListener\("change", sync\)/);
  assert.match(sync, /localStorage\.setItem\(PRODUCT_THEME_STORAGE_KEY, preference\)/);
  assert.match(control, /type="radio"/);
  assert.match(control, /data-theme-choice=\{value\}/);
  assert.match(control, /Light/);
  assert.match(control, /Dark/);
  assert.match(control, /System/);
  assert.match(settings, /title="Appearance"/);
  assert.doesNotMatch(sync, /fetch\(/);
  assert.doesNotMatch(settings, /prisma\..*theme/);
});

test("semantic focus, badge, callout, and pre-paint selector tokens preserve AA contrast", () => {
  const css = source("app/(product)/product.css");
  const luminance = (hex: string) => {
    const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  for (const [foreground, background] of [
    ["#19764e", "#ffffff"],
    ["#7a5108", "#ffffff"],
    ["#a12e29", "#ffffff"],
    ["#f1dfb0", "#0a1815"],
    ["#ffd8d4", "#071411"]
  ]) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background} must meet WCAG AA`);
  }

  assert.match(css, /html\[data-product-theme="dark"\] \.product-shell:has\(\.product-page-themed\).*:focus-visible/);
  assert.match(css, /--product-badge-low-text: #f1dfb0/);
  assert.match(css, /--product-danger-text: #ffd8d4/);
  for (const preference of ["light", "dark", "system"]) {
    assert.match(css, new RegExp(`data-product-theme-preference="${preference}"`));
  }
});

test("mounted theme controls persist explicit choices and follow live System changes", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.test/settings/profile"
  });
  const mediaListeners = new Set<() => void>();
  let systemPrefersDark = false;
  const media = {
    get matches() { return systemPrefersDark; },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener)
  };
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => media });
  dom.window.localStorage.setItem(PRODUCT_THEME_STORAGE_KEY, "dark");
  dom.window.document.documentElement.dataset.productThemePreference = "dark";
  dom.window.document.documentElement.dataset.productTheme = "dark";

  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    StorageEvent: dom.window.StorageEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Fragment, null, createElement(ThemePreferenceSync), createElement(ThemePreferenceControl)));
    });
    const input = (value: string) => container.querySelector<HTMLInputElement>(`input[value='${value}']`);
    assert.equal(input("dark")?.checked, true);

    await act(async () => { input("light")?.click(); });
    assert.equal(dom.window.localStorage.getItem(PRODUCT_THEME_STORAGE_KEY), "light");
    assert.equal(dom.window.document.documentElement.dataset.productTheme, "light");

    await act(async () => { input("system")?.click(); });
    systemPrefersDark = true;
    await act(async () => { mediaListeners.forEach((listener) => listener()); });
    assert.equal(dom.window.document.documentElement.dataset.productThemePreference, "system");
    assert.equal(dom.window.document.documentElement.dataset.productTheme, "dark");

    await act(async () => { input("light")?.click(); });
    systemPrefersDark = false;
    await act(async () => { mediaListeners.forEach((listener) => listener()); });
    assert.equal(dom.window.document.documentElement.dataset.productTheme, "light");
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
