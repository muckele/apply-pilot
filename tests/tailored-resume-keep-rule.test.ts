import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
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
import { finalizeTailoredResume, validateTailoredResumeQuality } from "@/lib/ai/application-document-quality";
import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";
import {
  TAILORED_RESUME_FLOORS,
  tailoredResumeLeftOut,
  tailoredResumeProtectedFactIds,
  tailoredResumeRestorations,
  tailoredResumeReversions
} from "@/lib/ai/tailored-resume-keep-rule";
import { PublicApiError } from "@/lib/api-errors";

// Fully synthetic applicant. Nothing here is drawn from a real résumé.
const HEADER = ["Jordan Sample", "jordan.sample@example.test | Denver, CO"];
const SUMMARY = "Account executive with seven years of B2B software sales experience.";
const SKILLS = [
  "Salesforce", "Pipeline forecasting", "Discovery calls", "Contract negotiation", "HubSpot",
  "Territory planning", "Account mapping", "Gong", "Excel modeling", "Public speaking",
  "Spanish", "Event planning", "Photography", "Woodworking"
];
const JOBS = [
  {
    header: "Northwind Software | Account Executive | 2021–Present",
    company: "Northwind Software", title: "Account Executive", startDate: "2021", endDate: "Present",
    bullets: [
      "Closed 38 new mid-market accounts in two years.",
      "Ran weekly demos for regional prospects.",
      "Coordinated renewals with customer success."
    ]
  },
  {
    header: "Fabrikam Analytics | Sales Development Representative | 2018–2021",
    company: "Fabrikam Analytics", title: "Sales Development Representative", startDate: "2018", endDate: "2021",
    bullets: [
      "Booked 220 qualified meetings for senior sellers.",
      "Researched target companies across three verticals.",
      "Maintained call notes in the shared CRM."
    ]
  },
  {
    header: "Contoso Retail | Store Associate | 2016–2018",
    company: "Contoso Retail", title: "Store Associate", startDate: "2016", endDate: "2018",
    bullets: ["Trained four new associates on point-of-sale procedures."]
  }
];
const PROJECT = {
  header: "Regional Demo Library | Sales enablement | 2023",
  bullets: ["Recorded twelve product demo videos for new hires.", "Organized the demo library by industry."]
};
const EDUCATION = {
  header: "State College | Bachelor of Science in Marketing | 2012–2016",
  details: ["Completed a capstone on subscription pricing."]
};
const CERTIFICATION = "Certified Sales Professional | Example Sales Board | 2022";
const ACHIEVEMENTS = [
  "President's Club: Finished 2023 at 128% of quota.",
  "Rookie Award: Named top new account executive in 2021.",
  "Volunteer: Organized a 2022 charity fun run."
];
const OWNER_FACT = "I hold an active Spanish medical interpreting certificate.";

const rawText = [
  ...HEADER, "",
  "SUMMARY", SUMMARY, "",
  "SKILLS", ...SKILLS, "",
  "EXPERIENCE", ...JOBS.flatMap((job) => [job.header, ...job.bullets.map((bullet) => `• ${bullet}`)]), "",
  "PROJECTS", PROJECT.header, ...PROJECT.bullets.map((bullet) => `• ${bullet}`), "",
  "EDUCATION", EDUCATION.header, ...EDUCATION.details.map((detail) => `• ${detail}`), "",
  "CERTIFICATIONS", CERTIFICATION, "",
  "ACHIEVEMENTS", ...ACHIEVEMENTS
].join("\n");

