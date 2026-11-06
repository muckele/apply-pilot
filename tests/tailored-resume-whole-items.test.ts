import assert from "node:assert/strict";
import test from "node:test";

import {
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import { applicationDocumentPriorityOpportunities } from "@/lib/ai/application-document-priorities";
import { validateTailoredResumeQuality } from "@/lib/ai/application-document-quality";
import {
  buildTailoredResumeGeminiJsonSchema,
  tailoredResumeProviderSchema
} from "@/lib/ai/resume";
import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";
import {
  tailoredResumeLeftOut,
  tailoredResumeProtectedFactIds,
  tailoredResumeRestorations
} from "@/lib/ai/tailored-resume-keep-rule";

// Fully synthetic, shaped like the 2026-11-05 live run: semicolon summary and achievements,
// grouped skills, a LICENSES heading and three owner-attested facts for this job.
const SUMMARY = "Account executive with six years of small-business sales experience; ranked top five of 120 sellers in 2023; and built a referral program from scratch.";
const SKILL_LINES = [
  "Sales tools: Salesforce, HubSpot, Outreach, Gong",
  "Selling: Book-of-business ownership, Upsell and cross-sell, Retention, Cold calling, Event planning",
  "Languages: Spanish (conversational), French"
];
const SKILLS = [
  "Salesforce", "HubSpot", "Outreach", "Gong",
  "Book-of-business ownership", "Upsell and cross-sell", "Retention", "Cold calling", "Event planning",
  "Spanish (conversational)", "French"
];
const JOBS = [
  {
    header: "Northwind Payments | Account Executive | 2021–Present",
    bullets: [
      "Closed $1.2M in new annual revenue from 85 small-business merchants in 2023; ranked first of 14 reps.",
      "Managed a pipeline of 140 accounts in Salesforce.",
      "Reduced onboarding time from 5 days to 2 by rewriting the handoff checklist."
    ]
  },
  {
    header: "Fabrikam Software | Sales Development Representative | 2018–2021",
    bullets: [
      "Booked 220 qualified meetings for senior account executives.",
      "Researched each category and wrote the sales playbooks; the playbooks were used by 100 agents.",
      "Worked enterprise accounts to raise closing rates; tracked customers and calls in Salesforce."
    ]
  },
  {
    header: "Contoso Retail | Store Associate | 2016–2018",
    bullets: ["Trained four new associates on point-of-sale procedures."]
  }
];
const PROJECT = {
  header: "Apply Pilot | Personal tool | 2026",
  bullet: "Fills job applications from a reviewed packet, then stops for human review before submission."
};
const EDUCATION = "State College | Bachelor of Science in Marketing | 2012–2016";
const LICENSE = "Texas Insurance Producer License | Texas Department of Insurance | 2020";
const ACHIEVEMENTS = [
  "President's Club: Finished 2023 at 128% of quota; mentored two new reps.",
  "Top five of 400+ advisors in rate locks for two consecutive quarters; workflow pilots cut time to close by 30%.",
  "Volunteer: Organized a 2022 charity fun run."
];
const OWNER_FACTS = [
  "I managed a book of 60 small-business merchants generating $40M in annual GMV at Northwind Payments.",
  "I renewed 95% of my merchant accounts in 2023.",
  "I am fluent in Portuguese."
];

const rawText = [
  "Riley Synthetic", "riley@example.test | Austin, TX", "",
  "SUMMARY", SUMMARY, "",
  "SKILLS", ...SKILL_LINES, "",
  "EXPERIENCE", ...JOBS.flatMap((job) => [job.header, ...job.bullets.map((bullet) => `• ${bullet}`)]), "",
  "PROJECTS", PROJECT.header, `• ${PROJECT.bullet}`, "",
  "EDUCATION", EDUCATION, "",
  "LICENSES", LICENSE, "",
  "ACHIEVEMENTS", ...ACHIEVEMENTS
].join("\n");

function livePayload(): ApplicationDocumentPayload {
  return buildApplicationDocumentPayload(
    {
      title: "SMB Account Executive",
      company: "Example Buyer Co",
      description: "Own a book of business of SMB merchants, upsell and cross-sell, drive retention, and grow GMV and pipeline in your territory.",
      requirements: [
        "Book-of-business ownership for SMB merchants",
        "Upsell and cross-sell experience",
        "Retention of existing accounts",
        "Salesforce proficiency"
      ],
      preferredQualifications: [],
      detectedTechStack: ["Salesforce"]
    },
    {
      rawText,
      summary: SUMMARY,
      skills: SKILLS,
      achievements: ACHIEVEMENTS,
      workHistory: JOBS.map((job) => ({ sourceText: [job.header, ...job.bullets].join("\n"), bullets: job.bullets })),
      projects: [{ sourceText: [PROJECT.header, PROJECT.bullet].join("\n"), name: "Apply Pilot", bullets: [PROJECT.bullet] }],
      education: [{ sourceText: EDUCATION, institution: "State College", details: [] }],
      certifications: [{ sourceText: LICENSE, name: "Texas Insurance Producer License", details: [] }]
    },
    { skillsToEmphasize: [], skillsNotToExaggerate: [] },
    {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "synthetic-snapshot",
      snapshotHash: "d".repeat(64),
      unresolvedGapIds: [],
      facts: OWNER_FACTS.map((fact, index) => ({ gapId: `gap:${index}`, fact, provenance: "OWNER_ATTESTED", sourceRef: null }))
    }
  );
}

const heading = /^(?:SUMMARY|SKILLS|EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|LICENSES|ACHIEVEMENTS|ADDITIONAL INFORMATION)$/u;

// Each rendered line cites the catalog facts whose excerpts it contains (first clauses included).
function wire(payload: ApplicationDocumentPayload, resumeText: string, rewrites: Record<string, string[]> = {}): TailoredResumeProviderOutput {
  const facts = buildApplicationDocumentFactCatalog(payload);
  return {
    professionalSummary: "",
    professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: resumeText.split("\n")
      .map((line) => line.replace(/^• /u, "").trim())
      .filter((line) => line && !heading.test(line))
      .map((claim) => {
        const sources = rewrites[claim] ?? [claim];
        const factIds = sources.flatMap((source) => {
          const exact = facts.find((fact) => fact.excerpt === source);
          if (exact) return [exact.factId];
          const parts = facts.filter((fact) => source.includes(fact.excerpt) && fact.excerpt.length > 3 &&
            !facts.some((other) => other !== fact && other.excerpt.includes(fact.excerpt) && source.includes(other.excerpt)));
          if (!parts.length) throw new Error(`No synthetic fact for: ${source}`);
          return parts.map((fact) => fact.factId);
        });
        return { claim, factIds };
      }),
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText
  };
}

function complete(payload: ApplicationDocumentPayload, resumeText: string, rewrites: Record<string, string[]> = {}) {
  const assembled = assembleTailoredResumeProviderOutput(payload, wire(payload, resumeText, rewrites));
  const completed = validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, assembled));
  validateTailoredResumeClaims(payload, completed);
  return completed;
}

