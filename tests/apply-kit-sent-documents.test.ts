import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  SENT_DOCUMENTS_METADATA_KEY,
  SENT_DOCUMENTS_SCHEMA,
  assertSentDocumentsUnchanged,
  buildSentDocumentsSnapshot,
  captureSentDocumentsInTransaction,
  documentVersionNumbers,
  latestSentDocumentsEvent,
  readSentDocumentsSnapshot,
  shortContentHash,
  versionOrdinalWhere
} from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import {
  APPLY_KIT_NOW,
  CURRENT_SNAPSHOT,
  editedConfirmed,
  editedCoverText,
  editedResumeText,
  editedUnconfirmed,
  generatedCoverMetadata,
  generatedCoverText,
  generatedResumeMetadata,
  generatedResumeText,
  legacyConfirmed
} from "@/tests/fixtures/apply-kit-documents";

const resumeFormat = {
  template: "CLASSIC",
  pageSize: "LETTER",
  fontFamily: "ARIAL",
  accentColor: "#0F766E",
  fontSize: 10,
  lineSpacing: 115
};

function resumeRow(overrides: Partial<{ id: string; fullText: string; evidenceSnapshotId: string | null; metadata: unknown; createdAt: Date }> = {}) {
  return {
    id: "resume-v2",
    title: "Example Co - Platform Engineer tailored resume",
    fullText: generatedResumeText,
    evidenceSnapshotId: CURRENT_SNAPSHOT as string | null,
    metadata: generatedResumeMetadata as unknown,
    createdAt: new Date("2026-11-02T10:00:00.000Z"),
    ...resumeFormat,
    ...overrides
  };
}

function coverRow(overrides: Partial<{ id: string; content: string; evidenceSnapshotId: string | null; metadata: unknown; createdAt: Date }> = {}) {
  return {
    id: "cover-v1",
    title: "Example Co cover letter",
    content: generatedCoverText,
    evidenceSnapshotId: CURRENT_SNAPSHOT as string | null,
    metadata: generatedCoverMetadata as unknown,
    createdAt: new Date("2026-11-02T11:00:00.000Z"),
    ...overrides
  };
}

const current = { currentEvidenceSnapshotId: CURRENT_SNAPSHOT, currentEvidenceSourceValid: true };

test("the sent snapshot freezes ids, version numbers, exact content and its hash for each document", () => {
  const snapshot = buildSentDocumentsSnapshot({
    ...current,
    recordedAt: APPLY_KIT_NOW,
    resume: { row: resumeRow(), versionNumber: 2 },
    coverLetter: { row: coverRow(), versionNumber: 1 }
  });
  assert.equal(snapshot.schema, SENT_DOCUMENTS_SCHEMA);
  assert.equal(snapshot.recordedAt, APPLY_KIT_NOW.toISOString());
  assert.deepEqual(snapshot.resume && {
    kind: snapshot.resume.kind,
    documentId: snapshot.resume.documentId,
    versionNumber: snapshot.resume.versionNumber,
    readinessState: snapshot.resume.readinessState,
    contentHash: snapshot.resume.contentHash,
    content: snapshot.resume.content,
    evidenceSnapshotId: snapshot.resume.evidenceSnapshotId
  }, {
    kind: "RESUME",
    documentId: "resume-v2",
    versionNumber: 2,
    readinessState: "EVIDENCE_CURRENT",
    contentHash: documentContentHash(generatedResumeText),
    content: generatedResumeText,
    evidenceSnapshotId: CURRENT_SNAPSHOT
  });
  assert.deepEqual(snapshot.resume?.resumeFormat, resumeFormat);
  assert.equal(snapshot.coverLetter?.kind, "COVER_LETTER");
  assert.equal(snapshot.coverLetter?.versionNumber, 1);
  assert.equal(snapshot.coverLetter?.contentHash, documentContentHash(generatedCoverText));
  assert.equal(snapshot.coverLetter?.resumeFormat, null);
  // Round-trips through JSON (event metadata) intact.
  assert.deepEqual(readSentDocumentsSnapshot({ [SENT_DOCUMENTS_METADATA_KEY]: JSON.parse(JSON.stringify(snapshot)) }), snapshot);
});

