import assert from "node:assert/strict";
import test from "node:test";

import { validateCoverLetterClaims, type ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { assembleCoverLetterProviderOutput, buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { finalizeCoverLetter } from "@/lib/ai/application-document-quality";
import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";

// Live case 2026-11-16 (shape only; every name and fact here is invented): a cover letter passed
// every check but its last paragraph stacked eight of the owner's saved lines, because grouping the
// letter by employer moved every sentence that names no employer into one closing paragraph:
//   - the second sentence of a saved line ("At <Org> I …. I respond quickly …") left its employer;
//   - the line about the company applied to ended up at the bottom instead of opening the letter;
//   - paragraphs Gemini wrote without any employer were merged into one.

const TRAVEL = "Account Manager | Example Travel | 2021 – Present";
const HOTELS = "Managed 80 partner hotel accounts.";
const NORTHWIND = "Support Lead | Northwind Rentals | 2017 – 2021";
const TICKETS = "Resolved 40+ rental support tickets a day in Zendesk.";

const OWNER_INBOUND = "At Northwind Rentals I handled inbound tickets for 300+ renters by email and phone.";
const OWNER_RESPONSE = "I answer every ticket within one business day.";
const OWNER_SWITCH = "I switched from retail to software because I enjoy building tools.";
const OWNER_MOTIVE = "I care about fast, reliable tools, and Example Software’s focus on speed is the standard I hold my own projects to.";
const OWNER_REPORTS = "I write clear bug reports with repro steps and logs.";
const OWNER_LOCATION = "I’m based in Riverton, on Pacific Time.";

const TRAVEL_LEAD = "Since 2021, I have been Account Manager at Example Travel.";
const NORTHWIND_LEAD = "From 2017 to 2021, I was Support Lead at Northwind Rentals.";
const INTRO = "I am applying for the Product Support Specialist position at Example Software.";

function payload(): ApplicationDocumentPayload {
  const record = (header: string, company: string, title: string, startDate: string, endDate: string, bullets: string[]) => ({
    sourceText: [header, ...bullets.map((value) => `• ${value}`)].join("\n"),
    company, title, location: null, startDate, endDate, bullets
  });
  return buildApplicationDocumentPayload(
    {
      title: "Product Support Specialist",
      company: "Example Software",
      requirements: ["Customer support tickets in Zendesk", "Clear bug reports"],
      description: "Support customers."
    },
    {
      rawText: ["Sam Sample", "sam@example.test | +1 555 010 0199 | Riverton", "", "EXPERIENCE", TRAVEL, `• ${HOTELS}`, "", NORTHWIND, `• ${TICKETS}`].join("\n"),
      summary: "",
      skills: [],
      achievements: [],
      workHistory: [
        record(TRAVEL, "Example Travel", "Account Manager", "2021", "Present", [HOTELS]),
        record(NORTHWIND, "Northwind Rentals", "Support Lead", "2017", "2021", [TICKETS])
      ],
      projects: [],
      education: [],
      certifications: []
    },
    { skillsToEmphasize: [] },
    {
      schema: "synthetic", snapshotId: "snapshot", snapshotHash: "hash", unresolvedGapIds: [],
      facts: [
        `${OWNER_INBOUND} ${OWNER_RESPONSE}`,
        `${OWNER_SWITCH} ${OWNER_MOTIVE}`,
        OWNER_REPORTS,
        OWNER_LOCATION
      ].map((fact, index) => ({ gapId: `gap-${index}`, provenance: "OWNER_ATTESTED", sourceRef: null, fact }))
    }
  );
}

const firstPerson = (value: string) => `I ${value[0]!.toLocaleLowerCase()}${value.slice(1)}`;
const paragraphsOf = (letter: string) => letter.split(/\n\s*\n/u).map((paragraph) => paragraph.trim());

function finalize(body: readonly string[]) {
  const source = payload();
  const facts = buildApplicationDocumentFactCatalog(source);
  const claims = [firstPerson(HOTELS), firstPerson(TICKETS), OWNER_INBOUND, OWNER_RESPONSE, OWNER_SWITCH, OWNER_MOTIVE, OWNER_REPORTS, OWNER_LOCATION];
  const claimsUsed = claims.map((claim) => {
    const fact = facts.find((value) => value.excerpt === claim || firstPerson(value.excerpt) === claim);
    assert.ok(fact, `synthetic fact for: ${claim}`);
    return { claim, factId: fact.factId };
  });
  const coverLetter = [
    "Sam Sample\nsam@example.test | +1 555 010 0199 | Riverton",
    "Dear Example Software Hiring Team,",
    INTRO,
    ...body,
    "Thank you for your time and consideration.",
    "Sincerely,\nSam Sample"
  ].join("\n\n");
  const final = finalizeCoverLetter(source, assembleCoverLetterProviderOutput(source, { title: "Cover letter", angle: "Support", coverLetter, claimsUsed }));
  validateCoverLetterClaims(source, final);
  return paragraphsOf(final.coverLetter).slice(2, -2);
}

test("saved lines keep their place: a line's next sentence stays with its employer, the line about the company opens the letter, and Gemini's other paragraphs stay apart", () => {
  const body = finalize([
    `${TRAVEL_LEAD} ${firstPerson(HOTELS)}`,
    `${NORTHWIND_LEAD} ${OWNER_INBOUND} ${OWNER_RESPONSE} ${OWNER_REPORTS} ${firstPerson(TICKETS)}`,
    OWNER_LOCATION,
    `${OWNER_SWITCH} ${OWNER_MOTIVE}`
  ]);
  assert.deepEqual(body, [
    INTRO,
    `${OWNER_SWITCH} ${OWNER_MOTIVE}`,
    `${TRAVEL_LEAD} ${firstPerson(HOTELS)}`,
    // "I answer …" is the next sentence of the saved line that names Northwind Rentals. The bug-report
    // line is a different saved line, so it leaves the employer's paragraph.
    `${OWNER_INBOUND} ${OWNER_RESPONSE} ${firstPerson(TICKETS)}`,
    OWNER_REPORTS,
    OWNER_LOCATION
  ]);
});

test("a saved line's sentence that only follows a résumé fact still leaves the employer's paragraph", () => {
  const body = finalize([
    `${TRAVEL_LEAD} ${firstPerson(HOTELS)} ${OWNER_RESPONSE}`,
    `${NORTHWIND_LEAD} ${OWNER_INBOUND} ${firstPerson(TICKETS)}`,
    `${OWNER_REPORTS} ${OWNER_SWITCH} ${OWNER_MOTIVE} ${OWNER_LOCATION}`
  ]);
  const travel = body.find((paragraph) => paragraph.startsWith(TRAVEL_LEAD))!;
  assert.equal(travel, `${TRAVEL_LEAD} ${firstPerson(HOTELS)}`);
  assert.ok(body.some((paragraph) => paragraph.includes(OWNER_RESPONSE) && !paragraph.includes(OWNER_INBOUND)), body.join("\n\n"));
});
