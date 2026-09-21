import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

const repositoryRoot = process.cwd();
const publicPagePath = path.join(repositoryRoot, "app/(public)/page.tsx");

async function renderHomePage() {
  assert.equal(existsSync(publicPagePath), true, "public landing route must exist");
  const { default: HomePage } = await import("@/app/(public)/page");
  const page = (HomePage as unknown as () => React.ReactElement)();
  return renderToStaticMarkup(page);
}

async function renderSignupPresentation() {
  const { PublicAuthPage } = await import("@/components/public-auth/public-auth-page");
  return renderToStaticMarkup(
    React.createElement(PublicAuthPage, { mode: "signup", authState: "unavailable" })
  );
}

function decodeText(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attributeValues(html: string, attribute: "href" | "id") {
  return [...html.matchAll(new RegExp(`\\s${attribute}="([^"]+)"`, "g"))].map(
    (match) => match[1]
  );
}

test("the root route presents the approved Apply Pilot identity and conversion paths", async () => {
  const html = await renderHomePage();
  const text = decodeText(html);

  assert.match(text, /Apply Pilot/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>Apply smarter\.<br\/>Stay in control\.<\/h1>/);
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="#how-it-works"/);
});

test("the public workflow preserves its five stages and ends with applicant submission", async () => {
  const text = decodeText(await renderHomePage());
  const stages = ["Discover", "Evaluate", "Prepare", "Review", "You submit"];
  let previousIndex = -1;

  for (const stage of stages) {
    const stageIndex = text.indexOf(stage, previousIndex + 1);
    assert.ok(stageIndex > previousIndex, `${stage} must follow the prior stage`);
    previousIndex = stageIndex;
  }

  assert.match(text, /personally submit/i);
  assert.doesNotMatch(text, /We submit|Apply Pilot submits/i);
});

test("every landing anchor resolves exactly once and every internal route is approved", async () => {
  const html = await renderHomePage();
  const ids = attributeValues(html, "id");
  const hrefs = attributeValues(html, "href");

  assert.equal(new Set(ids).size, ids.length, "landing IDs must be unique");

  for (const href of hrefs) {
    if (href.startsWith("#")) {
      assert.equal(ids.filter((id) => id === href.slice(1)).length, 1, `${href} must resolve once`);
    } else {
      assert.ok(["/", "/login", "/signup"].includes(href), `unexpected route: ${href}`);
    }
  }

  assert.deepEqual(
    [...new Set(hrefs.filter((href) => href.startsWith("#")))].sort(),
    ["#how-it-works", "#product", "#safety", "#why-apply-pilot"]
  );
});

test("marketing product illustrations remain static and noninteractive", async () => {
  const previewPath = path.join(repositoryRoot, "components/landing/product-preview.tsx");
  const showcasePath = path.join(repositoryRoot, "components/landing/product-showcase.tsx");
  assert.equal(existsSync(previewPath), true, "product preview must exist");
  assert.equal(existsSync(showcasePath), true, "product showcase must exist");
  const { ProductPreview } = await import("@/components/landing/product-preview");
  const { ProductShowcase } = await import("@/components/landing/product-showcase");

  for (const component of [
    React.createElement(ProductPreview, { key: "preview" }),
    React.createElement(ProductShowcase, { key: "showcase" })
  ]) {
    const html = renderToStaticMarkup(component);
    assert.doesNotMatch(html, /<(?:a|button|form|input|select|textarea|summary)\b/i);
    assert.doesNotMatch(html, /\s(?:tabindex|onclick|role="button")=/i);
  }
});

test("current-main capability copy keeps employer form entry and submission with the applicant", async () => {
  const text = decodeText(await renderHomePage());

  assert.match(text, /Review-before-save job capture/);
  assert.match(text, /Copy-only answer handoff/);
  assert.match(
    text,
    /Apply Pilot does not fill or submit the employer form in this release\./
  );
  assert.match(
    text,
    /Take your reviewed materials to the employer site, then personally submit\./
  );
  assert.match(text, /No automatic employer submission/);
  assert.match(text, /Employer submission · User only/);
});

test("root metadata describes preparation without claiming evidence-backed provenance", async () => {
  const pageModule = (await import("@/app/(public)/page")) as unknown as {
    metadata?: { description?: string };
  };

  assert.equal(
    pageModule.metadata?.description,
    "Discover relevant opportunities, evaluate fit, and prepare, review, and organize application materials while keeping every final submission decision yours."
  );
  assert.doesNotMatch(pageModule.metadata?.description ?? "", /evidence-backed applications/i);
});

