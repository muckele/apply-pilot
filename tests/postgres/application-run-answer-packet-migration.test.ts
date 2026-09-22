import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import { auditLegacyApplicationRunAnswers } from "@/scripts/audit-application-run-answer-legacy";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const repositoryPrismaDirectory = path.join(repositoryRoot, "prisma");
const repositoryMigrationsDirectory = path.join(repositoryPrismaDirectory, "migrations");
const f2MigrationSuffix = "_add_form_inspection_answer_packets";

type CommandResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

type TransitionWorkspace = {
  admin: PrismaClient;
  child: PrismaClient;
  childUrl: string;
  schemaName: string;
  tempRoot: string;
  tempSchemaPath: string;
  f2MigrationName: string;
  copyF2Migration(): Promise<void>;
  cleanup(): Promise<void>;
};

type LegacyAnswerFixture = {
  id: string;
  normalizedFieldKey: string;
  proposedValue?: string | null;
  sourceIds?: string[] | null;
  evidenceIds?: string[] | null;
  confidence?: number;
  sensitive?: boolean;
  valueRedacted?: boolean;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByUser?: boolean;
  reviewedAt?: Date | null;
  finalValueHash?: string | null;
};

type PacketAnswerFixture = {
  id: string;
  packetId: string;
  normalizedFieldKey: string;
  normalizedQuestion?: string | null;
  fieldFingerprint?: string | null;
  fieldType?: string | null;
  classification?: string | null;
  disposition?: "PROPOSABLE" | "MANUAL_ONLY" | "EXCLUDED" | "UNSUPPORTED";
  dispositionReason?: string | null;
  proposal?: unknown | null;
  sourceType?: string | null;
  sourceIds?: string[];
  evidenceIds?: string[];
  sourceFingerprint?: string | null;
  confidence?: number;
  sensitive?: boolean;
  valueRedacted?: boolean;
  requiresReview?: boolean;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByUser?: boolean;
  reviewedAt?: Date | null;
  finalValueHash?: string | null;
  reviewHashVersion?: "LEGACY_SCALAR_SHA256" | "CANONICAL_PROPOSAL_V1" | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textArray(values: string[] | null): Prisma.Sql {
  if (values === null) return Prisma.sql`NULL::TEXT[]`;
  if (values.length === 0) return Prisma.sql`ARRAY[]::TEXT[]`;
  return Prisma.sql`ARRAY[${Prisma.join(values)}]::TEXT[]`;
}

function jsonValue(value: unknown | null): Prisma.Sql {
  if (value === null) return Prisma.sql`NULL::JSONB`;
  return Prisma.sql`${JSON.stringify(value)}::JSONB`;
}

async function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString("utf8", 0, 64 * 1024 - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => reject(new Error("Required F2 PostgreSQL child command could not start.")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    });
  });
}

function childEnvironment(childUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: childUrl,
    DIRECT_URL: childUrl,
    PRISMA_HIDE_UPDATE_MESSAGE: "1"
  };
}

async function assertGuardedDatabase(): Promise<string> {
  const config = validatePostgresTestEnvironment(process.env);
  const liveDatabase = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(liveDatabase);
  assert.equal(liveDatabase.databaseName, "apply_pilot_commit5_test");
  assert.equal(liveDatabase.isolation, "read committed");
  return config.url;
}

