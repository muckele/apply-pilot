import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { CompanionSignInCode } from "@/components/companion-sign-in-code";
import { CompanionSignInForm } from "@/components/companion-sign-in-form";
import { PublicAuthPage } from "@/components/public-auth/public-auth-page";
import {
  companionCallbackForLogin,
  companionLoginPath,
  generateCompanionSignInCode,
  normalizeCompanionSignInCode
} from "@/lib/companion-sign-in";
import { formatCompanionCodeInput, hasImpossibleCompanionCodeCharacter } from "@/lib/companion-sign-in-code-format";

const RUN = "clz8w7m9a0004qwer1234tyui";
const CONTROL = `/application-runs/${RUN}/browser`;
const HINT = "Codes use letters and the digits 2–9. There's no O, I, 0 or 1.";

type FetchHandler = (input: string, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function mount(element: ReactElement, handler: FetchHandler, navigations: string[] = []) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.example.com/start" });
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
  await act(async () => { root.render(element); });
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
  return {
    container, calls, navigations, window: dom.window,
    text() {
      return container.textContent ?? "";
    },
    value(selector: string) {
      return container.querySelector<HTMLInputElement>(selector)?.value ?? "<missing>";
    },
    async click(selector: string) {
      const target = container.querySelector<HTMLElement>(selector);
      assert.ok(target, `missing ${selector}`);
      await act(async () => { target.click(); });
    },
    // Replaces the box's whole value, as typing or pasting does, with the caret at `caret`.
    async type(selector: string, value: string, caret = value.length) {
      const input = container.querySelector<HTMLInputElement>(selector);
      assert.ok(input, `missing ${selector}`);
      // react-dom was imported before this JSDOM window existed, so it uses its fallback
      // text-input listener (focus plus key events) instead of "input" events.
      await act(async () => {
        input.focus();
        setter?.call(input, value);
        input.setSelectionRange(caret, caret);
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

function renderLogin(options: { codeSignIn: boolean; authState?: "available" | "denied" | "unavailable" }) {
  return renderToStaticMarkup(
    createElement(PublicAuthPage, {
      mode: "login",
      authState: options.authState ?? "available",
      googleAction: createElement("button", null, "Continue with Google"),
      deniedAction: createElement("button", null, "Sign out"),
      codeSignIn: options.codeSignIn ? createElement(CompanionSignInForm, { callbackUrl: CONTROL }) : undefined
    })
  );
}

// --- Where the code form appears ---------------------------------------------------------

test("the login page leads with the code only on the way to a run's control page", () => {
  assert.equal(companionCallbackForLogin(CONTROL), CONTROL);
  assert.equal(companionCallbackForLogin("/dashboard"), null);
  assert.equal(companionCallbackForLogin(`${CONTROL}?x=1`), null);
  assert.equal(companionCallbackForLogin(`//evil.example${CONTROL}`), null);
  assert.equal(companionCallbackForLogin([CONTROL]), null);
  assert.equal(companionCallbackForLogin(undefined), null);

  const loginSource = readFileSync(path.join(process.cwd(), "app/(public)/login/page.tsx"), "utf8");
  assert.match(loginSource, /companionCallbackForLogin\(params\.callbackUrl\)/);
  assert.match(loginSource, /codeSignIn=/);
});

test("on the way to a control page, the code form comes first and Google is a secondary choice", () => {
  const html = renderLogin({ codeSignIn: true });

  assert.equal(html.includes("Sign in this window with a code"), true);
  assert.equal(
    html.includes("Get a one-time code from this job&#x27;s application page in your usual browser, where you&#x27;re signed in to Apply Pilot."),
    true
  );
  const heading = html.indexOf("Sign in this window with a code");
  const codeBox = html.indexOf('name="code"');
  const signIn = html.indexOf(">Sign in</button>");
  const google = html.indexOf("Continue with Google");
  assert.equal(heading >= 0 && codeBox > heading && signIn > codeBox && google > signIn, true);
  // Nothing about the usual returning-user page sits above the code form.
  assert.equal(html.includes("Welcome back."), false);
  assert.equal(html.includes("Sign in to Apply Pilot."), false);

  // Google sits inside a closed disclosure, with the reason it fails in the Apply Pilot browser.
  const disclosure = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(disclosure);
  assert.equal(/<details[^>]*\bopen\b/.test(html), false);
  assert.equal(/<summary[^>]*>Not in the Apply Pilot browser\? Sign in with Google<\/summary>/.test(disclosure[1]), true);
  assert.equal(
    disclosure[1].includes("Google blocks automated browsers, so it won&#x27;t work in the Apply Pilot browser window."),
    true
  );
  assert.equal(disclosure[1].includes("Continue with Google"), true);
});

test("the code form still comes first when Google is unavailable or the account is refused", () => {
  const unavailable = renderLogin({ codeSignIn: true, authState: "unavailable" });
  assert.equal(unavailable.indexOf('name="code"') >= 0, true);
  assert.equal(unavailable.includes("Continue with Google"), false);
  assert.equal(unavailable.indexOf("Google sign-in is temporarily unavailable.") > unavailable.indexOf('name="code"'), true);

  const denied = renderLogin({ codeSignIn: true, authState: "denied" });
  assert.equal(denied.indexOf('name="code"') >= 0, true);
  assert.equal(denied.includes("Access not available."), true);
});

test("the login page without a control-page destination is unchanged", () => {
  const html = renderLogin({ codeSignIn: false });
  assert.equal(html.includes("Welcome back."), true);
  assert.equal(html.includes("Sign in to Apply Pilot."), true);
  assert.equal(html.includes("Continue with Google"), true);
  assert.equal(html.includes("Sign in this window with a code"), false);
  assert.equal(html.includes('name="code"'), false);
  assert.equal(html.includes("<details"), false);
  assert.equal(html.includes("Not in the Apply Pilot browser?"), false);
});

test("the old code-only page sends people to the login page, which now leads with the code", () => {
  assert.equal(companionLoginPath(CONTROL), `/login?callbackUrl=${encodeURIComponent(CONTROL)}`);
  assert.equal(companionLoginPath("/dashboard"), "/login");
  assert.equal(companionLoginPath(undefined), "/login");

  const pageSource = readFileSync(path.join(process.cwd(), "app/(public)/companion-sign-in/page.tsx"), "utf8");
  assert.match(pageSource, /redirect\(companionLoginPath\(params\.callbackUrl\)\)/);
  // The login page never links back to it, so there is no redirect loop.
  const loginSource = readFileSync(path.join(process.cwd(), "app/(public)/login/page.tsx"), "utf8");
  assert.equal(/["'`]\/companion-sign-in/.test(loginSource), false);
  assert.equal(loginSource.includes("companionLoginPath"), false);
});

// --- The code box -------------------------------------------------------------------------

test("code formatting uppercases, groups in fours and flags characters codes never use", () => {
  assert.equal(formatCompanionCodeInput(""), "");
  assert.equal(formatCompanionCodeInput("abcd"), "ABCD");
  assert.equal(formatCompanionCodeInput("abcde"), "ABCD-E");
  assert.equal(formatCompanionCodeInput("ABCD-"), "ABCD");
  assert.equal(formatCompanionCodeInput("abcdefghjkmn"), "ABCD-EFGH-JKMN");
  assert.equal(formatCompanionCodeInput(" abcd efgh-jkmn "), "ABCD-EFGH-JKMN");
  assert.equal(formatCompanionCodeInput("ABCD-EFGH-JKMN-PQRS"), "ABCD-EFGH-JKMN");
  for (const character of ["O", "o", "I", "i", "0", "1", "%", "_"]) {
    assert.equal(hasImpossibleCompanionCodeCharacter(formatCompanionCodeInput(`AB${character}`)), true, character);
  }
  assert.equal(hasImpossibleCompanionCodeCharacter("ABCD-EFGH-JKLM"), false);
  assert.equal(hasImpossibleCompanionCodeCharacter("2345-6789"), false);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(hasImpossibleCompanionCodeCharacter(generateCompanionSignInCode()), false);
  }
});

test("the code box formats as you type", async () => {
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL }), async () => json({}));
  try {
    await ui.type("input[name='code']", "abcd");
    assert.equal(ui.value("input[name='code']"), "ABCD");
    await ui.type("input[name='code']", "ABCDe");
    assert.equal(ui.value("input[name='code']"), "ABCD-E");
    await ui.type("input[name='code']", "ABCD-Efghjkmn");
    assert.equal(ui.value("input[name='code']"), "ABCD-EFGH-JKMN");
    assert.equal(ui.text().includes(HINT), false);
  } finally { await ui.cleanup(); }
});

test("fixing a character in the middle keeps the caret where you are typing", async () => {
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL }), async () => json({}));
  try {
    await ui.type("input[name='code']", "ABCD-EFGH-JKMN");
    // Delete the F: the groups shift, and the caret stays after the E.
    await ui.type("input[name='code']", "ABCD-EGH-JKMN", 6);
    assert.equal(ui.value("input[name='code']"), "ABCD-EGHJ-KMN");
    assert.equal(ui.container.querySelector<HTMLInputElement>("input[name='code']")?.selectionStart, 6);
  } finally { await ui.cleanup(); }
});

