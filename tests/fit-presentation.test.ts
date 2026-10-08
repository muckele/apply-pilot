import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplyPacketBuilder } from "@/components/apply-packet-builder";
import { JobCard } from "@/components/job-card";

import { ScoreBadge } from "@/components/ui";

function renderBadge(score: number | null | undefined) {
  return renderToStaticMarkup(React.createElement(ScoreBadge, { score }));
}

test("fit badge renders unknown and invalid values as Unscored", () => {
  for (const score of [null, undefined, Number.NaN, Infinity, -Infinity, -1, 101]) {
    const html = renderBadge(score);
    assert.match(html, /Unscored/);
    assert.doesNotMatch(html, /(?:NaN|Infinity|50)%|0% fit/);
  }
});

test("fit badge preserves genuine zero and numeric scores", () => {
  assert.match(renderBadge(0), /0% fit/);
  assert.match(renderBadge(81), /81% fit/);
  assert.doesNotMatch(renderBadge(0), /Unscored/);
});

test("aggregate fit label distinguishes no scored jobs from zero and a real average", async () => {
  const { formatAverageFit } = await import("@/lib/jobs/fit-presentation");
  for (const value of [null, undefined]) {
    assert.equal(formatAverageFit(value), "No scored jobs");
  }
  for (const value of [Number.NaN, Infinity, -Infinity, -1, 101, "50"]) {
    assert.equal(formatAverageFit(value), "Score unavailable");
  }
  assert.equal(formatAverageFit(0), "0%");
  assert.equal(formatAverageFit(72.4), "72%");
});

test("job detail fit presentation keeps zero scored and avoids a fixed applicant persona", async () => {
  const { getJobFitPresentation } = await import("@/lib/jobs/fit-presentation");
  const unscored = getJobFitPresentation({
    overallFitScore: null,
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  });
  assert.equal(unscored.fitScore, null);
  assert.equal(unscored.hasFitAnalysis, false);
  assert.match(unscored.suggestedResumeAngle, /actual experience/i);
  assert.match(unscored.suggestedCoverLetterAngle, /verified experience/i);
  assert.doesNotMatch(JSON.stringify(unscored), /Mathew|Uckele|software training|operations leadership/i);

  const zero = getJobFitPresentation({
    overallFitScore: 0,
    suggestedResumeAngle: "Existing personalized resume guidance.",
    suggestedCoverLetterAngle: "Existing personalized cover-letter guidance."
  });
  assert.equal(zero.fitScore, 0);
  assert.equal(zero.hasFitAnalysis, true);
  assert.equal(zero.suggestedResumeAngle, "Existing personalized resume guidance.");
  assert.equal(zero.suggestedCoverLetterAngle, "Existing personalized cover-letter guidance.");

  const invalid = getJobFitPresentation({
    overallFitScore: Number.NaN,
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  });
  assert.equal(invalid.fitScore, null);
  assert.equal(invalid.hasFitAnalysis, false);

  const blankGuidance = getJobFitPresentation({
    overallFitScore: null,
    suggestedResumeAngle: "  ",
    suggestedCoverLetterAngle: "  "
  });
  assert.match(blankGuidance.suggestedResumeAngle, /actual experience/i);
  assert.match(blankGuidance.suggestedCoverLetterAngle, /verified experience/i);
});

test("v3 fit presentation labels confidence as uncalibrated and explains unknown compensation", async () => {
  const { getJobMatchAnalysisPresentation } = await import("@/lib/jobs/fit-presentation");
  const presentation = getJobMatchAnalysisPresentation(
    {
      overallFitScore: 82,
      compensationScore: null,
      confidenceScore: 79,
      keyMatchReason: "Legacy projection",
      concerns: ["Legacy concern"],
      suggestedResumeAngle: "Validated advice",
      suggestedCoverLetterAngle: "Validated letter advice"
    },
    {
      contractVersion: "3",
      promptVersion: "3.4",
      compensationAssessment: { score: null, reason: "missing_applicant_salary_target" },
      confidenceAssessment: {
        score: 79,
        label: "Uncalibrated model self-assessment",
        basis: "Based on cited submitted fields."
      },
      factualMatches: [{
        claim: "TypeScript evidence matches the requirement.",
        applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }],
        jobEvidence: [{ ref: "job.requirements[0]", excerpt: "TypeScript" }],
        supportedKeywords: ["TypeScript"]
      }],
      requirementGaps: [{
        requirement: "Kubernetes",
        jobRequirement: { ref: "job.preferredQualifications[0]", excerpt: "Kubernetes" },
        missingKeywords: ["Kubernetes"]
      }]
    }
  );

  assert.equal(presentation.confidence?.label, "Uncalibrated model self-assessment");
  assert.equal(presentation.confidence?.basis, "Based on cited submitted fields.");
  assert.equal(presentation.compensation.score, null);
  assert.match(presentation.compensation.explanation, /applicant salary target is missing/i);
  assert.equal(presentation.factualMatches[0].claim, "TypeScript evidence matches the requirement.");
  assert.equal(presentation.requirementGaps[0].requirement, "Kubernetes");
  assert.equal(presentation.isLegacyAnalysis, false);
  assert.equal(presentation.isCurrentAnalysis, true);
});

