import assert from "node:assert/strict";
import test from "node:test";

import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";

const requirements = [
  "Current Quenby certification",
  "Eight or more years of service operations",
  "Enterprise service delivery",
  "Working knowledge of SQL"
];

const output = {
  factualMatches: [
    {
      claim: "Twelve years of service operations.",
      applicantEvidence: [{ ref: "resume.summary", excerpt: "twelve years of experience" }],
      jobEvidence: [{ ref: "job.requirements[1]", excerpt: "Eight or more years of service operations" }]
    },
    {
      claim: "Directed enterprise service delivery.",
      applicantEvidence: [{ ref: "resume.rawText", excerpt: "Directed service delivery for 42 enterprise accounts." }],
      jobEvidence: [{ ref: "job.requirements[2]", excerpt: "Enterprise service delivery" }, { ref: "job.description", excerpt: "delivery" }]
    }
  ],
  requirementGaps: [
    { requirement: "Current Quenby certification", jobRequirement: { ref: "job.requirements[0]", excerpt: "Current Quenby certification" } }
  ]
};

test("each listed requirement is marked shown, not shown, or not assessed from cited lines only", () => {
  const checklist = buildRequirementChecklist(requirements, output);
  assert.deepEqual(checklist.items.map((item) => [item.requirement, item.status]), [
    ["Current Quenby certification", "not_shown"],
    ["Eight or more years of service operations", "shown"],
    ["Enterprise service delivery", "shown"],
    ["Working knowledge of SQL", "not_assessed"]
  ]);
  assert.deepEqual(checklist.counts, { shown: 2, notShown: 1, notAssessed: 1, total: 4 });
  const delivery = checklist.items[2]!;
  assert.equal(delivery.status === "shown" && delivery.resumeLines[0], "Directed service delivery for 42 enterprise accounts.");
  assert.equal(delivery.jobRef, "job.requirements[2]");
});

test("a requirement with both a match and a gap is never counted as shown", () => {
  const checklist = buildRequirementChecklist(requirements, {
    ...output,
    requirementGaps: [...output.requirementGaps, { requirement: "Enterprise service delivery", jobRequirement: { ref: "job.requirements[2]", excerpt: "Enterprise service delivery" } }]
  });
  assert.equal(checklist.items[2]!.status, "not_shown");
  assert.equal(checklist.counts.shown, 1);
});

test("top items put shown and not-shown requirements first and summarise the rest", () => {
  const checklist = buildRequirementChecklist(requirements, output);
  const top = checklist.top(2);
  assert.deepEqual(top.items.map((item) => item.requirement), [
    "Current Quenby certification",
    "Eight or more years of service operations"
  ]);
  assert.deepEqual(top.more, { shown: 1, notShown: 0, notAssessed: 1 });
});

test("postings without a requirements list fall back to the analysis's own cited items", () => {
  const checklist = buildRequirementChecklist([], {
    factualMatches: [{ claim: "Led incident reviews.", applicantEvidence: [{ ref: "resume.rawText", excerpt: "Built weekly governance reviews." }], jobEvidence: [{ ref: "job.description", excerpt: "incident governance" }] }],
    requirementGaps: [{ requirement: "Quenby certification", jobRequirement: { ref: "job.preferredQualifications[0]", excerpt: "Quenby" } }]
  });
  assert.deepEqual(checklist.items.map((item) => [item.requirement, item.status]), [
    ["incident governance", "shown"],
    ["Quenby certification", "not_shown"]
  ]);
  assert.equal(checklist.source, "analysis");
});

test("missing or malformed output yields an all-unassessed checklist", () => {
  const checklist = buildRequirementChecklist(requirements, null);
  assert.equal(checklist.counts.notAssessed, 4);
  assert.equal(checklist.counts.shown, 0);
});