test("typing a character codes never use shows the hint at once", async () => {
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL }), async () => json({}));
  try {
    assert.equal(ui.text().includes(HINT), false);
    for (const character of ["O", "I", "0", "1", "o", "%"]) {
      await ui.type("input[name='code']", `ABC${character}`);
      assert.equal(ui.text().includes(HINT), true, `hint for ${character}`);
      assert.equal(ui.container.querySelector("input[name='code']")?.getAttribute("aria-invalid"), "true");
      await ui.type("input[name='code']", "ABCD");
      assert.equal(ui.text().includes(HINT), false, `hint cleared after ${character}`);
    }
    assert.equal(ui.calls.length, 0);
  } finally { await ui.cleanup(); }
});

test("entering a code posts it with the control page and goes there when accepted", async () => {
  const navigations: string[] = [];
  const navigate = (url: string) => { navigations.push(url); };
  const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL, navigate }), async (input, init) => {
    assert.equal(input, "/api/companion-sign-in");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { code: "ABCD-EFGH-JKMN", callbackUrl: CONTROL });
    return json({ redirectTo: CONTROL });
  }, navigations);
  try {
    await ui.type("input[name='code']", "abcd-efgh-jkmn");
    assert.equal(ui.container.querySelector("button[type='submit']")?.textContent, "Sign in");
    await ui.click("button[type='submit']");
    assert.deepEqual(ui.navigations, [CONTROL]);
  } finally { await ui.cleanup(); }
});

