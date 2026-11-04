import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  DOCUMENT_REVIEW_SCHEMA,
  buildDocumentReview,
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