async function createTransitionWorkspace(): Promise<TransitionWorkspace> {
  const baseUrl = await assertGuardedDatabase();
  const schemaName = `f2_${randomUUID().replaceAll("-", "")}`;
  assert.match(schemaName, /^f2_[a-f0-9]{32}$/);

  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);

  const parsedChildUrl = new URL(baseUrl);
  parsedChildUrl.searchParams.set("schema", schemaName);
  const childUrl = parsedChildUrl.toString();
  const child = new PrismaClient({ datasources: { db: { url: childUrl } } });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "apply-pilot-f2-migration-"));
  const tempPrismaDirectory = path.join(tempRoot, "prisma");
  const tempMigrationsDirectory = path.join(tempPrismaDirectory, "migrations");
  const tempSchemaPath = path.join(tempPrismaDirectory, "schema.prisma");

  const migrationEntries = await readdir(repositoryMigrationsDirectory, { withFileTypes: true });
  const f2MigrationNames = migrationEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(f2MigrationSuffix))
    .map((entry) => entry.name);
  assert.equal(f2MigrationNames.length, 1);
  const f2MigrationName = f2MigrationNames[0];

  try {
    await mkdir(tempMigrationsDirectory, { recursive: true });
    await cp(path.join(repositoryPrismaDirectory, "schema.prisma"), tempSchemaPath);
    await cp(
      path.join(repositoryMigrationsDirectory, "migration_lock.toml"),
      path.join(tempMigrationsDirectory, "migration_lock.toml")
    );
    for (const entry of migrationEntries) {
      if (!entry.isDirectory() || entry.name === f2MigrationName) continue;
      await cp(
        path.join(repositoryMigrationsDirectory, entry.name),
        path.join(tempMigrationsDirectory, entry.name),
        { recursive: true }
      );
    }

    const preF2Deploy = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", tempSchemaPath],
      childEnvironment(childUrl)
    );
    assert.equal(preF2Deploy.timedOut, false);
    assert.equal(preF2Deploy.exitCode, 0, preF2Deploy.output);

    const identity = await child.$queryRaw<Array<{ databaseName: string; schemaName: string }>>`
      SELECT current_database() AS "databaseName", current_schema() AS "schemaName"
    `;
    assert.deepEqual(identity[0], {
      databaseName: "apply_pilot_commit5_test",
      schemaName
    });
  } catch (error) {
    await child.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    admin,
    child,
    childUrl,
    schemaName,
    tempRoot,
    tempSchemaPath,
    f2MigrationName,
    async copyF2Migration() {
      await cp(
        path.join(repositoryMigrationsDirectory, f2MigrationName),
        path.join(tempMigrationsDirectory, f2MigrationName),
        { recursive: true }
      );
    },
    async cleanup() {
      await child.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.$disconnect();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

async function deployF2(workspace: TransitionWorkspace): Promise<CommandResult> {
  await workspace.copyF2Migration();
  return deployCopiedF2(workspace);
}

async function deployCopiedF2(workspace: TransitionWorkspace): Promise<CommandResult> {
  return runCommand(
    path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
    ["migrate", "deploy", "--schema", workspace.tempSchemaPath],
    childEnvironment(workspace.childUrl)
  );
}

async function deployF2WithLateFailure(workspace: TransitionWorkspace): Promise<CommandResult> {
  const repositoryMigrationPath = path.join(
    repositoryMigrationsDirectory,
    workspace.f2MigrationName,
    "migration.sql"
  );
  const temporaryMigrationPath = path.join(
    workspace.tempRoot,
    "prisma",
    "migrations",
    workspace.f2MigrationName,
    "migration.sql"
  );
  const finalCommit = "COMMIT;\n";
  const failureSql = `DO $$
BEGIN
  RAISE EXCEPTION 'F2_TEST_LATE_ROLLBACK';
END
$$;

`;

  const repositoryMigration = await readFile(repositoryMigrationPath, "utf8");
  const commitMatches = [...repositoryMigration.matchAll(/^COMMIT;$/gm)];
  assert.equal(commitMatches.length, 1, "expected exactly one standalone COMMIT in the real F2 migration");
  assert.equal(repositoryMigration.endsWith(finalCommit), true, "expected the real F2 migration to end in COMMIT");
  const finalCommitIndex = commitMatches[0]?.index;
  assert.ok(finalCommitIndex !== undefined, "expected the final F2 COMMIT offset");
  assert.equal(
    finalCommitIndex,
    repositoryMigration.length - finalCommit.length,
    "expected the only F2 COMMIT to be the final statement"
  );

  await workspace.copyF2Migration();
  assert.equal(await readFile(temporaryMigrationPath, "utf8"), repositoryMigration);

  const temporaryMigration =
    repositoryMigration.slice(0, finalCommitIndex) +
    failureSql +
    repositoryMigration.slice(finalCommitIndex);
  assert.equal(temporaryMigration.match(/F2_TEST_LATE_ROLLBACK/g)?.length, 1);
  assert.equal(temporaryMigration.endsWith(finalCommit), true);
  await writeFile(temporaryMigrationPath, temporaryMigration, "utf8");
  assert.equal(await readFile(repositoryMigrationPath, "utf8"), repositoryMigration);

  return deployCopiedF2(workspace);
}

async function insertFixtureGraph(client: PrismaClient, prefix: string): Promise<void> {
  const userId = `${prefix}_user`;
  const jobId = `${prefix}_job`;
  const applicationId = `${prefix}_application`;
  const runId = `${prefix}_run`;
  const now = new Date();

  await client.$transaction([
    client.$executeRaw(Prisma.sql`
      INSERT INTO "User" ("id", "email", "updatedAt")
      VALUES (${userId}, ${`${prefix}@example.test`}, ${now})
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "JobPosting" (
        "id", "userId", "title", "normalizedTitle", "company", "normalizedCompany",
        "normalizedLocation", "sourceUrl", "normalizedApplyUrl", "description",
        "requirements", "preferredQualifications", "benefits", "detectedTechStack",
        "sourceType", "missingKeywords", "supportedKeywords", "concerns", "updatedAt"
      ) VALUES (
        ${jobId}, ${userId}, 'F2 Test Role', 'f2 test role', 'F2 Test Company', 'f2 test company',
        'remote', 'https://example.test/job', 'https://example.test/apply', 'fixture',
        ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
        'MANUAL', ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ${now}
      )
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "Application" ("id", "userId", "jobPostingId", "updatedAt")
      VALUES (${applicationId}, ${userId}, ${jobId}, ${now})
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "ApplicationRun" (
        "id", "userId", "jobPostingId", "applicationId", "idempotencyKey",
        "activeRunKey", "applyUrlSnapshot", "applyHost", "updatedAt"
      ) VALUES (
        ${runId}, ${userId}, ${jobId}, ${applicationId}, ${`${prefix}_idempotency`},
        ${`${prefix}_active`}, 'https://example.test/apply', 'example.test', ${now}
      )
    `)
  ]);
}

async function insertLegacyAnswer(
  client: PrismaClient,
  prefix: string,
  fixture: LegacyAnswerFixture
): Promise<void> {
  const status = fixture.status ?? "PENDING";
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "ApplicationRunAnswer" (
      "id", "runId", "userId", "normalizedFieldKey", "originalQuestion", "proposedValue",
      "sourceIds", "evidenceIds", "confidence", "sensitive", "valueRedacted", "status",
      "reviewedByUser", "reviewedAt", "finalValueHash", "updatedAt"
    ) VALUES (
      ${fixture.id}, ${`${prefix}_run`}, ${`${prefix}_user`}, ${fixture.normalizedFieldKey},
      'legacy fixture question', ${fixture.proposedValue ?? null},
      ${textArray(fixture.sourceIds === undefined ? [] : fixture.sourceIds)},
      ${textArray(fixture.evidenceIds === undefined ? [] : fixture.evidenceIds)},
      ${fixture.confidence ?? 0}, ${fixture.sensitive ?? false}, ${fixture.valueRedacted ?? false},
      ${status}::"ApplicationRunAnswerStatus", ${fixture.reviewedByUser ?? false},
      ${fixture.reviewedAt ?? null}::TIMESTAMP(3), ${fixture.finalValueHash ?? null}, CURRENT_TIMESTAMP
    )
  `);
}

async function safeLegacySnapshot(client: PrismaClient): Promise<unknown[]> {
  return client.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      "id",
      "sourceIds" IS NULL AS "sourceIdsNull",
      "evidenceIds" IS NULL AS "evidenceIdsNull",
      "sourceIds",
      "evidenceIds",
      "confidence",
      "sensitive",
      "valueRedacted",
      "status"::TEXT AS "status",
      "reviewedByUser",
      "reviewedAt",
      "finalValueHash",
      CASE
        WHEN "proposedValue" IS NULL THEN NULL
        ELSE encode(sha256(convert_to("proposedValue", 'UTF8')), 'hex')
      END AS "proposedValueHash"
    FROM "ApplicationRunAnswer"
    ORDER BY "id"
  `);
}

async function runAuditCli(workspace: TransitionWorkspace): Promise<CommandResult> {
  return runCommand(
    process.execPath,
    ["--import", "tsx", path.join(repositoryRoot, "scripts", "audit-application-run-answer-legacy.ts")],
    {
      ...childEnvironment(workspace.childUrl),
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL: workspace.childUrl
    }
  );
}

function packetAnswerDefaults(fixture: PacketAnswerFixture): Required<PacketAnswerFixture> {
  return {
    id: fixture.id,
    packetId: fixture.packetId,
    normalizedFieldKey: fixture.normalizedFieldKey,
    normalizedQuestion: fixture.normalizedQuestion === undefined ? "" : fixture.normalizedQuestion,
    fieldFingerprint: fixture.fieldFingerprint === undefined ? sha256("field") : fixture.fieldFingerprint,
    fieldType: fixture.fieldType === undefined ? "TEXT" : fixture.fieldType,
    classification: fixture.classification === undefined ? "UNKNOWN" : fixture.classification,
    disposition: fixture.disposition ?? "PROPOSABLE",
    dispositionReason: fixture.dispositionReason ?? null,
    proposal: fixture.proposal === undefined ? { kind: "SCALAR", value: "safe" } : fixture.proposal,
    sourceType: fixture.sourceType === undefined ? "PROFILE" : fixture.sourceType,
    sourceIds: fixture.sourceIds ?? ["source-1"],
    evidenceIds: fixture.evidenceIds ?? [],
    sourceFingerprint:
      fixture.sourceFingerprint === undefined ? sha256("source") : fixture.sourceFingerprint,
    confidence: fixture.confidence ?? 100,
    sensitive: fixture.sensitive ?? false,
    valueRedacted: fixture.valueRedacted ?? false,
    requiresReview: fixture.requiresReview ?? true,
    status: fixture.status ?? "PENDING",
    reviewedByUser: fixture.reviewedByUser ?? false,
    reviewedAt: fixture.reviewedAt ?? null,
    finalValueHash: fixture.finalValueHash ?? null,
    reviewHashVersion: fixture.reviewHashVersion ?? null
  };
}

async function insertPacketAnswer(
  client: PrismaClient,
  prefix: string,
  fixture: PacketAnswerFixture
): Promise<void> {
  const answer = packetAnswerDefaults(fixture);
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "ApplicationRunAnswer" (
      "id", "runId", "userId", "answerPacketId", "normalizedFieldKey", "originalQuestion",
      "normalizedQuestion", "fieldFingerprint", "fieldType", "classification", "disposition",
      "dispositionReason", "proposedValue", "proposal", "valueRedacted", "sourceType", "sourceIds",
      "evidenceIds", "sourceFingerprint", "confidence", "sensitive", "required", "requiresReview",
      "status", "reviewedByUser", "reviewedAt", "finalValueHash", "reviewHashVersion", "updatedAt"
    ) VALUES (
      ${answer.id}, ${`${prefix}_run`}, ${`${prefix}_user`}, ${answer.packetId},
      ${answer.normalizedFieldKey}, 'packet fixture question', ${answer.normalizedQuestion},
      ${answer.fieldFingerprint}, ${answer.fieldType}::"ApplicationFormFieldType",
      ${answer.classification}::"ApplicationQuestionClassification",
      ${answer.disposition}::"ApplicationAnswerDisposition",
      ${answer.dispositionReason}::"ApplicationAnswerDispositionReason", NULL,
      ${jsonValue(answer.proposal)}, ${answer.valueRedacted},
      ${answer.sourceType}::"ApplicationAnswerSourceType", ${textArray(answer.sourceIds)},
      ${textArray(answer.evidenceIds)}, ${answer.sourceFingerprint}, ${answer.confidence},
      ${answer.sensitive}, false, ${answer.requiresReview}, ${answer.status}::"ApplicationRunAnswerStatus",
      ${answer.reviewedByUser}, ${answer.reviewedAt}::TIMESTAMP(3), ${answer.finalValueHash},
      ${answer.reviewHashVersion}::"ApplicationAnswerReviewHashVersion", CURRENT_TIMESTAMP
    )
  `);
}

async function assertConstraintRejected(
  operation: Promise<unknown>,
  constraintName: string
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const diagnostic =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? `${error.message} ${String(error.meta?.message ?? "")}`
        : String(error);
    return diagnostic.includes(constraintName);
  });
}

test("F2 audit and migration preserve valid legacy rows and enforce packet persistence", async () => {
  const workspace = await createTransitionWorkspace();
  const prefix = `valid_${randomUUID().slice(0, 8)}`;
  const approvedValue = "Résumé\n東京";
  const approvedHash = sha256(approvedValue);
  const orderedSources = ["source-b", "source-a"];
  const orderedEvidence = ["evidence-2", "evidence-1"];

  try {
    await insertFixtureGraph(workspace.child, prefix);
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_pending`,
      normalizedFieldKey: "legacy-pending"
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_approved`,
      normalizedFieldKey: "legacy-approved",
      proposedValue: approvedValue,
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: new Date(),
      finalValueHash: approvedHash
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_rejected`,
      normalizedFieldKey: "legacy-rejected",
      proposedValue: "rejected",
      status: "REJECTED",
      reviewedByUser: true,
      reviewedAt: new Date()
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_null_arrays`,
      normalizedFieldKey: "legacy-null-arrays",
      sourceIds: null,
      evidenceIds: null
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_ordered_arrays`,
      normalizedFieldKey: "legacy-ordered-arrays",
      sourceIds: orderedSources,
      evidenceIds: orderedEvidence
    });

    const beforeAudit = await safeLegacySnapshot(workspace.child);
    const findings = await auditLegacyApplicationRunAnswers({
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL: workspace.childUrl
    });
    assert.deepEqual(
      findings.map(({ code, severity, count }) => ({ code, severity, count })),
      [
        { code: "EVIDENCE_IDS_NULL", severity: "REPAIRABLE", count: 1 },
        { code: "SOURCE_IDS_NULL", severity: "REPAIRABLE", count: 1 }
      ]
    );
    assert.deepEqual(await safeLegacySnapshot(workspace.child), beforeAudit);

    const cliAudit = await runAuditCli(workspace);
    assert.equal(cliAudit.timedOut, false);
    assert.equal(cliAudit.exitCode, 0);
    assert.doesNotMatch(cliAudit.output, /Résumé|東京|source-b|evidence-2|postgres(?:ql)?:\/\//);
    const cliFindings = JSON.parse(cliAudit.output) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(cliFindings[0]), ["code", "count", "rowIds"]);

    const deploy = await deployF2(workspace);
    assert.equal(deploy.timedOut, false);
    assert.equal(deploy.exitCode, 0, deploy.output);

    const legacyRows = await workspace.child.$queryRaw<
      Array<{
        id: string;
        answerPacketId: string | null;
        normalizedQuestion: string | null;
        proposal: unknown | null;
        proposedValueHash: string | null;
        finalValueHash: string | null;
        reviewHashVersion: string | null;
        sourceIds: string[];
        evidenceIds: string[];
      }>
    >(Prisma.sql`
      SELECT
        "id", "answerPacketId", "normalizedQuestion", "proposal",
        CASE
          WHEN "proposedValue" IS NULL THEN NULL
          ELSE encode(sha256(convert_to("proposedValue", 'UTF8')), 'hex')
        END AS "proposedValueHash",
        "finalValueHash", "reviewHashVersion"::TEXT AS "reviewHashVersion", "sourceIds", "evidenceIds"
      FROM "ApplicationRunAnswer"
      ORDER BY "id"
    `);
    assert.equal(legacyRows.length, 5);
    assert.ok(legacyRows.every((row) => row.answerPacketId === null));
    assert.ok(legacyRows.every((row) => row.normalizedQuestion === null));
    assert.ok(legacyRows.every((row) => row.proposal === null));
    const approvedRow = legacyRows.find((row) => row.id === `${prefix}_approved`);
    assert.equal(approvedRow?.proposedValueHash, approvedHash);
    assert.equal(approvedRow?.finalValueHash, approvedHash);
    assert.equal(approvedRow?.reviewHashVersion, "LEGACY_SCALAR_SHA256");
    assert.ok(
      legacyRows
        .filter((row) => row.id !== `${prefix}_approved`)
        .every((row) => row.reviewHashVersion === null)
    );
    const repairedRow = legacyRows.find((row) => row.id === `${prefix}_null_arrays`);
    assert.deepEqual(repairedRow?.sourceIds, []);
    assert.deepEqual(repairedRow?.evidenceIds, []);
    const orderedRow = legacyRows.find((row) => row.id === `${prefix}_ordered_arrays`);
    assert.deepEqual(orderedRow?.sourceIds, orderedSources);
    assert.deepEqual(orderedRow?.evidenceIds, orderedEvidence);

    const countersAndParents = await workspace.child.$queryRaw<
      Array<{ inspectionVersion: number; packetVersion: number; inspections: number; packets: number }>
    >(Prisma.sql`
      SELECT
        run."currentFormInspectionVersion" AS "inspectionVersion",
        run."currentAnswerPacketVersion" AS "packetVersion",
        (SELECT COUNT(*)::int FROM "ApplicationRunFormInspection") AS "inspections",
        (SELECT COUNT(*)::int FROM "ApplicationRunAnswerPacket") AS "packets"
      FROM "ApplicationRun" AS run
      WHERE run."id" = ${`${prefix}_run`}
    `);
    assert.deepEqual(countersAndParents[0], {
      inspectionVersion: 0,
      packetVersion: 0,
      inspections: 0,
      packets: 0
    });

    const enumRows = await workspace.child.$queryRaw<Array<{ typeName: string; values: string[] }>>(Prisma.sql`
      SELECT enum_type.typname AS "typeName", array_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder) AS "values"
      FROM pg_type AS enum_type
      INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
      WHERE namespace.nspname = current_schema()
        AND enum_type.typname IN (
          'ApplicationAnswerSourceType',
          'ApplicationFormFieldType',
          'ApplicationQuestionClassification',
          'ApplicationAnswerDisposition',
          'ApplicationAnswerDispositionReason',
          'ApplicationAnswerReviewHashVersion'
        )
      GROUP BY enum_type.typname
      ORDER BY enum_type.typname
    `);
    assert.equal(enumRows.length, 6);
    assert.ok(
      enumRows.find((row) => row.typeName === "ApplicationAnswerSourceType")?.values.includes("COVER_LETTER")
    );

    const constraintNames = await workspace.child.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT constraint_metadata.conname AS "name"
      FROM pg_constraint AS constraint_metadata
      INNER JOIN pg_namespace AS namespace ON namespace.oid = constraint_metadata.connamespace
      WHERE namespace.nspname = current_schema()
        AND constraint_metadata.conname LIKE '%_ck'
      ORDER BY constraint_metadata.conname
    `);
    for (const expectedName of [
      "application_run_form_inspection_version_nonnegative_ck",
      "application_run_answer_packet_version_nonnegative_ck",
      "form_inspection_component_versions_positive_ck",
      "form_inspection_fingerprint_sha256_ck",
      "form_inspection_snapshot_object_ck",
      "answer_packet_component_versions_positive_ck",
      "answer_packet_hashes_sha256_ck",
      "answer_packet_reviewed_after_created_ck",
      "run_answer_confidence_range_ck",
      "run_answer_proposal_shape_ck",
      "run_answer_packet_identity_ck",
      "run_answer_packet_disposition_ck",
      "run_answer_packet_privacy_ck",
      "run_answer_packet_review_lifecycle_ck",
      "run_answer_packet_hash_versions_ck"
    ]) {
      assert.ok(constraintNames.some(({ name }) => name === expectedName), expectedName);
    }

    const foreignKeys = await workspace.child.$queryRaw<Array<{ name: string; deleteAction: string }>>(Prisma.sql`
      SELECT conname AS "name", confdeltype::TEXT AS "deleteAction"
      FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace
        AND conname IN (
          'ApplicationRunFormInspection_runId_fkey',
          'ApplicationRunFormInspection_userId_fkey',
          'ApplicationRunAnswerPacket_runId_fkey',
          'ApplicationRunAnswerPacket_userId_fkey',
          'ApplicationRunAnswerPacket_formInspectionId_fkey',
          'ApplicationRunAnswer_answerPacketId_fkey'
        )
      ORDER BY conname
    `);
    assert.equal(foreignKeys.length, 6);
    assert.ok(foreignKeys.every(({ deleteAction }) => deleteAction === "c"));

    const hashA = sha256("a");
    const hashB = sha256("b");
    const inspectionId = `${prefix}_inspection`;
    const packetOneId = `${prefix}_packet_1`;
    const packetTwoId = `${prefix}_packet_2`;
    await workspace.child.$executeRaw(Prisma.sql`
      INSERT INTO "ApplicationRunFormInspection" (
        "id", "runId", "userId", "version", "schemaVersion", "normalizerVersion",
        "classifierVersion", "fingerprintVersion", "formFingerprint", "normalizedSnapshot"
      ) VALUES (
        ${inspectionId}, ${`${prefix}_run`}, ${`${prefix}_user`}, 1, 1, 1, 1, 1, ${hashA}, '{}'::JSONB
      )
    `);
    for (const [packetId, version] of [
      [packetOneId, 1],
      [packetTwoId, 2]
    ] as const) {
      await workspace.child.$executeRaw(Prisma.sql`
        INSERT INTO "ApplicationRunAnswerPacket" (
          "id", "runId", "userId", "version", "formInspectionId", "schemaVersion",
          "builderVersion", "policyHash", "inputHash", "packetHash"
        ) VALUES (
          ${packetId}, ${`${prefix}_run`}, ${`${prefix}_user`}, ${version}, ${inspectionId}, 1, 1,
          ${hashA}, ${hashB}, ${sha256(`packet-${version}`)}
        )
      `);
    }

    await assertConstraintRejected(
      workspace.child.$executeRaw(Prisma.sql`
        UPDATE "ApplicationRun" SET "currentFormInspectionVersion" = -1 WHERE "id" = ${`${prefix}_run`}
      `),
      "application_run_form_inspection_version_nonnegative_ck"
    );
    await assertConstraintRejected(
      workspace.child.$executeRaw(Prisma.sql`
        INSERT INTO "ApplicationRunFormInspection" (
          "id", "runId", "userId", "version", "schemaVersion", "normalizerVersion",
          "classifierVersion", "fingerprintVersion", "formFingerprint", "normalizedSnapshot"
        ) VALUES (
          ${`${prefix}_bad_inspection`}, ${`${prefix}_run`}, ${`${prefix}_user`}, 0, 1, 1, 1, 1, ${hashA}, '[]'::JSONB
        )
      `),
      "form_inspection_component_versions_positive_ck"
    );
    await assertConstraintRejected(
      workspace.child.$executeRaw(Prisma.sql`
        UPDATE "ApplicationRunAnswerPacket" SET "reviewedAt" = "createdAt" - INTERVAL '1 second'
        WHERE "id" = ${packetOneId}
      `),
      "answer_packet_reviewed_after_created_ck"
    );

    const emptyQuestionKey = sha256("empty-question");
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_empty_question`,
      packetId: packetOneId,
      normalizedFieldKey: emptyQuestionKey,
      normalizedQuestion: ""
    });
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_text_question`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("text-question"),
      normalizedQuestion: "linkedin profile"
    });
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_null_question`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("null-question"),
        normalizedQuestion: null
      }),
      "run_answer_packet_identity_ck"
    );

    const rejectedPacketCases: Array<[string, Partial<PacketAnswerFixture>, string]> = [
      ["null-field", { fieldFingerprint: null }, "run_answer_packet_identity_ck"],
      ["bad-field", { fieldFingerprint: "not-a-hash" }, "run_answer_packet_identity_ck"],
      ["no-kind", { proposal: { value: "x" } }, "run_answer_proposal_shape_ck"],
      ["null-kind", { proposal: { kind: null } }, "run_answer_proposal_shape_ck"],
      ["number-kind", { proposal: { kind: 1 } }, "run_answer_proposal_shape_ck"],
      ["bad-kind", { proposal: { kind: "OTHER" } }, "run_answer_proposal_shape_ck"],
      ["null-source-hash", { sourceFingerprint: null }, "run_answer_packet_disposition_ck"],
      ["bad-source-hash", { sourceFingerprint: "bad" }, "run_answer_packet_disposition_ck"],
      ["zero-sources", { sourceIds: [] }, "run_answer_packet_disposition_ck"],
      ["two-sources", { sourceIds: ["one", "two"] }, "run_answer_packet_disposition_ck"]
    ];
    for (const [label, overrides, constraint] of rejectedPacketCases) {
      await assertConstraintRejected(
        insertPacketAnswer(workspace.child, prefix, {
          id: `${prefix}_${label}`,
          packetId: packetOneId,
          normalizedFieldKey: sha256(label),
          ...overrides
        }),
        constraint
      );
    }

    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_boolean_kind`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("boolean-kind"),
      proposal: { kind: "BOOLEAN", value: true },
      sourceIds: ["exactly-one"]
    });
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_approved_null_hash`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("approved-null-hash"),
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: new Date(),
        finalValueHash: null,
        reviewHashVersion: "CANONICAL_PROPOSAL_V1"
      }),
      "run_answer_packet_review_lifecycle_ck"
    );
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_approved_bad_hash`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("approved-bad-hash"),
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: new Date(),
        finalValueHash: "bad",
        reviewHashVersion: "CANONICAL_PROPOSAL_V1"
      }),
      "run_answer_packet_review_lifecycle_ck"
    );
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_approved_legacy_version`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("approved-legacy-version"),
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: new Date(),
        finalValueHash: hashA,
        reviewHashVersion: "LEGACY_SCALAR_SHA256"
      }),
      "run_answer_packet_hash_versions_ck"
    );
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_approved_valid`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("approved-valid"),
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: new Date(),
      finalValueHash: hashA,
      reviewHashVersion: "CANONICAL_PROPOSAL_V1"
    });
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_rejected_valid`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("rejected-valid"),
      status: "REJECTED",
      reviewedByUser: true,
      reviewedAt: new Date()
    });

    const manualDefaults: Partial<PacketAnswerFixture> = {
      disposition: "MANUAL_ONLY",
      dispositionReason: "NO_ELIGIBLE_SOURCE",
      proposal: null,
      sourceType: null,
      sourceIds: [],
      sourceFingerprint: null,
      confidence: 0,
      requiresReview: false
    };
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_manual_valid`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("manual-valid"),
      ...manualDefaults
    });
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_manual_review`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("manual-review"),
        ...manualDefaults,
        requiresReview: true
      }),
      "run_answer_packet_disposition_ck"
    );
    await assertConstraintRejected(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_excluded_not_private`,
        packetId: packetOneId,
        normalizedFieldKey: sha256("excluded-not-private"),
        ...manualDefaults,
        disposition: "EXCLUDED",
        dispositionReason: "POLICY_EXCLUDED"
      }),
      "run_answer_packet_privacy_ck"
    );
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_excluded_valid`,
      packetId: packetOneId,
      normalizedFieldKey: sha256("excluded-valid"),
      ...manualDefaults,
      disposition: "EXCLUDED",
      dispositionReason: "POLICY_EXCLUDED",
      sensitive: true,
      valueRedacted: true
    });

    await assert.rejects(
      insertPacketAnswer(workspace.child, prefix, {
        id: `${prefix}_same_packet_duplicate`,
        packetId: packetOneId,
        normalizedFieldKey: emptyQuestionKey
      })
    );
    await insertPacketAnswer(workspace.child, prefix, {
      id: `${prefix}_different_packet_same_field`,
      packetId: packetTwoId,
      normalizedFieldKey: emptyQuestionKey
    });
    await assert.rejects(
      insertLegacyAnswer(workspace.child, prefix, {
        id: `${prefix}_legacy_duplicate`,
        normalizedFieldKey: "legacy-pending"
      })
    );
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_legacy_packet_overlap`,
      normalizedFieldKey: emptyQuestionKey
    });

    const indexes = await workspace.child.$queryRaw<
      Array<{
        name: string;
        unique: boolean;
        valid: boolean;
        nullsNotDistinct: boolean;
        columns: string[];
        predicate: string | null;
      }>
    >(Prisma.sql`
      SELECT
        index_relation.relname AS "name",
        index_metadata.indisunique AS "unique",
        index_metadata.indisvalid AS "valid",
        index_metadata.indnullsnotdistinct AS "nullsNotDistinct",
        ARRAY(
          SELECT attribute_metadata.attname
          FROM unnest(index_metadata.indkey::SMALLINT[]) WITH ORDINALITY
            AS indexed_key("attributeNumber", "position")
          INNER JOIN pg_attribute AS attribute_metadata
            ON attribute_metadata.attrelid = index_metadata.indrelid
           AND attribute_metadata.attnum = indexed_key."attributeNumber"
          WHERE indexed_key."position" <= index_metadata.indnkeyatts
          ORDER BY indexed_key."position"
        ) AS "columns",
        pg_get_expr(index_metadata.indpred, index_metadata.indrelid) AS "predicate"
      FROM pg_index AS index_metadata
      INNER JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND index_relation.relname IN (
          'ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key',
          'ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key',
          'ApplicationRunAnswer_runId_normalizedFieldKey_key',
          'ApplicationRunAnswer_runId_idx'
        )
      ORDER BY index_relation.relname
    `);
    assert.deepEqual(
      indexes.map(({ name }) => name),
      [
        "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key",
        "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key",
        "ApplicationRunAnswer_runId_idx"
      ]
    );
    assert.ok(indexes.every(({ valid }) => valid));
    assert.deepEqual(
      indexes.find(({ name }) => name === "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key"),
      {
        name: "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key",
        unique: true,
        valid: true,
        nullsNotDistinct: false,
        columns: ["answerPacketId", "normalizedFieldKey"],
        predicate: null
      }
    );
    const legacyUnique = indexes.find(
      ({ name }) => name === "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key"
    );
    assert.deepEqual(
      legacyUnique && {
        name: legacyUnique.name,
        unique: legacyUnique.unique,
        valid: legacyUnique.valid,
        nullsNotDistinct: legacyUnique.nullsNotDistinct,
        columns: legacyUnique.columns
      },
      {
        name: "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key",
        unique: true,
        valid: true,
        nullsNotDistinct: false,
        columns: ["runId", "normalizedFieldKey"]
      }
    );
    assert.match(legacyUnique?.predicate ?? "", /^\(*\s*"answerPacketId"\s+IS\s+NULL\s*\)*$/);

    await workspace.child.$executeRaw`DELETE FROM "ApplicationRunAnswerPacket" WHERE "id" = ${packetOneId}`;
    const packetOneAnswers = await workspace.child.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM "ApplicationRunAnswer" WHERE "answerPacketId" = ${packetOneId}
    `;
    assert.equal(packetOneAnswers[0]?.count, 0);
    await workspace.child.$executeRaw`DELETE FROM "ApplicationRunFormInspection" WHERE "id" = ${inspectionId}`;
    const remainingParents = await workspace.child.$queryRaw<Array<{ packets: number; answers: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM "ApplicationRunAnswerPacket" WHERE "formInspectionId" = ${inspectionId}) AS "packets",
        (SELECT COUNT(*)::int FROM "ApplicationRunAnswer" WHERE "answerPacketId" = ${packetTwoId}) AS "answers"
    `;
    assert.deepEqual(remainingParents[0], { packets: 0, answers: 0 });
  } finally {
    await workspace.cleanup();
  }
});

test("F2 migration blocks anomalous legacy data and rolls back all application changes", async () => {
  const workspace = await createTransitionWorkspace();
  const prefix = `invalid_${randomUUID().slice(0, 8)}`;
  const plaintextSentinel = `private-${randomUUID()}`;

  try {
    await insertFixtureGraph(workspace.child, prefix);
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_confidence`,
      normalizedFieldKey: "bad-confidence",
      sourceIds: null,
      evidenceIds: null,
      confidence: 101
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_hash`,
      normalizedFieldKey: "bad-hash",
      proposedValue: "exact-format-wrong-content",
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: new Date(),
      finalValueHash: "a".repeat(64)
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_lifecycle`,
      normalizedFieldKey: "bad-lifecycle",
      status: "PENDING",
      reviewedByUser: true,
      reviewedAt: new Date()
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_privacy`,
      normalizedFieldKey: "bad-privacy",
      proposedValue: plaintextSentinel,
      sensitive: true,
      valueRedacted: true
    });

    const beforeAudit = await safeLegacySnapshot(workspace.child);
    const auditFindings = await auditLegacyApplicationRunAnswers({
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT: "1",
      APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL: workspace.childUrl
    });
    assert.ok(auditFindings.some(({ code }) => code === "APPROVED_FINAL_HASH_MISMATCH"));
    assert.ok(auditFindings.some(({ code }) => code === "CONFIDENCE_OUT_OF_RANGE"));
    assert.ok(auditFindings.some(({ code }) => code === "PENDING_REVIEW_METADATA_INVALID"));
    assert.ok(auditFindings.some(({ code }) => code === "SENSITIVE_PLAINTEXT_PRESENT"));
    assert.ok(auditFindings.some(({ code }) => code === "REDACTED_PLAINTEXT_PRESENT"));
    assert.ok(auditFindings.some(({ code, severity }) => code === "SOURCE_IDS_NULL" && severity === "REPAIRABLE"));
    assert.ok(auditFindings.some(({ severity }) => severity === "BLOCKING"));
    assert.deepEqual(await safeLegacySnapshot(workspace.child), beforeAudit);

    const cliAudit = await runAuditCli(workspace);
    assert.equal(cliAudit.timedOut, false);
    assert.notEqual(cliAudit.exitCode, 0);
    assert.doesNotMatch(cliAudit.output, new RegExp(plaintextSentinel));
    assert.doesNotMatch(cliAudit.output, /exact-format-wrong-content|postgres(?:ql)?:\/\//);

    const failedDeploy = await deployF2(workspace);
    assert.equal(failedDeploy.timedOut, false);
    assert.notEqual(failedDeploy.exitCode, 0);
    assert.doesNotMatch(failedDeploy.output, new RegExp(plaintextSentinel));

    assert.deepEqual(await safeLegacySnapshot(workspace.child), beforeAudit);
    const rollbackState = await workspace.child.$queryRaw<
      Array<{
        f2TableCount: number;
        f2ColumnCount: number;
        coverLetterCount: number;
        oldIndexCount: number;
      }>
    >(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN ('ApplicationRunFormInspection', 'ApplicationRunAnswerPacket')
        ) AS "f2TableCount",
        (
          SELECT COUNT(*)::int
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ApplicationRunAnswer'
            AND column_name IN ('answerPacketId', 'proposal', 'reviewHashVersion')
        ) AS "f2ColumnCount",
        (
          SELECT COUNT(*)::int
          FROM pg_enum AS enum_value
          INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
          INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
          WHERE namespace.nspname = current_schema()
            AND enum_type.typname = 'ApplicationAnswerSourceType'
            AND enum_value.enumlabel = 'COVER_LETTER'
        ) AS "coverLetterCount",
        (
          SELECT COUNT(*)::int
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'ApplicationRunAnswer_runId_normalizedFieldKey_key'
        ) AS "oldIndexCount"
    `);
    assert.deepEqual(rollbackState[0], {
      f2TableCount: 0,
      f2ColumnCount: 0,
      coverLetterCount: 0,
      oldIndexCount: 1
    });
  } finally {
    await workspace.cleanup();
  }
});

