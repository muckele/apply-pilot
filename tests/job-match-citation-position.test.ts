import assert from "node:assert/strict";
import { test } from "node:test";

import { validateAndNormalizeJobMatchOutput } from "@/lib/ai/job-match";

// Live case: the model quoted "Salesforce" (skills[35]) but cited resume.skills[34].
const input = {
  job: {
    title: "Small Business Account Executive",
    company: "Example",
    description: "Manage your pipeline in Salesforce.",
    requirements: ["Experience running full-cycle sales.", "Pipeline hygiene in Salesforce."]
  },
  resume: { summary: "Seller.", skills: ["referral partnerships", "Salesforce", "HubSpot"] }
};

function output(applicantRef: string, excerpt: string, gapRef = "job.requirements[0]") {
  return {
    contractVersion: "3",
    overallFitScore: 75, resumeKeywordScore: 70, skillsMatchScore: 70,
    experienceMatchScore: 70, careerGoalScore: 70, locationWorkStyleScore: 70,
    compensationScore: null, confidenceScore: 70,
    confidenceBasis: "Based on cited submitted fields.",
    factualMatches: [{
      applicantEvidence: [{ ref: applicantRef, excerpt }],
      jobEvidence: [{ ref: "job.description", excerpt: "Salesforce" }],
      supportedKeywords: ["Salesforce"]
    }],
    requirementGaps: [{
      requirement: "Experience running full-cycle sales.",
      jobRequirement: { ref: gapRef, excerpt: "Experience running full-cycle sales." },
      missingKeywords: ["full-cycle"]
    }],
    advice: { keywordsToEmphasize: ["Salesforce"], resumeAngle: "Lead with Salesforce.", coverLetterAngle: "Mention Salesforce." },
    recommendation: "consider"
  };
}

test("a verbatim quote cited at a neighbouring list position is re-pointed to the item that contains it", () => {
  const { normalized } = validateAndNormalizeJobMatchOutput(input, output("resume.skills[0]", "Salesforce"));
  assert.equal(normalized.factualMatches[0]!.applicantEvidence[0]!.ref, "resume.skills[1]");
});

test("a gap whose requirement text sits at a neighbouring position is re-pointed too", () => {
  const { normalized } = validateAndNormalizeJobMatchOutput(input, output("resume.skills[1]", "Salesforce", "job.requirements[1]"));
  assert.equal(normalized.requirementGaps[0]!.jobRequirement.ref, "job.requirements[0]");
});

test("a quote that is in no item of the list is still rejected", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output("resume.skills[0]", "Marketo")),
    /unsupported applicant evidence excerpt/
  );
});

test("a citation to a position that does not exist is still rejected, not re-pointed", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output("resume.skills[99]", "Salesforce")),
    /unknown applicant evidence reference/
  );
});
