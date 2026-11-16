import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { getCoverLetterLeadLines } from "@/lib/ai/cover-letter-lead-lines";
import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";
import { coverLetterPrompt } from "@/prompts/coverLetterPrompt";

// Live case 2026-11-15 (shape only; every name and fact here is invented): a cover letter was
// refused three times as "not varied across the available source context". The refusal detail
// showed why: every body paragraph cited only the owner's saved lines and no résumé fact, and the
// prompt never said which kinds of fact count as different contexts. The repair already puts back
// a saved line Gemini leaves out; it now also adds the résumé facts that best match the job when
// the letter cites none, so a truthful letter is not refused for its sources alone.

const TRAVEL = "Account Manager | Example Travel | 2021 – Present";
const TRAVEL_BULLETS = ["Managed 80 partner hotel accounts.", "Answered customer billing questions by phone."];
const NORTHWIND = "Support Lead | Northwind Rentals | 2017 – 2021";
const TICKETS = "Resolved 40+ rental support tickets a day in Zendesk.";
const BUGS = "Partnered with engineering on incident bug reports and repro steps.";
const COACHED = "Coached six new support agents.";
// The closest match of all, but no first-person rule rewords its verb, so it would read as a fragment.
const FRAGMENT = "Escalated urgent customer support tickets in Zendesk.";
const NORTHWIND_BULLETS = [COACHED, FRAGMENT, TICKETS, BUGS];

const OWNER_REPORTS = "I write clear bug reports with repro steps and logs.";
const OWNER_RESPONSE = "I answer customer tickets within one business day.";
const OWNER_LOCATION = "I’m based in Riverton, on Pacific Time.";

const SOURCE = [
  "Sam Sample",
  "sam@example.test | +1 555 010 0199 | Riverton",
  "",
  "EXPERIENCE",
  TRAVEL,
  ...TRAVEL_BULLETS.map((value) => `• ${value}`),
  "",
  NORTHWIND,
  ...NORTHWIND_BULLETS.map((value) => `• ${value}`)
].join("\n");

function payload(): ApplicationDocumentPayload {
  const record = (header: string, company: string, title: string, startDate: string, endDate: string, bullets: string[]) => ({
    sourceText: [header, ...bullets.map((value) => `• ${value}`)].join("\n"),
    company, title, location: null, startDate, endDate, bullets
  });
  return buildApplicationDocumentPayload(
    {
      title: "Product Support Specialist",
      company: "Example Software",
      requirements: ["Clear bug reports and incident escalation", "Customer support tickets in Zendesk"],
      description: "Support customers."
    },
    {
      rawText: SOURCE,
      summary: "",
      skills: [],
      achievements: [],
      workHistory: [
        record(TRAVEL, "Example Travel", "Account Manager", "2021", "Present", TRAVEL_BULLETS),
        record(NORTHWIND, "Northwind Rentals", "Support Lead", "2017", "2021", NORTHWIND_BULLETS)
      ],
      projects: [],
      education: [],
      certifications: []
    },
    { skillsToEmphasize: [] },
    {
      schema: "synthetic", snapshotId: "snapshot", snapshotHash: "hash", unresolvedGapIds: [],
      facts: [OWNER_REPORTS, OWNER_RESPONSE, OWNER_LOCATION]
        .map((fact, index) => ({ gapId: `gap-${index}`, provenance: "OWNER_ATTESTED", sourceRef: null, fact }))
    }
  );
}

// Gemini's letter as the live refusal described it: header, salutation, introduction, three body
// paragraphs of saved lines, courtesy close and signoff.
function letter(body: readonly string[]) {
  return [
    "Sam Sample\nsam@example.test | +1 555 010 0199 | Riverton",
    "Dear Example Software Hiring Team,",
    "I am applying for the Product Support Specialist position at Example Software.",
    ...body,
    "Thank you for your time and consideration.",
    "Sincerely,\nSam Sample"
  ].join("\n\n");
}

function finalize(source: ApplicationDocumentPayload, body: readonly string[]) {
  const facts = buildApplicationDocumentFactCatalog(source);
  const claimsUsed = body.map((claim) => {
    const fact = facts.find((value) => value.excerpt === claim || `I ${value.excerpt[0]!.toLocaleLowerCase()}${value.excerpt.slice(1)}` === claim);
    assert.ok(fact, `synthetic fact for: ${claim}`);
    return { claim, factId: fact.factId };
  });
  const provider = { title: "Cover letter", angle: "Support", coverLetter: letter(body), claimsUsed };
  return finalizeCoverLetter(source, assembleCoverLetterProviderOutput(source, provider));
}

