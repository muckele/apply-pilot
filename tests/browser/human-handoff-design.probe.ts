// Opt-in P0.2 design probes. All pages and values are synthetic; this is not a production handoff.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";

import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { createProtectedApplicationBrowserSession } from "@/lib/application-browser/protected-browser-session";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

const targetUrl = "https://synthetic.example.test/apply";
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test.skip("production guard distinguishes original POST from redirected navigation (event-observation harness unresolved)", async () => {
  for (const action of ["/submit", "/apply"] as const) {
    const context = await browser.newContext();
    const intercepted: string[] = [];
    const attempted: string[] = [];
    const responses: string[] = [];
    const failures: string[] = [];
    const submitEvents: string[] = [];
    const unsafe: string[] = [];
    context.on("request", (request) => attempted.push(`${request.method()} ${new URL(request.url()).pathname}`));
    context.on("response", (response) => responses.push(`${response.status()} ${new URL(response.url()).pathname}`));
    context.on("requestfailed", (request) => failures.push(`${request.method()} ${new URL(request.url()).pathname}`));
    const targetController = createPlaywrightTargetController({
      context,
      onUnsafe: (code) => { unsafe.push(code); },
      testOnlyCreateProtectedSession: (page) => createProtectedApplicationBrowserSession({ page }),
      async testOnlyFulfillMainDocument(request, route) {
        intercepted.push(`${request.method()} ${new URL(request.url()).pathname}`);
        if (request.method() === "POST") {
          await route.fulfill({ status: 303, headers: { location: "/confirmation" }, body: "" });
        } else {
          await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><form action="${action}" method="post"><input name="synthetic" value="x"><button>Send</button></form><script>document.querySelector('form').addEventListener('submit',()=>console.log('synthetic-submit-event'))</script>` });
        }
      }
    });
    try {
      const target = parseExecutionTargetUrl(targetUrl);
      assert.ok(target);
      await targetController.open({ target, policy: { effectiveEnabled: true, allowedHosts: [target.host], blockedHosts: [] } }, () => undefined);
      const page = targetController.page();
      assert.ok(page);
      page.on("console", (message) => { if (message.text() === "synthetic-submit-event") submitEvents.push(message.text()); });
      // The HUMAN test actor is separate from the companion and acts only here.
      await page.locator("button").click({ noWaitAfter: true });
      const deadline = Date.now() + 2000;
      while (!unsafe.includes("TARGET_NAVIGATION_BLOCKED") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(unsafe, ["TARGET_NAVIGATION_BLOCKED"]);
      assert.equal(new URL(page.url()).pathname, "/apply");
      if (action === "/submit") {
        assert.deepEqual(intercepted, ["GET /apply"]); // test fulfill hook is after the production guard
        assert.ok(attempted.includes("POST /submit"));
        assert.ok(failures.includes("POST /submit"));
        assert.equal(responses.some((value) => value.includes("/submit")), false);
      } else {
        assert.deepEqual(intercepted, ["GET /apply", "POST /apply"]);
        assert.ok(responses.includes("303 /apply"));
        assert.ok(attempted.includes("GET /confirmation"));
        assert.ok(failures.includes("GET /confirmation"));
      }
      assert.deepEqual(submitEvents, ["synthetic-submit-event"]);
      // route.fulfill is a local interception, not a real collector receipt.
    } finally {
      await targetController.close();
      await context.close();
    }
  }
});

test("test-owned session can revoke its protected surface while retaining the filled page", async () => {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort("blockedbyclient"));
  const page = await context.newPage();
  try {
    const session = await createProtectedApplicationBrowserSession({ page });
    await page.goto('data:text/html,<label>Profile<input value="synthetic-filled"></label>');
    await session.waitUntilReady();
    const closing = session.close();
    await assert.rejects(session.snapshot());
    await closing;
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator("input").inputValue(), "synthetic-filled");
    // This does not fence a pending write, retire the target controller, or remove shared-context risks.
  } finally {
    await context.close();
  }
});

test("loopback collector separates human POST receipt, redirects, validation, script effects and blocked cross-origin", async () => {
  const receipts: string[] = [];
  let origin = "";
  const server: Server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    if (request.method === "POST") {
      for await (const chunk of request) { void chunk; } // consume exact-owned synthetic body
      receipts.push(`${request.method} ${path}`);
      if (path === "/apply") {
        response.writeHead(303, { location: "/confirmation" }); response.end(); return;
      }
      if (path === "/invalid") {
        response.writeHead(422, { "content-type": "text/html" }); response.end("Validation error"); return;
      }
      response.writeHead(200); response.end("ok"); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(path === "/form" ? `<!doctype html><form action="/apply" method="post"><input name="fake" value="x"><button id="human">Send</button></form><button id="script" type="button">Script</button><a id="unrelated" href="/unrelated">Other path</a><a id="external" href="https://outside.example.test/" target="_blank">Popup</a><script>window.submitEvents=0;document.querySelector('form').addEventListener('submit',()=>window.submitEvents++);document.querySelector('#script').onclick=()=>setTimeout(()=>fetch('/invalid',{method:'POST',body:'x'}),0)</script>` : `<p>${path}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  const blocked: string[] = [];
  await context.route("**/*", async (route, request) => {
    if (new URL(request.url()).origin === origin) await route.continue();
    else { blocked.push(request.url()); await route.abort("blockedbyclient"); }
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/form`);
    await page.locator("#script").click();
    const deadline = Date.now() + 2000;
    while (!receipts.includes("POST /invalid") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(receipts.includes("POST /invalid"));
    assert.equal(await page.evaluate(() => (window as typeof window & { submitEvents: number }).submitEvents), 0);
    await page.locator("#unrelated").click();
    assert.equal(new URL(page.url()).pathname, "/unrelated");
    await page.goto(`${origin}/form`);
    const popupPromise = context.waitForEvent("page");
    await page.locator("#external").click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);
    assert.ok(blocked.some((url) => url.startsWith("https://outside.example.test/")));
    await popup.close();
    // The HUMAN test actor is separate from the test-owned route policy.
    await page.locator("#human").click();
    await page.waitForURL(`${origin}/confirmation`);
    assert.deepEqual(receipts, ["POST /invalid", "POST /apply"]);
    assert.equal(new URL(page.url()).pathname, "/confirmation");
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
