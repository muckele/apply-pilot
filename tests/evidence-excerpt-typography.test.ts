import assert from "node:assert/strict";
import { test } from "node:test";

import { comparableEvidenceText } from "@/lib/ai/evidence-text";
import { validateAndNormalizeJobMatchOutput } from "@/lib/ai/job-match";

test("evidence comparison ignores dash, quote and space typography but not wording", () => {
  assert.equal(
    comparableEvidenceText("Closed ~30 deals a month at a 40–50% demo‑to‑close rate"),
    comparableEvidenceText("closed ~30 deals a month at a 40-50% demo-to-close rate")
  );
  assert.equal(comparableEvidenceText("Better’s in-house CRM — “Tinman”"), comparableEvidenceText("Better's in-house CRM - \"Tinman\""));
  assert.equal(comparableEvidenceText("$90K – $150K"), comparableEvidenceText("$90K - $150K"));
  assert.notEqual(comparableEvidenceText("40–50% demo-to-close"), comparableEvidenceText("40-60% demo-to-close"));
});

const input = {
  job: { title: "Account Executive", company: "Example", description: "Run demos and close deals with a strong demo-to-close rate." },
  resume: {
    summary: "Seller.",
    workHistory: [{
      company: "Tripadvisor",
      title: "Business Development Executive",
      bullets: ["Owned the full sales cycle, closing ~30 deals a month at a 40–50% demo-to-close rate."]
    }]
  }
};

function output(applicantExcerpt: string) {
  return {
    contractVersion: "3",
    overallFitScore: 80, resumeKeywordScore: 70, skillsMatchScore: 70,
    experienceMatchScore: 80, careerGoalScore: 80, locationWorkStyleScore: 80,
    compensationScore: null, confidenceScore: 70,
    confidenceBasis: "Based on cited submitted fields.",
    factualMatches: [{
      applicantEvidence: [{ ref: "resume.workHistory[0]", excerpt: applicantExcerpt }],
      jobEvidence: [{ ref: "job.description", excerpt: "demo-to-close rate" }],
      supportedKeywords: ["demo-to-close"]
    }],
    requirementGaps: [],
    advice: { keywordsToEmphasize: ["demo-to-close"], resumeAngle: "Lead with closing.", coverLetterAngle: "Cite the close rate." },
    recommendation: "consider"
  };
}

test("job match accepts a quote whose only difference is a plain hyphen for an en dash", () => {
  assert.doesNotThrow(() => validateAndNormalizeJobMatchOutput(input, output("closing ~30 deals a month at a 40-50% demo-to-close rate")));
});

test("job match still rejects a quote that changes a number", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output("closing ~30 deals a month at a 40-60% demo-to-close rate")),
    /unsupported applicant evidence excerpt/
  );
});

test("job match accepts a quote that spans a line break inside a work record", () => {
  const withSource = {
    ...input,
    resume: {
      ...input.resume,
      workHistory: [{
        ...input.resume.workHistory[0],
        sourceText: "Tripadvisor Feb 2022 – Sep 2023\nBusiness Development Executive, SMB Hotels\n•Owned the full sales cycle, closing ~30 deals a month at a 40–50% demo-to-close rate."
      }]
    }
  };
  assert.doesNotThrow(() => validateAndNormalizeJobMatchOutput(
    withSource,
    output("Business Development Executive, SMB Hotels •Owned the full sales cycle, closing ~30 deals a month at a 40–50% demo-to-close rate")
  ));
});

test("a rejected job match logs which field and reference failed, never the quoted text", async () => {
  const { apiErrorResponse } = await import("@/lib/user-context");
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    let failure: unknown;
    try {
      validateAndNormalizeJobMatchOutput(input, output("closing 99 deals a day"));
    } catch (error) {
      failure = error;
    }
    const response = apiErrorResponse(failure);
    assert.equal(response.status, 400);
  } finally {
    console.warn = original;
  }
  const logged = lines.join("\n");
  assert.match(logged, /UNSUPPORTED_APPLICANT_EXCERPT/);
  assert.match(logged, /factualMatches\[0\]\.applicantEvidence\[0\]\.excerpt/);
  assert.doesNotMatch(logged, /closing 99 deals a day/);
});
