import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const schema = readFileSync(path.join(repositoryRoot, "prisma", "schema.prisma"), "utf8");
const migration = readFileSync(
  path.join(
    repositoryRoot,
    "prisma",
    "migrations",
    "20261008120000_add_evidence_snapshots",
    "migration.sql"
  ),
  "utf8"
);
const accountExportRoute = readFileSync(path.join(repositoryRoot, "app", "api", "account", "export", "route.ts"), "utf8");
const generatedDocumentRoute = readFileSync(
  path.join(repositoryRoot, "app", "api", "generated-documents", "[id]", "route.ts"),
  "utf8"
);
const resumeVersionRoute = readFileSync(
  path.join(repositoryRoot, "app", "api", "resume-versions", "[id]", "route.ts"),
  "utf8"
);

function prismaBlock(kind: "model" | "enum", name: string): string {
  const match = schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `expected ${kind} ${name}`);
  return match[0];
}

test("EvidenceSnapshot has only the approved immutable persistence fields and indexes", () => {
  const snapshot = prismaBlock("model", "EvidenceSnapshot");

  for (const field of [
    "id",
    "userId",
    "jobPostingId",
    "resumeId",
    "reviewedAnalysisId",
    "requestId",
    "requestHash",
    "schemaVersion",
    "sourceResumeUpdatedAt",
    "snapshotHash",
    "sourceProjectionHash",
    "gapProjectionHash",
    "reviewPayload",
    "createdAt"
  ]) {
    assert.match(snapshot, new RegExp(`^  ${field}\\s+`, "m"));
  }

  assert.match(snapshot, /@@unique\(\[userId, requestId\]\)/);
  assert.match(snapshot, /@@index\(\[userId, jobPostingId, snapshotHash\]\)/);
  assert.match(snapshot, /@@index\(\[userId, jobPostingId, createdAt\]\)/);
  assert.match(snapshot, /@@index\(\[jobPostingId\]\)/);
  assert.match(snapshot, /@@index\(\[resumeId, sourceResumeUpdatedAt\]\)/);
  assert.match(snapshot, /@@index\(\[reviewedAnalysisId\]\)/);
  assert.doesNotMatch(snapshot, /\bstatus\b|parentSnapshotId|documentApproval|careerFact/i);
});

test("the four approved consumers expose nullable bindings and JobPosting has the approved monotonic generation", () => {
  const job = prismaBlock("model", "JobPosting");
  const analysis = prismaBlock("model", "AIAnalysis");
  const resumeVersion = prismaBlock("model", "ResumeVersion");
  const generatedDocument = prismaBlock("model", "GeneratedDocument");

  assert.match(job, /^  currentEvidenceSnapshotId\s+String\?$/m);
  assert.match(job, /^  evidenceSnapshotGeneration\s+Int\s+@default\(0\)$/m);
  assert.match(
    job,
    /^  currentEvidenceSnapshot\s+EvidenceSnapshot\?\s+@relation\("JobCurrentEvidenceSnapshot", fields: \[currentEvidenceSnapshotId\], references: \[id\], onDelete: SetNull\)$/m
  );
  for (const block of [analysis, resumeVersion, generatedDocument]) {
    assert.match(block, /^  evidenceSnapshotId\s+String\?$/m);
    assert.match(block, /evidenceSnapshot\s+EvidenceSnapshot\?[\s\S]*onDelete: SetNull/);
    assert.match(block, /@@index\(\[evidenceSnapshotId\]\)/);
  }
  assert.match(job, /@@index\(\[currentEvidenceSnapshotId\]\)/);
});

test("the migration is additive, tenant-scoped, immutable, and free of backfill or excluded storage", () => {
  assert.match(migration, /CREATE TABLE "EvidenceSnapshot"/);
  for (const table of ["JobPosting", "AIAnalysis", "ResumeVersion", "GeneratedDocument"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ADD COLUMN`));
  }

  assert.match(migration, /EvidenceSnapshot_userId_requestId_key/);
  assert.match(migration, /EvidenceSnapshot_userId_jobPostingId_snapshotHash_idx/);
  assert.match(migration, /EvidenceSnapshot_reviewedAnalysisId_idx/);
  for (const index of [
    "EvidenceSnapshot_jobPostingId_idx",
    "JobPosting_currentEvidenceSnapshotId_idx",
    "AIAnalysis_evidenceSnapshotId_idx",
    "ResumeVersion_evidenceSnapshotId_idx",
    "GeneratedDocument_evidenceSnapshotId_idx"
  ]) {
    assert.match(migration, new RegExp(index));
  }
  assert.match(migration, /EvidenceSnapshot_[\s\S]*ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(migration, /currentEvidenceSnapshotId_fkey[\s\S]*ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(migration, /evidenceSnapshotId_fkey[\s\S]*ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(migration, /CREATE FUNCTION "enforce_evidence_snapshot_scope"/);
  assert.match(migration, /CREATE FUNCTION "enforce_evidence_binding_scope"/);
  assert.equal(
    migration.match(/CREATE CONSTRAINT TRIGGER "(?:JobPosting|AIAnalysis|ResumeVersion|GeneratedDocument)_evidence_binding_scope"/g)?.length,
    4
  );
  assert.equal(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length, 4);
  assert.match(migration, /EvidenceSnapshot rows are immutable/);
  assert.match(migration, /JobPosting_evidenceSnapshotGeneration_check/);
  assert.match(migration, /Evidence snapshot generation cannot decrease/);
  assert.match(migration, /must advance generation exactly once/);
  assert.match(migration, /ERRCODE = '23514'/);
  assert.doesNotMatch(migration, /\bUPDATE\s+"(?:JobPosting|AIAnalysis|ResumeVersion|GeneratedDocument)"\b/i);
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(migration, /EvidenceSnapshotStatus|parentSnapshotId|ApplicationDocumentApproval|CareerFact/);
});

test("owner export includes snapshot metadata/payload and content edits invalidate generated provenance", () => {
  assert.match(accountExportRoute, /prisma\.evidenceSnapshot\.findMany\(\{[\s\S]*where: \{ userId \}/);
  for (const field of ["snapshotHash", "sourceProjectionHash", "gapProjectionHash", "reviewPayload"]) {
    assert.match(accountExportRoute, new RegExp(`${field}: true`));
  }
  assert.match(accountExportRoute, /evidenceSnapshots,/);
  assert.match(generatedDocumentRoute, /Object\.hasOwn\(input, "content"\)/);
  assert.match(generatedDocumentRoute, /invalidatesEvidenceBinding \? \{ evidenceSnapshotId: null \}/);
  assert.match(resumeVersionRoute, /\["summary", "fullText", "skills"\]/);
  assert.match(resumeVersionRoute, /invalidatesEvidenceBinding \? \{ evidenceSnapshotId: null \}/);
});
