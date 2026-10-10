import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JobMatchOmissionNotice,
  summarizeBoundedJobResults
} from "@/components/job-match-omission-notice";

test("bounded omission notices distinguish exact counts from lower bounds", () => {
  const exact = renderToStaticMarkup(React.createElement(JobMatchOmissionNotice, {
    evaluatedCandidateCount: 500,
    omittedCandidateCount: 12,
    viewLabel: "jobs view"
  }));
  const lowerBound = renderToStaticMarkup(React.createElement(JobMatchOmissionNotice, {
    evaluatedCandidateCount: 500,
    omittedCandidateCount: 1,
    omittedCountIsLowerBound: true,
    viewLabel: "dashboard view"
  }));

  assert.match(exact, /500 candidates checked; 12 additional candidates omitted/);
  assert.match(lowerBound, /500 candidates checked; at least 1 additional candidate omitted/);
});

test("bounded job results count display-cap omissions and separately disclose unevaluated candidates", () => {
  assert.deepEqual(summarizeBoundedJobResults({
    evaluatedCandidateCount: 400,
    evaluatedMatchingCount: 100,
    totalCandidateCount: 400,
    visibleCount: 40
  }), {
    omittedCandidateCount: 60,
    unevaluatedCandidateCount: 0
  });
  assert.deepEqual(summarizeBoundedJobResults({
    evaluatedCandidateCount: 500,
    evaluatedMatchingCount: 120,
    totalCandidateCount: 725,
    visibleCount: 100
  }), {
    omittedCandidateCount: 20,
    unevaluatedCandidateCount: 225
  });

  const combined = renderToStaticMarkup(React.createElement(JobMatchOmissionNotice, {
    evaluatedCandidateCount: 500,
    omittedCandidateCount: 20,
    unevaluatedCandidateCount: 225,
    viewLabel: "review view"
  }));
  assert.match(combined, /20 additional evaluated matches omitted from this bounded review view/i);
  assert.match(combined, /225 candidates were not evaluated and may contain more matches/i);
});
