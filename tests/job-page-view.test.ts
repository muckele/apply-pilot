import assert from "node:assert/strict";
import test from "node:test";

import { JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { buildEstimateView, buildJobDetailView, sourceLabel } from "@/lib/jobs/job-page-view";

const now = new Date("2026-11-05T18:00:00.000Z");

test("the job view uses only listed data, in plain labels", () => {
  const view = buildJobDetailView({
    id: "job-1", title: "Director", company: "Northwind", location: "Remote — US", remoteStatus: "REMOTE",
    salaryMin: 165_000, salaryMax: 195_000, datePosted: new Date("2026-11-03T12:00:00.000Z"), firstDiscoveredAt: new Date("2026-11-04T00:00:00.000Z"),
    sourceType: "GREENHOUSE", description: "Lead delivery. This role is fully remote.", requirements: ["A"], preferredQualifications: ["B"]
  }, now);
  assert.deepEqual(view, {
    id: "job-1", title: "Director", company: "Northwind", location: "Remote — US", workStyle: "Remote",
    salary: "$165k–$195k", postedAge: "2 days ago", source: "Greenhouse",
    description: "Lead delivery. This role is fully remote.", requirements: ["A"], preferredQualifications: ["B"],
    workStyleQuotes: ["This role is fully remote."], listedWorkStyle: "REMOTE"
  });
});

test("missing posting fields stay missing", () => {
  const view = buildJobDetailView({
    id: "job-2", title: "Lead", company: "Litware", location: null, remoteStatus: null, salaryMin: null, salaryMax: null,
    datePosted: null, firstDiscoveredAt: new Date("2026-11-05T09:00:00.000Z"), sourceType: "MANUAL", description: "Lead.",
    requirements: [], preferredQualifications: []
  }, now);
  assert.equal(view.salary, null);
  assert.equal(view.location, null);
  assert.equal(view.workStyle, null);
  assert.equal(view.postedAge, "Today");
  assert.equal(view.source, "Added by you");
});

test("source labels are readable", () => {
  assert.equal(sourceLabel("COMPANY_CAREERS"), "Company careers page");
  assert.equal(sourceLabel("ASHBY"), "Ashby");
  assert.equal(sourceLabel("USAJOBS"), "USAJOBS");
});

test("the estimate view reads angles and salary fit from the scored output", () => {
  const view = buildEstimateView({
    score: 68,
    basis: "MASTER_RESUME",
    analysis: {
      createdAt: new Date("2026-11-05T10:00:00.000Z"),
      output: {
        contractVersion: "3", promptVersion: JOB_MATCH_PROMPT_VERSION, overallFitScore: 68,
        suggestedResumeAngle: "Lead with delivery.", suggestedCoverLetterAngle: "Connect governance.",
        compensationAssessment: { score: null, reason: "missing_job_salary" }
      }
    }
  });
  assert.deepEqual(view, {
    score: 68, basis: "MASTER_RESUME", scoredAt: "2026-11-05T10:00:00.000Z",
    compensation: { score: null, explanation: "Unknown because both job salary bounds are missing." },
    resumeAngle: "Lead with delivery.", coverLetterAngle: "Connect governance."
  });
});
