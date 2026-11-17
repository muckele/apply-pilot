import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

// G-6 in a real browser: the Apply page's one-time Gemini notice, the one-click score and the large
// result window, built from the production components and served from a synthetic origin. The match
// API is mocked; nothing leaves the test. All data is synthetic.

const ORIGIN = "https://apply-pilot.test";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NOTICE_KEY = "apply-pilot:gemini-notice:v1:0123456789abcdef";
const MONEY = /¢|\$|\bcost\b|charged/u;

// ScoreJobButton reads next/navigation's router; outside Next a stub records refreshes.
const nextNavigationStub: Plugin = {
  name: "next-navigation-stub",
  setup(builder) {
    // esbuild filters are Go regular expressions, which reject JavaScript's "u" flag.
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-navigation", namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export function useRouter() {
        return { refresh() { window.__refreshes = (window.__refreshes || 0) + 1; }, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
      }`,
      loader: "js"
    }));
  }
};

let browser: Browser;
let bundle: string;
let styles: string;

before(async () => {
  const result = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    define: { "process.env": JSON.stringify({ NODE_ENV: "test" }), "process.env.NODE_ENV": JSON.stringify("test") },
    format: "iife",
    logLevel: "silent",
    platform: "browser",
    plugins: [nextNavigationStub],
    target: "chrome123",
    tsconfig: "tsconfig.json",
    write: false,
    jsx: "automatic",
    stdin: {
      loader: "tsx",
      resolveDir: REPOSITORY_ROOT,
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
        import { ResultWindow } from "@/components/apply-page/result-window";
        import { useGeminiNotice } from "@/components/apply-page/use-gemini-notice";
        import { resultWindowView } from "@/lib/apply-page/result-window";

        const item = (requirement, status) => ({ requirement, jobRef: null, status, claim: null, resumeLines: [], tenure: null });
        const checklist = {
          items: [item("Service delivery", "shown"), item("SQL", "shown"), item("Quenby certification", "not_shown"), item("Spanish", "not_shown")],
          counts: { shown: 2, notShown: 2, notAssessed: 0, total: 4 }
        };
        const score = Number(new URLSearchParams(location.search).get("score") ?? "91");

        function Harness() {
          const notice = useGeminiNotice("0123456789abcdef");
          const [open, setOpen] = useState(false);
          const view = resultWindowView({ score, checklist });
          const record = (name) => () => { window.__actions = [...(window.__actions || []), name]; };
          return (
            <div className="product-shell">
              <main className="product-page-themed apply-page">
                <section className="job-card" id="step-1">
                  <ScoreJobButton jobId="job-1" label="Check my match" beforeRun={notice.ensure} onScored={() => setOpen(true)} />
                </section>
                {open && view ? (
                  <ResultWindow
                    view={view}
                    onCreate={record("create")}
                    onClose={() => setOpen(false)}
                    onAddExperience={() => { record("add")(); setOpen(false); }}
                    onApplyOnMyOwn={() => { record("own")(); setOpen(false); }}
                  />
                ) : null}
                {notice.window}
              </main>
            </div>
          );
        }

        createRoot(document.getElementById("root")).render(<Harness />);
      `
    }
  });
  bundle = result.outputFiles[0].text;
  styles = await readFile(new URL("../../app/(product)/product.css", import.meta.url), "utf8");
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

type MatchRequest = { costConfirmed: string | null; dataConfirmed: string | null };

async function openHarness(options: { score?: number; viewport?: { width: number; height: number }; noticeSeen?: boolean } = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 } });
  const page = await context.newPage();
  const matchRequests: MatchRequest[] = [];
  const outside: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      outside.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/product.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`
      });
    }
    if (url.pathname === "/product.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/api/jobs/job-1/match") {
      const headers = route.request().headers();
      matchRequests.push({ costConfirmed: headers["x-ai-cost-confirmed"] ?? null, dataConfirmed: headers["x-ai-data-confirmed"] ?? null });
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  if (options.noticeSeen) {
    await context.addInitScript(([key]) => { window.localStorage.setItem(key, "seen"); }, [NOTICE_KEY]);
  }
  await page.goto(`${ORIGIN}/?score=${options.score ?? 91}`);
  await page.getByRole("button", { name: "Check my match" }).waitFor();
  return { page, context, matchRequests, outside };
}

// Set APPLY_WINDOW_SCREENSHOT_DIR to look at the windows.
async function screenshot(page: Page, name: string) {
  const directory = process.env.APPLY_WINDOW_SCREENSHOT_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}` });
}

async function isModal(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => element.matches(":modal"));
}

// Focus starts inside the window, on its heading: never on a button a stray Enter would press.
async function focusIsInside(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) =>
    element.contains(document.activeElement) && document.activeElement?.tagName === "H2");
}