// glued: the master résumé as PDF extraction can store it, each bullet glyph glued to its text
// ("•Closed 38 …") in the raw text, the record source text and the achievements.
function syntheticPayload(protectedCitations: Array<{ ref: string; excerpt: string }> | null = null, glued = false) {
  const glue = (text: string) => glued ? text.replaceAll("• ", "•") : text;
  return buildApplicationDocumentPayload(
    {
      title: "Mid-Market Account Executive",
      company: "Example Buyer Co",
      description: "Sell software to mid-market companies.",
      requirements: ["Salesforce administration", "Pipeline forecasting accuracy"],
      preferredQualifications: [],
      detectedTechStack: ["Salesforce"]
    },
    {
      rawText: glue(rawText),
      summary: SUMMARY,
      skills: SKILLS,
      achievements: ACHIEVEMENTS.map((item) => glued ? `•${item}` : item),
      workHistory: JOBS.map((job) => ({
        sourceText: [job.header, ...job.bullets.map((bullet) => glued ? `•${bullet}` : bullet)].join("\n"),
        company: job.company,
        title: job.title,
        location: null,
        startDate: job.startDate,
        endDate: job.endDate,
        bullets: job.bullets
      })),
      projects: [{
        sourceText: [PROJECT.header, ...PROJECT.bullets].join("\n"),
        name: "Regional Demo Library",
        description: "Sales enablement",
        date: "2023",
        technologies: [],
        bullets: PROJECT.bullets
      }],
      education: [{
        sourceText: [EDUCATION.header, ...EDUCATION.details].join("\n"),
        institution: "State College",
        credential: "Bachelor of Science in Marketing",
        fieldOfStudy: "Marketing",
        startDate: "2012",
        endDate: "2016",
        details: EDUCATION.details
      }],
      certifications: [{
        sourceText: CERTIFICATION,
        name: "Certified Sales Professional",
        issuer: "Example Sales Board",
        date: "2022",
        expirationDate: null,
        details: []
      }]
    },
    { skillsToEmphasize: ["Salesforce"], skillsNotToExaggerate: [] },
    {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "synthetic-snapshot",
      snapshotHash: "c".repeat(64),
      unresolvedGapIds: [],
      facts: [{ gapId: "gap:0", fact: OWNER_FACT, provenance: "OWNER_ATTESTED", sourceRef: null }]
    },
    protectedCitations ? { citations: protectedCitations } : null
  );
}

// A complete copy of the source plus the owner-attested fact, as a Gemini answer would render it.
const completeText = rawText.replace(CERTIFICATION, `${CERTIFICATION}\n${OWNER_FACT}`);

function withoutLines(text: string, ...remove: string[]) {
  const targets = new Set(remove);
  return text.split("\n").filter((line) => !targets.has(line.replace(/^• /u, ""))).join("\n");
}

const heading = /^(?:SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION)$/u;

// Build the provider wire Gemini would return: every rendered line cites exactly one catalog fact.
function providerWire(payload: ApplicationDocumentPayload, resumeText: string, extraClaims: Array<{ claim: string; factExcerpt: string }> = []): TailoredResumeProviderOutput {
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factId = (excerpt: string) => {
    const id = facts.find((fact) => fact.excerpt === excerpt)?.factId;
    if (!id) throw new Error(`Synthetic fact is missing: ${excerpt}`);
    return id;
  };
  const extra = new Map(extraClaims.map((entry) => [entry.claim, entry.factExcerpt]));
  return {
    professionalSummary: SUMMARY,
    professionalSummaryFactId: factId(SUMMARY),
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: resumeText.split("\n")
      .map((line) => line.trim().replace(/^[-*•▪◦–—]\s+/u, ""))
      .filter((line) => line && !heading.test(line))
      .map((claim) => ({ claim, factId: factId(extra.get(claim) ?? claim) })),
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText
  };
}

function tailor(payload: ApplicationDocumentPayload, resumeText: string) {
  const assembled = assembleTailoredResumeProviderOutput(payload, providerWire(payload, resumeText));
  const completed = validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, assembled));
  // The restored result must still pass the unchanged truth checks on every line.
  validateTailoredResumeClaims(payload, completed);
  return { assembled, completed };
}

function lineIndex(text: string, line: string) {
  return text.split("\n").findIndex((candidate) => candidate.replace(/^• /u, "") === line);
}

