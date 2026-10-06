import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("all paid packet actions use the existing consent-aware browser request", () => {
  const component = source("components/apply-packet-builder.tsx");
  assert.doesNotMatch(component, /await runJsonPost\(`\/api\/jobs\/\$\{job\.id\}\/tailored-resume`\)/);
  assert.doesNotMatch(component, /await runJsonPost\(`\/api\/jobs\/\$\{job\.id\}\/cover-letter`\)/);
  assert.match(component, /fetchWithAiCostConfirmation\(endpoint, \{ method: "POST" \}\)/);
  assert.match(component, /fetchWithAiCostConfirmation\(`\/api\/jobs\/\$\{job\.id\}\/tailored-resume`, \{ method: "POST" \}\)/);
  assert.match(component, /fetchWithAiCostConfirmation\(`\/api\/jobs\/\$\{job\.id\}\/cover-letter`, \{ method: "POST" \}\)/);
});

test("the existing formatted preview component is reused for cover review", () => {
  const workspace = source("components/job-document-workspace.tsx");
  assert.match(workspace, /import \{ FormattedDocumentPreview \}/);
  assert.match(workspace, /<FormattedDocumentPreview text=\{coverText\} title="Cover letter preview"/);
});

test("packet errors surface only bounded validation and billing diagnostics", () => {
  const component = source("components/apply-packet-builder.tsx");
  assert.match(component, /function formatAiActionError/);
  assert.match(component, /json\.fieldPath/);
  assert.match(component, /json\?\.billingStatus/);
  assert.match(component, /json\?\.actualCostMicros/);
  assert.match(component, /formatAiActionError\(json,/);
});
