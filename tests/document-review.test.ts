import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  DOCUMENT_REVIEW_SCHEMA,
  buildDocumentReview,
  buildDocumentReviewSources,
  buildDocumentReviewView,
  confirmDocumentReviewFlag,
  confirmLegacyDocumentReview,
  documentContentHash,
  extractClaimTokens,
  readStoredDocumentReview,
  resolveDocumentReadiness,
  resolveReviewBaseline,
  withDocumentReview,
  type StoredDocumentReview
} from "@/lib/documents/document-review";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const LATER = new Date("2026-11-03T11:30:00.000Z");
const SNAPSHOT = "snapshot-current";

const generatedCover = [
  "Dear Example Co Hiring Team,",
  "",
  "I led a team of 5 engineers at Example Co.",
  "I built reliable TypeScript services.",
  "",
  "Sincerely,",
  "Synthetic Applicant"
].join("\n");

const coverMetadata = {
  angle: "Reliability",
  claimsUsed: [
    {
      claim: "I led a team of 5 engineers at Example Co.",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "Led a team of 5 engineers at Example Co." }]
    },
    {
      claim: "I built reliable TypeScript services.",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "Built reliable TypeScript services." }]
    }
  ]
};

function generatedBaseline() {
  return resolveReviewBaseline({
    kind: "COVER_LETTER",
    existing: { content: generatedCover, evidenceSnapshotId: SNAPSHOT, metadata: coverMetadata },
    now: NOW
  });
}

function edit(content: string, previous: StoredDocumentReview | null = null, now = NOW) {
  return buildDocumentReview({ baseline: previous?.baseline ?? generatedBaseline(), content, previous, now });
}

function readiness(content: string, metadata: unknown, evidenceSnapshotId: string | null = null, overrides: Partial<{
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  jobBound: boolean;
}> = {}) {
  return resolveDocumentReadiness({
    jobBound: overrides.jobBound ?? true,
    currentEvidenceSnapshotId: overrides.currentEvidenceSnapshotId === undefined ? SNAPSHOT : overrides.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: overrides.currentEvidenceSourceValid ?? true,
    artifact: { evidenceSnapshotId, content, metadata }
  });
}

test("claim-bearing tokens cover metrics, dates, names, titles and credentials but not ordinary wording", () => {
  const tokens = extractClaimTokens("Increased revenue 40% at Globex Corporation in 2021.");
  assert.deepEqual(tokens.map(({ token, kind }) => [token, kind]), [
    ["40", "NUMBER"],
    ["globex", "NAME"],
    ["corporation", "NAME"],
    ["2021", "DATE"]
  ]);
  assert.deepEqual(extractClaimTokens("Globex Corp | Staff Engineer | 2019 – Present").map(({ text }) => text), [
    "Globex", "Corp", "Staff", "Engineer", "2019", "Present"
  ]);
  assert.deepEqual(extractClaimTokens("Earned a bachelor's degree and became AWS certified in March 2020").map(({ token, kind }) => [token, kind]), [
    ["bachelor's", "CREDENTIAL"],
    ["degree", "CREDENTIAL"],
    ["aws", "NAME"],
    ["certified", "CREDENTIAL"],
    ["march", "DATE"],
    ["2020", "DATE"]
  ]);
  assert.deepEqual(extractClaimTokens("Guided the team through a careful rollout."), []);
  assert.deepEqual(extractClaimTokens("synthetic.owner@example.com | (555) 123-4567 | https://example.test/me"), []);
  assert.deepEqual(extractClaimTokens("EXPERIENCE"), []);
});