test("no current analysis does not present denormalized legacy scores or gaps as current", async () => {
  const { getJobMatchAnalysisPresentation } = await import("@/lib/jobs/fit-presentation");
  const presentation = getJobMatchAnalysisPresentation({
    overallFitScore: 91,
    compensationScore: 88,
    confidenceScore: 90,
    keyMatchReason: "Stale match reason",
    concerns: ["Stale requirement gap"],
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  }, null);

  assert.equal(presentation.hasFitAnalysis, false);
  assert.equal(presentation.fitScore, null);
  assert.equal(presentation.confidence, null);
  assert.equal(presentation.compensation.score, null);
  assert.deepEqual(presentation.factualMatches, []);
  assert.deepEqual(presentation.requirementGaps, []);
  assert.equal(presentation.isCurrentAnalysis, false);
});

test("a stale prompt analysis cannot leak denormalized document advice", async () => {
  const { getJobMatchAnalysisPresentation } = await import("@/lib/jobs/fit-presentation");
  const presentation = getJobMatchAnalysisPresentation({
    overallFitScore: 91,
    compensationScore: 88,
    confidenceScore: 90,
    keyMatchReason: "Stale match reason",
    concerns: ["Stale requirement gap"],
    suggestedResumeAngle: "STALE PRIVATE RESUME ANGLE",
    suggestedCoverLetterAngle: "STALE PRIVATE COVER ANGLE"
  }, {
    contractVersion: "3",
    promptVersion: "3.2"
  });

  assert.equal(presentation.fitScore, null);
  assert.equal(presentation.hasFitAnalysis, false);
  assert.match(presentation.suggestedResumeAngle, /actual experience/i);
  assert.match(presentation.suggestedCoverLetterAngle, /verified experience/i);
  assert.doesNotMatch(JSON.stringify(presentation), /STALE PRIVATE/);
});

test("client-used fit presentation depends only on the lightweight version module", () => {
  const source = readFileSync("lib/jobs/fit-presentation.ts", "utf8");
  assert.match(source, /@\/lib\/ai\/job-match-version/);
  assert.doesNotMatch(source, /@\/lib\/ai\/job-match["']/);
});

test("legacy analysis is isolated instead of presenting stale denormalized fields", async () => {
  const { getJobMatchAnalysisPresentation } = await import("@/lib/jobs/fit-presentation");
  const presentation = getJobMatchAnalysisPresentation(
    {
      overallFitScore: 0,
      compensationScore: 0,
      confidenceScore: 0,
      keyMatchReason: "Legacy recorded reason",
      concerns: ["Legacy recorded concern"],
      suggestedResumeAngle: null,
      suggestedCoverLetterAngle: null
    },
    { overallFitScore: 0, confidenceScore: 0 }
  );

  assert.equal(presentation.fitScore, null);
  assert.equal(presentation.compensation.score, null);
  assert.match(presentation.compensation.explanation, /legacy analysis/i);
  assert.equal(presentation.confidence, null);
  assert.deepEqual(presentation.factualMatches, []);
  assert.deepEqual(presentation.requirementGaps, []);
  assert.match(presentation.suggestedResumeAngle, /actual experience/i);
  assert.match(presentation.suggestedCoverLetterAngle, /verified experience/i);
  assert.equal(presentation.isLegacyAnalysis, true);
});

function renderWithRouter(element: React.ReactElement) {
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never }, element));
}

test("job card renders a null fit as Unscored without hiding manual actions", () => {
  const html = renderWithRouter(React.createElement(JobCard, {
    job: {
      id: "job-1", title: "Solutions Engineer", company: "Example Co", location: "Remote",
      remoteStatus: "Remote", salary: "Salary not listed", datePosted: "2026-09-22",
      fitScore: null, status: "ACTIVE", keyReason: "Review this posting."
    }
  }));
  assert.match(html, /Unscored/);
  assert.match(html, /Review this posting/);
  assert.match(html, /Save/);
  assert.match(html, /Mark applied/);
  assert.doesNotMatch(html, /50% fit/);
});

test("apply packet renders unknown resume metrics without fake percentages and keeps zero", () => {
  function packet(score: number | null, resumeScore: number | null) {
    return renderWithRouter(React.createElement(ApplyPacketBuilder, {
      job: {
        id: "job-1", title: "Solutions Engineer", company: "Example Co",
        applyUrl: "https://example.com/apply", fitScore: score,
        recommendation: "Review", keyReason: "Review actual evidence.", hasFitAnalysis: score !== null
      },
      resumeVersions: [{
        id: "resume-1", title: "Resume", atsCompatibility: resumeScore,
        jobFitScore: resumeScore, evidenceCurrent: true, createdAt: "2026-09-22T00:00:00.000Z"
      }],
      coverLetters: [], application: null
    }));
  }

  const unknown = packet(null, null);
  assert.match(unknown, /Unscored/);
  assert.match(unknown, /ATS unscored/);
  assert.match(unknown, /Fit unscored/);
  assert.doesNotMatch(unknown, /-%|50% fit/);
  assert.match(unknown, /Score match/);

  const zero = packet(0, 0);
  assert.match(zero, /0% fit/);
  assert.match(zero, /0% ATS/);
  assert.doesNotMatch(zero, /ATS unscored|Fit unscored/);
});