function lines(text: string) {
  return text.split("\n").map((line) => line.replace(/^• /u, ""));
}

const fullSource = rawText.replace(LICENSE, `${LICENSE}\n\nADDITIONAL INFORMATION\n${OWNER_FACTS.join("\n")}`);

test("the live-shaped source has no priority opportunities, and protects job-matching skills and attested facts", () => {
  const payload = livePayload();
  assert.deepEqual(applicationDocumentPriorityOpportunities(payload), []);
  const catalog = buildApplicationDocumentFactCatalog(payload);
  const protectedTexts = tailoredResumeProtectedFactIds(payload).map((id) => catalog.find((fact) => fact.factId === id)!.excerpt);
  for (const skill of ["Salesforce", "Book-of-business ownership", "Upsell and cross-sell", "Retention"]) {
    assert.ok(protectedTexts.includes(skill), `requirement-matched skill is protected: ${skill}`);
  }
  for (const skill of ["Gong", "Cold calling", "Event planning", "French"]) {
    assert.equal(protectedTexts.includes(skill), false, `unmatched skill stays trimmable: ${skill}`);
  }
  for (const fact of OWNER_FACTS) assert.ok(protectedTexts.includes(fact), `owner-attested fact is protected: ${fact}`);
});

test("regression: a bullet kept as its first clause is restored whole in place, never as a loose fragment", () => {
  const payload = livePayload();
  const firstClause = "Researched each category and wrote the sales playbooks";
  const text = fullSource.replace(`• ${JOBS[1]!.bullets[1]}`, `• ${firstClause}`);
  const completed = complete(payload, text);
  const rendered = completed.resumeText.split("\n");
  const index = rendered.indexOf(`• ${JOBS[1]!.bullets[1]}`);
  assert.ok(index > rendered.indexOf(JOBS[1]!.header) && index < rendered.indexOf(JOBS[2]!.header), "whole bullet sits under its own job");
  assert.equal(rendered.indexOf(`• ${JOBS[1]!.bullets[0]}`) + 1, index, "in its original position");
  assert.equal(rendered.some((line) => line.replace(/^• /u, "") === firstClause), false, "the partial line is replaced");
  assert.equal(rendered.some((line) => /^(?:• )?the playbooks were used by 100 agents\.$/u.test(line)), false, "no loose fragment");
});

