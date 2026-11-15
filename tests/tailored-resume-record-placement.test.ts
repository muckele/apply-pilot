import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import {
  applicationDocumentSectionOf,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import { finalizeTailoredResume } from "@/lib/ai/application-document-quality";
import { assertTailoredResumeRecordPlacement, ownerLineInResumeVoice } from "@/lib/ai/tailored-resume-keep-rule";
import { PublicApiError } from "@/lib/api-errors";

// Live case 2026-11-09 (shape only; every name and fact here is invented): a tailored résumé put
// one job's bullets under another job, a sales result under an operations job, a job bullet under
// a project, rendered the oldest job again after Education under a second EXPERIENCE heading, and
// pasted owner-added lines naming several employers, whole and in the first person, under one job.

type Job = { title: string; company: string; dates: string; bullets: string[] };
const JOBS: Job[] = [
  { title: "Solutions Engineer", company: "Juniper Ledger", dates: "2023 – Present", bullets: [
    "Built onboarding scripts that cut customer setup time by 30%.",
    "Led integration calls for 25 new merchant accounts."
  ] },
  { title: "Operations Associate", company: "Brightway Market", dates: "2020 – 2021", bullets: [
    "Processed vendor onboarding requests for 40 regional sellers.",
    "Maintained the seller support queue and escalation log."
  ] },
  { title: "Account Executive", company: "Brightway Market", dates: "2019 – 2020", bullets: [
    "Moved into marketplace sales after one year in operations.",
    "Grew monthly recurring revenue by 22% across a book of 60 sellers."
  ] },
  { title: "Loan Servicing Analyst", company: "Cedar Lending", dates: "2017 – 2019", bullets: [
    "Reviewed 150 loan files each month for document completeness.",
    "Reconciled payment exceptions with the servicing team."
  ] },
  { title: "E-commerce Coordinator", company: "Pinecone Goods", dates: "2015 – 2017", bullets: [
    "Raised checkout conversion by 12% by simplifying the cart page.",
    "Cut product listing errors by 40% with a weekly catalog audit.",
    "Managed the promotions calendar for 300 products."
  ] }
];
const [JUNIPER, BRIGHTWAY_OPS, BRIGHTWAY_SALES, CEDAR, PINECONE] = JOBS as [Job, Job, Job, Job, Job];
const PROJECT = { name: "Ledger Sync Tool", bullet: "Wrote a Python tool that reconciles two invoice exports." };
const EDUCATION = "Example State University | Bachelor of Science in Information Systems | 2011 – 2015";
// Owner-added lines (first person, as typed on the Apply page). The first names no employer in its
// first sentence and one employer in its second; the second line names two employers.
const OWNER_GENERAL = "I'm a full-stack developer who builds internal tools.";
const OWNER_PINECONE = "At Pinecone Goods I raised checkout conversion by 12% and reduced listing errors by 40%.";
const OWNER_TWO_EMPLOYERS = "I used SQL at Cedar Lending and at Pinecone Goods.";
// The same lines in résumé voice, as the server renders them: only the first-person subject goes.
const GENERAL = "Full-stack developer who builds internal tools.";
const PINECONE_LINE = "At Pinecone Goods, raised checkout conversion by 12% and reduced listing errors by 40%.";
const TWO_EMPLOYERS = "Used SQL at Cedar Lending and at Pinecone Goods.";
// Under its own employer's heading the Pinecone line does not name Pinecone Goods again (live case
// 2026-11-14); everywhere else it keeps "At Pinecone Goods,".
const UNDER_PINECONE = "Raised checkout conversion by 12% and reduced listing errors by 40%.";
const VOICED = new Map([
  [GENERAL, OWNER_GENERAL], [PINECONE_LINE, OWNER_PINECONE], [TWO_EMPLOYERS, OWNER_TWO_EMPLOYERS],
  [`${GENERAL} ${PINECONE_LINE}`, `${OWNER_GENERAL} ${OWNER_PINECONE}`]
]);

const header = (job: Job) => `${job.title} | ${job.company} | ${job.dates}`;
const bullet = (text: string) => `• ${text}`;

type Headings = { experience: string; projects: string; education: string };
const CAPS: Headings = { experience: "PROFESSIONAL EXPERIENCE", projects: "SELECTED TECHNICAL PROJECTS", education: "EDUCATION" };
const TITLE_CASE: Headings = { experience: "Professional Experience", projects: "Selected Technical Projects", education: "Education" };
const HEADING_LINES = new Set([
  "SUMMARY", "SKILLS", "EXPERIENCE", "ADDITIONAL INFORMATION", ...Object.values(CAPS), ...Object.values(TITLE_CASE)
]);

function sourceText(headings: Headings) {
  return [
    "Robin Example",
    "robin@example.test | +1 555 010 0100 | Remote",
    "",
    "SUMMARY",
    "Operations-minded engineer with sales and lending experience.",
    "",
    "SKILLS",
    "Python, SQL, Salesforce",
    "",
    headings.experience,
    ...JOBS.flatMap((job) => [header(job), ...job.bullets.map(bullet), ""]),
    headings.projects,
    PROJECT.name,
    bullet(PROJECT.bullet),
    "",
    headings.education,
    EDUCATION
  ].join("\n");
}

function payload(headings: Headings = CAPS): ApplicationDocumentPayload {
  return {
    job: {
      title: "Implementation Specialist",
      company: "Example Payments",
      requirements: ["Customer onboarding experience"],
      description: "Onboard new merchants."
    },
    resume: {
      rawText: sourceText(headings),
      summary: "Operations-minded engineer with sales and lending experience.",
      skills: ["Python", "SQL", "Salesforce"],
      achievements: [],
      workHistory: JOBS.map((job) => ({
        sourceText: [header(job), ...job.bullets.map(bullet)].join("\n"),
        company: job.company,
        title: job.title,
        location: null,
        startDate: job.dates.split(" – ")[0]!,
        endDate: job.dates.split(" – ")[1]!,
        bullets: job.bullets
      })),
      projects: [{
        sourceText: `${PROJECT.name}\n${bullet(PROJECT.bullet)}`,
        name: PROJECT.name, description: null, date: null, technologies: [], bullets: [PROJECT.bullet]
      }],
      education: [{
        sourceText: EDUCATION, institution: "Example State University", credential: "Bachelor of Science in Information Systems",
        fieldOfStudy: null, startDate: "2011", endDate: "2015", details: []
      }],
      certifications: []
    },
    profile: { skillsToEmphasize: [] },
    reviewedEvidence: {
      schema: "synthetic", snapshotId: "snapshot", snapshotHash: "hash", unresolvedGapIds: [],
      facts: [
        { gapId: "gap-1", provenance: "OWNER_ATTESTED", sourceRef: null, fact: `${OWNER_GENERAL} ${OWNER_PINECONE}` },
        { gapId: "gap-2", provenance: "OWNER_ATTESTED", sourceRef: null, fact: OWNER_TWO_EMPLOYERS }
      ]
    }
  };
}

// Gemini's wire answer for a résumé text: every line cites the catalog facts it is made of.
function wire(source: ApplicationDocumentPayload, resumeText: string): TailoredResumeProviderOutput {
  const facts = buildApplicationDocumentFactCatalog(source);
  const key = (value: string) => value.trim().replace(/^[-*•▪◦–—]\s+/u, "").toLocaleLowerCase();
  const resumeTextClaims = resumeText.split("\n")
    .map((line) => line.trim().replace(/^[-*•▪◦–—]\s+/u, ""))
    .filter((line) => line && !HEADING_LINES.has(line))
    .map((claim) => {
      const basis = VOICED.get(claim) ?? claim;
      const exact = facts.filter((fact) => key(fact.excerpt) === key(basis));
      const parts = exact.length ? exact : facts.filter((fact) => key(basis).includes(key(fact.excerpt)) &&
        fact.ref.startsWith("reviewedEvidence."));
      if (!parts.length) throw new Error(`No synthetic fact for: ${claim}`);
      return { claim, factIds: parts.map((fact) => fact.factId) };
    });
  return {
    professionalSummary: "",
    professionalSummaryFactId: "__NO_APPLICANT_FACT__",
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims,
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText
  };
}

// The whole server path tailorResume runs on Gemini's answer.
function tailor(source: ApplicationDocumentPayload, resumeText: string) {
  return finalizeTailoredResume(source, assembleTailoredResumeProviderOutput(source, wire(source, resumeText)));
}

const ownerSection = ["", "ADDITIONAL INFORMATION", `${GENERAL} ${PINECONE_LINE}`, TWO_EMPLOYERS];

function lines(text: string) {
  return text.split("\n").map((line) => line.trim().replace(/^[-*•▪◦–—]\s+/u, "")).filter(Boolean);
}
function count(text: string, line: string) {
  return lines(text).filter((value) => value === line).length;
}
// The nearest record header or section heading above a line: the record or section it reads under.
function under(text: string, line: string) {
  const all = lines(text);
  const at = all.indexOf(line);
  assert.ok(at >= 0, `missing line: ${line}`);
  const anchors = new Set([...JOBS.map(header), PROJECT.name, EDUCATION, ...HEADING_LINES]);
  for (let index = at - 1; index >= 0; index -= 1) if (anchors.has(all[index]!)) return all[index]!;
  return null;
}
function assertEveryJobInPlace(text: string, headings: Headings) {
  const all = lines(text);
  for (const job of JOBS) {
    assert.equal(count(text, header(job)), 1, `${job.title} is rendered once`);
    assert.ok(all.indexOf(header(job)) > all.indexOf(headings.experience), `${job.title} is under ${headings.experience}`);
    assert.ok(all.indexOf(header(job)) < all.indexOf(headings.projects), `${job.title} comes before projects`);
    for (const value of job.bullets) {
      if (count(text, value)) assert.equal(under(text, value), header(job), `"${value}" reads under its own job`);
    }
  }
  assert.ok(all.indexOf(headings.projects) < all.indexOf(headings.education));
  assert.ok(!all.slice(all.indexOf(headings.education) + 1).some((line) => JOBS.some((job) => line === header(job))),
    "no job after Education");
  assert.equal(all.filter((line) => applicationDocumentSectionOf(line) === "EXPERIENCE").length, 1, "one experience heading");
}

test("the tailoring heading vocabulary matches the parser's: typed headings count in any case", () => {
  assert.equal(applicationDocumentSectionOf("Professional Experience"), "EXPERIENCE");
  assert.equal(applicationDocumentSectionOf("Selected Technical Projects"), "PROJECTS");
  assert.equal(applicationDocumentSectionOf("Work History:"), "EXPERIENCE");
  assert.equal(applicationDocumentSectionOf("Certifications & Licenses"), "CERTIFICATIONS");
  assert.equal(applicationDocumentSectionOf("Key Achievements"), "ACHIEVEMENTS");
  assert.equal(applicationDocumentSectionOf("PROFESSIONAL EXPERIENCE"), "EXPERIENCE");
  assert.equal(applicationDocumentSectionOf("Additional Information"), "ADDITIONAL INFORMATION");
  assert.equal(applicationDocumentSectionOf("Led integration calls for 25 new merchant accounts."), null);
  assert.equal(applicationDocumentSectionOf("Solutions Engineer | Juniper Ledger | 2023 – Present"), null);
});

test("a faithful answer for a résumé with title-case headings comes back unchanged", () => {
  const source = payload(TITLE_CASE);
  const text = [sourceText(TITLE_CASE), ...ownerSection].join("\n");
  const result = tailor(source, text);
  assert.equal(result.resumeText, text);
  assertEveryJobInPlace(result.resumeText, TITLE_CASE);
});

for (const [label, headings] of [["title-case", TITLE_CASE], ["mixed-case", { ...CAPS, projects: TITLE_CASE.projects }]] as const) {
  test(`a job Gemini left out returns inside the experience section (${label} headings), never under projects or after Education`, () => {
    const source = payload(headings);
    const omitted = [header(PINECONE), ...PINECONE.bullets.map(bullet), ""].join("\n");
    const text = [sourceText(headings).replace(`${omitted}\n`, ""), ...ownerSection].join("\n");
    assert.ok(!text.includes(header(PINECONE)));
    const result = tailor(source, text);
    assertEveryJobInPlace(result.resumeText, headings);
    assert.ok(lines(result.resumeText).indexOf(header(PINECONE)) > lines(result.resumeText).indexOf(header(CEDAR)));
  });
}

test("bullets Gemini rendered under another job move back under their own job", () => {
  const source = payload();
  const text = [
    sourceText(CAPS)
      // A sales bullet and its result under the operations job...
      .replace(`${bullet(BRIGHTWAY_OPS.bullets[1]!)}\n`, `${bullet(BRIGHTWAY_OPS.bullets[1]!)}\n${BRIGHTWAY_SALES.bullets.map(bullet).join("\n")}\n`)
      .replace(`${header(BRIGHTWAY_SALES)}\n${BRIGHTWAY_SALES.bullets.map(bullet).join("\n")}`, header(BRIGHTWAY_SALES))
      // ...and every e-commerce bullet, with its percentages, under the lending job.
      .replace(`${bullet(CEDAR.bullets[0]!)}\n`, `${bullet(CEDAR.bullets[0]!)}\n${PINECONE.bullets.map(bullet).join("\n")}\n`)
      .replace(`${header(PINECONE)}\n${PINECONE.bullets.map(bullet).join("\n")}`, header(PINECONE)),
    ...ownerSection
  ].join("\n");
  assert.equal(under(text, PINECONE.bullets[0]!), header(CEDAR));
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  for (const job of JOBS) for (const value of job.bullets) assert.equal(count(result.resumeText, value), 1);
});

test("a job bullet rendered under a project, and a project bullet under a job, return to their own records", () => {
  const source = payload();
  const text = [
    sourceText(CAPS)
      .replace(`${bullet(BRIGHTWAY_SALES.bullets[1]!)}\n`, "")
      .replace(`${bullet(PROJECT.bullet)}\n`, `${bullet(BRIGHTWAY_SALES.bullets[1]!)}\n`)
      .replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(PROJECT.bullet)}\n`),
    ...ownerSection
  ].join("\n");
  assert.equal(under(text, BRIGHTWAY_SALES.bullets[1]!), PROJECT.name);
  assert.equal(under(text, PROJECT.bullet), header(JUNIPER));
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  assert.equal(under(result.resumeText, PROJECT.bullet), PROJECT.name);
  assert.equal(count(result.resumeText, PROJECT.bullet), 1);
});

test("a project bullet whose project header Gemini dropped brings the header back in the projects section", () => {
  const source = payload();
  const text = [
    sourceText(CAPS)
      .replace(`${PROJECT.name}\n${bullet(PROJECT.bullet)}\n`, "")
      .replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(PROJECT.bullet)}\n`),
    ...ownerSection
  ].join("\n");
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  assert.equal(under(result.resumeText, PROJECT.name), CAPS.projects);
  assert.equal(under(result.resumeText, PROJECT.bullet), PROJECT.name);
});