test("unchanged AI-written lines keep their citations and user lines are marked as the user's", () => {
  const content = generatedCover.replace("I built reliable TypeScript services.", "I care deeply about dependable systems.");
  const review = edit(content);
  assert.equal(review.schema, DOCUMENT_REVIEW_SCHEMA);
  assert.equal(review.contentHash, documentContentHash(content));
  const byText = new Map(review.segments.map((segment) => [segment.text, segment]));
  assert.equal(byText.get("I led a team of 5 engineers at Example Co.")?.origin, "GENERATED");
  assert.deepEqual(byText.get("I led a team of 5 engineers at Example Co.")?.citations, [
    { ref: "resume.workHistory[0]", excerpt: "Led a team of 5 engineers at Example Co." }
  ]);
  assert.equal(byText.get("I care deeply about dependable systems.")?.origin, "USER_EDIT");
  assert.deepEqual(byText.get("I care deeply about dependable systems.")?.citations, []);
  assert.equal(byText.get("Dear Example Co Hiring Team,")?.origin, "GENERATED");
  assert.deepEqual(review.flags, [], "A rewording that adds no factual claim needs no confirmation.");
  assert.equal(review.segments.find((segment) => segment.origin === "USER_EDIT")?.lineIndex, 3);
});

test("an edit that changes a metric, employer or date is flagged against the cited source facts", () => {
  const metric = edit(generatedCover.replace("team of 5 engineers", "team of 12 engineers"));
  assert.equal(metric.flags.length, 1);
  assert.equal(metric.flags[0]!.text, "I led a team of 12 engineers at Example Co.");
  assert.deepEqual(metric.flags[0]!.claims.map(({ text, kind }) => [text, kind]), [["12", "NUMBER"]]);
  assert.equal(metric.flags[0]!.confirmedAt, null);
  assert.match(metric.flags[0]!.id, /^flag:[0-9a-f]{24}$/u);

  const employer = edit(generatedCover.replace("at Example Co.", "at Globex in 2019."));
  assert.deepEqual(employer.flags[0]!.claims.map(({ text }) => text), ["Globex", "2019"]);

  const inserted = edit(`${generatedCover}\nI earned a PMP certification.`);
  assert.deepEqual(inserted.flags.map((flag) => flag.claims.map(({ text }) => text)), [["PMP", "certification"]]);

  const reused = edit(`${generatedCover}\nExample Co trusted me with TypeScript.`);
  assert.deepEqual(reused.flags, [], "A new line built only from cited facts is not a changed claim.");
});

test("a moved AI line keeps its citations instead of becoming a user edit", () => {
  const moved = generatedCover.split("\n");
  [moved[2], moved[3]] = [moved[3]!, moved[2]!];
  const review = edit(moved.join("\n"));
  assert.ok(review.segments.every((segment) => segment.origin === "GENERATED"));
  assert.equal(review.segments.find((segment) => segment.text.startsWith("I led"))?.citations.length, 1);
});

test("confirmations are timestamped, survive unrelated re-edits and reset when the flagged line changes", () => {
  const first = edit(generatedCover.replace("team of 5", "team of 12"));
  const flagId = first.flags[0]!.id;
  const confirmed = confirmDocumentReviewFlag({ review: first, flagId, now: LATER });
  assert.equal(confirmed.flags[0]!.confirmedAt, LATER.toISOString());

  const unrelated = edit(confirmed.segments.map((segment) => segment.text).join("\n").replace("Sincerely,", "Best regards,"), confirmed);
  assert.equal(unrelated.flags.find((flag) => flag.id === flagId)?.confirmedAt, LATER.toISOString());

  const changedAgain = edit(generatedCover.replace("team of 5", "team of 15"), confirmed);
  assert.equal(changedAgain.flags.length, 1);
  assert.notEqual(changedAgain.flags[0]!.id, flagId);
  assert.equal(changedAgain.flags[0]!.confirmedAt, null);

  assert.throws(() => confirmDocumentReviewFlag({ review: first, flagId: "flag:000000000000000000000000", now: LATER }),
    (error: unknown) => error instanceof PublicApiError && error.status === 404);
});