test("a letter that cites only saved lines gains the résumé facts that best match the job", () => {
  const source = payload();
  const result = finalize(source, [OWNER_REPORTS, OWNER_RESPONSE, OWNER_LOCATION]);
  const paragraphs = result.coverLetter.split(/\n\s*\n/u);

  // One paragraph holds the best-matching job's two best-matching facts, in the first person,
  // opened by that job's lead line. The weaker fact, the fragment and the other job are left out.
  const lead = getCoverLetterLeadLines(source).find((value) => value.ref === "resume.workHistory[1]")!.line;
  const added = paragraphs.find((paragraph) => paragraph.startsWith(lead));
  assert.ok(added, `a paragraph opens with: ${lead}`);
  assert.ok(added.includes(`I ${TICKETS[0]!.toLocaleLowerCase()}${TICKETS.slice(1)}`), added);
  assert.ok(added.includes(`I ${BUGS[0]!.toLocaleLowerCase()}${BUGS.slice(1)}`), added);
  assert.equal(/coached|escalated|hotel|billing/iu.test(result.coverLetter), false);

  // It reads after the introduction and before the courtesy close; every saved line stays.
  const at = paragraphs.indexOf(added);
  assert.ok(at > paragraphs.findIndex((paragraph) => paragraph.startsWith("I am applying")));
  assert.ok(at < paragraphs.findIndex((paragraph) => paragraph.startsWith("Thank you")));
  for (const line of [OWNER_REPORTS, OWNER_RESPONSE, OWNER_LOCATION]) assert.ok(result.coverLetter.includes(line), line);

  // Each added sentence is backed by its own résumé fact.
  const cited = result.claimsUsed.filter((entry) => entry.citations.some((citation) => citation.ref === "resume.workHistory[1]"));
  assert.deepEqual(cited.map((entry) => entry.citations[0]!.excerpt).sort(), [BUGS, TICKETS]);
});

test("a letter that already cites a résumé fact gets nothing added", () => {
  const source = payload();
  const hotel = `I ${TRAVEL_BULLETS[0]![0]!.toLocaleLowerCase()}${TRAVEL_BULLETS[0]!.slice(1)}`;
  const result = finalize(source, [OWNER_REPORTS, `${hotel}`, OWNER_RESPONSE, OWNER_LOCATION]);
  assert.equal(result.coverLetter.includes("rental support tickets"), false);
  assert.equal(result.coverLetter.includes("incident bug reports"), false);
});

// Live case 2026-11-15, the next try: with résumé sentences in the letter, it was refused as "missing
// source evidence for generated claim". A claim Gemini lists in nearly the words of its sentence
// (here without the final period) covers no sentence, so the repair binds the sentence itself to
// the same fact; the step that keeps one claim per fact then kept Gemini's near copy and dropped
// the binding, leaving the sentence uncited.
test("a claim listed without its sentence's final period still covers that sentence", () => {
  const source = payload();
  const facts = buildApplicationDocumentFactCatalog(source);
  const factId = (excerpt: string) => facts.find((value) => value.excerpt === excerpt)!.factId;
  const firstPersonTickets = `I ${TICKETS[0]!.toLocaleLowerCase()}${TICKETS.slice(1)}`;
  const firstPersonBugs = `I ${BUGS[0]!.toLocaleLowerCase()}${BUGS.slice(1)}`;
  const provider = {
    title: "Cover letter",
    angle: "Support",
    coverLetter: letter([`${firstPersonTickets} ${firstPersonBugs}`, [OWNER_REPORTS, OWNER_RESPONSE, OWNER_LOCATION].join(" ")]),
    claimsUsed: [
      { claim: firstPersonTickets.replace(/\.$/u, ""), factId: factId(TICKETS) },
      { claim: firstPersonBugs, factId: factId(BUGS) },
      { claim: OWNER_REPORTS.replace(/\.$/u, ""), factId: factId(OWNER_REPORTS) },
      { claim: OWNER_RESPONSE, factId: factId(OWNER_RESPONSE) },
      { claim: OWNER_LOCATION, factId: factId(OWNER_LOCATION) }
    ]
  };
  const result = finalizeCoverLetter(source, assembleCoverLetterProviderOutput(source, provider));

  // Each sentence is covered by a claim in its own words, once per fact.
  for (const [sentence, excerpt] of [[firstPersonTickets, TICKETS], [OWNER_REPORTS, OWNER_REPORTS]] as const) {
    assert.ok(result.coverLetter.includes(sentence), sentence);
    const cited = result.claimsUsed.filter((entry) => entry.citations.some((citation) => citation.excerpt === excerpt));
    assert.deepEqual(cited.map((entry) => entry.claim), [sentence]);
  }
});

test("the prompt names the kinds of fact that count as different sources", () => {
  assert.match(coverLetterPrompt, /at least two provenance kinds \(resume, profile, reviewed_evidence\)/u);
  assert.match(coverLetterPrompt, /reviewed_evidence facts alone never satisfy this rule/u);
});
