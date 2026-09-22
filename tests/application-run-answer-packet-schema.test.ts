import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { APPLICATION_FORM_FIELD_TYPES } from "@/lib/application-runs/form-inspection";
import {
  APPLICATION_ANSWER_DISPOSITION_REASONS,
  APPLICATION_ANSWER_DISPOSITIONS,
  APPLICATION_QUESTION_CLASSIFICATIONS
} from "@/lib/application-runs/question-classification";
import {
  LegacyApplicationRunAnswerAuditSafetyError,
  formatLegacyApplicationRunAnswerAuditReport,
  resolveLegacyApplicationRunAnswerAuditConfig
} from "@/scripts/audit-application-run-answer-legacy";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(repositoryRoot, "prisma", "schema.prisma");
const migrationsPath = path.join(repositoryRoot, "prisma", "migrations");
const schema = readFileSync(schemaPath, "utf8");

function prismaBlock(kind: "enum" | "model", name: string): string {
  const match = schema.match(new RegExp(`^${kind} ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"));
  assert.ok(match, `expected ${kind} ${name} in prisma/schema.prisma`);
  return match[1];
}

function enumValues(name: string): string[] {
  return prismaBlock("enum", name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
}

function modelFieldNames(name: string): string[] {
  return prismaBlock("model", name)
    .split("\n")
    .filter((line) => /^  [A-Za-z]/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);
}

function f2MigrationSql(): string {
  const directories = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("_add_form_inspection_answer_packets"))
    .map((entry) => entry.name);
  assert.equal(directories.length, 1, "expected exactly one F2 migration directory");
  return readFileSync(path.join(migrationsPath, directories[0], "migration.sql"), "utf8");
}

test("legacy audit configuration fails closed without using ordinary Prisma URLs", () => {
  for (const environment of [
    {},
    { APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "0" },
    {
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
      DATABASE_URL: "postgresql://secret@example.invalid/fallback?schema=public",
      DIRECT_URL: "postgresql://secret@example.invalid/fallback?schema=public"
    }
  ]) {
    assert.throws(
      () => resolveLegacyApplicationRunAnswerAuditConfig(environment),
      LegacyApplicationRunAnswerAuditSafetyError
    );
  }

  assert.throws(
    () =>
      resolveLegacyApplicationRunAnswerAuditConfig({
        APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
        APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL: "mysql://secret@example.invalid/db"
      }),
    LegacyApplicationRunAnswerAuditSafetyError
  );

  const config = resolveLegacyApplicationRunAnswerAuditConfig({
    APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
    APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL:
      "postgresql://auditor:secret@127.0.0.1:55432/audit?schema=f2_audit"
  });
  assert.equal(config.expectedSchema, "f2_audit");
});

test("legacy audit reporting emits only bounded sorted identifiers and safe counts", () => {
  const secretValue = "do-not-print-proposed-value";
  const report = formatLegacyApplicationRunAnswerAuditReport([
    {
      code: "APPROVED_FINAL_HASH_MISMATCH",
      severity: "BLOCKING",
      count: 27,
      rowIds: ["row-z", "row-b", "row-a", ...Array.from({ length: 24 }, (_, index) => `row-${index}`)]
    },
    {
      code: "SOURCE_IDS_NULL",
      severity: "REPAIRABLE",
      count: 1,
      rowIds: ["repair-row"]
    }
  ]);
  const parsed = JSON.parse(report) as Array<{ code: string; count: number; rowIds: string[] }>;

  assert.deepEqual(Object.keys(parsed[0]), ["code", "count", "rowIds"]);
  assert.equal(parsed[0].rowIds.length, 25);
  assert.deepEqual(parsed[0].rowIds, [...parsed[0].rowIds].sort());
  assert.doesNotMatch(report, /BLOCKING|REPAIRABLE/);
  assert.doesNotMatch(report, new RegExp(secretValue));
  assert.doesNotMatch(report, /postgres(?:ql)?:\/\//);
});

test("Prisma persistence enums stay exactly aligned with the committed F1 literals", () => {
  assert.deepEqual(enumValues("ApplicationFormFieldType"), [...APPLICATION_FORM_FIELD_TYPES]);
  assert.deepEqual(enumValues("ApplicationQuestionClassification"), [
    ...APPLICATION_QUESTION_CLASSIFICATIONS
  ]);
  assert.deepEqual(enumValues("ApplicationAnswerDisposition"), [...APPLICATION_ANSWER_DISPOSITIONS]);
  assert.deepEqual(enumValues("ApplicationAnswerDispositionReason"), [
    ...APPLICATION_ANSWER_DISPOSITION_REASONS
  ]);
  assert.deepEqual(enumValues("ApplicationAnswerReviewHashVersion"), [
    "LEGACY_SCALAR_SHA256",
    "CANONICAL_PROPOSAL_V1"
  ]);
  assert.deepEqual(enumValues("ApplicationAnswerSourceType"), [
    "PROFILE",
    "ANSWER_VAULT",
    "MASTER_RESUME",
    "TAILORED_RESUME",
    "APPLICATION_PLAN",
    "USER_PROVIDED",
    "GENERATED_WITH_EVIDENCE",
    "COVER_LETTER"
  ]);
});

test("inspection and packet models contain only the approved persistence fields", () => {
  assert.deepEqual(modelFieldNames("ApplicationRunFormInspection"), [
    "id",
    "runId",
    "userId",
    "version",
    "schemaVersion",
    "normalizerVersion",
    "classifierVersion",
    "fingerprintVersion",
    "formFingerprint",
    "normalizedSnapshot",
    "createdAt",
    "run",
    "user",
    "answerPackets"
  ]);
  assert.deepEqual(modelFieldNames("ApplicationRunAnswerPacket"), [
    "id",
    "runId",
    "userId",
    "version",
    "formInspectionId",
    "schemaVersion",
    "builderVersion",
    "policyHash",
    "inputHash",
    "packetHash",
    "reviewedAt",
    "createdAt",
    "run",
    "user",
    "formInspection",
    "answers"
  ]);

  const inspection = prismaBlock("model", "ApplicationRunFormInspection");
  const packet = prismaBlock("model", "ApplicationRunAnswerPacket");
  assert.doesNotMatch(inspection, /\bupdatedAt\b/);
  assert.doesNotMatch(packet, /\bupdatedAt\b/);
  assert.match(inspection, /@@unique\(\[runId, version\]\)/);
  assert.match(inspection, /@@index\(\[userId, runId\]\)/);
  assert.match(packet, /@@unique\(\[runId, version\]\)/);
  assert.match(packet, /@@index\(\[userId, runId\]\)/);
  assert.match(packet, /@@index\(\[formInspectionId\]\)/);
});

test("run, answer, and user models expose only the approved F2 relations and legacy-compatible fields", () => {
  const run = prismaBlock("model", "ApplicationRun");
  const answer = prismaBlock("model", "ApplicationRunAnswer");
  const user = prismaBlock("model", "User");

  assert.match(run, /^  currentFormInspectionVersion\s+Int\s+@default\(0\)$/m);
  assert.match(run, /^  currentAnswerPacketVersion\s+Int\s+@default\(0\)$/m);
  assert.match(run, /^  formInspections\s+ApplicationRunFormInspection\[\]$/m);
  assert.match(run, /^  answerPackets\s+ApplicationRunAnswerPacket\[\]$/m);

  for (const field of [
    "answerPacketId     String?",
    "normalizedQuestion String?",
    "fieldFingerprint   String?",
    "semanticFieldKey   String?",
    "fieldType          ApplicationFormFieldType?",
    "classification     ApplicationQuestionClassification?",
    "disposition        ApplicationAnswerDisposition?",
    "dispositionReason  ApplicationAnswerDispositionReason?",
    "proposal           Json?",
    "sourceFingerprint  String?",
    "reviewHashVersion  ApplicationAnswerReviewHashVersion?"
  ]) {
    assert.ok(answer.includes(field), `expected nullable answer field: ${field}`);
  }
  assert.match(answer, /^  proposedValue\s+String\?$/m);
  assert.doesNotMatch(answer, /^  proposal\s+Json\?\s+@default/m);
  assert.match(
    answer,
    /^  answerPacket\s+ApplicationRunAnswerPacket\?\s+@relation\(fields: \[answerPacketId\], references: \[id\], onDelete: Cascade\)$/m
  );
  assert.match(answer, /@@unique\(\[answerPacketId, normalizedFieldKey\]\)/);
  assert.match(answer, /@@index\(\[runId\]\)/);
  assert.match(answer, /@@index\(\[userId, runId\]\)/);
  assert.doesNotMatch(answer, /@@unique\(\[runId, normalizedFieldKey\]\)/);

  assert.match(user, /^  applicationRunFormInspections\s+ApplicationRunFormInspection\[\]$/m);
  assert.match(user, /^  applicationRunAnswerPackets\s+ApplicationRunAnswerPacket\[\]$/m);
  assert.match(user, /^  applicationRunAnswers\s+ApplicationRunAnswer\[\]$/m);
});

test("the F2 migration owns the approved raw checks and only the legacy partial answer unique", () => {
  const migration = f2MigrationSql();
  const packetUniqueCreates = migration.match(
    /CREATE UNIQUE INDEX "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key"/g
  );

  assert.equal(packetUniqueCreates?.length, 1, "expected one Prisma-generated packet unique");
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key"[\s\S]*WHERE "answerPacketId" IS NULL;/
  );
  assert.doesNotMatch(migration, /CREATE EXTENSION[\s\S]*pgcrypto/i);
  assert.doesNotMatch(migration, /USING\s+GIN/i);
  assert.doesNotMatch(migration, /btrim\s*\(\s*"normalizedQuestion"/i);
  assert.doesNotMatch(migration, /"normalizedQuestion"\s*<>\s*''/);
  assert.doesNotMatch(migration, /length\s*\(\s*"normalizedQuestion"\s*\)\s*>\s*0/i);
  assert.match(migration, /"normalizedQuestion" IS NOT NULL/);
  assert.match(migration, /"fieldFingerprint" IS NOT NULL[\s\S]*"fieldFingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /"sourceFingerprint" IS NOT NULL[\s\S]*"sourceFingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /cardinality\("sourceIds"\) = 1/);
  assert.doesNotMatch(migration, /cardinality\("sourceIds"\) > 0/);
  assert.match(migration, /"proposal" \? 'kind'/);
  assert.match(migration, /COALESCE\([\s\S]*jsonb_typeof\("proposal" -> 'kind'\) = 'string'/);

  const packetUniqueOffset = migration.indexOf(
    'CREATE UNIQUE INDEX "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key"'
  );
  const legacyUniqueOffset = migration.indexOf(
    'CREATE UNIQUE INDEX "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key"'
  );
  const oldUniqueDropOffset = migration.indexOf(
    'DROP INDEX "ApplicationRunAnswer_runId_normalizedFieldKey_key"'
  );
  assert.ok(packetUniqueOffset >= 0 && legacyUniqueOffset > packetUniqueOffset);
  assert.ok(oldUniqueDropOffset > legacyUniqueOffset);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
});
