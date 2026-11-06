import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  type ApplicationDocumentCitation
} from "@/lib/ai/application-document-claims";
import { PublicApiError } from "@/lib/api-errors";

// Fully synthetic applicant. Rewording rules for tailored résumés: a line may reorder, re-inflect,
// condense or combine its cited facts, but every word, number, name and qualifier stays sourced.
const BULLETS = {
  revenue: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023; ranked first of 14 reps.",
  pipeline: "Managed a pipeline of 140 accounts in Salesforce.",
  assisted: "Assisted the regional director in onboarding 30 franchise owners.",
  onboarding: "Reduced onboarding time from 5 days to 2 by rewriting the handoff checklist.",
  meetings: "Booked 220 qualified meetings for senior account executives.",
  former: "Former team lead for the night shift.",
  renewals: "Never missed a renewal deadline in 3 years."
};
const OWNER_FACT = "I managed a book of 60 SMB merchants generating $40M in annual GMV at Northwind Payments.";

const payload = {
  job: {
    title: "SMB Account Executive",
    company: "Example Buyer Co",
    description: "Own a territory of SMB merchants, grow GMV and build pipeline.",
    requirements: ["Salesforce proficiency"],
    preferredQualifications: [],
    detectedTechStack: ["Salesforce"]
  },
  resume: {
    rawText: [
      "Riley Synthetic",
      "EXPERIENCE",
      "Northwind Payments | Account Executive | 2021–Present",
      `• ${BULLETS.revenue}`, `• ${BULLETS.pipeline}`, `• ${BULLETS.assisted}`, `• ${BULLETS.onboarding}`, `• ${BULLETS.renewals}`,
      "Fabrikam Software | Sales Development Representative | 2018–2021",
      `• ${BULLETS.meetings}`, `• ${BULLETS.former}`
    ].join("\n"),
    summary: "",
    skills: ["Salesforce", "Gong"],
    achievements: [],
    workHistory: [
      {
        sourceText: ["Northwind Payments | Account Executive | 2021–Present", BULLETS.revenue, BULLETS.pipeline, BULLETS.assisted, BULLETS.onboarding, BULLETS.renewals].join("\n"),
        company: "Northwind Payments",
        title: "Account Executive",
        bullets: [BULLETS.revenue, BULLETS.pipeline, BULLETS.assisted, BULLETS.onboarding, BULLETS.renewals]
      },
      {
        sourceText: ["Fabrikam Software | Sales Development Representative | 2018–2021", BULLETS.meetings, BULLETS.former].join("\n"),
        company: "Fabrikam Software",
        title: "Sales Development Representative",
        bullets: [BULLETS.meetings, BULLETS.former]
      }
    ],
    projects: [],
    education: [],
    certifications: []
  },
  profile: { skillsToEmphasize: [] as string[], skillsNotToExaggerate: [] as string[] },
  reviewedEvidence: {
    facts: [{ gapId: "gap:0", fact: OWNER_FACT, provenance: "OWNER_ATTESTED", sourceRef: null }]
  }
};

const job0 = "resume.workHistory[0]";
const job1 = "resume.workHistory[1]";
const owner = "reviewedEvidence.facts[0].fact";

function resume(claim: string, citations: ApplicationDocumentCitation[]) {
  return {
    professionalSummary: "",
    skillsSection: [] as string[],
    bulletRewrites: [] as Array<{ original: string; rewrite: string; reason: string }>,
    rolesOrProjectsToEmphasize: [] as string[],
    resumeText: `EXPERIENCE\n• ${claim}`,
    claimEvidence: [{ claim, citations }]
  };
}

function accepted(claim: string, citations: ApplicationDocumentCitation[], source = payload) {
  const output = resume(claim, citations);
  assert.deepEqual(validateTailoredResumeClaims(source, output), output, claim);
}

