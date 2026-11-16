import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { JobReviewActions } from "@/components/job-review-actions";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const applyUrl = "https://jobs.ashbyhq.com/northwindlabs/00000000-0000-4000-8000-000000000001/application";

test("the Review Queue links the job's application page", async () => {
  const harness = createDomHarness();
  try {
    await harness.render(React.createElement(JobReviewActions, { jobId: "job-1", applyUrl }));
    const link = harness.container.querySelector(`a[href="${applyUrl}"]`);
    assert.equal(link?.textContent, "Apply link");
    assert.equal(harness.container.querySelector("[data-apply-on-company-site]") === null, true);
  } finally {
    await harness.close();
  }
});

test("a job whose job board page is off says to apply on the company site, with no dead link", async () => {
  const harness = createDomHarness();
  try {
    await harness.render(React.createElement(JobReviewActions, { jobId: "job-1", applyUrl, applyOnCompanySite: true }));
    assert.equal(harness.container.querySelector(`a[href="${applyUrl}"]`) === null, true);
    assert.equal(harness.container.querySelector("[data-apply-on-company-site]")?.textContent, "Apply on company site");
  } finally {
    await harness.close();
  }
});
