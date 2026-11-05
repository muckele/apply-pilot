import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JobMatchOutputValidationError,
  normalizeJobMatchOutput,
  validateAndNormalizeJobMatchOutput,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import {
  findTenureGaps,
  describeEvidencedDuration,
  parseTenureRequirement
} from "@/lib/ai/job-match-tenure";

// Synthetic applicants only. The posting line is the public Greenhouse
// requirement that the live 2026-11-05 run failed to report as a gap.
const GUSTO_SHAPED_REQUIREMENT = "Demonstrated 5+ years of hands-on experience in a customer-facing technical role such as Forward Deployed Engineer, Solutions Engineer, AI Engineer, Implementation Engineer, Solutions Architect, Technical Consultant, or similar.";
const AS_OF = new Date("2026-11-05T12:00:00.000Z");

type WorkRole = {
  title: string;
  company: string;
  startDate: string | null;
  endDate: string | null;
  bullets?: string[];
};

function role(value: WorkRole) {
  return {
    sourceText: `${value.title} | ${value.company} | ${value.startDate ?? ""} – ${value.endDate ?? ""}`,
    company: value.company,
    title: value.title,
    location: "Remote",
    startDate: value.startDate,
    endDate: value.endDate,
    bullets: value.bullets ?? []
  };
}

function matchInput(workHistory: WorkRole[], overrides: {
  requirements?: string[];
  summary?: string;
  reviewedFacts?: string[];
} = {}): MatchInput {
  return {
    job: {
      title: "Sales Engineer",
      company: "Synthetic Payroll Co",
      description: "Run technical discovery and demos for small-business payroll customers.",
      requirements: overrides.requirements ?? [
        GUSTO_SHAPED_REQUIREMENT,
        "Working knowledge of REST APIs, webhooks, and idempotency."
      ],
      preferredQualifications: [],
      detectedTechStack: []
    },
    resume: {
      summary: overrides.summary ?? "Revenue and operations professional with 8+ years in sales, account management, and operations.",
      rawText: workHistory.map((entry) => `${entry.title} | ${entry.company}`).join("\n"),
      skills: ["Python"],
      achievements: [],
      workHistory: workHistory.map(role)
    },
    profile: null,
    reviewedEvidence: overrides.reviewedFacts ? {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-1",
      snapshotHash: "a".repeat(64),
      facts: overrides.reviewedFacts.map((fact, index) => ({
        gapId: `gap:${index}`,
        fact,
        provenance: "OWNER_ATTESTED" as const,
        sourceRef: null
      })),
      unresolvedGapIds: []
    } : null
  };
}

const SHORT_TENURE_HISTORY: WorkRole[] = [
  {
    title: "Technical Consultant",
    company: "Northwind Studio",
    startDate: "Jul 2026",
    endDate: "Present",
    bullets: ["Build Zapier and Python automations for small-business clients."]
  },
  {
    title: "Senior Account Manager",
    company: "Contoso Payroll",
    startDate: "Mar 2021",
    endDate: "Jun 2026",
    bullets: ["Managed a book of 120 small-business payroll accounts.", "Partnered with Solutions Engineers on technical demos."]
  },
  { title: "Account Executive", company: "Fabrikam HR", startDate: "Jan 2018", endDate: "Feb 2021" },
  { title: "Operations Coordinator", company: "Tailspin Logistics", startDate: "Jun 2016", endDate: "Dec 2017" }
];

function modelOutput(input: MatchInput, gaps: JobMatchModelOutput["requirementGaps"] = []): JobMatchModelOutput {
  void input;
  return {
    contractVersion: "3",
    overallFitScore: 38,
    resumeKeywordScore: 35,
    skillsMatchScore: 40,
    experienceMatchScore: 30,
    careerGoalScore: 60,
    locationWorkStyleScore: 80,
    compensationScore: null,
    confidenceScore: 55,
    confidenceBasis: "Based on the cited submitted fields; limitations include sparse technical detail.",
    factualMatches: [],
    requirementGaps: gaps,
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "Lead with supported automation work.",
      coverLetterAngle: "Explain the move into technical consulting honestly."
    },
    recommendation: "consider"
  };
}

