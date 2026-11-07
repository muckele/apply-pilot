import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { assertCurrentApplicationRunEvidenceInTransaction } from "@/lib/application-runs/evidence-authority";
import { isRunDocumentCurrent } from "@/lib/application-runs/document-currentness";
import {
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

// D031 for assisted Fill: the locked run-evidence authority (answer packet, run document export and
// the one permanent Fill) accepts exactly the documents PR #41 considers ready, under the locked
// current snapshot. It does not change locking, ordering or any other run check.

const USER = "user-1";
const JOB = "job-1";
const MASTER = { id: "master-1", updatedAt: new Date("2026-11-01T00:00:00.000Z") };

type Artifact = { evidenceSnapshotId: string | null; content: string; metadata: unknown };

function selectedColumns(sql: string) {
  const match = /SELECT\s+(.+?)\s+FROM/su.exec(sql);
  assert.ok(match, sql);
  return match[1]!.split(",").map((column) => column.trim().replaceAll('"', ""));
}

function project(row: Record<string, unknown>, sql: string) {
  return Object.fromEntries(selectedColumns(sql).map((column) => [column, row[column]]));
}

function fakeTx(input: { resume?: Artifact | null; coverLetter?: Artifact | null; currentEvidenceSnapshotId?: string | null }) {
  const statements: string[] = [];
  const tx = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?").replace(/\s+/gu, " ").trim();
      statements.push(sql);
      if (sql.includes('FROM "JobPosting"')) {
        assert.match(sql, /FOR SHARE$/u);
        return values[0] === JOB && values[1] === USER
          ? [{ id: JOB, currentEvidenceSnapshotId: input.currentEvidenceSnapshotId ?? CURRENT_SNAPSHOT, evidenceSnapshotGeneration: 1 }]
          : [];
      }
      if (/FROM "Resume" /u.test(sql)) return [project({ ...MASTER }, sql)];
      if (sql.includes('FROM "EvidenceSnapshot"')) {
        return [project({ id: values[0], resumeId: MASTER.id, sourceResumeUpdatedAt: MASTER.updatedAt }, sql)];
      }
      if (sql.includes('FROM "ResumeVersion"')) {
        assert.match(sql, /FOR SHARE NOWAIT$/u);
        if (!input.resume || values[1] !== USER || values[2] !== JOB) return [];
        return [project({ id: values[0], evidenceSnapshotId: input.resume.evidenceSnapshotId, fullText: input.resume.content, metadata: input.resume.metadata }, sql)];
      }
      if (sql.includes('FROM "GeneratedDocument"')) {
        assert.match(sql, /FOR SHARE NOWAIT$/u);
        assert.match(sql, /"type" = 'COVER_LETTER'/u);
        if (!input.coverLetter || values[1] !== USER || values[2] !== JOB) return [];
        return [project({ id: values[0], evidenceSnapshotId: input.coverLetter.evidenceSnapshotId, content: input.coverLetter.content, metadata: input.coverLetter.metadata }, sql)];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements };
}

const run = (overrides: Partial<{ userId: string; resumeVersionId: string | null; coverLetterVersionId: string | null }> = {}) => ({
  userId: USER,
  jobPostingId: JOB,
  resumeVersionId: "resume-1" as string | null,
  coverLetterVersionId: "cover-1" as string | null,
  ...overrides
});

const exactResume: Artifact = { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedResumeText, metadata: generatedResumeMetadata };
const exactCover: Artifact = { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata };
const stale = (error: unknown) => error instanceof PublicApiError && error.status === 409 && error.details?.code === "RUN_DOCUMENT_EVIDENCE_STALE";

test("exactly generated documents remain current under the locked snapshot", async () => {
  const { tx } = fakeTx({ resume: exactResume, coverLetter: exactCover });
  assert.equal(await assertCurrentApplicationRunEvidenceInTransaction(tx, run()), CURRENT_SNAPSHOT);
});

test("edited-and-confirmed and legacy-confirmed documents are accepted", async () => {
  const { tx, statements } = fakeTx({
    resume: editedConfirmed("RESUME", exactResume, editedResumeText),
    coverLetter: legacyConfirmed("Legacy cover letter the owner confirmed.")
  });
  assert.equal(await assertCurrentApplicationRunEvidenceInTransaction(tx, run()), CURRENT_SNAPSHOT);
  // The review is read from the same locked row as the bytes it must cover.
  const resumeSql = statements.find((sql) => sql.includes('FROM "ResumeVersion"'))!;
  assert.deepEqual(selectedColumns(resumeSql).sort(), ["evidenceSnapshotId", "fullText", "id", "metadata"]);
  const coverSql = statements.find((sql) => sql.includes('FROM "GeneratedDocument"'))!;
  assert.deepEqual(selectedColumns(coverSql).sort(), ["content", "evidenceSnapshotId", "id", "metadata"]);
});

test("an edited document with an unconfirmed factual edit is still refused", async () => {
  const unconfirmedCover = editedUnconfirmed("COVER_LETTER", exactCover, editedCoverText);
  await assert.rejects(assertCurrentApplicationRunEvidenceInTransaction(fakeTx({ resume: exactResume, coverLetter: unconfirmedCover }).tx, run()), stale);
  const unconfirmedResume = editedUnconfirmed("RESUME", exactResume, editedResumeText);
  await assert.rejects(assertCurrentApplicationRunEvidenceInTransaction(fakeTx({ resume: unconfirmedResume, coverLetter: null }).tx, run({ coverLetterVersionId: null })), stale);
});

test("stale bindings, unreviewed legacy documents, outdated reviews and edits of old evidence are refused", async () => {
  const confirmed = editedConfirmed("RESUME", exactResume, editedResumeText);
  for (const resume of [
    { ...exactResume, evidenceSnapshotId: "snapshot-old" },
    { evidenceSnapshotId: null, content: "Legacy résumé never reviewed.", metadata: null },
    { ...confirmed, content: `${confirmed.content}\nChanged after review.` },
    editedConfirmed("RESUME", { ...exactResume, evidenceSnapshotId: "snapshot-old" }, editedResumeText)
  ]) {
    await assert.rejects(assertCurrentApplicationRunEvidenceInTransaction(fakeTx({ resume, coverLetter: null }).tx, run({ coverLetterVersionId: null })), stale);
  }
});

test("another user's document is never found, so it is refused", async () => {
  const { tx } = fakeTx({ resume: exactResume, coverLetter: null });
  await assert.rejects(assertCurrentApplicationRunEvidenceInTransaction(tx, run({ userId: "user-other", coverLetterVersionId: null })), stale);
});

test("the run currentness predicate is #41's export readiness for a job-bound document", () => {
  const current = { currentEvidenceSnapshotId: CURRENT_SNAPSHOT, currentEvidenceSourceValid: true };
  assert.equal(isRunDocumentCurrent({ ...current, artifact: exactResume }), true);
  assert.equal(isRunDocumentCurrent({ ...current, artifact: editedConfirmed("RESUME", exactResume, editedResumeText) }), true);
  assert.equal(isRunDocumentCurrent({ ...current, artifact: legacyConfirmed("Legacy.") }), true);
  assert.equal(isRunDocumentCurrent({ ...current, artifact: editedUnconfirmed("RESUME", exactResume, editedResumeText) }), false);
  assert.equal(isRunDocumentCurrent({ ...current, artifact: { ...exactResume, evidenceSnapshotId: "snapshot-old" } }), false);
  assert.equal(isRunDocumentCurrent({ ...current, currentEvidenceSourceValid: false, artifact: exactResume }), false);
  assert.equal(isRunDocumentCurrent({ ...current, artifact: { evidenceSnapshotId: null, content: "x", metadata: undefined } }), false);
});