test("an owner line naming one employer reads only under that employer's job", () => {
  const source = payload();
  const text = [
    sourceText(CAPS).replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(OWNER_PINECONE)}\n`),
    "", "ADDITIONAL INFORMATION", OWNER_GENERAL, OWNER_TWO_EMPLOYERS
  ].join("\n");
  assert.equal(under(text, OWNER_PINECONE), header(JUNIPER));
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  assert.equal(under(result.resumeText, UNDER_PINECONE), header(PINECONE));
  assert.equal(count(result.resumeText, UNDER_PINECONE), 1);
  assert.equal(count(result.resumeText, PINECONE_LINE), 0);
});

test("an owner line naming no employer, or several, never reads under a job", () => {
  const source = payload();
  const text = [
    sourceText(CAPS)
      .replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(OWNER_GENERAL)}\n`)
      .replace(`${bullet(CEDAR.bullets[1]!)}\n`, `${bullet(CEDAR.bullets[1]!)}\n${bullet(OWNER_TWO_EMPLOYERS)}\n`),
    "", "ADDITIONAL INFORMATION", OWNER_PINECONE
  ].join("\n");
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  assert.equal(under(result.resumeText, GENERAL), "ADDITIONAL INFORMATION");
  assert.equal(under(result.resumeText, TWO_EMPLOYERS), "ADDITIONAL INFORMATION");
  assert.equal(under(result.resumeText, PINECONE_LINE), "ADDITIONAL INFORMATION");
});