test("a pasted code with spaces, dashes or lowercase still signs in", async () => {
  for (const pasted of [" abcd efgh jkmn ", "abcd-efgh-jkmn", "AbCdEfGhJkMn", "ABCD - EFGH - JKMN"]) {
    const navigations: string[] = [];
    const posted: string[] = [];
    const navigate = (url: string) => { navigations.push(url); };
    const ui = await mount(createElement(CompanionSignInForm, { callbackUrl: CONTROL, navigate }), async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)).code);
      return json({ redirectTo: CONTROL });
    }, navigations);
    try {
      await ui.type("input[name='code']", pasted);
      assert.equal(ui.value("input[name='code']"), "ABCD-EFGH-JKMN", pasted);
      assert.equal(ui.text().includes(HINT), false, pasted);
      await ui.click("button[type='submit']");
      assert.equal(posted.length, 1, pasted);
      assert.equal(normalizeCompanionSignInCode(posted[0]), "ABCDEFGHJKMN", pasted);
      assert.deepEqual(ui.navigations, [CONTROL], pasted);
    } finally { await ui.cleanup(); }
  }
});

// --- When a code is refused -----------------------------------------------------------------

test("a refused code stays on the page and lists the usual causes", async () => {
  const navigations: string[] = [];
  const navigate = (url: string) => { navigations.push(url); };
  const ui = await mount(
    createElement(CompanionSignInForm, { callbackUrl: CONTROL, navigate }),
    async () => json({ error: "That code didn't work.", code: "COMPANION_SIGN_IN_FAILED" }, 400),
    navigations
  );
  try {
    await ui.type("input[name='code']", "ABCD-EFGH-JKMN");
    await ui.click("button[type='submit']");
    assert.deepEqual(ui.navigations, []);
    const text = ui.text();
    assert.equal(text.includes("That code didn't work."), true);
    assert.equal(text.includes("mistyped"), true);
    assert.equal(text.includes("older than 5 minutes"), true);
    assert.equal(text.includes("replaced by a newer code"), true);
    assert.equal(text.includes("Getting a new code cancels the old one."), true);
    assert.equal(text.includes("already used"), true);
    assert.equal(text.includes("Get a new code from this job's application page in your usual browser"), true);
  } finally { await ui.cleanup(); }
});