test("readiness keeps unedited current documents exportable and gates edited ones on confirmations", () => {
  assert.deepEqual(
    [readiness(generatedCover, coverMetadata, SNAPSHOT).state, readiness(generatedCover, coverMetadata, SNAPSHOT).exportReady],
    ["EVIDENCE_CURRENT", true]
  );
  const content = generatedCover.replace("team of 5", "team of 12");
  const pending = edit(content);
  const pendingMetadata = withDocumentReview(coverMetadata, pending);
  assert.equal((pendingMetadata as { angle?: string }).angle, "Reliability", "Existing metadata keys are preserved.");
  assert.deepEqual(readStoredDocumentReview(pendingMetadata), pending);
  const pendingState = readiness(content, pendingMetadata);
  assert.equal(pendingState.state, "EDITED_NEEDS_REVIEW");
  assert.equal(pendingState.exportReady, false);
  assert.deepEqual(pendingState.pendingFlagIds, [pending.flags[0]!.id]);

  const confirmed = withDocumentReview(coverMetadata, confirmDocumentReviewFlag({ review: pending, flagId: pending.flags[0]!.id, now: LATER }));
  assert.equal(readiness(content, confirmed).state, "EDITED_READY");
  assert.equal(readiness(content, confirmed).exportReady, true);

  const noFlags = withDocumentReview(coverMetadata, edit(generatedCover.replace("Sincerely,", "Best regards,")));
  assert.equal(readiness(generatedCover.replace("Sincerely,", "Best regards,"), noFlags).state, "EDITED_READY");
});

test("edited documents still go stale with their evidence and a review never covers different bytes", () => {
  const content = generatedCover.replace("Sincerely,", "Best regards,");
  const metadata = withDocumentReview(coverMetadata, edit(content));
  assert.equal(readiness(content, metadata, null, { currentEvidenceSnapshotId: "snapshot-newer" }).state, "EVIDENCE_STALE");
  assert.equal(readiness(content, metadata, null, { currentEvidenceSourceValid: false }).state, "EVIDENCE_STALE");
  assert.equal(readiness(`${content}\nUnreviewed text`, metadata).state, "REVIEW_OUTDATED");
  assert.equal(readiness(`${content}\nUnreviewed text`, metadata).exportReady, false);
  assert.equal(readiness(generatedCover, coverMetadata, "snapshot-old").state, "EVIDENCE_STALE");
  assert.equal(readiness(content, metadata, null, { jobBound: false }).exportReady, true);
});

test("legacy documents need one whole-document confirmation, get no invented citations and re-confirm after edits", () => {
  const legacy = "Legacy Applicant\nLed 40-person programs at Northwind.";
  const unconfirmed = readiness(legacy, null);
  assert.equal(unconfirmed.state, "LEGACY_REVIEW_REQUIRED");
  assert.equal(unconfirmed.exportReady, false);

  const view = buildDocumentReviewView({ kind: "RESUME", jobBound: true, currentEvidenceSnapshotId: SNAPSHOT, currentEvidenceSourceValid: true, artifact: { evidenceSnapshotId: null, content: legacy, metadata: null } });
  assert.ok(view.segments.every((segment) => segment.origin === "LEGACY" && segment.citations.length === 0));
  assert.equal(view.contentHash, documentContentHash(legacy));

  const confirmedReview = confirmLegacyDocumentReview({ review: null, content: legacy, now: LATER });
  assert.deepEqual(confirmedReview.legacyConfirmation, { confirmedAt: LATER.toISOString(), contentHash: documentContentHash(legacy) });
  assert.ok(confirmedReview.segments.every((segment) => segment.citations.length === 0));
  const confirmed = readiness(legacy, withDocumentReview(null, confirmedReview));
  assert.equal(confirmed.state, "LEGACY_CONFIRMED");
  assert.equal(confirmed.exportReady, true);

  const edited = `${legacy}\nAdded line.`;
  const reEdited = buildDocumentReview({ baseline: confirmedReview.baseline, content: edited, previous: confirmedReview, now: LATER });
  assert.equal(reEdited.legacyConfirmation, null);
  assert.equal(reEdited.segments.at(-1)?.origin, "USER_EDIT");
  assert.equal(readiness(edited, withDocumentReview(null, reEdited)).state, "LEGACY_REVIEW_REQUIRED");

  assert.throws(() => confirmLegacyDocumentReview({ review: edit(generatedCover), content: generatedCover, now: LATER }),
    (error: unknown) => error instanceof PublicApiError && error.status === 409);
});