test("the first paid click shows the Gemini notice once; Esc sends nothing; Continue scores in one click and opens the result window", async () => {
  const { page, context, matchRequests, outside } = await openHarness();
  try {
    assert.doesNotMatch(await page.locator("body").innerText(), MONEY, "no prices");

    await page.getByRole("button", { name: "Check my match" }).click();
    const notice = page.locator("dialog[data-gemini-notice]");
    await notice.waitFor();
    assert.equal(await isModal(page, "dialog[data-gemini-notice]"), true, "a real modal: the page behind is inert");
    assert.equal(await focusIsInside(page, "dialog[data-gemini-notice]"), true, "focus moves into the notice");
    assert.match(await notice.innerText(), /Google Gemini/u);
    await screenshot(page, "gemini-notice-desktop.png");
    assert.equal(matchRequests.length, 0, "nothing is sent before Continue");

    await page.keyboard.press("Escape");
    await notice.waitFor({ state: "detached" });
    await page.getByText("Nothing was sent.").waitFor();
    assert.equal(matchRequests.length, 0);
    assert.equal(await page.evaluate((key) => window.localStorage.getItem(key), NOTICE_KEY), null, "Esc isn't consent");

    await page.getByRole("button", { name: "Check my match" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    const result = page.locator("dialog[data-result-window]");
    await result.waitFor();
    assert.deepEqual(matchRequests, [{ costConfirmed: "true", dataConfirmed: "true" }], "one request, carrying the consent");
    assert.equal(await page.evaluate((key) => window.localStorage.getItem(key), NOTICE_KEY), "seen");
    assert.equal(await isModal(page, "dialog[data-result-window]"), true);
    assert.equal(await focusIsInside(page, "dialog[data-result-window]"), true, "focus moves into the result window");
    const text = await result.innerText();
    assert.match(text, /A · 91/u);
    assert.match(text, /Your résumé shows 2 of 4 must-haves\./u);
    assert.doesNotMatch(text, MONEY);
    assert.doesNotMatch(text, /credit/iu, "no credit line until credits exist");
    await screenshot(page, "result-window-a-desktop.png");

    await page.getByRole("button", { name: "Create my résumé and cover letter" }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __actions?: string[] }).__actions), ["create"]);
    await page.keyboard.press("Escape");
    await result.waitFor({ state: "detached" });

    // The notice never shows again for this account on this browser.
    await page.reload();
    await page.getByRole("button", { name: "Check my match" }).click();
    await result.waitFor();
    assert.equal(await page.locator("dialog[data-gemini-notice]").count(), 0);
    assert.equal(matchRequests.length, 2);
    assert.deepEqual(outside, [], "nothing leaves the synthetic origin");
  } finally {
    await context.close();
  }
});

test("a B lists what's missing with three ways on; a C or D goes to Jobs and keeps Apply on my own", async () => {
  {
    const { page, context } = await openHarness({ score: 76, noticeSeen: true });
    try {
      await page.getByRole("button", { name: "Check my match" }).click();
      const result = page.locator("dialog[data-result-window]");
      await result.waitFor();
      assert.match(await result.innerText(), /B · 76/u);
      assert.deepEqual(await result.locator("[data-missing] li").allInnerTexts(), ["Quenby certification", "Spanish"]);
      await screenshot(page, "result-window-b-desktop.png");
      assert.equal(await result.getByRole("link", { name: "Find better-fit jobs" }).getAttribute("href"), "/jobs");
      await result.getByRole("button", { name: "Add my experience first" }).click();
      await result.waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => (window as unknown as { __actions?: string[] }).__actions), ["add"]);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await openHarness({ score: 60, noticeSeen: true });
    try {
      await page.getByRole("button", { name: "Check my match" }).click();
      const result = page.locator("dialog[data-result-window]");
      await result.waitFor();
      const text = await result.innerText();
      assert.match(text, /C · 60/u);
      assert.match(text, /This may not be a good fit\. Let's look at other jobs\./u);
      await screenshot(page, "result-window-c-desktop.png");
      assert.equal(await result.getByRole("button", { name: "Create my résumé and cover letter" }).count(), 0, "nothing to create");
      assert.equal(await result.getByRole("link", { name: "Find other jobs" }).getAttribute("href"), "/jobs");
      await result.getByRole("button", { name: "Apply on my own" }).click();
      assert.deepEqual(await page.evaluate(() => (window as unknown as { __actions?: string[] }).__actions), ["own"]);
    } finally {
      await context.close();
    }
  }
});

test("on a phone the result window fills the screen, with no sideways scroll", async () => {
  const { page, context } = await openHarness({ viewport: { width: 390, height: 844 }, noticeSeen: true });
  try {
    await page.getByRole("button", { name: "Check my match" }).click();
    const result = page.locator("dialog[data-result-window]");
    await result.waitFor();
    const box = await result.boundingBox();
    assert.ok(box, "the window is laid out");
    assert.equal(Math.round(box.width), 390);
    assert.equal(Math.round(box.height), 844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await screenshot(page, "result-window-a-phone.png");
    const create = await result.getByRole("button", { name: "Create my résumé and cover letter" }).boundingBox();
    assert.ok(create && create.height >= 44, "a thumb-sized Create button");
  } finally {
    await context.close();
  }
});
