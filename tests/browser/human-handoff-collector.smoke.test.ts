import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";

import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

type Receipt = { method: string; path: string };
const hostname = "synthetic.example.test";
const confirmationHostname = "synthetic-confirm.example.test";
let controlOrigin = "";
let browser: Browser;
let server: Server;
let origin = "";
let certificateDirectory = "";
const receipts: Receipt[] = [];
const prohibitedReceipts: string[] = [];

before(async () => {
  certificateDirectory = mkdtempSync(join(tmpdir(), "apply-pilot-handoff-cert-"));
  const keyPath = join(certificateDirectory, "synthetic.key");
  const certPath = join(certificateDirectory, "synthetic.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${hostname}`,
    "-addext", `subjectAltName=DNS:${hostname}`], { stdio: "ignore" });
  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/control" || url.pathname === "/private") prohibitedReceipts.push(url.pathname);
    if (request.method === "POST") {
      for await (const chunk of request) { void chunk; }
      receipts.push({ method: "POST", path: url.pathname });
      if (url.pathname === "/collector/script") {
        response.writeHead(200, { "content-type": "text/plain" }); response.end("script received"); return;
      }
      const caseName = url.searchParams.get("case") ?? "unknown";
      if (caseName === "human-validation") {
        response.writeHead(422, { "content-type": "text/html" }); response.end("<!doctype html><p>Validation error</p>"); return;
      }
      const location = caseName === "human-blocked-control"
        ? `${controlOrigin}/control`
        : caseName === "human-blocked-private"
          ? `https://127.0.0.1:${new URL(origin).port}/private`
          : caseName === "human-cross-origin"
            ? `https://${confirmationHostname}:${new URL(origin).port}/confirmation`
            : `/confirmation?case=${caseName}`;
      response.writeHead(303, { location });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (url.pathname === "/confirmation") {
      response.end("<!doctype html><p>Synthetic confirmation</p>");
      return;
    }
    const caseName = url.searchParams.get("case") ?? "unknown";
    const action = caseName === "blocked-original" ? `/submit?case=${caseName}` : `/apply?case=${caseName}`;
    response.end(`<!doctype html><form action="${action}" method="post"><input name="fake" value="synthetic"><button id="human">Submit</button></form><button id="script-post" type="button">Script transport</button><button id="script-nav" type="button">Script navigation</button><a id="unrelated" href="/unrelated">Unrelated path</a><script>document.querySelector('form').addEventListener('submit',()=>console.log('synthetic-submit-event'));document.querySelector('#script-post').onclick=()=>setTimeout(()=>fetch('/collector/script',{method:'POST',body:'synthetic'}),0);document.querySelector('#script-nav').onclick=()=>setTimeout(()=>location.assign('/script-destination'),0)</script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `https://${hostname}:${address.port}`;
  controlOrigin = `https://apply-pilot.example.test:${address.port}`;
  browser = await chromium.launch({ headless: true, args: [
    `--host-resolver-rules=MAP ${hostname} 127.0.0.1,MAP ${confirmationHostname} 127.0.0.1,MAP apply-pilot.example.test 127.0.0.1`
  ] });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (certificateDirectory) rmSync(certificateDirectory, { recursive: true, force: true });
});

for (const scenario of ["blocked-original", "blocked-same-target", "human-confirmation", "human-cross-origin", "human-blocked-control", "human-blocked-private"] as const) {
  test(`integrated collector attributes ${scenario} original POST, redirect and final navigation`, async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const targetUrl = `${origin}/apply?case=${scenario}`;
    const attempted: string[] = [];
    const responses: string[] = [];
    const failed: string[] = [];
    const navigated: string[] = [];
    const submitEvents: string[] = [];
    const unsafe: string[] = [];
    context.on("request", (request) => attempted.push(`${request.method()} ${new URL(request.url()).pathname}`));
    context.on("response", (response) => responses.push(`${response.status()} ${new URL(response.url()).pathname}`));
    context.on("requestfailed", (request) => failed.push(`${request.method()} ${new URL(request.url()).pathname}`));
    const controller = createPlaywrightTargetController({
      context, onUnsafe: (code) => { unsafe.push(code); }
    });
    const receiptBaseline = receipts.length;
    const prohibitedBaseline = prohibitedReceipts.length;
    try {
      const target = parseExecutionTargetUrl(targetUrl);
      assert.ok(target);
      await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [hostname], blockedHosts: [] } }, () => undefined);
      const page = controller.page();
      assert.ok(page);
      page.on("console", (message) => { if (message.text() === "synthetic-submit-event") submitEvents.push(message.text()); });
      page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigated.push(new URL(frame.url()).pathname); });
      if (scenario.startsWith("human-")) await controller.retireForHuman(controlOrigin, () => undefined);
      // The separate simulated HUMAN actor is the only form submitter in this test.
      await page.locator("#human").click({ noWaitAfter: true });
      const expectedPath = scenario === "human-confirmation" || scenario === "human-cross-origin" ? "/confirmation" : "/apply";
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline &&
        (expectedPath === "/confirmation" ? new URL(page.url()).pathname !== expectedPath : unsafe.length === 0)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(submitEvents, ["synthetic-submit-event"]);
      assert.equal(new URL(page.url()).pathname, expectedPath);
      const caseReceipts = receipts.slice(receiptBaseline);
      if (scenario === "blocked-original") {
        assert.deepEqual(caseReceipts, []);
        assert.ok(attempted.includes("POST /submit"));
        assert.ok(failed.includes("POST /submit"));
        assert.deepEqual(unsafe, ["TARGET_NAVIGATION_BLOCKED"]);
      } else if (scenario === "blocked-same-target") {
        assert.deepEqual(caseReceipts, []);
        assert.ok(attempted.includes("POST /apply"));
        assert.ok(failed.includes("POST /apply"));
        assert.equal(attempted.includes("GET /confirmation"), false);
        assert.deepEqual(unsafe, ["TARGET_NAVIGATION_BLOCKED"]);
      } else if (scenario === "human-confirmation" || scenario === "human-cross-origin") {
        assert.deepEqual(caseReceipts, [{ method: "POST", path: "/apply" }]);
        assert.ok(responses.includes("303 /apply"));
        assert.ok(responses.includes("200 /confirmation"));
        assert.ok(navigated.includes("/confirmation"));
        if (scenario === "human-cross-origin") assert.equal(new URL(page.url()).hostname, confirmationHostname);
        assert.deepEqual(unsafe, []);
      } else {
        assert.deepEqual(caseReceipts, [{ method: "POST", path: "/apply" }]);
        assert.deepEqual(prohibitedReceipts.slice(prohibitedBaseline), []);
        assert.deepEqual(unsafe, ["HUMAN_NAVIGATION_BLOCKED"]);
      }
    } finally {
      await controller.close();
      await context.close();
    }
  });
}