test("landing examples visibly qualify provenance and job-fit estimates", async () => {
  const text = decodeText(await renderHomePage());

  assert.match(text, /Prepare, review, and organize your application\./);
  assert.match(
    text,
    /Review draft resumes, cover letters, and job-fit estimates before use\. Check names, experience, skills, and claims against your own records\./
  );
  assert.ok(
    (text.match(/Illustrative Apply Pilot job-fit estimate/g) ?? []).length >= 2,
    "expected both sample score surfaces to visibly identify an illustrative Apply Pilot estimate"
  );
  assert.match(text, /Illustrative experience/);
  assert.match(text, /Example profile information/);

  assert.doesNotMatch(text, /Automation, built from what you provide\./);
  assert.doesNotMatch(text, /Candidate-provided experience/);
  assert.doesNotMatch(text, /Applications draw from what you’ve actually provided\./);
  assert.doesNotMatch(text, /\bFIT SCORE\b/);
});

test("public copy does not advertise excluded or future capabilities as available", async () => {
  const text = decodeText(await renderHomePage());

  assert.doesNotMatch(
    text,
    /hosted (?:managed )?browser|managed browser (?:execution|workspace)|controlled browser|inspect, propose, and fill|unattended|auto[- ]?apply|apply automatically|submit on your behalf|universal ATS|every ATS|all ATS|90\+|guaranteed (?:interviews?|job offers?)/i
  );
  assert.doesNotMatch(text, /(?:install|download|required).{0,30}(?:Chrome )?extension/i);
});

test("public application copy describes drafts and requires record-by-record review", async () => {
  const text = decodeText(await renderHomePage());

  for (const unsupportedPromise of [
    /evidence-backed applications/i,
    /Automation, built from what you provide/i,
    /Candidate-provided experience/i,
    /Applications draw from what you(?:'|’)?ve actually provided/i,
    /Apply Pilot uses the information you provide to prepare application material/i,
    /Build application material from the experience you provide/i
  ]) {
    assert.doesNotMatch(text, unsupportedPromise);
  }

  assert.match(
    text,
    /Review draft resumes, cover letters, and job-fit estimates before use\./
  );
  assert.match(
    text,
    /Check names, experience, skills, and claims against your own records\./
  );
  assert.match(
    text,
    /Treat prepared material and job-fit estimates as drafts\. Confirm every name, experience, skill, and claim before use\./
  );
  assert.match(text, /Illustrative experience/);
});

test("sample fit scores are visibly labeled as illustrative Apply Pilot estimates", async () => {
  const { ProductPreview } = await import("@/components/landing/product-preview");
  const { ProductShowcase } = await import("@/components/landing/product-showcase");
  const renderedSamples = [
    renderToStaticMarkup(React.createElement(ProductPreview)),
    renderToStaticMarkup(React.createElement(ProductShowcase)),
    await renderSignupPresentation()
  ];

  for (const html of renderedSamples) {
    assert.match(
      html,
      /<span>Illustrative Apply Pilot job-fit estimate<\/span><strong>86<\/strong>/
    );
    assert.doesNotMatch(decodeText(html), /\bFIT SCORE\b/);
  }
});

test("signup and closing CTA avoid unsupported evidence-backed promises", async () => {
  const landingText = decodeText(await renderHomePage());
  const signupText = decodeText(await renderSignupPresentation());

  assert.match(
    landingText,
    /Build a more focused job search with AI assistance, review every application detail, and keep every decision yours\./
  );
  assert.match(
    signupText,
    /Use an approved Google account to organize a more focused job search and review every application detail before use\./
  );
  assert.doesNotMatch(`${landingText} ${signupText}`, /evidence-backed job search/i);
});

test("the landing page preserves the approved section story and review-first framing", async () => {
  const text = decodeText(await renderHomePage());

  for (const message of [
    "A deliberate path from discovery to application.",
    "Prepare, review, and organize your application.",
    "The applicant stays in command.",
    "Precision over volume.",
    "Take control of your job search.",
    "© 2026 Apply Pilot"
  ]) {
    assert.match(text, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(text, /Treat prepared material and job-fit estimates as drafts\./);
  assert.match(text, /review every application detail/i);
});

test("root metadata positions Apply Pilot without claiming automated submission", async () => {
  assert.equal(existsSync(publicPagePath), true, "public landing route must exist");
  const pageModule = (await import("@/app/(public)/page")) as unknown as {
    metadata?: { title?: string; description?: string };
  };

  assert.equal(pageModule.metadata?.title, "Apply Pilot — AI-Assisted Job Search With Human Control");
  assert.equal(
    pageModule.metadata?.description,
    "Discover relevant opportunities, evaluate fit, and prepare, review, and organize application materials while keeping every final submission decision yours."
  );
  assert.doesNotMatch(
    `${pageModule.metadata?.title ?? ""} ${pageModule.metadata?.description ?? ""}`,
    /auto-submit|automatically appl|submit on your behalf/i
  );
});