test("the synthetic keep-rule source has no within-record priority opportunities and keeps the stated floors", () => {
  assert.deepEqual(applicationDocumentPriorityOpportunities(syntheticPayload()), []);
  assert.deepEqual(TAILORED_RESUME_FLOORS, { jobBullets: 2, skills: 10, achievements: 2 });
  const { assembled, completed } = tailor(syntheticPayload(), completeText);
  assert.equal(completed, assembled, "a complete answer needs no restoration");
  assert.deepEqual(tailoredResumeLeftOut(syntheticPayload(), completed), []);
});

test("an omitted job is restored verbatim in source order instead of rejecting the paid result", () => {
  const payload = syntheticPayload();
  const fabrikam = JOBS[1]!;
  const { completed } = tailor(payload, withoutLines(completeText, fabrikam.header, ...fabrikam.bullets));

  const text = completed.resumeText;
  const header = lineIndex(text, fabrikam.header);
  assert.ok(header > lineIndex(text, JOBS[0]!.bullets[2]!), "restored after the preceding job");
  assert.ok(header < lineIndex(text, JOBS[2]!.header), "restored before the following job");
  assert.deepEqual(text.split("\n").slice(header, header + 4), [
    fabrikam.header,
    ...fabrikam.bullets.map((bullet) => `• ${bullet}`)
  ]);
  for (const line of [fabrikam.header, ...fabrikam.bullets]) {
    assert.ok(completed.claimEvidence.some((entry) => entry.claim === line &&
      entry.citations.some((citation) => citation.ref === "resume.workHistory[1]" && citation.excerpt === line)),
    `restored line keeps exact source evidence: ${line}`);
  }
  assert.deepEqual(tailoredResumeRestorations(completed).map((item) => [item.ref, item.kind]), [
    ["resume.workHistory[1]", "record"]
  ]);
  assert.deepEqual(tailoredResumeLeftOut(payload, completed), []);
});

test("an omitted education record, certification, summary and contact line are restored", () => {
  const payload = syntheticPayload();
  const { completed } = tailor(payload, withoutLines(completeText,
    HEADER[1]!, SUMMARY, EDUCATION.header, ...EDUCATION.details, CERTIFICATION));
  for (const line of [HEADER[1]!, SUMMARY, EDUCATION.header, EDUCATION.details[0]!, CERTIFICATION]) {
    assert.ok(lineIndex(completed.resumeText, line) >= 0, `restored: ${line}`);
  }
  assert.ok(lineIndex(completed.resumeText, HEADER[1]!) < lineIndex(completed.resumeText, "SUMMARY"));
  assert.ok(lineIndex(completed.resumeText, EDUCATION.header) > lineIndex(completed.resumeText, "EDUCATION"));
  assert.ok(lineIndex(completed.resumeText, CERTIFICATION) > lineIndex(completed.resumeText, "CERTIFICATIONS"));
});

test("trimmed irrelevant skills, achievements, bullets and projects are accepted without restoration", () => {
  const payload = syntheticPayload();
  const trimmed = withoutLines(completeText,
    "Public speaking", "Event planning", "Photography", "Woodworking",
    ACHIEVEMENTS[2]!, JOBS[0]!.bullets[2]!, "PROJECTS", PROJECT.header, ...PROJECT.bullets);
  const { assembled, completed } = tailor(payload, trimmed);
  assert.equal(completed, assembled);
  assert.deepEqual(tailoredResumeRestorations(completed), []);
});

