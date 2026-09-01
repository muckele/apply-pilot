import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";

let browser: Browser;
let origin: string;
let nextServer: ChildProcessWithoutNullStreams;
let serverOutput = "";

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForNextServer(url: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (nextServer.exitCode !== null) {
      throw new Error(`Next server exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // The server has not bound the loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Next server.\n${serverOutput}`);
}

before(async () => {
  const port = await reservePort();
  origin = `http://127.0.0.1:${port}`;
  nextServer = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTH_SECRET: "public-route-browser-test-secret",
        AUTH_TRUST_HOST: "true",
        ALLOW_DEMO_USER: "false",
        GOOGLE_CLIENT_ID: "public-route-test-client",
        GOOGLE_CLIENT_SECRET: "public-route-test-secret"
      }
    }
  );
  nextServer.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  nextServer.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForNextServer(origin);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (nextServer && nextServer.exitCode === null) {
    nextServer.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      nextServer.once("exit", () => resolve());
      setTimeout(resolve, 5_000);
    });
  }
});

test("the landing route renders its content and working conversion links", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Apply smarter.\nStay in control.");
  assert.equal(await page.getByRole("link", { name: "Sign up", exact: true }).first().getAttribute("href"), "/signup");
  assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).first().getAttribute("href"), "/login");
  assert.equal(await page.getByRole("link", { name: "See how it works", exact: true }).first().getAttribute("href"), "#how-it-works");

  for (const target of ["product", "how-it-works", "why-apply-pilot", "safety"]) {
    assert.equal(await page.locator(`#${target}`).count(), 1);
  }

  await page.getByRole("link", { name: "See how it works", exact: true }).first().click();
  assert.equal(new URL(page.url()).hash, "#how-it-works");
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Sign up", exact: true }).first().click();
  await page.waitForURL(`${origin}/signup`);

  await page.close();
});

test("signup and login render their distinct Google OAuth presentations", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(`${origin}/signup`, { waitUntil: "domcontentloaded" });
  assert.equal(new URL(page.url()).pathname, "/signup");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Your next opportunity starts here.");
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).last().getAttribute("href"), "/login");

  await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
  await page.waitForURL(`${origin}/login`);
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Welcome back.");
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Sign up", exact: true }).last().getAttribute("href"), "/signup");

  await page.close();
});

test("required viewports remain width-clean and preserve accessible public controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const targets = [
    ["/", [1440, 1280, 1024, 768, 390]],
    ["/signup", [1440, 768, 390]],
    ["/login", [1440, 768, 390]]
  ] as const;

  for (const [path, widths] of targets) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : width <= 768 ? 1024 : 900 });
      await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }));
      assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `${path} overflowed at ${width}px: ${JSON.stringify(dimensions)}`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const mobileMenu = page.locator("summary[aria-label='Open navigation menu']");
  assert.equal(await mobileMenu.isVisible(), true);
  await mobileMenu.click();
  assert.equal(await page.getByRole("navigation", { name: "Mobile navigation" }).isVisible(), true);
  await page.getByRole("link", { name: "Safety", exact: true }).last().click();
  assert.equal(new URL(page.url()).hash, "#safety");
  assert.equal(await page.locator(".product-preview button").count(), 0, "illustrative product controls must not be focusable");

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.keyboard.press("Tab");
  const focusedControl = page.locator(":focus");
  assert.equal(await focusedControl.innerText(), "Skip to content");
  const focusStyle = await focusedControl.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.notEqual(focusStyle.outlineStyle, "none");
  assert.ok(Number.parseFloat(focusStyle.outlineWidth) >= 2);
  assert.ok(Number.parseFloat(await page.locator(".public-hero-copy").evaluate((element) => getComputedStyle(element).animationDuration)) <= 0.01);

  await page.close();
});

test("public routes remain outside AppShell while protected boundaries remain intact", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  for (const path of ["/", "/signup", "/login"]) {
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.locator("[data-app-shell]").count(), 0, path);
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { selector: `${element.tagName.toLowerCase()}.${element.className}`, left: rect.left, right: rect.right, width: rect.width };
        })
        .filter(({ left, right }) => left < -0.5 || right > document.documentElement.clientWidth + 0.5)
        .slice(0, 12)
    }));
    assert.equal(overflow.scrollWidth <= overflow.clientWidth, true, `${path} must not overflow horizontally: ${JSON.stringify(overflow)}`);
  }

  const dashboardResponse = await page.goto(`${origin}/dashboard`, {
    waitUntil: "domcontentloaded"
  });
  assert.ok(dashboardResponse);
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("callbackUrl"), "/dashboard");

  const apiResponse = await page.request.get(`${origin}/api/profile`);
  assert.equal(apiResponse.status(), 401);
  assert.deepEqual(await apiResponse.json(), { error: "Authentication required" });

  await page.close();
});
