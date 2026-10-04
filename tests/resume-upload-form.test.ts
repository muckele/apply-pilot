import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ResumeUploadForm } from "@/components/resume-upload-form";

test("the Resumes page delegates parsing to a client workflow instead of a native mutating form", () => {
  const page = readFileSync(new URL("../app/(product)/resumes/page.tsx", import.meta.url), "utf8");
  assert.match(page, /ResumeUploadForm/);
  assert.doesNotMatch(page, /action="\/api\/resumes\/parse"/);
});

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function submissionId(call: { init?: RequestInit }) {
  assert.ok(call.init?.body instanceof FormData);
  const value = call.init.body.get("submissionId");
  assert.ok(typeof value === "string");
  assert.match(value, /^[0-9a-f-]{36}$/i);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mountForm(handler: FetchHandler, confirm: (message: string) => boolean = () => true) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.test/resumes"
  });
  dom.window.confirm = confirm;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, FormData: dom.window.FormData,
    File: dom.window.File, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return handler(input, init);
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  let refreshes = 0;
  const router = { back() {}, forward() {}, push() {}, replace() {}, prefetch() {}, refresh() { refreshes += 1; } };
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AppRouterContext.Provider, { value: router as never }, createElement(ResumeUploadForm)));
  });
  const title = container.querySelector<HTMLInputElement>("[name='title']");
  const pastedText = container.querySelector<HTMLTextAreaElement>("[name='pastedText']");
  assert.ok(title && pastedText);
  title.value = "Jordan Master Resume";
  pastedText.value = "Synthetic resume source";
  return {
    dom,
    container,
    fetchCalls,
    get refreshes() { return refreshes; },
    submit() {
      const form = container.querySelector("form");
      assert.ok(form);
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  };
}

test("resume upload confirms recipient and cost, then presents validated save plus warnings", async () => {
  let confirmation = "";
  let calls = 0;
  const mounted = await mountForm(async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({
          code: "AI_COST_CONFIRMATION_REQUIRED",
          maximumCostMicros: 38_250,
          provider: "gemini",
          dataType: "resume_text"
        }), { status: 428, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({
          resume: { id: "resume-1", title: "Jordan Master Resume", isMaster: true },
          parsed: { warnings: ["Education date is ambiguous in the source."] },
          replayed: false
        }), { status: 200, headers: { "content-type": "application/json" } });
  }, (message) => { confirmation = message; return true; });
  try {
    await act(async () => { mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 2);
    assert.equal(submissionId(mounted.fetchCalls[0]!), submissionId(mounted.fetchCalls[1]!));
    assert.match(confirmation, /complete resume text.*Google Gemini/i);
    assert.equal(new Headers(mounted.fetchCalls[1]?.init?.headers).get("x-ai-data-confirmed"), "true");
    assert.match(mounted.container.textContent ?? "", /Master resume saved/i);
    assert.match(mounted.container.textContent ?? "", /Education date is ambiguous/i);
    assert.equal(mounted.refreshes, 1);
  } finally { await mounted.cleanup(); }
});

test("double activation dispatches one parse while the request is pending", async () => {
  const pending = deferred<Response>();
  const mounted = await mountForm(async () => pending.promise);
  try {
    await act(async () => { mounted.submit(); mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 1);
    const button = mounted.container.querySelector<HTMLButtonElement>("button[type='submit']");
    assert.equal(button?.disabled, true);
    await act(async () => {
      pending.resolve(new Response(JSON.stringify({
        resume: { id: "resume-1", title: "Jordan Master Resume", isMaster: true },
        parsed: { warnings: [] }, replayed: false
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await pending.promise;
    });
  } finally { await mounted.cleanup(); }
});

test("an uncertain response is never retried automatically and directs the user to verify the master", async () => {
  const mounted = await mountForm(async () => { throw new TypeError("connection dropped"); });
  try {
    await act(async () => { mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 1);
    assert.match(mounted.container.textContent ?? "", /status could not be confirmed/i);
    assert.match(mounted.container.textContent ?? "", /check the Master resume profile before retrying/i);
    assert.equal(mounted.container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled, false);
  } finally { await mounted.cleanup(); }
});

test("an uncertain manual retry reuses its attempt id and a confirmed save rotates it", async () => {
  let calls = 0;
  const success = () => new Response(JSON.stringify({
    resume: { id: "resume-1", title: "Jordan Master Resume", isMaster: true },
    parsed: { warnings: [] },
    replayed: calls > 2
  }), { status: 200, headers: { "content-type": "application/json" } });
  const mounted = await mountForm(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("connection dropped after dispatch");
    return success();
  });
  try {
    await act(async () => { mounted.submit(); });
    await act(async () => { mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 2);
    const uncertainId = submissionId(mounted.fetchCalls[0]!);
    assert.equal(submissionId(mounted.fetchCalls[1]!), uncertainId);

    await act(async () => { mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 3);
    assert.notEqual(submissionId(mounted.fetchCalls[2]!), uncertainId);
  } finally { await mounted.cleanup(); }
});

test("invalid or incomplete parsing keeps the server reason visible and gives no automatic retry", async () => {
  const mounted = await mountForm(async () => new Response(JSON.stringify({
    error: "Resume parsing is incomplete for work history. No master resume was changed.",
    code: "RESUME_PARSE_INCOMPLETE",
    section: "workHistory",
    retryable: false
  }), { status: 422, headers: { "content-type": "application/json" } }));
  try {
    await act(async () => { mounted.submit(); });
    assert.equal(mounted.fetchCalls.length, 1);
    assert.match(mounted.container.textContent ?? "", /incomplete for work history/i);
    assert.match(mounted.container.textContent ?? "", /Review the source or parser issue before retrying/i);
    assert.equal(mounted.refreshes, 0);
  } finally { await mounted.cleanup(); }
});

test("resume validation failure renders only bounded field, billing, and cost diagnostics", async () => {
  const privateProviderOutput = "PRIVATE_PROVIDER_OUTPUT_MUST_NOT_RENDER";
  const mounted = await mountForm(async () => new Response(JSON.stringify({
    error: "Resume parsing rejected one unsupported typed fact. No master resume was changed.",
    code: "RESUME_PARSE_UNSUPPORTED_FACT",
    section: "education",
    fieldPath: "education[1].fieldOfStudy",
    billingStatus: "known",
    actualCostMicros: 12_345,
    providerOutput: privateProviderOutput,
    retryable: false
  }), { status: 422, headers: { "content-type": "application/json" } }));
  try {
    await act(async () => { mounted.submit(); });
    const text = mounted.container.textContent ?? "";
    assert.match(text, /RESUME_PARSE_UNSUPPORTED_FACT/u);
    assert.match(text, /education\[1\]\.fieldOfStudy/u);
    assert.match(text, /Billing status: known/u);
    assert.match(text, /Recorded provider cost: \$0\.012345/u);
    assert.equal(text.includes(privateProviderOutput), false);
  } finally { await mounted.cleanup(); }
});