function rejected(claim: string, citations: ApplicationDocumentCitation[], source: object = payload) {
  assert.throws(
    () => validateTailoredResumeClaims(source, resume(claim, citations)),
    (error: unknown) => error instanceof PublicApiError &&
      ["APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "APPLICATION_DOCUMENT_NEGATION_REVERSAL"].includes(String(error.details?.code)),
    claim
  );
}

test("a résumé line may reorder, re-inflect and condense its cited fact", () => {
  accepted("Rewrote the handoff checklist, reducing onboarding time from 5 days to 2.",
    [{ ref: job0, excerpt: BULLETS.onboarding }]);
  accepted("Managed a Salesforce pipeline of 140 accounts.",
    [{ ref: job0, excerpt: BULLETS.pipeline }]);
  accepted("Booked 220 qualified meetings for senior account executives.",
    [{ ref: job1, excerpt: BULLETS.meetings }]);
});

test("a résumé line may keep a whole multi-clause bullet by citing every fact in it", () => {
  accepted(BULLETS.revenue, [
    { ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" },
    { ref: job0, excerpt: "ranked first of 14 reps." }
  ]);
  accepted("Closed $1.2M in new annual revenue from 85 small-business merchants in 2023, ranking first of 14 reps.", [
    { ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" },
    { ref: job0, excerpt: "ranked first of 14 reps." }
  ]);
});

test("an owner-attested fact may be condensed into résumé wording", () => {
  accepted("Managed a book of 60 SMB merchants generating $40M in annual GMV.", [{ ref: owner, excerpt: OWNER_FACT }]);
});

test("a rewrite cannot add or change a metric, number, tool, employer, job term or seniority", () => {
  const revenue = [{ ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" }];
  rejected("Closed $1.5M in new annual revenue from 85 small-business merchants in 2023.", revenue);
  rejected("Closed $1.2M in new annual GMV from 85 small-business merchants in 2023.", revenue);
  rejected("Closed $1.2M in new annual revenue from 85 SMB merchants in 2023.", revenue);
  rejected("Closed $1.2M in new annual revenue from 85 small-business merchants at Contoso in 2023.", revenue);
  const pipeline = [{ ref: job0, excerpt: BULLETS.pipeline }];
  rejected("Managed a pipeline of 140 accounts in Salesforce and Gong.", pipeline);
  rejected("Led a pipeline of 140 accounts in Salesforce.", pipeline);
  rejected("Managed a pipeline of 140 merchants in Salesforce.", pipeline);
  rejected("Managed a territory pipeline of 140 accounts in Salesforce.", pipeline);
  rejected("Managed a pipeline of 140 enterprise accounts in Salesforce.", pipeline);
});

test("a rewrite cannot swap numbers or move them onto other nouns", () => {
  const onboarding = [{ ref: job0, excerpt: BULLETS.onboarding }];
  rejected("Reduced onboarding time from 2 days to 5 by rewriting the handoff checklist.", onboarding);
  rejected("Reduced onboarding time to 5 days from 2 by rewriting the handoff checklist.", onboarding);
  const both = [
    { ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" },
    { ref: job0, excerpt: "ranked first of 14 reps." }
  ];
  rejected("Closed $1.2M in new annual revenue from 14 small-business merchants in 2023, ranking first of 85 reps.", both);
});

test("a rewrite cannot drop a qualifier, ownership, status or negation", () => {
  rejected("Onboarded 30 franchise owners with the regional director.", [{ ref: job0, excerpt: BULLETS.assisted }]);
  rejected("Onboarded 30 franchise owners.", [{ ref: job0, excerpt: BULLETS.assisted }]);
  rejected("Team lead for the night shift.", [{ ref: job1, excerpt: BULLETS.former }]);
  rejected("Missed a renewal deadline in 3 years.", [{ ref: job0, excerpt: BULLETS.renewals }]);
  for (const [source, claim] of [
    ["AWS experience: none.", "AWS experience."],
    ["Security clearance expired.", "Security clearance."],
    ["CPA license is inactive.", "CPA license."],
    ["Kubernetes experience: 0 years.", "Kubernetes experience."],
    ["Aspiring Kubernetes architect.", "Kubernetes architect."],
    ["Studying for CPA certification.", "CPA certification."],
    ["Worked under a licensed CPA.", "Licensed CPA."],
    ["Seeking security clearance.", "Security clearance."],
    ["Eligible to apply for RN licensure.", "RN licensure."],
    ["Former security-cleared engineer.", "Security-cleared engineer."],
    ["I was a licensed CPA.", "I am a licensed CPA."],
    ["I had a valid security clearance.", "I have a valid security clearance."],
    ["Their patent won an award.", "My patent won an award."],
    ["Started after 2022.", "Started before 2022."],
    ["Worked within 10 months.", "Worked over 10 months."],
    ["Worked with Google.", "Worked for Google."],
    ["Sold to Walmart via Target's platform.", "Sold to Target via Walmart's platform."],
    ["Reduced latency 20%. Managed 10 engineers.", "Reduced latency 10%."],
    ["Increased sales; supported 10 customers.", "Increased sales for 10 customers."],
    ["Supported 10 engineers.", "Led 10 engineers."]
  ]) {
    const qualified = structuredClone(payload);
    qualified.resume.rawText = `Riley Synthetic\n${source}`;
    rejected(claim, [{ ref: "resume.rawText", excerpt: source }], qualified);
  }
});

test("facts cannot be combined across jobs, and every cited fact must be expressed", () => {
  rejected("Closed $1.2M in new annual revenue and booked 220 qualified meetings.", [
    { ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" },
    { ref: job1, excerpt: BULLETS.meetings }
  ]);
  rejected("Ranked first of 14 reps.", [
    { ref: job0, excerpt: "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023" },
    { ref: job0, excerpt: "ranked first of 14 reps." }
  ]);
});

test("a skills line may list verbatim cited skills under the source category label only", () => {
  const skills = structuredClone(payload);
  skills.resume.rawText = "Riley Synthetic\nSKILLS\nSales tools: Salesforce, HubSpot, Outreach\nLanguages: Spanish (conversational), French";
  skills.resume.skills = ["Salesforce", "HubSpot", "Outreach", "Spanish (conversational)", "French"];
  const category = { ref: "resume.rawText", excerpt: "Sales tools: Salesforce, HubSpot, Outreach" };
  accepted("Sales tools: Salesforce, HubSpot", [category], skills);
  accepted("Sales tools: Salesforce, Outreach", [category,
    { ref: "resume.skills[0]", excerpt: "Salesforce" }, { ref: "resume.skills[2]", excerpt: "Outreach" }], skills);
  rejected("CRM tools: Salesforce, HubSpot", [category], skills);
  rejected("Sales tools: Salesforce, Gong", [category, { ref: "resume.skills[0]", excerpt: "Salesforce" }], skills);
  rejected("Languages: Spanish, French", [{ ref: "resume.rawText", excerpt: "Languages: Spanish (conversational), French" }], skills);
  rejected("Closed deals with Salesforce, HubSpot", [category, { ref: "resume.skills[0]", excerpt: "Salesforce" }], skills);
});

test("cover letters keep the existing exact-wording grammar", () => {
  const claim = "I rewrote the handoff checklist, reducing onboarding time from 5 days to 2.";
  assert.throws(
    () => validateCoverLetterClaims(payload, {
      coverLetter: `Dear Example Buyer Co Hiring Team,\n\n${claim}\n\nSincerely,\nRiley Synthetic`,
      claimsUsed: [{ claim, citations: [{ ref: job0, excerpt: BULLETS.onboarding }] }]
    }),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
  );
});