function apiGap(input: MatchInput, index: number, missingKeywords: string[]) {
  const requirement = input.job.requirements![index];
  return {
    requirement,
    jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirement },
    missingKeywords
  };
}

test("tenure parser reads the Gusto-shaped minimum, its kind and its example roles", () => {
  assert.deepEqual(parseTenureRequirement(GUSTO_SHAPED_REQUIREMENT), {
    minimumMonths: 60,
    requiredLabel: "5+ years",
    kindLabel: "a customer-facing technical role",
    roleAnchors: [
      "Forward Deployed Engineer",
      "Solutions Engineer",
      "AI Engineer",
      "Implementation Engineer",
      "Solutions Architect",
      "Technical Consultant"
    ]
  });
});

test("tenure parser reads 'at least', ranges and 'as a' role lists", () => {
  assert.deepEqual(parseTenureRequirement("At least 3 years of experience as a Solutions Architect."), {
    minimumMonths: 36,
    requiredLabel: "at least 3 years",
    kindLabel: "a Solutions Architect role",
    roleAnchors: ["Solutions Architect"]
  });
  assert.deepEqual(parseTenureRequirement("3–5 years as an Implementation Engineer"), {
    minimumMonths: 36,
    requiredLabel: "3–5 years",
    kindLabel: "an Implementation Engineer role",
    roleAnchors: ["Implementation Engineer"]
  });
  assert.deepEqual(parseTenureRequirement(
    "3+ years as a Solutions Engineer (preferred), Implementation Consultant, Support Engineer, or Software Developer with experience leading projects and/or working with customers."
  ), {
    minimumMonths: 36,
    requiredLabel: "3+ years",
    kindLabel: "a Solutions Engineer, Implementation Consultant, Support Engineer, or Software Developer role",
    roleAnchors: ["Solutions Engineer", "Implementation Consultant", "Support Engineer", "Software Developer"]
  });
  assert.deepEqual(parseTenureRequirement(
    "4+ years of client-facing experience in Programmatic Advertising/Header Bidding Technologies in a Technical Account Management role or equivalent"
  ), {
    minimumMonths: 48,
    requiredLabel: "4+ years",
    kindLabel: "a Technical Account Management role",
    roleAnchors: ["Technical Account Management"]
  });
});

test("tenure parser leaves vague, skill-only and ambiguous duration requirements to the existing rules", () => {
  for (const requirement of [
    "Extensive hands-on experience in a customer-facing technical role such as Solutions Engineer or similar.",
    "5+ years of SQL required",
    "Eight or more years of progressive service operations experience",
    "You have ~1–3 years of experience in Customer Success, Support, Ops, or a similar customer-facing, systems-adjacent role",
    "7+ years of experience, including 3+ years as a Solutions Architect",
    "Promoted to Solutions Engineer within 2 years",
    "Bachelor's degree in Computer Science or 4+ years of experience as a Software Engineer",
    "4+ years as a Software Engineer, or a related degree"
  ]) {
    assert.equal(parseTenureRequirement(requirement), null, requirement);
  }
});

test("evidenced duration wording never rounds up toward the requirement", () => {
  assert.equal(describeEvidencedDuration(0.4), "less than a month");
  assert.equal(describeEvidencedDuration(1), "about 1 month");
  assert.equal(describeEvidencedDuration(4.17), "about 4 months");
  assert.equal(describeEvidencedDuration(12), "about 1 year");
  assert.equal(describeEvidencedDuration(13.9), "about 1 year and 1 month");
  assert.equal(describeEvidencedDuration(36), "about 3 years");
  assert.equal(describeEvidencedDuration(59.9), "about 4 years and 11 months");
});