test("integrated collector keeps validation and script effects distinct from HUMAN submission", async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const controller = createPlaywrightTargetController({ context, onUnsafe: () => undefined });
  const baseline = receipts.length;
  const submitEvents: string[] = [];
  try {
    const target = parseExecutionTargetUrl(`${origin}/apply?case=human-validation`);
    assert.ok(target);
    await controller.open({ target, policy: { effectiveEnabled: true, allowedHosts: [hostname], blockedHosts: [] } }, () => undefined);
    await controller.retireForHuman(controlOrigin, () => undefined);
    const page = controller.page();
    assert.ok(page);
    page.on("console", (message) => { if (message.text() === "synthetic-submit-event") submitEvents.push(message.text()); });
    // A HUMAN click triggers a page-script POST but no form submit event.
    await page.locator("#script-post").click();
    const deadline = Date.now() + 2000;
    while (!receipts.slice(baseline).some((item) => item.path === "/collector/script") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(submitEvents, []);
    assert.deepEqual(receipts.slice(baseline), [{ method: "POST", path: "/collector/script" }]);
    await page.locator("#unrelated").click();
    assert.equal(new URL(page.url()).pathname, "/unrelated");
    await page.goBack();
    await page.locator("#script-nav").click();
    await page.waitForURL(`${origin}/script-destination`);
    assert.deepEqual(submitEvents, []);
    await page.goBack();
    await page.locator("#human").click();
    assert.deepEqual(submitEvents, ["synthetic-submit-event"]);
    assert.deepEqual(receipts.slice(baseline), [
      { method: "POST", path: "/collector/script" },
      { method: "POST", path: "/apply" }
    ]);
    assert.equal(new URL(page.url()).pathname, "/apply");
    assert.equal(await page.locator("p").textContent(), "Validation error");
  } finally {
    await controller.close();
    await context.close();
  }
});
