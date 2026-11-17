import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { JobSourcesSettings } from "@/components/job-sources-settings";

// Settings → Job sources in the browser: the result of a Sync stays on screen.

type Request = { url: string; method: string };

const followedBoard = {
  id: "source-followed",
  name: "Synthetic Co",
  type: "ASHBY",
  baseUrl: null,
  boardToken: "synthetic",
  allowlisted: true,
  robotsChecked: true,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  syncEnabled: true,
  notes: null,
  _count: { jobPostings: 1 }
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Mounts the list the way app/(product)/settings/job-sources/page.tsx does: keyed on every
 * source's updatedAt, so a router refresh after a run that wrote the source row (a sync always
 * records lastSyncedAt) remounts it.
 */
async function mounted(respond: (request: Request) => Response, run: (container: HTMLElement, requests: Request[]) => Promise<void>) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "http://localhost/settings/job-sources" });
  const requests: Request[] = [];
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
    fetch: async (url: string, init: RequestInit = {}) => {
      const request = { url, method: init.method ?? "GET" };
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
  let serverVersion = 0;
  const noop = () => {};
  const render = () =>
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(JobSourcesSettings, { key: `source-followed:${serverVersion}`, initialSources: [followedBoard] })
      )
    );
  const router = {
    bfcacheId: "job-sources",
    back: noop,
    forward: noop,
    push: noop,
    replace: noop,
    prefetch: noop,
    refresh: () => {
      serverVersion += 1;
      render();
    }
  };
  try {
    await act(async () => { render(); });
    await run(container, requests);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.equal(Boolean(found), true, `missing ${label} button`);
  return found!;
}

function statusText(container: HTMLElement) {
  return container.querySelector("[role='status']")?.textContent ?? "";
}

const syncResponse = {
  imported: 1,
  skipped: 8,
  refreshedOutsideFilter: 1,
  bestRelevanceScore: 76,
  jobs: [],
  scoring: { eligible: 0, attempted: 0, cached: 0, scored: 0, failed: 0, stopReason: "DISABLED_BY_POLICY" }
};

function respond(request: Request) {
  if (request.url === "/api/job-sources/source-followed/sync" && request.method === "POST") {
    return json(syncResponse);
  }
  if (request.url === "/api/job-sources" && request.method === "GET") {
    return json({ sources: [{ ...followedBoard, lastSyncedAt: "2026-11-12T18:00:00.000Z", lastSyncStatus: "SUCCESS" }] });
  }
  throw new Error(`Unexpected request in test: ${request.method} ${request.url}`);
}

test("the Sync result stays on screen after the source list reloads", async () => {
  await mounted(respond, async (container, requests) => {
    await act(async () => { button(container, "Sync").click(); });

    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "POST /api/job-sources/source-followed/sync",
      "GET /api/job-sources"
    ]);
    const message = statusText(container);
    assert.match(message, /Sync complete: 1 imported or updated, 8 filtered\./);
    assert.match(message, /1 job you already had no longer passes your filters; it was refreshed and kept\./);
    assert.match(container.textContent ?? "", /SUCCESS/, "the reloaded row is shown");
  });
});
