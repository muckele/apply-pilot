import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";

import { chromium, type Browser } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MasterResumeDetail } from "@/components/master-resume-detail";
import type { MasterResumeDetailDto } from "@/lib/resumes/master-resume-detail";

const LONG_TOKEN = "source-backed-".repeat(80);

const resume: MasterResumeDetailDto = {
  id: "synthetic-master",
  title: `Synthetic ${LONG_TOKEN}`,
  parsedAt: new Date("2026-10-05T00:00:00.000Z"),
  rawText: "Synthetic Owner\nSynthetic role",
  summary: "Synthetic read-only browser fixture.",
  skills: [LONG_TOKEN],
  achievements: ["Preserved verified facts."],
  workHistory: [{
    company: "Synthetic Company",
    title: "Solutions Engineer",
    bullets: ["Built a source-backed workflow."]
  }],
  projects: [{ name: "Synthetic Project", description: LONG_TOKEN }],
  education: [{ institution: "Synthetic University", credential: "Bachelor of Arts" }],
  certifications: [{ name: "Synthetic Certificate", issuer: "Synthetic Issuer" }]
};

const detail = renderToStaticMarkup(createElement(MasterResumeDetail, { resume }));
const documentHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{box-sizing:border-box}.min-w-0{min-width:0}.break-words{overflow-wrap:break-word}.grid{display:grid}.flex{display:flex}.flex-wrap{flex-wrap:wrap}.inline-flex{display:inline-flex}body{margin:0;padding:16px}</style>
  </head><body>${detail}</body></html>`;

let browser: Browser;
let server: Server;
let origin: string;
let delayedRequestSeen: Promise<void>;
let markDelayedRequestSeen: (() => void) | undefined;
let resumeRequests = 0;

before(async () => {
  delayedRequestSeen = new Promise((resolve) => { markDelayedRequestSeen = resolve; });
  server = createServer((request, response) => {
    if (request.url === "/away") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Away</title><h1>Different page</h1>");
      return;
    }

    if (request.url?.startsWith("/resumes")) {
      resumeRequests += 1;
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(documentHtml);
      };
      if (request.url.includes("delay=1")) {
        markDelayedRequestSeen?.();
        setTimeout(send, 250);
      } else {
        send();
      }
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("read-only master detail survives interrupted, repeated, and responsive browser navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const interrupted = page.goto(`${origin}/resumes?delay=1`, { waitUntil: "domcontentloaded" }).catch((error: unknown) => error);
  await delayedRequestSeen;
  await page.goto(`${origin}/away`, { waitUntil: "domcontentloaded" });
  assert.ok(await interrupted instanceof Error);
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Different page");

  await page.goto(`${origin}/resumes`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByRole("heading", { name: "Master resume profile" }).count(), 1);
  assert.equal(await page.getByText("Synthetic Project", { exact: true }).count(), 1);
  assert.equal(await page.locator("form, input, textarea, select, button").count(), 0);
  assert.equal(await page.locator("script").count(), 0);

  for (const viewport of [{ width: 320, height: 568 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }));
    assert.ok(widths.scroll <= widths.client, `${viewport.width}px overflowed: ${JSON.stringify(widths)}`);
  }

  assert.equal(resumeRequests, 3);
  await page.close();
});
