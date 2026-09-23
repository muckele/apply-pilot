import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";

import type { ApplicationBrowserRuntime } from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { createApplicationFormInspectionController } from "@/lib/application-browser/form-inspection-controller";
import type { createSameOriginClient } from "@/lib/application-browser/same-origin-client";
import { APPLICATION_BROWSER_BINDING_NAME, type B1Command, type B1Status } from "@/lib/application-browser/types";
import { runApplicationBrowserCompanion } from "@/scripts/application-browser-companion";

const runId = "clz8w7m9a0002qwer1234tyui";
const host = "companion-synthetic.example.test";
const controlOrigin = "http://127.0.0.1:49123";

test("real companion owner handoff precedes separate HUMAN POST receipt and 303 confirmation", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "apply-pilot-companion-collector-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  let server: Server | undefined;
  let browser: Browser | undefined;
  let companion: Promise<void> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${host}`,
      "-addext", `subjectAltName=DNS:${host}`], { stdio: "ignore" });
    const receipts: string[] = [];
    server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
      const path = new URL(request.url ?? "/", "https://example.test").pathname;
      if (request.method === "POST") {
        for await (const chunk of request) { void chunk; }
        receipts.push(`POST ${path}`);
        response.writeHead(303, { location: "/confirmation" }); response.end();
      } else if (path === "/confirmation") {
        receipts.push("GET /confirmation");
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><p>Synthetic confirmation</p>");
      } else {
        receipts.push("GET /apply");
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><form action="/apply" method="post"><label>Name<input id="name" name="name"></label><button id="human">Submit</button></form>');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const targetUrl = `https://${host}:${address.port}/apply`;
    browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] });
    const ownedBrowser = browser;
    const controlContext = await browser.newContext();
    const employerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await controlContext.route(`${controlOrigin}/**`, async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>Owner control</p>" });
    });
    const controlPage = await controlContext.newPage();
    const attempted: string[] = [];
    const responses: string[] = [];
    const navigated: string[] = [];
    employerContext.on("request", (request) => attempted.push(`${request.method()} ${new URL(request.url()).pathname}`));
    employerContext.on("response", (response) => responses.push(`${response.status()} ${new URL(response.url()).pathname}`));
    let runtimeClose: Promise<void> | null = null;
    companion = runApplicationBrowserCompanion(
      ["--app-origin", controlOrigin, "--run-id", runId],
      {
        async launchRuntime(): Promise<ApplicationBrowserRuntime> {
          return {
            browser: ownedBrowser, context: controlContext, employerContext, controlPage,
            close() {
              runtimeClose ??= (async () => {
                await employerContext.close();
                await controlContext.close();
                await ownedBrowser.close();
              })();
              return runtimeClose;
            }
          };
        },
        createClient() {
          return {
            async getApplicationRun() {
              return { id: runId, state: "READY", stateVersion: 1, completedAt: null,
                applyHost: host, applyUrlSnapshot: targetUrl };
            },
            async getAutomationPolicy() {
              return { effectiveEnabled: true, allowedHosts: [host], blockedHosts: [] };
            }
          } as unknown as ReturnType<typeof createSameOriginClient>;
        },
        createTargetController: createPlaywrightTargetController,
        createFormInspectionController: createApplicationFormInspectionController,
        installBridge: installControlBridge,
        writeOutput() {}
      }
    );
    await controlPage.waitForFunction((name) =>
      typeof (window as unknown as Record<string, unknown>)[name] === "function", APPLICATION_BROWSER_BINDING_NAME, { timeout: 3_000 });
    const invoke = (command: B1Command): Promise<B1Status> => controlPage.evaluate(
      async ({ name, value }) =>
        (window as unknown as Record<string, (input: B1Command) => Promise<B1Status>>)[name](value),
      { name: APPLICATION_BROWSER_BINDING_NAME, value: command }
    );
    assert.equal((await invoke({ type: "OPEN_TARGET" })).state, "TARGET_OPEN");
    assert.deepEqual(receipts, ["GET /apply"]);
    const [employerPage] = employerContext.pages();
    assert.ok(employerPage);
    employerPage.on("framenavigated", (frame) => {
      if (frame === employerPage.mainFrame()) navigated.push(new URL(frame.url()).pathname);
    });
    assert.equal(await employerPage.evaluate((name) =>
      typeof (window as unknown as Record<string, unknown>)[name], APPLICATION_BROWSER_BINDING_NAME), "undefined");
    assert.equal((await invoke({ type: "HANDOFF_TO_HUMAN" })).state, "HUMAN_ONLY");
    assert.deepEqual(receipts, ["GET /apply"]);
    // Only this separate synthetic HUMAN actor invokes the employer Submit control.
    await employerPage.locator("#human").click();
    assert.deepEqual(receipts, ["GET /apply", "POST /apply", "GET /confirmation"]);
    assert.ok(attempted.includes("POST /apply"));
    assert.ok(responses.includes("303 /apply"));
    assert.ok(responses.includes("200 /confirmation"));
    assert.ok(navigated.includes("/confirmation"));
    assert.equal(await employerPage.locator("p").textContent(), "Synthetic confirmation");
    await controlPage.close();
    await companion;
    companion = undefined;
    assert.equal(employerContext.pages().length, 0);
  } finally {
    await browser?.close().catch(() => undefined);
    await Promise.race([companion?.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