test("an evidence-bound document edited before this change is captured as a generated baseline", () => {
  const baseline = resolveReviewBaseline({
    kind: "RESUME",
    existing: {
      content: "SUMMARY\nBuilt reliable TypeScript services.",
      evidenceSnapshotId: SNAPSHOT,
      metadata: { claimEvidence: [{ claim: "Built reliable TypeScript services.", citations: [{ ref: "resume.achievements[0]", excerpt: "Built reliable TypeScript services." }] }] }
    },
    now: NOW
  });
  assert.equal(baseline.kind, "GENERATED");
  assert.equal(baseline.kind === "GENERATED" ? baseline.evidenceSnapshotId : null, SNAPSHOT);
  assert.deepEqual(baseline.lines.map((line) => line.citations.length), [0, 1]);
  const legacy = resolveReviewBaseline({ kind: "RESUME", existing: { content: "Old text", evidenceSnapshotId: null, metadata: null }, now: NOW });
  assert.equal(legacy.kind, "LEGACY");
  assert.deepEqual(legacy.lines, [{ text: "Old text", citations: [] }]);
});

test("malformed stored review metadata is ignored instead of trusted", () => {
  assert.equal(readStoredDocumentReview({ documentReview: { schema: DOCUMENT_REVIEW_SCHEMA, contentHash: "nope" } }), null);
  assert.equal(readStoredDocumentReview("not an object"), null);
});

// The owner's own facts (D031 follow-up). Synthetic résumé: the AI put a step 2 line under the
// wrong employer; the owner moves and rewords lines. Facts the owner already gave for this job
// (truth-ticked step 2 lines, the master résumé entry of the employer a line sits under) need no
// second confirmation; facts from nowhere, or from another employer, still do.
const northwindHeader = "Support Lead | Northwind Labs | 2021 – 2024";
const contosoHeader = "Support Specialist | Contoso Bank | 2018 – 2021";
const generatedResume = [
  "Synthetic Applicant",
  "SUMMARY",
  "Support leader for regulated fintech teams.",
  "EXPERIENCE",
  northwindHeader,
  "- Reduced ticket backlog 40% with Zendesk macros.",
  contosoHeader,
  "- Resolved 60 wire disputes a day in Salesforce.",
  "- Onboarded 100+ enterprise accounts using Gainsight and Looker.",
  "SKILLS",
  "Zendesk, Salesforce"
].join("\n");

const resumeMetadata = {
  claimEvidence: [
    { claim: "Support leader for regulated fintech teams.", citations: [{ ref: "resume.summary", excerpt: "Support leader for regulated fintech teams." }] },
    { claim: northwindHeader, citations: [{ ref: "resume.workHistory[0]", excerpt: northwindHeader }] },
    { claim: "Reduced ticket backlog 40% with Zendesk macros.", citations: [{ ref: "resume.workHistory[0]", excerpt: "Reduced ticket backlog 40% with Zendesk macros." }] },
    { claim: contosoHeader, citations: [{ ref: "resume.workHistory[1]", excerpt: contosoHeader }] },
    { claim: "Resolved 60 wire disputes a day in Salesforce.", citations: [{ ref: "resume.workHistory[1]", excerpt: "Resolved 60 wire disputes a day in Salesforce." }] },
    {
      claim: "Onboarded 100+ enterprise accounts using Gainsight and Looker.",
      citations: [{ ref: "reviewedEvidence.facts[1].fact", excerpt: "Onboarded 100+ enterprise accounts using Gainsight and Looker." }]
    },
    { claim: "Zendesk, Salesforce", citations: [{ ref: "resume.skills[0]", excerpt: "Zendesk, Salesforce" }] }
  ]
};

const OWNER_LINES = [
  "Ramped new support hires in ~10 days with Notion playbooks.",
  "Onboarded 100+ enterprise accounts using Gainsight and Looker.",
  "At Contoso Bank, reduced wire-transfer escalations by 25%."
];