test("a floor miss restores the highest-priority missing items in source order", () => {
  const payload = syntheticPayload();
  const trimmed = withoutLines(completeText,
    "Discovery calls", "HubSpot", "Territory planning", "Event planning", "Photography", "Woodworking",
    ACHIEVEMENTS[0]!, ACHIEVEMENTS[1]!,
    JOBS[0]!.bullets[0]!, JOBS[0]!.bullets[2]!);
  const { completed } = tailor(payload, trimmed);
  const text = completed.resumeText;

  // Skills: 8 kept, floor 10 -> the first two missing skills in source order come back in place.
  assert.ok(lineIndex(text, "Discovery calls") > lineIndex(text, "Pipeline forecasting"));
  assert.ok(lineIndex(text, "Discovery calls") < lineIndex(text, "Contract negotiation"));
  assert.ok(lineIndex(text, "HubSpot") > lineIndex(text, "Contract negotiation"));
  assert.ok(lineIndex(text, "HubSpot") < lineIndex(text, "Account mapping"));
  assert.equal(lineIndex(text, "Territory planning"), -1);
  // Achievements: 1 kept, floor 2 -> the first missing achievement returns before the kept one.
  assert.ok(lineIndex(text, ACHIEVEMENTS[0]!) >= 0);
  assert.ok(lineIndex(text, ACHIEVEMENTS[0]!) < lineIndex(text, ACHIEVEMENTS[2]!));
  assert.equal(lineIndex(text, ACHIEVEMENTS[1]!), -1);
  // Job bullets: 1 of 3 kept, floor 2 -> the first missing bullet returns inside its own job.
  assert.ok(lineIndex(text, JOBS[0]!.bullets[0]!) > lineIndex(text, JOBS[0]!.header));
  assert.ok(lineIndex(text, JOBS[0]!.bullets[0]!) < lineIndex(text, JOBS[0]!.bullets[1]!));
  assert.equal(lineIndex(text, JOBS[0]!.bullets[2]!), -1);

  // Reported in master-résumé catalog order: skills, achievements, then work records.
  assert.deepEqual(tailoredResumeRestorations(completed).map((item) => item.text), [
    "Discovery calls", "HubSpot", ACHIEVEMENTS[0]!, JOBS[0]!.bullets[0]!
  ]);
  assert.deepEqual(tailoredResumeLeftOut(payload, completed).map((item) => item.text), [
    "Territory planning", "Event planning", "Photography", "Woodworking",
    ACHIEVEMENTS[1]!, JOBS[0]!.bullets[2]!
  ]);
});

test("a protected match-cited skill and bullet that Gemini dropped are restored above the floors", () => {
  const payload = syntheticPayload([
    { ref: "resume.skills[13]", excerpt: "Woodworking" },
    { ref: "resume.workHistory[0]", excerpt: "Coordinated renewals with customer success" },
    { ref: "reviewedEvidence.facts[0]", excerpt: OWNER_FACT },
    { ref: "job.requirements[0]", excerpt: "Salesforce administration" }
  ]);
  const catalog = buildApplicationDocumentFactCatalog(payload);
  const factId = (excerpt: string) => catalog.find((fact) => fact.excerpt === excerpt)!.factId;
  // Résumé match citations (not job or owner-attested refs) plus, since the live review, every
  // owner-attested fact for this job and every skill whose words all appear in the requirements.
  assert.deepEqual(tailoredResumeProtectedFactIds(payload), [
    factId("Salesforce"), factId("Pipeline forecasting"), factId("Woodworking"), factId(JOBS[0]!.bullets[2]!), factId(OWNER_FACT)
  ]);

  const trimmed = withoutLines(completeText,
    "Public speaking", "Event planning", "Photography", "Woodworking", JOBS[0]!.bullets[2]!, OWNER_FACT);
  const { completed } = tailor(payload, trimmed);
  const text = completed.resumeText;
  assert.ok(lineIndex(text, "Woodworking") > lineIndex(text, "Spanish"));
  assert.ok(lineIndex(text, "Woodworking") < lineIndex(text, "EXPERIENCE"));
  assert.ok(lineIndex(text, JOBS[0]!.bullets[2]!) > lineIndex(text, JOBS[0]!.bullets[1]!));
  assert.ok(lineIndex(text, JOBS[0]!.bullets[2]!) < lineIndex(text, JOBS[1]!.header));
  assert.ok(lineIndex(text, OWNER_FACT) > lineIndex(text, "ADDITIONAL INFORMATION"), "an omitted attested fact is restored");
  assert.deepEqual(tailoredResumeLeftOut(payload, completed).map((item) => item.text), [
    "Public speaking", "Event planning", "Photography"
  ]);
});