test("edited-and-confirmed and legacy-confirmed documents can be recorded as sent with their review state", () => {
  const edited = editedConfirmed("RESUME", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedResumeText, metadata: generatedResumeMetadata }, editedResumeText);
  const legacy = legacyConfirmed("Legacy cover letter body.");
  const snapshot = buildSentDocumentsSnapshot({
    ...current,
    recordedAt: APPLY_KIT_NOW,
    resume: { row: resumeRow({ fullText: edited.content, evidenceSnapshotId: null, metadata: edited.metadata }), versionNumber: 3 },
    coverLetter: { row: coverRow({ content: legacy.content, evidenceSnapshotId: null, metadata: legacy.metadata }), versionNumber: 1 }
  });
  assert.equal(snapshot.resume?.readinessState, "EDITED_READY");
  assert.equal(snapshot.resume?.content, editedResumeText);
  assert.equal(snapshot.coverLetter?.readinessState, "LEGACY_CONFIRMED");
});

test("a document that is not ready is never recorded as sent", () => {
  const unconfirmed = editedUnconfirmed("COVER_LETTER", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText);
  for (const coverLetter of [
    coverRow({ content: unconfirmed.content, evidenceSnapshotId: null, metadata: unconfirmed.metadata }),
    coverRow({ evidenceSnapshotId: "snapshot-old" }),
    coverRow({ evidenceSnapshotId: null, metadata: null })
  ]) {
    assert.throws(() => buildSentDocumentsSnapshot({
      ...current,
      recordedAt: APPLY_KIT_NOW,
      resume: null,
      coverLetter: { row: coverLetter, versionNumber: 1 }
    }), (error: unknown) => error instanceof PublicApiError && error.status === 409);
  }
});

test("a snapshot with no documents still records the attestation time", () => {
  const snapshot = buildSentDocumentsSnapshot({ ...current, recordedAt: APPLY_KIT_NOW, resume: null, coverLetter: null });
  assert.equal(snapshot.resume, null);
  assert.equal(snapshot.coverLetter, null);
  assert.equal(snapshot.recordedAt, APPLY_KIT_NOW.toISOString());
});

test("reading a snapshot rejects tampered content, unknown schemas and malformed metadata", () => {
  const snapshot = buildSentDocumentsSnapshot({
    ...current,
    recordedAt: APPLY_KIT_NOW,
    resume: { row: resumeRow(), versionNumber: 1 },
    coverLetter: null
  });
  const tampered = structuredClone(snapshot);
  tampered.resume!.content = `${tampered.resume!.content}\nInvented line.`;
  assert.equal(readSentDocumentsSnapshot({ [SENT_DOCUMENTS_METADATA_KEY]: tampered }), null);
  assert.equal(readSentDocumentsSnapshot({ [SENT_DOCUMENTS_METADATA_KEY]: { ...snapshot, schema: "other/v9" } }), null);
  for (const metadata of [null, undefined, "x", [], { resumeVersionId: "resume-v2" }]) {
    assert.equal(readSentDocumentsSnapshot(metadata), null);
  }
});

test("the newest event with a valid snapshot is the one the tracker shows", () => {
  const first = buildSentDocumentsSnapshot({ ...current, recordedAt: new Date("2026-11-01T00:00:00.000Z"), resume: { row: resumeRow(), versionNumber: 1 }, coverLetter: null });
  const second = buildSentDocumentsSnapshot({ ...current, recordedAt: new Date("2026-11-03T00:00:00.000Z"), resume: { row: resumeRow({ id: "resume-v3" }), versionNumber: 3 }, coverLetter: null });
  const latest = latestSentDocumentsEvent([
    { id: "event-note", occurredAt: new Date("2026-11-04T00:00:00.000Z"), metadata: { resumeVersionId: "resume-v3" } },
    { id: "event-old", occurredAt: new Date("2026-11-01T00:00:00.000Z"), metadata: { [SENT_DOCUMENTS_METADATA_KEY]: first } },
    { id: "event-new", occurredAt: new Date("2026-11-03T00:00:00.000Z"), metadata: { [SENT_DOCUMENTS_METADATA_KEY]: second } }
  ]);
  assert.equal(latest?.eventId, "event-new");
  assert.equal(latest?.snapshot.resume?.documentId, "resume-v3");
  assert.equal(latestSentDocumentsEvent([]), null);
});