const masterResume = {
  updatedAt: new Date("2026-11-01T09:00:00.000Z"),
  workHistory: [
    {
      sourceText: `${northwindHeader}\n- Reduced ticket backlog 40% with Zendesk macros.\n- Built a Tableau dashboard for 12 regional teams.`,
      company: "Northwind Labs",
      title: "Support Lead",
      startDate: "2021",
      endDate: "2024",
      bullets: ["Reduced ticket backlog 40% with Zendesk macros.", "Built a Tableau dashboard for 12 regional teams."]
    },
    {
      sourceText: `${contosoHeader}\n- Resolved 60 wire disputes a day in Salesforce.`,
      company: "Contoso Bank",
      title: "Support Specialist",
      startDate: "2018",
      endDate: "2021",
      bullets: ["Resolved 60 wire disputes a day in Salesforce."]
    }
  ],
  projects: []
};

const snapshotWithOwnerLines = {
  id: SNAPSHOT,
  sourceResumeUpdatedAt: masterResume.updatedAt,
  reviewPayload: {
    schema: "apply-pilot/evidence-snapshot-payload/v2",
    facts: [
      ...OWNER_LINES.map((fact, index) => ({
        factId: `owner-${index}`,
        originGapId: `gap:${index}`,
        fact,
        provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      })),
      {
        factId: "source-0",
        originGapId: "gap:9",
        fact: "Resolved 60 wire disputes a day in Salesforce.",
        provenance: {
          kind: "EXISTING_SOURCE",
          sourceFactId: "fact:0042",
          sourceRef: "resume.workHistory[1]",
          sourceExcerpt: "Resolved 60 wire disputes a day in Salesforce."
        },
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      }
    ],
    unresolvedGapIds: []
  }
};

function resumeBaseline(withSources = true) {
  const baseline = resolveReviewBaseline({
    kind: "RESUME",
    existing: { content: generatedResume, evidenceSnapshotId: SNAPSHOT, metadata: resumeMetadata },
    now: NOW
  });
  if (!withSources || baseline.kind !== "GENERATED") return baseline;
  return { ...baseline, sources: buildDocumentReviewSources({ kind: "RESUME", snapshot: snapshotWithOwnerLines, resume: masterResume }) };
}

function editResume(content: string, withSources = true) {
  return buildDocumentReview({ baseline: resumeBaseline(withSources), content, previous: null, now: NOW });
}

function flaggedTokens(review: StoredDocumentReview) {
  return review.flags.map((flag) => [flag.text, flag.claims.map((claim) => claim.text)]);
}

test("review sources keep only truth-ticked owner lines and the master résumé the evidence was saved against", () => {
  const sources = buildDocumentReviewSources({ kind: "RESUME", snapshot: snapshotWithOwnerLines, resume: masterResume });
  assert.equal(sources.kind, "RESUME");
  assert.deepEqual(sources.ownerLines, OWNER_LINES, "A résumé line kept in step 2 is a master résumé fact, not an owner line.");
  assert.deepEqual(sources.records.map((record) => [record.ref, record.name, record.headers]), [
    ["resume.workHistory[0]", "Northwind Labs", [northwindHeader]],
    ["resume.workHistory[1]", "Contoso Bank", [contosoHeader]]
  ]);
  assert.ok(sources.records[0]!.facts.some((fact) => fact.includes("Tableau dashboard for 12 regional teams")));

  const editedSince = buildDocumentReviewSources({
    kind: "RESUME",
    snapshot: snapshotWithOwnerLines,
    resume: { ...masterResume, updatedAt: new Date("2026-11-02T09:00:00.000Z") }
  });
  assert.deepEqual(editedSince.ownerLines, OWNER_LINES);
  assert.deepEqual(editedSince.records, [], "A master résumé edited after the evidence was saved is not used.");
  assert.deepEqual(buildDocumentReviewSources({ kind: "COVER_LETTER", snapshot: { ...snapshotWithOwnerLines, reviewPayload: { schema: "unknown" } }, resume: null }),
    { kind: "COVER_LETTER", ownerLines: [], records: [] });
});

test("a number or tool from the owner's own step 2 lines needs no second confirmation", () => {
  const edited = generatedResume
    .replace("- Reduced ticket backlog 40% with Zendesk macros.", "- Reduced ticket backlog 40% with Zendesk macros and Notion playbooks.")
    .replace(`${contosoHeader}\n`, `- Ramped new support hires in ~10 days.\n${contosoHeader}\n`);
  assert.deepEqual(flaggedTokens(editResume(edited, false)), [
    ["- Reduced ticket backlog 40% with Zendesk macros and Notion playbooks.", ["Notion"]],
    ["- Ramped new support hires in ~10 days.", ["10"]]
  ], "Without the owner's lines both edits are flagged, as before.");
  assert.deepEqual(editResume(edited).flags, []);
});

