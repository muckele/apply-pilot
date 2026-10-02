import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ManualJobImportForm } from "@/components/manual-job-import-form";

const job = { id: "job-1", company: "Example Co", title: "Solutions Engineer", overallFitScore: null };
const application = { id: "application-1" };

async function renderSubmission(status: number, body: unknown) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.test/jobs/import"
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ManualJobImportForm)); });
    for (const [name, value] of Object.entries({
      title: "Solutions Engineer", company: "Example Co", sourceUrl: "https://example.test/jobs/123",
      description: "A synthetic role requiring customer discovery and SQL experience."
    })) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`);
      assert.ok(input);
      input.value = value;
    }
    const form = container.querySelector("form");
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    return { text: container.textContent ?? "", link: container.querySelector<HTMLAnchorElement>("a[href='/jobs/job-1']")?.href };
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

test("manual import form distinguishes scored, unavailable, failed and full import failure", async () => {
  const scored = await renderSubmission(200, {
    job, application, match: { match: { overallFitScore: 87 } }, scoring: { status: "scored" }
  });
  assert.match(scored.text, /Imported Example Co · Solutions Engineer\. Fit score: 87/);
  assert.equal(scored.link, "https://app.example.test/jobs/job-1");

  const unavailable = await renderSubmission(200, {
    job, application, match: null, scoring: { status: "unavailable" }
  });
  assert.match(unavailable.text, /Imported Example Co · Solutions Engineer/);
  assert.match(unavailable.text, /Match scoring is currently unavailable; you can score this job later/);
  assert.doesNotMatch(unavailable.text, /Import failed|re-import|Fit score: pending/);
  assert.equal(unavailable.link, "https://app.example.test/jobs/job-1");

  const failed = await renderSubmission(200, {
    job, application, match: null, scoring: { status: "failed" }
  });
  assert.match(failed.text, /Job imported successfully, but match scoring failed/);
  assert.match(failed.text, /Open the job to retry scoring/);
  assert.doesNotMatch(failed.text, /Import failed|re-import/);
  assert.equal(failed.link, "https://app.example.test/jobs/job-1");

  const invalid = await renderSubmission(422, { error: "Invalid request" });
  assert.match(invalid.text, /Import failed: Invalid request/);
  assert.equal(invalid.link, undefined);
});

test("manual import form can submit evidence-complete job data without requesting a score", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.test/jobs/import"
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  let requestBody: Record<string, unknown> | null = null;
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        job, application, match: null, scoring: { status: "not_requested" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ManualJobImportForm)); });
    for (const [name, value] of Object.entries({
      title: "Solutions Engineer",
      company: "Example Co",
      location: "United States",
      sourceUrl: "https://example.test/jobs/123",
      applyUrl: "https://example.test/jobs/123/apply",
      description: "A synthetic role requiring customer discovery and SQL experience.",
      salaryMin: "0",
      salaryMax: "120000",
      datePosted: "2026-07-08",
      requirements: "Four years of client-facing experience\nSQL experience",
      preferredQualifications: "Early-stage company experience"
    })) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`);
      assert.ok(input, `expected ${name} input`);
      input.value = value;
    }
    const importOnly = container.querySelector<HTMLButtonElement>("button[value='false']");
    assert.ok(importOnly, "expected an explicit import-only action");
    await act(async () => { importOnly.click(); });

    assert.deepEqual(requestBody, {
      title: "Solutions Engineer",
      company: "Example Co",
      location: "United States",
      remoteStatus: "Remote",
      salaryMin: 0,
      salaryMax: 120000,
      datePosted: "2026-07-08",
      sourceUrl: "https://example.test/jobs/123",
      applyUrl: "https://example.test/jobs/123/apply",
      description: "A synthetic role requiring customer discovery and SQL experience.",
      requirements: ["Four years of client-facing experience", "SQL experience"],
      preferredQualifications: ["Early-stage company experience"],
      runMatch: false
    });
    assert.match(container.textContent ?? "", /Match scoring was not requested/);

    const importAndScore = container.querySelector<HTMLButtonElement>("button[value='true']");
    assert.ok(importAndScore, "expected an explicit import-and-score action");
    await act(async () => { importAndScore.click(); });
    assert.equal((requestBody as Record<string, unknown> | null)?.runMatch, true);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

test("import-only bypasses the AI cost-confirmation prompt and retry path", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.test/jobs/import"
  });
  let confirmations = 0;
  let requests = 0;
  const requestHeaders: Headers[] = [];
  dom.window.confirm = () => {
    confirmations += 1;
    return true;
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      requestHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({
        error: "Confirm this AI request's maximum cost before continuing.",
        code: "AI_COST_CONFIRMATION_REQUIRED",
        maximumCostMicros: 72_720
      }), { status: 428, headers: { "content-type": "application/json" } });
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ManualJobImportForm)); });
    for (const [name, value] of Object.entries({
      title: "Solutions Engineer",
      company: "Example Co",
      sourceUrl: "https://example.test/jobs/123",
      description: "A synthetic role requiring customer discovery and SQL experience."
    })) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`);
      assert.ok(input);
      input.value = value;
    }
    const importOnly = container.querySelector<HTMLButtonElement>("button[value='false']");
    assert.ok(importOnly);
    await act(async () => { importOnly.click(); });

    assert.equal(requests, 1);
    assert.equal(confirmations, 0);
    assert.equal(requestHeaders[0]?.has("x-ai-cost-confirmed"), false);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
