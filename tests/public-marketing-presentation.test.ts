import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { JSDOM } from "jsdom";

import HomePage from "@/app/(public)/page";

function renderHomePage() {
  const page = (HomePage as unknown as () => React.ReactElement)();
  return renderToStaticMarkup(page);
}

function renderLandingDocument() {
  return new JSDOM(renderHomePage()).window.document;
}

function renderedText(document: Document) {
  return normalizedText(document.body);
}

function normalizedText(element: Element) {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const breakElement of copy.querySelectorAll("br")) {
    breakElement.replaceWith(" ");
  }
  return copy.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function marketingAccuracyText(document: Document) {
  return [".safety-section", ".showcase-section", ".workflow-section", ".precision-section"]
    .map((selector) => {
      const section = document.querySelector(selector);
      assert.ok(section, `${selector} must render`);
      return normalizedText(section);
    })
    .join(" ");
}

test("the root route presents the approved Apply Pilot landing identity and conversion paths", () => {
  const document = renderLandingDocument();
  const text = renderedText(document);

  assert.match(text, /Apply Pilot/);
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(document.querySelector("h1")?.textContent, "Apply smarter.Stay in control.");
  assert.ok(document.querySelector('a[href="/signup"]'));
  assert.ok(document.querySelector('a[href="/login"]'));
  assert.ok(document.querySelector('a[href="#how-it-works"]'));
});

test("the public workflow contains the five approved stages in order and ends with applicant submission", () => {
  const document = renderLandingDocument();
  const stages = Array.from(document.querySelectorAll(".workflow-stage-copy h3"), (heading) =>
    heading.textContent?.trim()
  );
  const text = renderedText(document);

  assert.deepEqual(stages, ["Discover", "Evaluate", "Prepare", "Review", "You submit"]);
  assert.match(text, /personally submit/i);
  assert.doesNotMatch(text, /You apply|We submit|Apply Pilot submits/i);
});

test("every landing anchor resolves exactly once and every internal route is approved", () => {
  const document = renderLandingDocument();
  const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]"), (element) => element.id);
  const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) =>
    anchor.getAttribute("href")
  );

  assert.equal(new Set(ids).size, ids.length, "landing IDs must be unique");

  for (const href of hrefs) {
    assert.ok(href);
    if (href.startsWith("#")) {
      assert.equal(
        document.querySelectorAll(`[id="${href.slice(1)}"]`).length,
        1,
        `${href} must resolve to exactly one section`
      );
    } else {
      assert.ok(["/", "/login", "/signup"].includes(href), `unexpected internal destination: ${href}`);
    }
  }

  assert.deepEqual(
    [...new Set(hrefs.filter((href): href is string => Boolean(href && href.startsWith("#"))))].sort(),
    ["#how-it-works", "#product", "#safety", "#why-apply-pilot"]
  );
});

test("marketing product illustrations expose no live or focusable application controls", () => {
  const document = renderLandingDocument();
  const illustrations = document.querySelectorAll(
    ".product-preview, .showcase-panels, .workflow-mini"
  );

  assert.ok(illustrations.length > 0);
  for (const illustration of illustrations) {
    assert.equal(
      illustration.querySelectorAll(
        "a, button, form, input, select, textarea, summary, [tabindex], [onclick], [role='button']"
      ).length,
      0,
      "illustrative product surfaces must remain noninteractive"
    );
  }

  const illustrativeActionLabels = Array.from(
    document.querySelectorAll(".product-preview *, .showcase-panels *, .workflow-mini *")
  ).filter((element) => ["Approve", "Reject", "Fill"].includes(element.textContent?.trim() ?? ""));

  assert.ok(illustrativeActionLabels.some((element) => element.textContent?.trim() === "Approve"));
  assert.ok(illustrativeActionLabels.some((element) => element.textContent?.trim() === "Reject"));
  for (const label of illustrativeActionLabels) {
    assert.equal(
      label.closest("a, button, input, select, textarea, summary, [tabindex], [role='button']"),
      null
    );
  }
});