test("a token found nowhere in the owner's facts is still flagged", () => {
  const edited = generatedResume.replace(`${contosoHeader}\n`, `- Ramped new support hires in ~8 days with Confluence playbooks.\n${contosoHeader}\n`);
  assert.deepEqual(flaggedTokens(editResume(edited)), [
    ["- Ramped new support hires in ~8 days with Confluence playbooks.", ["8", "Confluence"]]
  ]);
});

test("a number moved from one employer's section to another is still flagged", () => {
  const replaced = generatedResume.replace("- Reduced ticket backlog 40% with Zendesk macros.", "- Resolved 60 wire disputes a day.");
  assert.deepEqual(flaggedTokens(editResume(replaced)), [["- Resolved 60 wire disputes a day.", ["60"]]]);

  // A new line under Northwind no longer borrows Contoso's numbers from elsewhere in the document.
  const inserted = generatedResume.replace(`${contosoHeader}\n`, `- Resolved 60 wire disputes a day.\n${contosoHeader}\n`);
  assert.deepEqual(flaggedTokens(editResume(inserted)), [["- Resolved 60 wire disputes a day.", ["60"]]]);
  const underContoso = generatedResume.replace("SKILLS", "- Resolved 60 wire disputes a day.\nSKILLS");
  assert.notEqual(underContoso, generatedResume);
  assert.deepEqual(editResume(underContoso).flags, [], "Under its own employer the same line borrows nothing new.");

  // A step 2 line that names an employer counts only under that employer.
  const ownerUnderNorthwind = generatedResume.replace(`${contosoHeader}\n`, `- Reduced wire-transfer escalations by 25%.\n${contosoHeader}\n`);
  assert.deepEqual(flaggedTokens(editResume(ownerUnderNorthwind)), [["- Reduced wire-transfer escalations by 25%.", ["25%"]]]);
  const ownerUnderContoso = generatedResume.replace("SKILLS", "- Reduced wire-transfer escalations by 25%.\nSKILLS");
  assert.deepEqual(editResume(ownerUnderContoso).flags, []);
});

test("a master résumé fact counts only under its own employer", () => {
  const underNorthwind = generatedResume.replace(`${contosoHeader}\n`, `- Built a Tableau dashboard for 12 regional teams.\n${contosoHeader}\n`);
  assert.deepEqual(editResume(underNorthwind).flags, []);
  const underContoso = generatedResume.replace("SKILLS", "- Built a Tableau dashboard for 12 regional teams.\nSKILLS");
  assert.deepEqual(flaggedTokens(editResume(underContoso)), [["- Built a Tableau dashboard for 12 regional teams.", ["Tableau", "12"]]]);
});

test("in a cover letter a line's employer is the one it names", () => {
  const sources = buildDocumentReviewSources({
    kind: "COVER_LETTER",
    snapshot: {
      ...snapshotWithOwnerLines,
      reviewPayload: { ...snapshotWithOwnerLines.reviewPayload, facts: [{ ...snapshotWithOwnerLines.reviewPayload.facts[2]! }] }
    },
    resume: masterResume
  });
  const baseline = { ...generatedBaseline(), sources } as ReturnType<typeof generatedBaseline>;
  const letter = (line: string) => buildDocumentReview({ baseline, content: `${generatedCover}\n${line}`, previous: null, now: NOW });
  assert.deepEqual(letter("At Contoso Bank, I reduced wire-transfer escalations by 25%.").flags, []);
  assert.deepEqual(letter("At Northwind Labs, I built a Tableau dashboard for 12 regional teams.").flags, []);
  assert.deepEqual(letter("At Northwind Labs, I reduced wire-transfer escalations by 25%.").flags.map((flag) => flag.claims.map((claim) => claim.text)), [["25%"]]);
});
