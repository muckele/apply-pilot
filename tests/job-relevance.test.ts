import assert from "node:assert/strict";
import { test } from "node:test";

import { getPreImportRejectionReason } from "@/lib/job-sources/discovery";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import { isRemoteLikeText } from "@/lib/job-sources/remote";
import type { NormalizedJob } from "@/lib/job-sources/types";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    title: "Solutions Engineer",
    company: "Example Co",
    location: "Los Angeles, CA",
    remoteStatus: "Hybrid",
    sourceUrl: "https://example.com/jobs/1",
    description: "",
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: [],
    sourceType: "MANUAL",
    ...overrides
  };
}

test("title match alone cannot carry an unrelated posting into review", () => {
  const result = scoreJobRelevance({
    job: job({
      title: "Solutions Engineer",
      description:
        "Mature and operationalize ransomware recovery governance. Develop risk heat maps, executive reporting, and recovery tracking dashboards."
    }),
    profile: null,
    query: "Solutions Engineer"
  });

  assert.equal(result.decision, "skip");
  assert.ok(result.score < 60);
});

test("references to a director in the body do not hard-exclude a good target role", () => {
  const result = scoreJobRelevance({
    job: job({
      title: "Solutions Engineer",
      description:
        "Partner with customers on technical discovery, product demos, API integrations, onboarding, implementation, and training. This role reports to the Director of Sales Engineering.",
      detectedTechStack: ["JavaScript", "REST APIs", "SQL"]
    }),
    profile: null,
    query: "Solutions Engineer"
  });

  assert.equal(result.hardExcluded, false);
  assert.notEqual(result.decision, "skip");
});

test("seniority exclusions still apply to title and seniority fields", () => {
  const result = scoreJobRelevance({
    job: job({
      title: "Director of Solutions Engineering",
      description: "Lead customer discovery, technical demos, implementation, and API integration strategy."
    }),
    profile: null,
    query: "Solutions Engineer"
  });

  assert.equal(result.hardExcluded, true);
  assert.equal(result.decision, "skip");
});

test("remote matching accepts common remote location variants", () => {
  assert.equal(isRemoteLikeText("Remote, US"), true);
  assert.equal(isRemoteLikeText("Remote - United States"), true);
  assert.equal(isRemoteLikeText("Los Angeles, CA"), false);
});

test("remote matching rejects negated remote language", () => {
  assert.equal(isRemoteLikeText("Hybrid, not remote"), false);
  assert.equal(isRemoteLikeText("This role is not remote and must be onsite."), false);
  assert.equal(isRemoteLikeText("No remote work available."), false);
});

test("healthcare stakeholder text does not hard-exclude implementation roles", () => {
  const result = scoreJobRelevance({
    job: job({
      title: "Implementation Specialist",
      description:
        "Implement healthcare workflows, train nurses and physician office staff, support client onboarding, and configure scheduling and billing integrations.",
      detectedTechStack: ["SQL", "REST APIs"]
    }),
    profile: null,
    query: "Implementation Specialist"
  });

  assert.equal(result.hardExcluded, false);
  assert.notEqual(result.decision, "skip");
});

test("healthcare practitioner titles are still hard-excluded", () => {
  const result = scoreJobRelevance({
    job: job({
      title: "Registered Nurse",
      description: "Provide patient care and coordinate clinical workflows."
    }),
    profile: null,
    query: "Nurse"
  });

  assert.equal(result.hardExcluded, true);
  assert.equal(result.decision, "skip");
});

test("pre-import filtering rejects stale postings before they hit the CRM", () => {
  const staleJob = job({
    datePosted: new Date(Date.now() - 45 * 86_400_000),
    description: "Support customer implementation, API integrations, workflow troubleshooting, and SaaS onboarding."
  });
  const relevance = scoreJobRelevance({ job: staleJob, profile: null });

  assert.match(
    getPreImportRejectionReason({ job: staleJob, profile: null, relevance }) ?? "",
    /older than 30 days/
  );
});

test("pre-import filtering rejects salary ranges below target when salary is available", () => {
  const lowSalaryJob = job({
    salaryMin: 45_000,
    salaryMax: 55_000,
    description: "Lead customer implementation, API integrations, workflow troubleshooting, and SaaS onboarding."
  });
  const relevance = scoreJobRelevance({ job: lowSalaryJob, profile: null });

  assert.match(
    getPreImportRejectionReason({
      job: lowSalaryJob,
      profile: {
        salaryTargetMin: 85_000,
        salaryTargetMax: 120_000,
        preferredLocations: ["Los Angeles, CA"],
        remotePreference: "FLEXIBLE",
        preferredRoles: [],
        skillsToEmphasize: [],
        dealBreakers: []
      } as never,
      relevance
    }) ?? "",
    /below the target range/
  );
});