test("a late F2 migration failure rolls back every application schema and data mutation", async () => {
  const workspace = await createTransitionWorkspace();
  const prefix = `late_${randomUUID().slice(0, 8)}`;
  const approvedValue = "late rollback approved value";
  const approvedHash = sha256(approvedValue);

  try {
    await insertFixtureGraph(workspace.child, prefix);
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_approved`,
      normalizedFieldKey: "late-approved",
      proposedValue: approvedValue,
      sourceIds: ["approved-source"],
      evidenceIds: ["approved-evidence"],
      confidence: 73,
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: new Date(),
      finalValueHash: approvedHash
    });
    await insertLegacyAnswer(workspace.child, prefix, {
      id: `${prefix}_null_arrays`,
      normalizedFieldKey: "late-null-arrays",
      sourceIds: null,
      evidenceIds: null,
      confidence: 42
    });

    const beforeMigration = await safeLegacySnapshot(workspace.child);
    const failedDeploy = await deployF2WithLateFailure(workspace);
    assert.equal(failedDeploy.timedOut, false);
    assert.notEqual(failedDeploy.exitCode, 0);

    assert.deepEqual(await safeLegacySnapshot(workspace.child), beforeMigration);
    const rollbackState = await workspace.child.$queryRaw<
      Array<{
        coverLetterCount: number;
        f2EnumCount: number;
        f2TableCount: number;
        f2AnswerColumnCount: number;
        f2RunCounterCount: number;
        f2ConstraintCount: number;
        oldIndexCount: number;
        newIndexCount: number;
      }>
    >(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM pg_enum AS enum_value
          INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
          INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
          WHERE namespace.nspname = current_schema()
            AND enum_type.typname = 'ApplicationAnswerSourceType'
            AND enum_value.enumlabel = 'COVER_LETTER'
        ) AS "coverLetterCount",
        (
          SELECT COUNT(*)::int
          FROM pg_type AS enum_type
          INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
          WHERE namespace.nspname = current_schema()
            AND enum_type.typname IN (
              'ApplicationFormFieldType',
              'ApplicationQuestionClassification',
              'ApplicationAnswerDisposition',
              'ApplicationAnswerDispositionReason',
              'ApplicationAnswerReviewHashVersion'
            )
        ) AS "f2EnumCount",
        (
          SELECT COUNT(*)::int
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN ('ApplicationRunFormInspection', 'ApplicationRunAnswerPacket')
        ) AS "f2TableCount",
        (
          SELECT COUNT(*)::int
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ApplicationRunAnswer'
            AND column_name IN (
              'answerPacketId',
              'normalizedQuestion',
              'fieldFingerprint',
              'semanticFieldKey',
              'fieldType',
              'classification',
              'disposition',
              'dispositionReason',
              'proposal',
              'sourceFingerprint',
              'reviewHashVersion'
            )
        ) AS "f2AnswerColumnCount",
        (
          SELECT COUNT(*)::int
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ApplicationRun'
            AND column_name IN ('currentFormInspectionVersion', 'currentAnswerPacketVersion')
        ) AS "f2RunCounterCount",
        (
          SELECT COUNT(*)::int
          FROM pg_constraint AS constraint_metadata
          INNER JOIN pg_namespace AS namespace ON namespace.oid = constraint_metadata.connamespace
          WHERE namespace.nspname = current_schema()
            AND constraint_metadata.conname IN (
              'application_run_form_inspection_version_nonnegative_ck',
              'application_run_answer_packet_version_nonnegative_ck',
              'run_answer_confidence_range_ck',
              'run_answer_proposal_shape_ck',
              'run_answer_packet_identity_ck',
              'run_answer_packet_disposition_ck',
              'run_answer_packet_privacy_ck',
              'run_answer_packet_review_lifecycle_ck',
              'run_answer_packet_hash_versions_ck'
            )
        ) AS "f2ConstraintCount",
        (
          SELECT COUNT(*)::int
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'ApplicationRunAnswer_runId_normalizedFieldKey_key'
        ) AS "oldIndexCount",
        (
          SELECT COUNT(*)::int
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN (
              'ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key',
              'ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key',
              'ApplicationRunAnswer_runId_idx'
            )
        ) AS "newIndexCount"
    `);
    assert.deepEqual(rollbackState[0], {
      coverLetterCount: 0,
      f2EnumCount: 0,
      f2TableCount: 0,
      f2AnswerColumnCount: 0,
      f2RunCounterCount: 0,
      f2ConstraintCount: 0,
      oldIndexCount: 1,
      newIndexCount: 0
    });
  } finally {
    await workspace.cleanup();
  }
});