test("the live failure shape: whole items, source headings, grouped skills and every attested fact", () => {
  const payload = livePayload();
  const gemini = [
    "Riley Synthetic", "riley@example.test | Austin, TX", "",
    "SUMMARY", "Account executive with six years of small-business sales experience", "",
    "SKILLS", "Salesforce", "HubSpot", "Gong", "Cold calling", "",
    "EXPERIENCE",
    JOBS[0]!.header,
    "• Closed $1.2M in new annual revenue from 85 small-business merchants in 2023",
    "• Managed a Salesforce pipeline of 140 accounts.",
    JOBS[1]!.header,
    `• ${JOBS[1]!.bullets[0]}`,
    "• Researched each category and wrote the sales playbooks",
    "• Worked enterprise accounts to raise closing rates",
    JOBS[2]!.header,
    `• ${JOBS[2]!.bullets[0]}`, "",
    "PROJECTS", PROJECT.header, "• Fills job applications from a reviewed packet", "",
    "EDUCATION", EDUCATION, "",
    "CERTIFICATIONS", LICENSE, "",
    "ACHIEVEMENTS", "President's Club: Finished 2023 at 128% of quota",
    "Top five of 400+ advisors in rate locks for two consecutive quarters"
  ].join("\n");
  const completed = complete(payload, gemini, {
    "Managed a Salesforce pipeline of 140 accounts.": [JOBS[0]!.bullets[1]!]
  });
  const out = lines(completed.resumeText);
  const text = completed.resumeText;

  // Whole items: the summary paragraph, every kept bullet and achievement is its complete source line.
  assert.ok(out.includes(SUMMARY));
  assert.equal(out.filter((line) => line.startsWith("Account executive")).length, 1);
  for (const item of [JOBS[0]!.bullets[0]!, JOBS[1]!.bullets[1]!, JOBS[1]!.bullets[2]!, PROJECT.bullet, ACHIEVEMENTS[0]!, ACHIEVEMENTS[1]!]) {
    assert.ok(out.includes(item), `kept whole: ${item}`);
  }
  for (const fragment of ["ranked first of 14 reps.", "the playbooks were used by 100 agents.", "tracked customers and calls in Salesforce.",
    "stops for human review before submission.", "mentored two new reps.", "workflow pilots cut time to close by 30%.",
    "ranked top five of 120 sellers in 2023", "and built a referral program from scratch."]) {
    assert.equal(out.includes(fragment), false, `no loose fragment: ${fragment}`);
  }
  // Each restored bullet stays inside its own job, in its source position.
  const fabrikam = out.indexOf(JOBS[1]!.header);
  assert.deepEqual(out.slice(fabrikam, fabrikam + 4), [JOBS[1]!.header, ...JOBS[1]!.bullets]);
  assert.deepEqual(out.slice(out.indexOf(JOBS[0]!.header), out.indexOf(JOBS[0]!.header) + 3),
    [JOBS[0]!.header, JOBS[0]!.bullets[0]!, "Managed a Salesforce pipeline of 140 accounts."]);
  // The reworded bullet survives as written.
  assert.ok(out.includes("Managed a Salesforce pipeline of 140 accounts."));
  // The source heading is kept.
  assert.ok(out.includes("LICENSES"));
  assert.equal(out.includes("CERTIFICATIONS"), false);
  // Skills are grouped like the source; job-matching skills are protected; the floor is met.
  const skills = text.split("\nSKILLS\n")[1]!.split("\n\n")[0]!.split("\n");
  assert.deepEqual(skills, [
    "Sales tools: Salesforce, HubSpot, Outreach, Gong",
    "Selling: Book-of-business ownership, Upsell and cross-sell, Retention, Cold calling, Event planning",
    "Languages: Spanish (conversational)"
  ]);
  // Every owner-attested fact for this job is used.
  for (const fact of OWNER_FACTS) assert.ok(out.includes(fact), `attested fact used: ${fact}`);
  // Left out: whole items only.
  assert.deepEqual(tailoredResumeLeftOut(payload, completed).map((item) => item.text), [
    "French", ACHIEVEMENTS[2]!, JOBS[0]!.bullets[2]!
  ]);
  for (const item of tailoredResumeRestorations(completed)) {
    assert.equal(/^(?:ranked|the playbooks|tracked|stops|mentored|workflow|and built)/u.test(item.text), false, `restored whole: ${item.text}`);
  }
  // A validated-cache replay of the completed résumé changes nothing.
  const replay = validateTailoredResumeQuality(payload, structuredClone(completed));
  assert.equal(replay.resumeText, completed.resumeText);
  assert.deepEqual(tailoredResumeRestorations(replay), []);
});