test("protection binds to the payload: stale or unknown match citations protect nothing", () => {
  const payload = syntheticPayload([
    { ref: "resume.skills[99]", excerpt: "Woodworking" },
    { ref: "resume.workHistory[0]", excerpt: "Led a lunar logistics program" }
  ]);
  assert.deepEqual(tailoredResumeProtectedFactIds(payload), tailoredResumeProtectedFactIds(syntheticPayload()));
});

test("an invented fact is still rejected, even when restoration would otherwise apply", () => {
  const payload = syntheticPayload();
  const invented = "Closed 400 new enterprise accounts in two years.";
  const text = withoutLines(completeText, JOBS[1]!.header, ...JOBS[1]!.bullets)
    .replace(`• ${JOBS[0]!.bullets[0]}`, `• ${invented}`);
  const assembled = assembleTailoredResumeProviderOutput(payload,
    providerWire(payload, text, [{ claim: invented, factExcerpt: JOBS[0]!.bullets[0]! }]));
  assert.throws(
    () => validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, assembled)),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
  );
});

test("restoration never launders an unsupported claim into accepted evidence", () => {
  const payload = syntheticPayload();
  const output = {
    resumeText: withoutLines(completeText, JOBS[1]!.header, ...JOBS[1]!.bullets),
    claimEvidence: [{
      claim: "Led a lunar logistics program.",
      citations: [{ ref: "resume.workHistory[0]", excerpt: JOBS[0]!.bullets[0]! }]
    }]
  };
  // The quality step restores omissions only; it does not vouch for evidence it did not create.
  const completed = validateTailoredResumeQuality(payload, output);
  assert.throws(
    () => validateTailoredResumeClaims(payload, { ...completed, professionalSummary: "", skillsSection: [], bulletRewrites: [], rolesOrProjectsToEmphasize: [] }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
  );
});

test("an omitted owner-attested fact for this job is restored, never left out", () => {
  const payload = syntheticPayload();
  const { completed } = tailor(payload, withoutLines(completeText, OWNER_FACT));
  assert.ok(completed.resumeText.endsWith(`\n\nADDITIONAL INFORMATION\n${OWNER_FACT}`));
  assert.deepEqual(tailoredResumeRestorations(completed), [{
    ref: "reviewedEvidence.facts[0].fact",
    kind: "owner_attested_fact",
    context: null,
    text: OWNER_FACT
  }]);
  assert.deepEqual(tailoredResumeLeftOut(payload, completed), []);
});

test("a used owner-attested fact keeps its OWNER_ATTESTED provenance in the evidence", () => {
  const payload = syntheticPayload();
  const fact = buildApplicationDocumentFactCatalog(payload).find((entry) => entry.excerpt === OWNER_FACT);
  assert.deepEqual(fact?.provenance, { kind: "reviewed_evidence", detail: "OWNER_ATTESTED" });
  const { completed } = tailor(payload, completeText);
  assert.ok(completed.claimEvidence.some((entry) => entry.claim === OWNER_FACT &&
    entry.citations.every((citation) => citation.ref === "reviewedEvidence.facts[0].fact")));
});

test("the left-out list matches exactly what was trimmed, in source order, with paste-ready text", () => {
  const payload = syntheticPayload();
  const trimmed = withoutLines(completeText,
    "Public speaking", "Event planning", "Photography", "Woodworking",
    ACHIEVEMENTS[2]!, JOBS[0]!.bullets[2]!, "PROJECTS", PROJECT.header, ...PROJECT.bullets, OWNER_FACT);
  const { completed } = tailor(payload, trimmed);
  assert.deepEqual(tailoredResumeLeftOut(payload, completed), [
    { ref: "resume.skills[9]", kind: "skill", context: null, text: "Public speaking" },
    { ref: "resume.skills[11]", kind: "skill", context: null, text: "Event planning" },
    { ref: "resume.skills[12]", kind: "skill", context: null, text: "Photography" },
    { ref: "resume.skills[13]", kind: "skill", context: null, text: "Woodworking" },
    { ref: "resume.achievements[2]", kind: "achievement", context: null, text: ACHIEVEMENTS[2]! },
    { ref: "resume.workHistory[0]", kind: "bullet", context: JOBS[0]!.header, text: JOBS[0]!.bullets[2]! },
    {
      ref: "resume.projects[0]",
      kind: "record",
      context: null,
      text: [PROJECT.header, ...PROJECT.bullets.map((bullet) => `• ${bullet}`)].join("\n")
    }
  ]);
});

test("restoration is idempotent, so validated-cache replays add nothing", () => {
  const payload = syntheticPayload();
  const { completed } = tailor(payload, withoutLines(completeText, JOBS[2]!.header, ...JOBS[2]!.bullets, "Gong", "Spanish", "Excel modeling", "Account mapping", "Territory planning"));
  const replay = validateTailoredResumeQuality(payload, structuredClone(completed));
  assert.equal(replay.resumeText, completed.resumeText);
  assert.deepEqual(replay.claimEvidence, completed.claimEvidence);
  assert.deepEqual(tailoredResumeRestorations(replay), []);
});

test("an omitted job with a job-priority opportunity is restored whole with its priority bullet first", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const output = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const record = (payload.resume?.workHistory as Array<{ sourceText: string; bullets: string[] }>)[1]!;
  const header = record.sourceText.split("\n")[0]!;
  const removed = new Set([header, ...record.bullets]);
  const trimmed = {
    ...output,
    resumeText: output.resumeText.split("\n").filter((line) => !removed.has(line.replace(/^• /u, ""))).join("\n"),
    claimEvidence: output.claimEvidence.filter((entry) =>
      !entry.citations.some((citation) => citation.ref === "resume.workHistory[1]"))
  };
  const completed = validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, trimmed));
  // The stub already leads Fabrikam with its reporting outcome; restoration reproduces that block.
  assert.equal(completed.resumeText, output.resumeText);
  validateTailoredResumeClaims(payload, completed);
});