test("the safety boundary describes explicit Fill and personal employer-site submission accurately", () => {
  const document = renderLandingDocument();
  const text = renderedText(document);

  assert.match(
    text,
    /Apply Pilot can inspect, propose, and fill approved supported fields only when you choose\./
  );
  assert.match(
    text,
    /Apply Pilot has not submitted this application\. Review the employer form, complete any manual fields, and personally submit on the employer website\./
  );
  assert.match(text, /No automatic employer submission/);
  assert.match(text, /Employer submission · User only/);
});

test("marketing accuracy copy rejects categorical truth and qualification-verification claims", () => {
  const document = renderLandingDocument();
  const text = marketingAccuracyText(document);
  const categoricalClaims = [
    "No invented claims",
    "Automation, grounded in what’s true.",
    "without inventing qualifications",
    "No fabricated qualifications",
    "Verified experience",
    "Verified source",
    "Source (verified)",
    "✓ Verified",
    "VERIFIED SOURCE",
    "From your verified information"
  ];
  const presentClaims = categoricalClaims.filter((claim) => text.includes(claim));

  assert.deepEqual(
    presentClaims,
    [],
    `unsupported categorical marketing claims remain: ${presentClaims.join(", ")}`
  );
});

test("marketing accuracy copy promises source-linked proposals with review before use", () => {
  const document = renderLandingDocument();
  const text = marketingAccuracyText(document);
  const requiredMessages = [
    "Source-informed proposals",
    "Automation, built from what you provide.",
    "experience and qualifications you provide",
    "review before use",
    "Review qualifications before use",
    "Source-linked experience",
    "Provided source",
    "PROVIDED SOURCE",
    "From your source-linked information"
  ];
  const missingMessages = requiredMessages.filter((message) => !text.includes(message));

  assert.deepEqual(
    missingMessages,
    [],
    `required provenance and review messages are missing: ${missingMessages.join(", ")}`
  );
});

test("the Precision section frames application material as a proposal requiring review", () => {
  const document = renderLandingDocument();
  const section = document.querySelector(".precision-section");

  assert.ok(section, ".precision-section must render");

  const text = normalizedText(section);
  const persistentGroundingGuarantee = text.match(/\b(?:stays|remains|always) grounded\b/i)?.[0];

  assert.equal(
    persistentGroundingGuarantee,
    undefined,
    `unqualified persistent-grounding guarantee remains: ${persistentGroundingGuarantee}`
  );
  assert.match(
    text,
    /Apply Pilot uses the information you provide to prepare application material\./
  );
  assert.match(text, /Review every proposal for accuracy before use\./);
  assert.match(text, /PROVIDED SOURCE/);
  assert.match(text, /source-linked information/i);
});

test("the evidence-lineage accessible name describes a provided source", () => {
  const document = renderLandingDocument();

  assert.equal(
    document.querySelector(".evidence-lineage")?.getAttribute("aria-label"),
    "From provided source to proposed answer"
  );
});

test("the landing page preserves the approved section story without prohibited automation claims", () => {
  const document = renderLandingDocument();
  const text = renderedText(document);

  for (const message of [
    "A deliberate path from discovery to application.",
    "Automation, built from what you provide.",
    "The applicant stays in command.",
    "Precision over volume.",
    "Take control of your job search.",
    "© 2026 Apply Pilot"
  ]) {
    assert.match(text, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.doesNotMatch(
    text,
    /auto-submit|apply automatically|click employer submit|apply on your behalf|detect successful employer submission|independently verify employer submission|guaranteed interviews|guaranteed job offers|hundreds of applications automatically/i
  );
});

test("root metadata positions Apply Pilot without claiming automated submission", async () => {
  const pageModule = (await import("@/app/(public)/page")) as unknown as {
    metadata?: { title?: string; description?: string };
  };

  assert.equal(pageModule.metadata?.title, "Apply Pilot — AI-Assisted Job Search With Human Control");
  assert.equal(
    pageModule.metadata?.description,
    "Discover relevant opportunities, evaluate fit, and prepare evidence-backed applications while keeping every final submission decision yours."
  );
  assert.doesNotMatch(
    `${pageModule.metadata?.title ?? ""} ${pageModule.metadata?.description ?? ""}`,
    /auto-submit|automatically appl|submit on your behalf/i
  );
});