test("a condensed owner-attested fact counts as used", () => {
  const payload = livePayload();
  const condensed = "Managed a book of 60 small-business merchants generating $40M in annual GMV.";
  const text = fullSource.replace(OWNER_FACTS[0]!, condensed);
  const completed = complete(payload, text, { [condensed]: [OWNER_FACTS[0]!] });
  assert.ok(lines(completed.resumeText).includes(condensed));
  assert.equal(lines(completed.resumeText).includes(OWNER_FACTS[0]!), false);
  const entry = completed.claimEvidence.find((item) => item.claim === condensed);
  assert.deepEqual(entry?.citations, [{ ref: "reviewedEvidence.facts[0].fact", excerpt: OWNER_FACTS[0] }]);
  const fact = buildApplicationDocumentFactCatalog(payload).find((item) => item.excerpt === OWNER_FACTS[0]);
  assert.deepEqual(fact?.provenance, { kind: "reviewed_evidence", detail: "OWNER_ATTESTED" });
});

test("a whole multi-clause item can be cited with all its fact IDs and is kept as written", () => {
  const payload = livePayload();
  const completed = complete(payload, fullSource);
  assert.equal(completed.resumeText, fullSource);
  assert.deepEqual(tailoredResumeRestorations(completed), []);
});

test("the provider wire accepts several fact IDs per résumé line and still accepts one", () => {
  const payload = livePayload();
  const schema = buildTailoredResumeGeminiJsonSchema(payload) as {
    properties: { resumeTextClaims: { items: { properties: Record<string, { type: string; minItems?: number }>; required: string[] } } }
  };
  const item = schema.properties.resumeTextClaims.items;
  assert.equal(item.properties.factIds?.type, "array");
  assert.equal(item.properties.factIds?.minItems, 1);
  assert.deepEqual(item.required, ["claim", "factIds"]);
  const base = { professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__", skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [], unsupportedKeywords: [], formattingWarnings: [], resumeText: "x" };
  assert.ok(tailoredResumeProviderSchema.safeParse({ ...base, resumeTextClaims: [{ claim: "x", factIds: ["fact:0001", "fact:0002"] }] }).success);
  assert.ok(tailoredResumeProviderSchema.safeParse({ ...base, resumeTextClaims: [{ claim: "x", factId: "fact:0001" }] }).success);
  assert.equal(tailoredResumeProviderSchema.safeParse({ ...base, resumeTextClaims: [{ claim: "x", factIds: [] }] }).success, false);
});