test("source heading variants and combined skill lines are not reported as left out", () => {
  const variantRaw = rawText
    .replace("\nEXPERIENCE\n", "\nPROFESSIONAL EXPERIENCE\n")
    .replace("\nSKILLS\n", `\nSKILLS\n${SKILLS.slice(0, 4).join(", ")}\n`);
  const payload = { ...syntheticPayload(), resume: { ...syntheticPayload().resume, rawText: variantRaw } };
  // Gemini writes the canonical EXPERIENCE heading and lists the skills one per line.
  const trimmed = withoutLines(completeText, "Public speaking", "Event planning", "Photography", "Woodworking", OWNER_FACT);
  const assembled = assembleTailoredResumeProviderOutput(payload, providerWire(payload, trimmed));
  const completed = validateTailoredResumeQuality(payload, validateTailoredResumeClaims(payload, assembled));
  assert.deepEqual(tailoredResumeLeftOut(payload, completed).map((item) => item.text), [
    "Public speaking", "Event planning", "Photography", "Woodworking"
  ]);
  // The source's own (recognized) heading is kept rather than Gemini's rename.
  assert.ok(completed.resumeText.includes("\nPROFESSIONAL EXPERIENCE\n"));
});

test("a missing required section heading is restored above its retained content", () => {
  const payload = syntheticPayload();
  const { completed } = tailor(payload, completeText.replace("\nEDUCATION\n", "\n"));
  const text = completed.resumeText;
  assert.equal(lineIndex(text, "EDUCATION") + 1, lineIndex(text, EDUCATION.header));
});

