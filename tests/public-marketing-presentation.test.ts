import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import HomePage from "@/app/(public)/page";

function renderHomePage() {
  const page = (HomePage as unknown as () => React.ReactElement)();
  return renderToStaticMarkup(page);
}

function renderedText(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("the root route presents the approved landing message and conversion paths", () => {
  const html = renderHomePage();

  assert.match(html, /Apply smarter\./);
  assert.match(html, /Stay in control\./);
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="#how-it-works"/);
  assert.match(html, /Discover/);
  assert.match(html, /Evaluate/);
  assert.match(html, /Prepare/);
  assert.match(html, /Review/);
  assert.match(html, /You submit/);
});

test("every public header anchor resolves to a rendered landing section", () => {
  const html = renderHomePage();

  for (const target of ["product", "how-it-works", "why-apply-pilot", "safety"]) {
    assert.match(html, new RegExp(`href="#${target}"`));
    assert.match(html, new RegExp(`id="${target}"`));
  }
});

test("the landing page preserves the approved section and human-control story", () => {
  const html = renderHomePage();
  const text = renderedText(html);

  assert.match(text, /A deliberate path from discovery to application\./);
  assert.match(text, /Automation, grounded in what’s true\./);
  assert.match(text, /The applicant stays in command\./);
  assert.match(text, /Apply Pilot can inspect and propose\./);
  assert.match(text, /Only you can submit\./);
  assert.match(text, /Precision over volume\./);
  assert.match(text, /Take control of your job search\./);
  assert.match(text, /© 2026 Apply Pilot/);
});

test("the customer-facing landing copy contains no prohibited positioning", () => {
  const html = renderHomePage();

  assert.doesNotMatch(
    html,
    /GitHub|portfolio|Mathew|10x|guaranteed|automatically applies|submit on your behalf|customers|testimonials|SOC 2|funding|award/i
  );
});