test("short tenure in matching roles becomes a cited gap; sales roles and 'partnered with' bullets are not counted", () => {
  const input = matchInput(SHORT_TENURE_HISTORY);
  const assessments = findTenureGaps(input, { asOf: AS_OF });

  assert.equal(assessments.length, 1);
  const [assessment] = assessments;
  assert.equal(assessment.requirement, GUSTO_SHAPED_REQUIREMENT);
  assert.deepEqual(assessment.jobRequirement, { ref: "job.requirements[0]", excerpt: GUSTO_SHAPED_REQUIREMENT });
  assert.equal(
    assessment.tenure.summary,
    "Your résumé shows about 4 months in a customer-facing technical role; this job asks for 5+ years."
  );
  assert.equal(assessment.tenure.requiredLabel, "5+ years");
  assert.equal(assessment.tenure.minimumMonths, 60);
  assert.equal(assessment.tenure.evidencedMonths, 4);
  assert.deepEqual(assessment.tenure.countedRoles, [{
    ref: "resume.workHistory[0]",
    excerpt: "Technical Consultant",
    title: "Technical Consultant",
    company: "Northwind Studio",
    startDate: "Jul 2026",
    endDate: "Present"
  }]);
  assert.equal(assessment.tenure.uncountedRoleCount, 3);
});