test("too many tries and a lost connection say so instead of blaming the code", async () => {
  const limited = await mount(
    createElement(CompanionSignInForm, { callbackUrl: CONTROL }),
    async () => json({ error: "Rate limit exceeded. Try again shortly." }, 429)
  );
  try {
    await limited.type("input[name='code']", "ABCD-EFGH-JKMN");
    await limited.click("button[type='submit']");
    assert.equal(limited.text().includes("Too many tries"), true);
    assert.equal(limited.text().includes("mistyped"), false);
  } finally { await limited.cleanup(); }

  const offline = await mount(
    createElement(CompanionSignInForm, { callbackUrl: CONTROL }),
    async () => { throw new TypeError("network down"); }
  );
  try {
    await offline.type("input[name='code']", "ABCD-EFGH-JKMN");
    await offline.click("button[type='submit']");
    assert.equal(offline.text().includes("couldn't check the code"), true);
    assert.equal(offline.text().includes("mistyped"), false);
  } finally { await offline.cleanup(); }
});

// --- Getting a code in your usual browser ---------------------------------------------------

test("getting a code shows it once with how and where to use it, and requests nothing on render", async () => {
  const ui = await mount(createElement(CompanionSignInCode, { runId: RUN }), async (input, init) => {
    assert.equal(input, `/api/application-runs/${RUN}/companion-sign-in-code`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    return json({ code: "ABCD-EFGH-JKMN", expiresAt: "2026-11-10T12:05:00.000Z" });
  });
  try {
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.container.querySelector("[data-testid='companion-code']") === null, true);
    assert.equal(ui.text().includes("Getting a new code cancels the previous one."), true);
    await ui.click("[data-testid='companion-code-button']");
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.container.querySelector("[data-testid='companion-code']")?.textContent, "ABCD-EFGH-JKMN");
    const text = ui.text();
    assert.equal(text.includes("the Apply Pilot browser window (it shows as ‘Google Chrome for Testing’)"), true);
    assert.equal(text.includes("Getting a new code cancels the previous one."), true);
    assert.equal(ui.container.querySelector("[data-testid='companion-code-button']")?.textContent, "Get a new code");
    assert.match(text, /once/);
    assert.match(text, /5 minutes/);
    assert.match(text, /this browser run/);
    assert.equal(/companion/i.test(text), false);
  } finally { await ui.cleanup(); }
});

test("a refused code request explains itself and shows no code", async () => {
  const ui = await mount(createElement(CompanionSignInCode, { runId: RUN }), async () => json({ error: "Browser run not found." }, 404));
  try {
    await ui.click("[data-testid='companion-code-button']");
    assert.equal(ui.container.querySelector("[data-testid='companion-code']") === null, true);
    assert.match(ui.text(), /couldn't get a code/i);
  } finally { await ui.cleanup(); }
});