// Owner decision 2026-11-06: a reworded line that fails the truth check goes back to the master
// résumé's own wording instead of discarding the whole paid résumé. Nothing unverified is kept:
// the final document still passes every unchanged truth check.
function finalize(
  payload: ApplicationDocumentPayload,
  resumeText: string,
  extraClaims: Array<{ claim: string; factExcerpt: string }> = [],
  overrides: Partial<TailoredResumeProviderOutput> = {}
) {
  const assembled = assembleTailoredResumeProviderOutput(payload, { ...providerWire(payload, resumeText, extraClaims), ...overrides });
  return { assembled, final: finalizeTailoredResume(payload, assembled) };
}

test("a reworded line that fails the truth check is put back in its source wording, in place", () => {
  const payload = syntheticPayload();
  const source = JOBS[0]!.bullets[0]!;
  const invented = "Closed 400 new enterprise accounts in two years.";
  const { final } = finalize(payload, completeText.replace(`• ${source}`, `• ${invented}`), [{ claim: invented, factExcerpt: source }]);

  assert.equal(final.resumeText, completeText);
  assert.ok(!final.claimEvidence.some((entry) => entry.claim === invented), "the rejected wording leaves the evidence");
  assert.deepEqual(tailoredResumeReversions(final), [{
    rejectedText: invented,
    reason: "unsupported_word",
    original: [{ ref: "resume.workHistory[0]", kind: "bullet", context: JOBS[0]!.header, text: source }]
  }]);
  validateTailoredResumeClaims(payload, final);
  assert.deepEqual(tailoredResumeLeftOut(payload, final), []);
});

test("every failed line is reverted, including the summary and an item the keep rule would let go", () => {
  const payload = syntheticPayload();
  const achievement = ACHIEVEMENTS[2]!;
  const fakeAchievement = "Volunteer: Organized a 2024 charity marathon.";
  const fakeSummary = "Account executive with ten years of enterprise software sales experience.";
  const text = completeText.replace(achievement, fakeAchievement).replace(SUMMARY, fakeSummary);
  const { final } = finalize(payload, text, [
    { claim: fakeAchievement, factExcerpt: achievement },
    { claim: fakeSummary, factExcerpt: SUMMARY }
  ], { professionalSummary: fakeSummary });

  assert.equal(final.resumeText, completeText);
  assert.equal(final.professionalSummary, "", "a reverted summary leaves no unverified summary field");
  assert.deepEqual(tailoredResumeReversions(final).map((entry) => [entry.rejectedText, entry.original.map((item) => item.text)]), [
    [fakeSummary, [SUMMARY]],
    [fakeAchievement, [achievement]]
  ]);
  validateTailoredResumeClaims(payload, final);
});

test("a faithful rewording is kept while a failed line beside it is reverted", () => {
  const payload = syntheticPayload();
  const meetings = JOBS[1]!.bullets[0]!;
  const reworded = "For senior sellers, booked 220 qualified meetings.";
  const demos = JOBS[0]!.bullets[1]!;
  const invented = "Ran weekly demos for 50 enterprise prospects.";
  const text = completeText.replace(`• ${meetings}`, `• ${reworded}`).replace(`• ${demos}`, `• ${invented}`);
  const { final } = finalize(payload, text, [
    { claim: reworded, factExcerpt: meetings },
    { claim: invented, factExcerpt: demos }
  ]);

  assert.ok(final.resumeText.includes(`• ${reworded}`), "the verified rewording stays");
  assert.ok(final.resumeText.includes(`• ${demos}`) && !final.resumeText.includes(invented));
  assert.deepEqual(tailoredResumeReversions(final).map((entry) => entry.rejectedText), [invented]);
});

test("a clean answer passes through unchanged with nothing reverted", () => {
  const payload = syntheticPayload();
  const { assembled, final } = finalize(payload, completeText);
  assert.equal(final, assembled);
  assert.deepEqual(tailoredResumeReversions(final), []);
});