test("owner lines Gemini left out return sentence by sentence: an employer's sentence under that job, the rest labelled", () => {
  const source = payload();
  const result = tailor(source, sourceText(CAPS));
  assertEveryJobInPlace(result.resumeText, CAPS);
  assert.equal(under(result.resumeText, UNDER_PINECONE), header(PINECONE));
  assert.equal(under(result.resumeText, GENERAL), "ADDITIONAL INFORMATION");
  assert.equal(under(result.resumeText, TWO_EMPLOYERS), "ADDITIONAL INFORMATION");
});

test("a partly used owner line is completed sentence by sentence, never pasted whole under one job or twice", () => {
  const source = payload();
  const text = sourceText(CAPS)
    .replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(OWNER_GENERAL)}\n`)
    .replace(`${bullet(CEDAR.bullets[1]!)}\n`, `${bullet(CEDAR.bullets[1]!)}\n${bullet("At Pinecone Goods I raised checkout conversion by 12%")}\n`);
  const result = tailor(source, text);
  assertEveryJobInPlace(result.resumeText, CAPS);
  const all = lines(result.resumeText);
  assert.ok(!all.some((line) => line.includes("full-stack") && line.includes("Pinecone")), "the owner paragraph is not pasted whole");
  assert.equal(all.filter((line) => /full-stack developer/iu.test(line)).length, 1);
  assert.equal(all.filter((line) => line.includes("reduced listing errors by 40%")).length, 1);
  assert.equal(under(result.resumeText, GENERAL), "ADDITIONAL INFORMATION");
  assert.equal(under(result.resumeText, UNDER_PINECONE), header(PINECONE));
});

function assertMisattributed(source: ApplicationDocumentPayload, resumeText: string) {
  const output = { resumeText, claimEvidence: assembleTailoredResumeProviderOutput(source, wire(source, resumeText)).claimEvidence };
  assert.throws(() => assertTailoredResumeRecordPlacement(source, output), (error: unknown) =>
    error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_MISATTRIBUTED");
}

test("the quality check rejects a résumé whose bullets read under another record", () => {
  const source = payload();
  const base = [sourceText(CAPS), ...ownerSection].join("\n");
  const output = { resumeText: base, claimEvidence: assembleTailoredResumeProviderOutput(source, wire(source, base)).claimEvidence };
  assert.doesNotThrow(() => assertTailoredResumeRecordPlacement(source, output));
  // A job bullet under another job.
  assertMisattributed(source, base
    .replace(`${bullet(PINECONE.bullets[0]!)}\n`, "")
    .replace(`${bullet(CEDAR.bullets[0]!)}\n`, `${bullet(CEDAR.bullets[0]!)}\n${bullet(PINECONE.bullets[0]!)}\n`));
  // A job bullet under a project.
  assertMisattributed(source, base
    .replace(`${bullet(BRIGHTWAY_SALES.bullets[1]!)}\n`, "")
    .replace(`${bullet(PROJECT.bullet)}\n`, `${bullet(PROJECT.bullet)}\n${bullet(BRIGHTWAY_SALES.bullets[1]!)}\n`));
  // An owner sentence naming one employer under another employer's job.
  assertMisattributed(source, base
    .replace(`${GENERAL} ${PINECONE_LINE}`, GENERAL)
    .replace(`${bullet(JUNIPER.bullets[1]!)}\n`, `${bullet(JUNIPER.bullets[1]!)}\n${bullet(PINECONE_LINE)}\n`));
});

test("the quality check rejects a job rendered twice or after Education under a second experience heading", () => {
  const source = payload();
  const base = [sourceText(CAPS), ...ownerSection].join("\n");
  const pinecone = [header(PINECONE), ...PINECONE.bullets.map(bullet)].join("\n");
  assertMisattributed(source, base.replace(`${EDUCATION}\n`, `${EDUCATION}\n\n${CAPS.experience}\n${pinecone}\n`));
  assertMisattributed(source, base
    .replace(`${pinecone}\n`, "")
    .replace(`${EDUCATION}\n`, `${EDUCATION}\n\n${CAPS.experience}\n${pinecone}\n`));
});

test("first-person owner lines read in résumé voice, without a word added, and still pass the truth checks", () => {
  assert.equal(ownerLineInResumeVoice(OWNER_GENERAL), GENERAL);
  assert.equal(ownerLineInResumeVoice(OWNER_PINECONE), PINECONE_LINE);
  assert.equal(ownerLineInResumeVoice(OWNER_TWO_EMPLOYERS), TWO_EMPLOYERS);
  assert.equal(ownerLineInResumeVoice("I have shipped three internal tools. I've led weekly demos."), "Shipped three internal tools. Led weekly demos.");
  // Only a leading subject before a past-tense verb or role goes; anything else stays as typed.
  for (const typed of ["I hold a current forklift licence.", "I speak Spanish.", "I have been mentoring new hires.", "In 2021 I joined the team."]) {
    assert.equal(ownerLineInResumeVoice(typed), typed.startsWith("In 2021") ? "In 2021, joined the team." : typed);
  }
  const source = payload();
  const text = [sourceText(CAPS), "", "ADDITIONAL INFORMATION", `${OWNER_GENERAL} ${OWNER_PINECONE}`, OWNER_TWO_EMPLOYERS].join("\n");
  const result = tailor(source, text);
  assert.equal(result.resumeText, [sourceText(CAPS), ...ownerSection].join("\n"));
  for (const line of [`${GENERAL} ${PINECONE_LINE}`, TWO_EMPLOYERS]) {
    assert.ok(result.claimEvidence.some((entry) => entry.claim === line), line);
  }
  assert.ok(!result.claimEvidence.some((entry) => /^I\b/u.test(entry.claim) && result.resumeText.includes(entry.claim)));
});
