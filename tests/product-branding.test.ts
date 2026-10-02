import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import type { ComponentType, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ManualJobImportForm } from "@/components/manual-job-import-form";
import { resolveActiveProductNavHref } from "@/components/product-nav";
import { ButtonLink, MetricCard, PageHeader, Panel, PrimaryButton, SecondaryButton, type UiTone } from "@/components/ui";

const repositoryRoot = process.cwd();

function source(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("product layout owns a scoped theme without importing public landing styles", () => {
  const layout = source("app/(product)/layout.tsx");
  const shell = source("components/app-shell.tsx");
  const css = source("app/(product)/product.css");

  assert.match(layout, /import "\.\/product\.css";/);
  assert.doesNotMatch(layout, /public\.css/);
  assert.match(shell, /data-app-shell/);
  assert.match(shell, /className="product-skip-link"/);
  assert.match(shell, /id="product-main"/);
  assert.match(shell, /absolute inset-x-4 bottom-44/);
  assert.match(css, /--product-canvas: #f5faf7/);
  assert.match(css, /--product-surface: #ffffff/);
  assert.match(css, /html\[data-product-theme="dark"\]/);
  assert.match(css, /--product-canvas: #020a08/);
  assert.match(css, /--product-surface: #071411/);
  assert.match(css, /--product-mint: #5bd894/);
  assert.match(css, /color-scheme: light/);
  assert.match(css, /\.product-shell:has\(\.product-page-themed\)/);
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /\.product-surface/);
  assert.match(css, /\.product-callout-success/);
  assert.match(css, /\.product-callout-warning/);
  assert.match(css, /\.product-callout-danger/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@media \(min-width: 380px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("product navigation resolves one longest active route", () => {
  const navigation = source("components/product-nav.tsx");

  assert.equal(resolveActiveProductNavHref("/dashboard"), "/dashboard");
  assert.equal(resolveActiveProductNavHref("/jobs/job-1"), "/jobs");
  assert.equal(resolveActiveProductNavHref("/jobs/review"), "/jobs/review");
  assert.equal(resolveActiveProductNavHref("/interviews/library/question-1"), "/interviews/library");
  assert.equal(resolveActiveProductNavHref("/settings/profile"), "/settings/profile");
  assert.equal(resolveActiveProductNavHref("/unknown"), undefined);
  assert.match(navigation, /aria-current=\{active \? "page" : undefined\}/);
});

test("branded primitives opt in without replacing default styling", () => {
  const TestPanel = Panel as ComponentType<PropsWithChildren<{ tone?: UiTone }>>;
  const TestButtonLink = ButtonLink as ComponentType<PropsWithChildren<{ href: string; tone?: UiTone }>>;
  const branded = renderToStaticMarkup(
    createElement("div", null,
      createElement(PageHeader, { title: "Dashboard", description: "Overview", tone: "branded" }),
      createElement(TestPanel, { tone: "branded" }, "Panel content"),
      createElement(MetricCard, { label: "Saved", value: 4, detail: "This week", tone: "branded" }),
      createElement(TestButtonLink, { href: "/jobs", tone: "branded" }, "Import job"),
      createElement(PrimaryButton, { tone: "branded" }, "Primary"),
      createElement(SecondaryButton, { tone: "branded" }, "Secondary")
    )
  );
  const defaults = renderToStaticMarkup(
    createElement("div", null,
      createElement(PageHeader, { title: "Tasks" }),
      createElement(TestPanel, null, "Default panel"),
      createElement(PrimaryButton, null, "Default primary")
    )
  );

  assert.match(branded, /tracking-\[-0\.04em\]/);
  assert.match(branded, /product-surface/);
  assert.match(branded, /product-primary-action/);
  assert.match(branded, /product-secondary-action/);
  assert.match(branded, /product-themed-title/);
  assert.match(defaults, /text-slate-950/);
  assert.match(defaults, /border-slate-200/);
  assert.match(defaults, /bg-brand-600/);
});

test("Dashboard and Jobs style their real content and result states, not only product chrome", () => {
  const dashboard = source("app/(product)/dashboard/page.tsx");
  const jobs = source("app/(product)/jobs/page.tsx");
  const jobCard = source("components/job-card.tsx");
  const discovery = source("components/automated-job-discovery-panel.tsx");
  const manualImport = source("components/manual-job-import-form.tsx");

  assert.match(dashboard, /product-page product-page-themed/);
  assert.match(jobs, /product-page product-page-themed/);
  assert.match(dashboard, /product-themed-title/);
  assert.match(dashboard, /product-divider/);
  assert.match(jobs, /product-surface/);
  assert.match(jobCard, /product-surface-raised/);
  for (const resultClass of ["product-callout-success", "product-callout-warning", "product-callout-danger"]) {
    assert.match(discovery, new RegExp(resultClass));
    assert.match(manualImport, new RegExp(resultClass));
  }
});

test("Jobs keeps labeled filters and the expanded import-only workflow", () => {
  const jobs = source("app/(product)/jobs/page.tsx");
  const BrandedManualJobImportForm = ManualJobImportForm as (props: { tone?: UiTone }) => React.JSX.Element;
  const form = renderToStaticMarkup(createElement(BrandedManualJobImportForm, { tone: "branded" }));

  for (const label of ["Search jobs", "Source", "Status", "Work style", "Date posted", "Company", "Role type", "Minimum fit score"]) {
    assert.match(jobs, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(jobs, /product-filter-grid/);
  assert.match(form, /class="space-y-4 product-form"/);
  assert.match(form, /name="salaryMin"/);
  assert.match(form, /name="requirements"/);
  assert.match(form, /value="false"/);
  assert.match(form, />Import only</);
  assert.match(form, /value="true"/);
  assert.match(form, />Import and score</);
});