test("a claim with a broken citation is still rejected rather than reverted", () => {
  const payload = syntheticPayload();
  const { assembled } = finalize(payload, completeText);
  const broken = {
    ...assembled,
    claimEvidence: [...assembled.claimEvidence, {
      claim: JOBS[0]!.bullets[0]!,
      citations: [{ ref: "resume.workHistory[9]", excerpt: JOBS[0]!.bullets[0]! }]
    }]
  };
  assert.throws(
    () => finalizeTailoredResume(payload, broken),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_UNKNOWN_REFERENCE"
  );
});

test("reverting is idempotent, so validated-cache replays revert nothing", () => {
  const payload = syntheticPayload();
  const source = JOBS[0]!.bullets[0]!;
  const invented = "Closed 400 new enterprise accounts in two years.";
  const { final } = finalize(payload, completeText.replace(`• ${source}`, `• ${invented}`), [{ claim: invented, factExcerpt: source }]);
  const replay = finalizeTailoredResume(payload, structuredClone(final));
  assert.equal(replay.resumeText, final.resumeText);
  assert.deepEqual(tailoredResumeReversions(replay), []);
});

// Live case 2026-11-06: the owner's stored résumé glues each bullet glyph to its text. Every
// check treated "•Started …" as a second, required source line beside the parsed bullet, so a
// normal answer was "completed" with duplicate bullets and then failed the evidence check.
test("bullet glyphs glued to their text are one source item, not a second required line", () => {
  const payload = syntheticPayload(null, true);
  assert.ok(String(payload.resume?.rawText).includes(`• ${JOBS[0]!.bullets[0]}`), "the payload spaces a glued glyph");
  const { assembled, final } = finalize(payload, completeText);
  assert.equal(final, assembled, "a complete answer needs no restoration");
  assert.equal(final.resumeText, completeText);
  assert.deepEqual(tailoredResumeLeftOut(payload, final), []);
});

test("with glued glyphs, a failed line still reverts once, in place, without duplicates", () => {
  const payload = syntheticPayload(null, true);
  const source = JOBS[1]!.bullets[1]!;
  const invented = "Researched 900 target companies across twelve verticals.";
  const { final } = finalize(payload, completeText.replace(`• ${source}`, `• ${invented}`), [{ claim: invented, factExcerpt: source }]);
  assert.equal(final.resumeText, completeText);
  assert.deepEqual(tailoredResumeReversions(final).map((entry) => entry.original.map((item) => item.text)), [[source]]);
});

// Live case 2026-11-06: owner-attested facts are often several sentences. Restored when Gemini
// left one out, the fact rendered as one line, but its evidence named each sentence separately,
// so the whole line was "missing source evidence" and the paid résumé was rejected.
test("an omitted multi-sentence owner-attested fact is restored verbatim as one accepted line", () => {
  const payload = syntheticPayload();
  const fact = "I managed a book of 60 merchants. I ran quarterly reviews with each owner.";
  (payload.reviewedEvidence!.facts as Array<{ fact: string }>)[0]!.fact = fact;
  const { final } = finalize(payload, withoutLines(completeText, OWNER_FACT));
  assert.ok(final.resumeText.endsWith(`\n\nADDITIONAL INFORMATION\n${fact}`));
  for (const sentence of ["I managed a book of 60 merchants.", "I ran quarterly reviews with each owner."]) {
    assert.ok(final.claimEvidence.some((entry) => entry.claim === sentence &&
      entry.citations.every((citation) => citation.ref === "reviewedEvidence.facts[0].fact")), sentence);
  }
  validateTailoredResumeClaims(payload, final);
});

test("a line is accepted as an owner fact only when it is exactly that fact", () => {
  const payload = syntheticPayload();
  const fact = "I managed a book of 60 merchants. I ran quarterly reviews with each owner.";
  (payload.reviewedEvidence!.facts as Array<{ fact: string }>)[0]!.fact = fact;
  const { final } = finalize(payload, withoutLines(completeText, OWNER_FACT));
  const altered = final.resumeText.replace(fact, "I managed a book of 90 merchants. I ran quarterly reviews with each owner.");
  assert.throws(
    () => validateTailoredResumeClaims(payload, { ...final, resumeText: altered }),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
  );
});