test("the Apply Kit's expected hashes must match the documents being recorded", () => {
  const resume = { content: generatedResumeText };
  const coverLetter = { content: generatedCoverText };
  assert.doesNotThrow(() => assertSentDocumentsUnchanged({ resume, coverLetter }));
  assert.doesNotThrow(() => assertSentDocumentsUnchanged({
    expectedResumeContentHash: documentContentHash(generatedResumeText),
    expectedCoverLetterContentHash: documentContentHash(generatedCoverText),
    resume,
    coverLetter
  }));
  const changed = (error: unknown) => error instanceof PublicApiError &&
    error.status === 409 && error.details?.code === "APPLICATION_SENT_DOCUMENT_CHANGED";
  assert.throws(() => assertSentDocumentsUnchanged({ expectedResumeContentHash: "0".repeat(64), resume, coverLetter }), changed);
  assert.throws(() => assertSentDocumentsUnchanged({ expectedCoverLetterContentHash: documentContentHash(generatedCoverText), resume, coverLetter: null }), changed);
});

test("version numbers count each user's versions for the job in creation order", async () => {
  const rows = [
    { id: "b", createdAt: new Date("2026-11-02T00:00:00.000Z") },
    { id: "a", createdAt: new Date("2026-11-01T00:00:00.000Z") },
    { id: "c", createdAt: new Date("2026-11-02T00:00:00.000Z") }
  ];
  const numbers = documentVersionNumbers(rows);
  assert.deepEqual([...numbers.entries()].sort(), [["a", 1], ["b", 2], ["c", 3]]);
  // The transaction count uses the same ordering, scoped to the owner and the job.
  const where = versionOrdinalWhere({ userId: "owner", jobPostingId: "job-1", row: rows[2]! });
  assert.equal(where.userId, "owner");
  assert.equal(where.jobPostingId, "job-1");
  const counted = rows.filter((row) => row.createdAt < rows[2]!.createdAt ||
    (row.createdAt.getTime() === rows[2]!.createdAt.getTime() && row.id <= rows[2]!.id)).length;
  assert.equal(counted, numbers.get("c"));
});

test("capture in a transaction counts owner-scoped versions and builds the frozen snapshot", async () => {
  const counts: Array<{ model: string; where: Record<string, unknown> }> = [];
  const tx = {
    resumeVersion: { count: async (args: { where: Record<string, unknown> }) => { counts.push({ model: "resumeVersion", where: args.where }); return 4; } },
    generatedDocument: { count: async (args: { where: Record<string, unknown> }) => { counts.push({ model: "generatedDocument", where: args.where }); return 2; } }
  };
  const snapshot = await captureSentDocumentsInTransaction(tx, {
    userId: "owner",
    jobPostingId: "job-1",
    ...current,
    recordedAt: APPLY_KIT_NOW,
    resumeVersion: resumeRow(),
    coverLetterVersion: coverRow(),
    expectedResumeContentHash: documentContentHash(generatedResumeText)
  });
  assert.equal(snapshot.resume?.versionNumber, 4);
  assert.equal(snapshot.coverLetter?.versionNumber, 2);
  assert.deepEqual(counts.map((entry) => [entry.model, entry.where.userId, entry.where.jobPostingId]), [
    ["resumeVersion", "owner", "job-1"],
    ["generatedDocument", "owner", "job-1"]
  ]);
  assert.equal(counts[1]!.where.type, "COVER_LETTER");
  await assert.rejects(captureSentDocumentsInTransaction(tx, {
    userId: "owner",
    jobPostingId: "job-1",
    ...current,
    recordedAt: APPLY_KIT_NOW,
    resumeVersion: resumeRow(),
    coverLetterVersion: null,
    expectedResumeContentHash: "f".repeat(64)
  }), (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_SENT_DOCUMENT_CHANGED");
});

test("short hashes are 12 hex characters", () => {
  assert.equal(shortContentHash("abcdef0123456789".repeat(4)), "abcdef012345");
});
