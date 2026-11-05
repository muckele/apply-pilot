import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { JobDocumentWorkspace, type JobResumeVersionOption } from "@/components/job-document-workspace";
import { readTailoredResumeLeftOut } from "@/lib/ai/tailored-resume-keep-rule";

const projectText = "Regional Demo Library | Sales enablement | 2023\n• Recorded twelve product demo videos for new hires.";

function version(leftOut: JobResumeVersionOption["leftOut"]): JobResumeVersionOption {
  return {
    id: "version-1",
    title: "Example Buyer Co - Account Executive tailored resume",
    fullText: "Jordan Sample\n\nSKILLS\nSalesforce",
    summary: null,
    atsCompatibility: null,
    jobFitScore: null,
    evidenceCurrent: true,
    createdAt: "2026-11-05T00:00:00.000Z",
    leftOut
  };
}

async function mounted(option: JobResumeVersionOption, run: (h: { container: HTMLElement; copied: string[] }) => Promise<void>) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "http://localhost/jobs/job-1" });
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } }
  });
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
    fetch: async () => { throw new Error("no network in this test"); }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const noop = () => {};
  const router = { bfcacheId: "left-out", back: noop, forward: noop, push: noop, replace: noop, prefetch: noop, refresh: noop };
  try {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router },
        createElement(JobDocumentWorkspace, { resumeVersions: [option], coverLetters: [] })));
    });
    await run({ container, copied });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

test("the tailored résumé view lists what was left out, each with a Copy button", async () => mounted(version([
  { ref: "resume.skills[13]", kind: "skill", context: null, text: "Woodworking" },
  { ref: "resume.workHistory[0]", kind: "bullet", context: "Northwind Software | Account Executive | 2021–Present", text: "Coordinated renewals with customer success." },
  { ref: "resume.projects[0]", kind: "record", context: null, text: projectText }
]), async ({ container, copied }) => {
  const section = container.querySelector("[data-left-out]");
  assert.ok(section);
  assert.match(section.textContent ?? "", /Left out of this version/u);
  const items = Array.from(section.querySelectorAll("li"));
  assert.equal(items.length, 3);
  assert.match(items[1]!.textContent ?? "", /Northwind Software/u);
  const copyButtons = Array.from(section.querySelectorAll("button")).filter((button) => button.textContent === "Copy");
  assert.equal(copyButtons.length, 3);
  await act(async () => copyButtons[2]!.click());
  assert.deepEqual(copied, [projectText]);
  assert.match(items[2]!.textContent ?? "", /Copied/u);
}));

test("a version with nothing left out shows no left-out list", async () => mounted(version([]), async ({ container }) => {
  assert.equal(container.querySelector("[data-left-out]"), null);
}));

test("stored left-out metadata is read defensively", () => {
  assert.deepEqual(readTailoredResumeLeftOut(null), []);
  assert.deepEqual(readTailoredResumeLeftOut({ claimEvidence: [] }), []);
  assert.deepEqual(readTailoredResumeLeftOut({ leftOut: [
    { ref: "resume.skills[0]", kind: "skill", context: null, text: "Gong" },
    { ref: "resume.skills[1]", kind: "skill", text: 7 },
    "junk"
  ] }), [{ ref: "resume.skills[0]", kind: "skill", context: null, text: "Gong" }]);
});
