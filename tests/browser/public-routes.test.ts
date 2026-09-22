import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";

import { startNextTestServer, type NextTestServer } from "./next-test-server";

let browser: Browser;
let origin: string;
let nextServer: NextTestServer;

type Rgba = [red: number, green: number, blue: number, alpha: number];

function parseCssColor(value: string): Rgba {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  assert.ok(channels && channels.length >= 3, `Expected an rgb/rgba color, received ${value}`);
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
}

function compositeColor(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha
  ];
}

function relativeLuminance(color: Rgba) {
  const linearChannels = color.slice(0, 3).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linearChannels[0] * 0.2126 + linearChannels[1] * 0.7152 + linearChannels[2] * 0.0722;
}

function contrastRatio(first: Rgba, second: Rgba) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(first: Rgba, second: Rgba, minimum: number, label: string) {
  const ratio = contrastRatio(first, second);
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)}:1 was below ${minimum}:1`);
}

before(async () => {
  nextServer = await startNextTestServer({
    environment: {
      ...process.env,
      AUTH_SECRET: "public-route-browser-test-secret",
      AUTH_TRUST_HOST: "true",
      ALLOW_DEMO_USER: "false",
      GOOGLE_CLIENT_ID: "public-route-test-client",
      GOOGLE_CLIENT_SECRET: "public-route-test-secret"
    }
  });
  origin = nextServer.origin;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await nextServer?.stop();
  }
});

test("the landing route renders its content and working conversion links", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Apply smarter.\nStay in control.");
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
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

test("major public text, controls, and focus indicators meet the requested contrast targets", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".public-skip-link").focus();

  const landingColors = await page.evaluate(() => {
    return {
      shell: getComputedStyle(document.querySelector(".public-shell") as Element).backgroundColor,
      heading: getComputedStyle(document.querySelector(".public-hero-copy h1") as Element).color,
      body: getComputedStyle(document.querySelector(".public-hero-copy > p") as Element).color,
      navigation: getComputedStyle(document.querySelector(".public-desktop-nav") as Element).color,
      safetyBody: getComputedStyle(document.querySelector(".safety-copy > p") as Element).color,
      boundaryAssist: getComputedStyle(document.querySelector(".boundary-assist") as Element).color,
      boundaryUser: getComputedStyle(document.querySelector(".boundary-user-copy") as Element).color,
      primaryText: getComputedStyle(document.querySelector(".public-button-primary") as Element).color,
      secondaryBackground: getComputedStyle(document.querySelector(".public-button-secondary") as Element)
        .backgroundColor,
      secondaryBorder: getComputedStyle(document.querySelector(".public-button-secondary") as Element)
        .borderTopColor,
      focus: getComputedStyle(document.querySelector(".public-skip-link") as Element).outlineColor
    };
  });

  const shell = parseCssColor(landingColors.shell);
  for (const [label, value] of Object.entries({
    "hero heading": landingColors.heading,
    "hero body": landingColors.body,
    navigation: landingColors.navigation,
    "safety body": landingColors.safetyBody,
    "Fill boundary copy": landingColors.boundaryAssist,
    "Human-Submit boundary copy": landingColors.boundaryUser
  })) {
    assertContrast(parseCssColor(value), shell, 4.5, label);
  }
  assertContrast(parseCssColor(landingColors.primaryText), [76, 207, 136, 1], 4.5, "primary CTA text");
  assertContrast(parseCssColor(landingColors.focus), shell, 3, "focus indicator");

  const secondaryBackground = compositeColor(parseCssColor(landingColors.secondaryBackground), shell);
  const secondaryBorder = compositeColor(parseCssColor(landingColors.secondaryBorder), secondaryBackground);
  assertContrast(secondaryBorder, secondaryBackground, 3, "secondary CTA boundary");

  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  const authColors = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector(".public-google-button") as Element);
    return {
      heading: getComputedStyle(document.querySelector(".public-auth-story h1") as Element).color,
      body: getComputedStyle(document.querySelector(".public-auth-story > p") as Element).color,
      buttonText: style.color,
      buttonBackground: style.backgroundColor,
      buttonBorder: style.borderTopColor
    };
  });
  assertContrast(parseCssColor(authColors.heading), shell, 4.5, "auth heading");
  assertContrast(parseCssColor(authColors.body), shell, 4.5, "auth body");
  const authButtonBackground = compositeColor(parseCssColor(authColors.buttonBackground), shell);
  assertContrast(parseCssColor(authColors.buttonText), authButtonBackground, 4.5, "Google action text");
  const authButtonBorder = compositeColor(parseCssColor(authColors.buttonBorder), authButtonBackground);
  assertContrast(authButtonBorder, authButtonBackground, 3, "Google action boundary");

  await page.close();
});

test("required viewports remain width-clean and preserve accessible public controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const targets = [
    ["/", [[1440, 1000], [1280, 900], [1024, 768], [768, 1024], [390, 844], [320, 568]]],
    ["/signup", [[1440, 1000], [768, 1024], [390, 844]]],
    ["/login", [[1440, 1000], [768, 1024], [390, 844]]]
  ] as const;

  for (const [path, viewports] of targets) {
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }));
      assert.ok(
        dimensions.scrollWidth <= dimensions.clientWidth,
        `${path} overflowed at ${width}x${height}: ${JSON.stringify(dimensions)}`
      );
      assert.equal(await page.locator("[data-app-shell]").count(), 0, path);
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, `${path} at ${width}x${height}`);

      if (path === "/") {
        const previewRect = await page.locator(".product-preview").boundingBox();
        assert.ok(previewRect);
        for (const cta of await page.locator(".public-hero-actions a").all()) {
          const ctaRect = await cta.boundingBox();
          assert.ok(ctaRect);
          const horizontalIntersection = Math.max(
            0,
            Math.min(ctaRect.x + ctaRect.width, previewRect.x + previewRect.width) -
              Math.max(ctaRect.x, previewRect.x)
          );
          const verticalIntersection = Math.max(
            0,
            Math.min(ctaRect.y + ctaRect.height, previewRect.y + previewRect.height) -
              Math.max(ctaRect.y, previewRect.y)
          );
          assert.equal(
            horizontalIntersection * verticalIntersection,
            0,
            `${await cta.innerText()} overlapped the product preview at ${width}x${height}`
          );
        }

        const submissionCopyRect = await page.locator(".boundary-user-copy").boundingBox();
        const submissionStatusRect = await page.locator(".boundary-status").boundingBox();
        assert.ok(submissionCopyRect);
        assert.ok(submissionStatusRect);
        const horizontalIntersection = Math.max(
          0,
          Math.min(
            submissionCopyRect.x + submissionCopyRect.width,
            submissionStatusRect.x + submissionStatusRect.width
          ) - Math.max(submissionCopyRect.x, submissionStatusRect.x)
        );
        const verticalIntersection = Math.max(
          0,
          Math.min(
            submissionCopyRect.y + submissionCopyRect.height,
            submissionStatusRect.y + submissionStatusRect.height
          ) - Math.max(submissionCopyRect.y, submissionStatusRect.y)
        );
        assert.equal(
          horizontalIntersection * verticalIntersection,
          0,
          `Human-Submit copy overlapped the authority status at ${width}x${height}`
        );
      }
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const mobileMenu = page.locator("summary[aria-label='Open navigation menu']");
  assert.equal(await mobileMenu.isVisible(), true);
  await mobileMenu.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("navigation", { name: "Mobile navigation" }).isVisible(), true);
  await page.getByRole("link", { name: "Safety", exact: true }).last().click();
  assert.equal(new URL(page.url()).hash, "#safety");
  assert.equal(
    await page.locator(
      ".product-preview button, .product-preview a, .product-preview [tabindex], .showcase-panels button, .showcase-panels a, .showcase-panels [tabindex], .workflow-mini button, .workflow-mini a, .workflow-mini [tabindex]"
    ).count(),
    0,
    "illustrative product controls must not be focusable"
  );

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.keyboard.press("Tab");
  const focusedControl = page.locator(":focus");
  assert.equal(await focusedControl.innerText(), "Skip to content");
  assert.equal(await focusedControl.getAttribute("href"), "#public-main");
  assert.equal(await page.locator("#public-main").count(), 1);
  const focusStyle = await focusedControl.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.notEqual(focusStyle.outlineStyle, "none");
  assert.ok(Number.parseFloat(focusStyle.outlineWidth) >= 2);
  assert.ok(
    Number.parseFloat(
      await page.locator(".public-hero-copy").evaluate((element) => getComputedStyle(element).animationDuration)
    ) <= 0.01
  );

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