test("enough tenure in matching roles produces no tenure gap", () => {
  const input = matchInput([
    { title: "Senior Solutions Engineer", company: "Contoso Cloud", startDate: "Jan 2019", endDate: "Present" },
    { title: "Account Executive", company: "Fabrikam HR", startDate: "Jan 2015", endDate: "Dec 2018" }
  ]);
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("similar titles count toward an illustrative role list", () => {
  const input = matchInput([
    { title: "Sales Engineer", company: "Contoso Cloud", startDate: "2018", endDate: "2025" }
  ]);
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("tenure only in unrelated roles is a gap that says the résumé does not show the role", () => {
  const input = matchInput([
    { title: "Account Executive", company: "Fabrikam HR", startDate: "Jan 2015", endDate: "Present", bullets: ["Partnered with Solutions Engineers on demos."] },
    { title: "Operations Coordinator", company: "Tailspin Logistics", startDate: "Jun 2012", endDate: "Dec 2014" }
  ]);
  const [assessment] = findTenureGaps(input, { asOf: AS_OF });
  assert.ok(assessment);
  assert.equal(
    assessment.tenure.summary,
    "Your résumé doesn't show time in a customer-facing technical role; this job asks for 5+ years."
  );
  assert.deepEqual(assessment.tenure.countedRoles, []);
  assert.equal(assessment.tenure.evidencedMonths, 0);
  assert.equal(assessment.tenure.uncountedRoleCount, 2);
});

test("a bullet that says the applicant served in the role counts that role", () => {
  const input = matchInput([
    {
      title: "Founder",
      company: "Northwind Studio",
      startDate: "Jan 2019",
      endDate: "Dec 2025",
      bullets: ["Served as technical consultant for 30 small-business clients."]
    }
  ]);
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("overlapping matching roles are counted once", () => {
  const input = matchInput([
    { title: "Solutions Engineer", company: "Contoso Cloud", startDate: "Jan 2020", endDate: "Dec 2022" },
    { title: "Solutions Architect (contract)", company: "Fabrikam Labs", startDate: "Jan 2021", endDate: "Dec 2021" }
  ]);
  const [assessment] = findTenureGaps(input, { asOf: AS_OF });
  assert.ok(assessment);
  assert.equal(assessment.tenure.evidencedMonths, 36);
  assert.equal(
    assessment.tenure.summary,
    "Your résumé shows about 3 years in a customer-facing technical role; this job asks for 5+ years."
  );
  assert.deepEqual(assessment.tenure.countedRoles.map((entry) => entry.ref), [
    "resume.workHistory[0]",
    "resume.workHistory[1]"
  ]);
});

test("an undated matching role makes the duration unknown, so no gap is claimed", () => {
  const input = matchInput([
    { title: "Technical Consultant", company: "Northwind Studio", startDate: "Jul 2026", endDate: "Present" },
    { title: "Solutions Engineer", company: "Contoso Cloud", startDate: null, endDate: null }
  ]);
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("missing structured work history is not treated as zero tenure", () => {
  const input = matchInput([]);
  input.resume!.workHistory = undefined;
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
  input.resume!.workHistory = [];
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("a duration the résumé states for that kind of role is not contradicted", () => {
  const input = matchInput(SHORT_TENURE_HISTORY, {
    summary: "Solutions Engineer with 6 years of experience running technical demos."
  });
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("a stated duration for a different kind of work does not hide the gap", () => {
  const input = matchInput(SHORT_TENURE_HISTORY, {
    summary: "Sales leader with 8+ years of experience, recently working as a technical consultant."
  });
  assert.equal(findTenureGaps(input, { asOf: AS_OF }).length, 1);
});

test("owner-attested reviewed evidence stating enough tenure clears the tenure gap", () => {
  const input = matchInput(SHORT_TENURE_HISTORY, {
    reviewedFacts: ["I worked 6 years as a Solutions Engineer at a prior employer not listed on this résumé."]
  });
  assert.deepEqual(findTenureGaps(input, { asOf: AS_OF }), []);
});

test("a requirement with no number is unchanged", () => {
  const vague = "Extensive hands-on experience in a customer-facing technical role such as Solutions Engineer or similar.";
  const input = matchInput(SHORT_TENURE_HISTORY, { requirements: [vague] });
  const before = modelOutput(input);
  const normalized = normalizeJobMatchOutput(input, before, { asOf: AS_OF });
  assert.deepEqual(normalized.requirementGaps, []);
  assert.deepEqual(normalized.concerns, []);
});

test("normalized job match appends the tenure gap after model gaps without inventing missing keywords", () => {
  const input = matchInput(SHORT_TENURE_HISTORY);
  const normalized = normalizeJobMatchOutput(input, modelOutput(input, [apiGap(input, 1, ["webhooks", "idempotency"])]), {
    asOf: AS_OF
  });

  assert.deepEqual(normalized.requirementGaps.map((gap) => gap.jobRequirement.ref), [
    "job.requirements[1]",
    "job.requirements[0]"
  ]);
  const tenureGap = normalized.requirementGaps[1];
  assert.equal(tenureGap.requirement, GUSTO_SHAPED_REQUIREMENT);
  assert.deepEqual(tenureGap.missingKeywords, []);
  assert.equal(
    tenureGap.tenure?.summary,
    "Your résumé shows about 4 months in a customer-facing technical role; this job asks for 5+ years."
  );
  assert.equal(normalized.requirementGaps[0].tenure, undefined);
  assert.deepEqual(normalized.missingKeywords, ["webhooks", "idempotency"]);
  assert.deepEqual(normalized.concerns, [input.job.requirements![1], GUSTO_SHAPED_REQUIREMENT]);
});

test("a model gap for the same requirement keeps its keywords and gains the tenure finding", () => {
  const input = matchInput(SHORT_TENURE_HISTORY);
  const normalized = normalizeJobMatchOutput(input, modelOutput(input, [apiGap(input, 0, ["Demonstrated"])]), {
    asOf: AS_OF
  });
  assert.equal(normalized.requirementGaps.length, 1);
  assert.deepEqual(normalized.requirementGaps[0].missingKeywords, ["Demonstrated"]);
  assert.equal(normalized.requirementGaps[0].tenure?.evidencedMonths, 4);
});

test("enough tenure leaves the normalized gap list exactly as the model returned it", () => {
  const input = matchInput([
    { title: "Solutions Engineer", company: "Contoso Cloud", startDate: "Jan 2019", endDate: "Present" }
  ]);
  const gaps = [apiGap(input, 1, ["webhooks", "idempotency"])];
  const normalized = normalizeJobMatchOutput(input, modelOutput(input, gaps), { asOf: AS_OF });
  assert.deepEqual(normalized.requirementGaps, gaps);
});

test("root cause stays pinned: the keyword gap rules cannot express the tenure requirement themselves", () => {
  const input = matchInput(SHORT_TENURE_HISTORY);
  for (const [keyword, code] of [
    ["Forward Deployed Engineer", "GAP_KEYWORD_ILLUSTRATIVE_ONLY"],
    ["years", "GAP_KEYWORD_PRESENT_IN_APPLICANT_EVIDENCE"],
    ["technical", "GAP_KEYWORD_PRESENT_IN_APPLICANT_EVIDENCE"]
  ] as const) {
    assert.throws(
      () => validateAndNormalizeJobMatchOutput(input, modelOutput(input, [apiGap(input, 0, [keyword])])),
      (error: unknown) => error instanceof JobMatchOutputValidationError && error.validationCode === code,
      keyword
    );
  }
});
