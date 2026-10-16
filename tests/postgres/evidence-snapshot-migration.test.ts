import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const repositoryPrismaDirectory = path.join(repositoryRoot, "prisma");
const repositoryMigrationsDirectory = path.join(repositoryPrismaDirectory, "migrations");
const migrationName = "20261008120000_add_evidence_snapshots";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);

type CommandResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

type SourceGraph = {
  userId: string;
  jobId: string;
  resumeId: string;
  analysisId: string;
};

function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
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
    child.once("error", () => reject(new Error("Evidence snapshot migration command could not start.")));
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
    AI_ENABLED: "false",
    AI_MOCK_MODE: "true",
    OPENAI_MOCK_MODE: "true",
    GEMINI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENAI_API_KEY: "",
    PRISMA_HIDE_UPDATE_MESSAGE: "1"
  };
}

async function guardedDatabaseUrl(): Promise<string> {
  const config = validatePostgresTestEnvironment(process.env);
  const liveDatabase = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(liveDatabase);
  return config.url;
}

async function createSourceGraph(client: PrismaClient, label: string): Promise<SourceGraph> {
  const suffix = randomUUID();
  const user = await client.user.create({
    data: { email: `${label}-${suffix}@example.test` },
    select: { id: true }
  });
  const job = await client.jobPosting.create({
    data: {
      userId: user.id,
      title: `${label} synthetic role`,
      normalizedTitle: `${label}-synthetic-role-${suffix}`,
      company: `${label} Synthetic Company`,
      normalizedCompany: `${label}-synthetic-company-${suffix}`,
      normalizedLocation: `remote-${suffix}`,
      sourceUrl: `https://example.test/jobs/${suffix}`,
      normalizedApplyUrl: `https://example.test/apply/${suffix}`,
      description: "Synthetic evidence snapshot migration fixture.",
      requirements: [],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      sourceType: "MANUAL",
      missingKeywords: [],
      supportedKeywords: [],
      concerns: []
    },
    select: { id: true }
  });
  const resume = await client.resume.create({
    data: {
      userId: user.id,
      title: `${label} synthetic source`,
      rawText: "Synthetic source text only.",
      skills: [],
      achievements: []
    },
    select: { id: true }
  });
  const analysis = await client.aIAnalysis.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      type: "JOB_MATCH",
      model: "synthetic-model",
      promptName: "synthetic-evidence-migration",
      promptVersion: "test",
      inputHash: hashA,
      input: { fixture: true },
      output: { gaps: [] }
    },
    select: { id: true }
  });
  return { userId: user.id, jobId: job.id, resumeId: resume.id, analysisId: analysis.id };
}

async function createSnapshot(
  client: PrismaClient,
  graph: SourceGraph,
  label: string
): Promise<string> {
  const source = await client.resume.findUniqueOrThrow({
    where: { id: graph.resumeId },
    select: { updatedAt: true }
  });
  const snapshot = await client.evidenceSnapshot.create({
    data: {
      userId: graph.userId,
      jobPostingId: graph.jobId,
      resumeId: graph.resumeId,
      reviewedAnalysisId: graph.analysisId,
      requestId: `${label}-${randomUUID()}`,
      requestHash: hashA,
      sourceResumeUpdatedAt: source.updatedAt,
      snapshotHash: hashB,
      sourceProjectionHash: hashC,
      gapProjectionHash: hashD,
      reviewPayload: { decisions: [], reuseScope: "JOB_ONLY" }
    },
    select: { id: true }
  });
  return snapshot.id;
}

async function assertRejectedWithoutMutation(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation);
}

test("fresh schema exposes the additive table, four nullable bindings, constraints, and triggers", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const migrationRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL',
      migrationName
    );
    assert.equal(migrationRows[0]?.count, 1n);

    const columns = await client.$queryRawUnsafe<Array<{ tableName: string; columnName: string; nullable: string }>>(
      `SELECT table_name AS "tableName", column_name AS "columnName", is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (
           (table_name = 'EvidenceSnapshot') OR
           (table_name = 'JobPosting' AND column_name IN ('currentEvidenceSnapshotId', 'evidenceSnapshotGeneration')) OR
           (table_name IN ('AIAnalysis', 'ResumeVersion', 'GeneratedDocument') AND column_name = 'evidenceSnapshotId')
         )
       ORDER BY table_name, column_name`
    );
    assert.equal(columns.filter((column) => column.tableName === "EvidenceSnapshot").length, 14);
    assert.deepEqual(
      columns.filter((column) => column.tableName !== "EvidenceSnapshot"),
      [
        { tableName: "AIAnalysis", columnName: "evidenceSnapshotId", nullable: "YES" },
        { tableName: "GeneratedDocument", columnName: "evidenceSnapshotId", nullable: "YES" },
        { tableName: "JobPosting", columnName: "currentEvidenceSnapshotId", nullable: "YES" },
        { tableName: "JobPosting", columnName: "evidenceSnapshotGeneration", nullable: "NO" },
        { tableName: "ResumeVersion", columnName: "evidenceSnapshotId", nullable: "YES" }
      ]
    );

    const triggers = await client.$queryRawUnsafe<Array<{ triggerName: string }>>(
      `SELECT trigger_name AS "triggerName"
       FROM information_schema.triggers
       WHERE event_object_schema = current_schema()
         AND trigger_name ILIKE '%evidence%'
       GROUP BY trigger_name
       ORDER BY trigger_name`
    );
    assert.deepEqual(
      triggers.map((row) => row.triggerName),
      [
        "AIAnalysis_evidence_binding_scope",
        "EvidenceSnapshot_scope_and_immutability",
        "GeneratedDocument_evidence_binding_scope",
        "JobPosting_evidence_binding_scope",
        "ResumeVersion_evidence_binding_scope"
      ]
    );
  } finally {
    await client.$disconnect();
  }
});

test("database checks reject invalid schema versions, hashes, and non-object review payloads", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(client, "check-constraints");

  try {
    const source = await client.resume.findUniqueOrThrow({
      where: { id: graph.resumeId },
      select: { updatedAt: true }
    });
    const validValues = {
      schemaVersion: 1,
      requestHash: hashA,
      snapshotHash: hashB,
      sourceProjectionHash: hashC,
      gapProjectionHash: hashD,
      reviewPayload: JSON.stringify({ decisions: [], reuseScope: "JOB_ONLY" })
    };
    const insert = (overrides: Partial<typeof validValues>) => {
      const values = { ...validValues, ...overrides };
      return client.$executeRawUnsafe(
        `INSERT INTO "EvidenceSnapshot" (
          "id", "userId", "jobPostingId", "resumeId", "reviewedAnalysisId",
          "requestId", "requestHash", "schemaVersion", "sourceResumeUpdatedAt",
          "snapshotHash", "sourceProjectionHash", "gapProjectionHash", "reviewPayload"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
        randomUUID(),
        graph.userId,
        graph.jobId,
        graph.resumeId,
        graph.analysisId,
        `invalid-check-${randomUUID()}`,
        values.requestHash,
        values.schemaVersion,
        source.updatedAt,
        values.snapshotHash,
        values.sourceProjectionHash,
        values.gapProjectionHash,
        values.reviewPayload
      );
    };

    const invalidCases: Array<Partial<typeof validValues>> = [
      { schemaVersion: 0 },
      { requestHash: "A".repeat(64) },
      { snapshotHash: "b".repeat(63) },
      { sourceProjectionHash: `g${"c".repeat(63)}` },
      { gapProjectionHash: "d".repeat(65) },
      { reviewPayload: JSON.stringify([]) }
    ];
    for (const invalid of invalidCases) {
      await assertRejectedWithoutMutation(insert(invalid));
    }
    assert.equal(await client.evidenceSnapshot.count({ where: { userId: graph.userId } }), 0);
  } finally {
    await client.user.deleteMany({ where: { id: graph.userId } });
    await client.$disconnect();
  }
});

test("the job generation advances exactly once per new pointer and never rewinds", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(client, "generation-invariant");

  try {
    const first = await createSnapshot(client, graph, "generation-first");
    const second = await createSnapshot(client, graph, "generation-second");
    await client.jobPosting.update({
      where: { id: graph.jobId },
      data: { currentEvidenceSnapshotId: first, evidenceSnapshotGeneration: { increment: 1 } }
    });
    await assert.rejects(client.jobPosting.update({
      where: { id: graph.jobId },
      data: { currentEvidenceSnapshotId: second }
    }));
    await assert.rejects(client.jobPosting.update({
      where: { id: graph.jobId },
      data: { evidenceSnapshotGeneration: { increment: 1 } }
    }));
    await assert.rejects(client.jobPosting.update({
      where: { id: graph.jobId },
      data: { evidenceSnapshotGeneration: 0 }
    }));
    const unchanged = await client.jobPosting.findUniqueOrThrow({ where: { id: graph.jobId } });
    assert.equal(unchanged.currentEvidenceSnapshotId, first);
    assert.equal(unchanged.evidenceSnapshotGeneration, 1);

    await client.jobPosting.update({
      where: { id: graph.jobId },
      data: { currentEvidenceSnapshotId: second, evidenceSnapshotGeneration: { increment: 1 } }
    });
    const advanced = await client.jobPosting.findUniqueOrThrow({ where: { id: graph.jobId } });
    assert.equal(advanced.currentEvidenceSnapshotId, second);
    assert.equal(advanced.evidenceSnapshotGeneration, 2);
  } finally {
    await client.user.deleteMany({ where: { id: graph.userId } });
    await client.$disconnect();
  }
});

test("existing-schema upgrade preserves legacy rows and leaves all new bindings null", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const schemaName = `evidence_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "apply-pilot-evidence-migration-"));
  const tempPrismaDirectory = path.join(tempRoot, "prisma");
  const tempMigrationsDirectory = path.join(tempPrismaDirectory, "migrations");
  const tempSchemaPath = path.join(tempPrismaDirectory, "schema.prisma");
  let child: PrismaClient | undefined;

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    const childUrl = new URL(databaseUrl);
    childUrl.searchParams.set("schema", schemaName);
    child = new PrismaClient({ datasources: { db: { url: childUrl.toString() } } });

    await mkdir(tempMigrationsDirectory, { recursive: true });
    await cp(path.join(repositoryPrismaDirectory, "schema.prisma"), tempSchemaPath);
    await cp(
      path.join(repositoryMigrationsDirectory, "migration_lock.toml"),
      path.join(tempMigrationsDirectory, "migration_lock.toml")
    );
    const entries = await readdir(repositoryMigrationsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === migrationName) continue;
      await cp(
        path.join(repositoryMigrationsDirectory, entry.name),
        path.join(tempMigrationsDirectory, entry.name),
        { recursive: true }
      );
    }

    const preUpgrade = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", tempSchemaPath],
      childEnvironment(childUrl.toString())
    );
    assert.equal(preUpgrade.timedOut, false);
    assert.equal(preUpgrade.exitCode, 0, preUpgrade.output);

    const now = new Date("2026-10-08T12:00:00.000Z");
    await child.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, $3)`,
      "legacy_evidence_user",
      "legacy-evidence@example.test",
      now
    );
    await child.$executeRawUnsafe(
      `INSERT INTO "JobPosting" (
        "id", "userId", "title", "normalizedTitle", "company", "normalizedCompany",
        "normalizedLocation", "sourceUrl", "normalizedApplyUrl", "description",
        "requirements", "preferredQualifications", "benefits", "detectedTechStack",
        "sourceType", "missingKeywords", "supportedKeywords", "concerns", "updatedAt"
      ) VALUES (
        $1, $2, 'Legacy evidence role', 'legacy-evidence-role', 'Legacy Evidence Co',
        'legacy-evidence-co', 'remote', 'https://example.test/jobs/legacy-evidence',
        'https://example.test/apply/legacy-evidence', 'legacy evidence fixture',
        ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
        'MANUAL', ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], $3
      )`,
      "legacy_evidence_job",
      "legacy_evidence_user",
      now
    );
    await child.$executeRawUnsafe(
      `INSERT INTO "Resume" (
        "id", "userId", "title", "skills", "achievements", "updatedAt"
      ) VALUES ($1, $2, 'Legacy source', ARRAY[]::TEXT[], ARRAY[]::TEXT[], $3)`,
      "legacy_evidence_resume",
      "legacy_evidence_user",
      now
    );
    await child.$executeRawUnsafe(
      `INSERT INTO "AIAnalysis" (
        "id", "userId", "jobPostingId", "type", "model", "promptName",
        "promptVersion", "input", "output"
      ) VALUES ($1, $2, $3, 'JOB_MATCH', 'legacy-model', 'legacy-prompt', '3.2', '{}'::JSONB, '{}'::JSONB)`,
      "legacy_evidence_analysis",
      "legacy_evidence_user",
      "legacy_evidence_job"
    );
    await child.$executeRawUnsafe(
      `INSERT INTO "ResumeVersion" (
        "id", "userId", "resumeId", "jobPostingId", "title", "skills", "fullText"
      ) VALUES ($1, $2, $3, $4, 'Legacy tailored resume', ARRAY[]::TEXT[], 'legacy resume text')`,
      "legacy_evidence_version",
      "legacy_evidence_user",
      "legacy_evidence_resume",
      "legacy_evidence_job"
    );
    await child.$executeRawUnsafe(
      `INSERT INTO "GeneratedDocument" (
        "id", "userId", "jobPostingId", "type", "title", "content", "updatedAt"
      ) VALUES ($1, $2, $3, 'COVER_LETTER', 'Legacy cover letter', 'legacy cover text', $4)`,
      "legacy_evidence_document",
      "legacy_evidence_user",
      "legacy_evidence_job",
      now
    );

    await cp(
      path.join(repositoryMigrationsDirectory, migrationName),
      path.join(tempMigrationsDirectory, migrationName),
      { recursive: true }
    );
    const upgrade = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", tempSchemaPath],
      childEnvironment(childUrl.toString())
    );
    assert.equal(upgrade.timedOut, false);
    assert.equal(upgrade.exitCode, 0, upgrade.output);

    const legacyRows = await child.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
        job."title" AS "jobTitle",
        job."currentEvidenceSnapshotId" AS "jobBinding",
        job."evidenceSnapshotGeneration" AS "jobGeneration",
        analysis."promptVersion" AS "promptVersion",
        analysis."evidenceSnapshotId" AS "analysisBinding",
        version."fullText" AS "resumeText",
        version."evidenceSnapshotId" AS "resumeBinding",
        document."content" AS "documentText",
        document."evidenceSnapshotId" AS "documentBinding",
        (SELECT COUNT(*)::integer FROM "EvidenceSnapshot") AS "snapshotCount"
       FROM "JobPosting" AS job
       JOIN "AIAnalysis" AS analysis ON analysis."id" = 'legacy_evidence_analysis'
       JOIN "ResumeVersion" AS version ON version."id" = 'legacy_evidence_version'
       JOIN "GeneratedDocument" AS document ON document."id" = 'legacy_evidence_document'
       WHERE job."id" = 'legacy_evidence_job'`
    );
    assert.deepEqual(legacyRows, [
      {
        jobTitle: "Legacy evidence role",
        jobBinding: null,
        jobGeneration: 0,
        promptVersion: "3.2",
        analysisBinding: null,
        resumeText: "legacy resume text",
        resumeBinding: null,
        documentText: "legacy cover text",
        documentBinding: null,
        snapshotCount: 0
      }
    ]);

    const repeatDeploy = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", tempSchemaPath],
      childEnvironment(childUrl.toString())
    );
    assert.equal(repeatDeploy.timedOut, false);
    assert.equal(repeatDeploy.exitCode, 0, repeatDeploy.output);
    assert.match(repeatDeploy.output, /No pending migrations to apply/);
  } finally {
    await child?.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("database scope guards reject cross-tenant and cross-job snapshots and bindings", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const owner = await createSourceGraph(client, "scope-owner");
  const other = await createSourceGraph(client, "scope-other");
  const ownerSecondJob = await client.jobPosting.create({
    data: {
      userId: owner.userId,
      title: "Scope second synthetic role",
      normalizedTitle: `scope-second-${randomUUID()}`,
      company: "Scope Synthetic Company",
      normalizedCompany: `scope-synthetic-${randomUUID()}`,
      normalizedLocation: `remote-${randomUUID()}`,
      sourceUrl: `https://example.test/jobs/${randomUUID()}`,
      normalizedApplyUrl: `https://example.test/apply/${randomUUID()}`,
      description: "Synthetic second job.",
      requirements: [],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      sourceType: "MANUAL",
      missingKeywords: [],
      supportedKeywords: [],
      concerns: []
    },
    select: { id: true }
  });

  try {
    const ownerResume = await client.resume.findUniqueOrThrow({
      where: { id: owner.resumeId },
      select: { updatedAt: true }
    });
    await assertRejectedWithoutMutation(
      client.evidenceSnapshot.create({
        data: {
          userId: owner.userId,
          jobPostingId: owner.jobId,
          resumeId: other.resumeId,
          reviewedAnalysisId: owner.analysisId,
          requestId: `cross-tenant-${randomUUID()}`,
          requestHash: hashA,
          sourceResumeUpdatedAt: ownerResume.updatedAt,
          snapshotHash: hashB,
          sourceProjectionHash: hashC,
          gapProjectionHash: hashD,
          reviewPayload: { decisions: [], reuseScope: "JOB_ONLY" }
        }
      })
    );
    assert.equal(await client.evidenceSnapshot.count({ where: { userId: owner.userId } }), 0);

    await assertRejectedWithoutMutation(
      client.evidenceSnapshot.create({
        data: {
          userId: owner.userId,
          jobPostingId: owner.jobId,
          resumeId: owner.resumeId,
          reviewedAnalysisId: owner.analysisId,
          requestId: `stale-resume-fence-${randomUUID()}`,
          requestHash: hashA,
          sourceResumeUpdatedAt: new Date(ownerResume.updatedAt.getTime() - 1),
          snapshotHash: hashB,
          sourceProjectionHash: hashC,
          gapProjectionHash: hashD,
          reviewPayload: { decisions: [], reuseScope: "JOB_ONLY" }
        }
      })
    );
    assert.equal(await client.evidenceSnapshot.count({ where: { userId: owner.userId } }), 0);

    const snapshotId = await createSnapshot(client, owner, "valid-scope");
    const otherAnalysis = await client.aIAnalysis.create({
      data: {
        userId: owner.userId,
        jobPostingId: ownerSecondJob.id,
        type: "JOB_MATCH",
        model: "synthetic-model",
        promptName: "binding-scope-test",
        input: {},
        output: {}
      },
      select: { id: true }
    });
    const otherResumeVersion = await client.resumeVersion.create({
      data: {
        userId: other.userId,
        jobPostingId: other.jobId,
        title: "Cross-tenant synthetic resume",
        skills: [],
        fullText: "Synthetic only."
      },
      select: { id: true }
    });
    const otherJobDocument = await client.generatedDocument.create({
      data: {
        userId: owner.userId,
        jobPostingId: ownerSecondJob.id,
        type: "COVER_LETTER",
        title: "Wrong-job synthetic document",
        content: "Synthetic only."
      },
      select: { id: true }
    });

    await assertRejectedWithoutMutation(
      client.jobPosting.update({
        where: { id: other.jobId },
        data: { currentEvidenceSnapshotId: snapshotId, evidenceSnapshotGeneration: { increment: 1 } }
      })
    );
    await assertRejectedWithoutMutation(
      client.aIAnalysis.update({ where: { id: otherAnalysis.id }, data: { evidenceSnapshotId: snapshotId } })
    );
    await assertRejectedWithoutMutation(
      client.resumeVersion.update({
        where: { id: otherResumeVersion.id },
        data: { evidenceSnapshotId: snapshotId }
      })
    );
    await assertRejectedWithoutMutation(
      client.generatedDocument.update({
        where: { id: otherJobDocument.id },
        data: { evidenceSnapshotId: snapshotId }
      })
    );

    const bindings = await Promise.all([
      client.jobPosting.findUniqueOrThrow({ where: { id: other.jobId }, select: { currentEvidenceSnapshotId: true } }),
      client.aIAnalysis.findUniqueOrThrow({ where: { id: otherAnalysis.id }, select: { evidenceSnapshotId: true } }),
      client.resumeVersion.findUniqueOrThrow({
        where: { id: otherResumeVersion.id },
        select: { evidenceSnapshotId: true }
      }),
      client.generatedDocument.findUniqueOrThrow({
        where: { id: otherJobDocument.id },
        select: { evidenceSnapshotId: true }
      })
    ]);
    assert.deepEqual(bindings, [
      { currentEvidenceSnapshotId: null },
      { evidenceSnapshotId: null },
      { evidenceSnapshotId: null },
      { evidenceSnapshotId: null }
    ]);

    await assertRejectedWithoutMutation(
      client.evidenceSnapshot.update({ where: { id: snapshotId }, data: { requestHash: hashB } })
    );
    assert.equal(
      (await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, select: { requestHash: true } }))
        .requestHash,
      hashA
    );
  } finally {
    await client.user.deleteMany({ where: { id: { in: [owner.userId, other.userId] } } });
    await client.$disconnect();
  }
});

test("deferred binding guards accept a valid same-transaction source and consumer graph", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(client, "deferred-binding");

  try {
    const result = await client.$transaction(async (transaction) => {
      const source = await transaction.resume.findUniqueOrThrow({
        where: { id: graph.resumeId },
        select: { updatedAt: true }
      });
      const snapshot = await transaction.evidenceSnapshot.create({
        data: {
          userId: graph.userId,
          jobPostingId: graph.jobId,
          resumeId: graph.resumeId,
          reviewedAnalysisId: graph.analysisId,
          requestId: `deferred-binding-${randomUUID()}`,
          requestHash: hashA,
          sourceResumeUpdatedAt: source.updatedAt,
          snapshotHash: hashB,
          sourceProjectionHash: hashC,
          gapProjectionHash: hashD,
          reviewPayload: { decisions: [], reuseScope: "JOB_ONLY" }
        },
        select: { id: true }
      });
      await transaction.jobPosting.update({
        where: { id: graph.jobId },
        data: { currentEvidenceSnapshotId: snapshot.id, evidenceSnapshotGeneration: { increment: 1 } }
      });
      await transaction.aIAnalysis.update({
        where: { id: graph.analysisId },
        data: { evidenceSnapshotId: snapshot.id }
      });
      const resumeVersion = await transaction.resumeVersion.create({
        data: {
          userId: graph.userId,
          resumeId: graph.resumeId,
          jobPostingId: graph.jobId,
          evidenceSnapshotId: snapshot.id,
          title: "Deferred synthetic resume",
          skills: [],
          fullText: "Synthetic only."
        },
        select: { id: true }
      });
      const document = await transaction.generatedDocument.create({
        data: {
          userId: graph.userId,
          jobPostingId: null,
          evidenceSnapshotId: snapshot.id,
          type: "COVER_LETTER",
          title: "Deferred synthetic document",
          content: "Synthetic only."
        },
        select: { id: true }
      });
      await transaction.generatedDocument.update({
        where: { id: document.id },
        data: { jobPostingId: graph.jobId }
      });

      await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      return { snapshotId: snapshot.id, resumeVersionId: resumeVersion.id, documentId: document.id };
    });

    assert.deepEqual(
      await Promise.all([
        client.jobPosting.findUniqueOrThrow({
          where: { id: graph.jobId },
          select: { currentEvidenceSnapshotId: true }
        }),
        client.aIAnalysis.findUniqueOrThrow({
          where: { id: graph.analysisId },
          select: { evidenceSnapshotId: true }
        }),
        client.resumeVersion.findUniqueOrThrow({
          where: { id: result.resumeVersionId },
          select: { evidenceSnapshotId: true }
        }),
        client.generatedDocument.findUniqueOrThrow({
          where: { id: result.documentId },
          select: { evidenceSnapshotId: true }
        })
      ]),
      [
        { currentEvidenceSnapshotId: result.snapshotId },
        { evidenceSnapshotId: result.snapshotId },
        { evidenceSnapshotId: result.snapshotId },
        { evidenceSnapshotId: result.snapshotId }
      ]
    );
  } finally {
    await client.user.deleteMany({ where: { id: graph.userId } });
    await client.$disconnect();
  }
});

test("a concurrent snapshot deletion waits for an in-flight valid binding", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const setup = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const bindingClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const deletingClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(setup, "binding-delete-race");
  const snapshotId = await createSnapshot(setup, graph, "binding-delete-race");
  const document = await setup.generatedDocument.create({
    data: {
      userId: graph.userId,
      jobPostingId: graph.jobId,
      type: "COVER_LETTER",
      title: "Binding race synthetic document",
      content: "Synthetic only."
    },
    select: { id: true }
  });
  let releaseBinding!: () => void;
  const holdBinding = new Promise<void>((resolve) => {
    releaseBinding = resolve;
  });
  let bindingWritten!: () => void;
  const bindingReady = new Promise<void>((resolve) => {
    bindingWritten = resolve;
  });

  const bindingTransaction = bindingClient.$transaction(async (transaction) => {
    await transaction.generatedDocument.update({
      where: { id: document.id },
      data: { evidenceSnapshotId: snapshotId }
    });
    bindingWritten();
    await holdBinding;
  });

  try {
    await bindingReady;
    await assert.rejects(
      deletingClient.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
        await transaction.evidenceSnapshot.delete({ where: { id: snapshotId } });
      }),
      /lock timeout/i
    );
  } finally {
    releaseBinding();
    await bindingTransaction;
  }

  try {
    assert.equal(
      (await setup.generatedDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: { evidenceSnapshotId: true }
      })).evidenceSnapshotId,
      snapshotId
    );
    await deletingClient.evidenceSnapshot.delete({ where: { id: snapshotId } });
    assert.equal(
      (await setup.generatedDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: { evidenceSnapshotId: true }
      })).evidenceSnapshotId,
      null
    );
  } finally {
    await setup.user.deleteMany({ where: { id: graph.userId } });
    await Promise.all([setup.$disconnect(), bindingClient.$disconnect(), deletingClient.$disconnect()]);
  }
});

test("snapshot creation serializes a concurrent source edit until after commit", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const setup = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const snapshotClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const writer = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(setup, "source-edit-race");
  const source = await setup.resume.findUniqueOrThrow({
    where: { id: graph.resumeId },
    select: { updatedAt: true }
  });
  let releaseSnapshot!: () => void;
  const holdSnapshot = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let snapshotInserted!: () => void;
  const snapshotReady = new Promise<void>((resolve) => {
    snapshotInserted = resolve;
  });
  const snapshotId = randomUUID();

  const snapshotTransaction = snapshotClient.$transaction(async (transaction) => {
    await transaction.evidenceSnapshot.create({
      data: {
        id: snapshotId,
        userId: graph.userId,
        jobPostingId: graph.jobId,
        resumeId: graph.resumeId,
        reviewedAnalysisId: graph.analysisId,
        requestId: `source-edit-race-${randomUUID()}`,
        requestHash: hashA,
        sourceResumeUpdatedAt: source.updatedAt,
        snapshotHash: hashB,
        sourceProjectionHash: hashC,
        gapProjectionHash: hashD,
        reviewPayload: { decisions: [], reuseScope: "JOB_ONLY" }
      }
    });
    snapshotInserted();
    await holdSnapshot;
  });

  try {
    await snapshotReady;
    await assert.rejects(
      writer.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
        await transaction.$executeRawUnsafe(
          `UPDATE "Resume"
              SET "rawText" = 'Concurrent synthetic edit',
                  "updatedAt" = "updatedAt" + INTERVAL '1 second'
            WHERE "id" = $1`,
          graph.resumeId
        );
      }),
      /lock timeout/i
    );
  } finally {
    releaseSnapshot();
    await snapshotTransaction;
  }

  try {
    await writer.$executeRawUnsafe(
      `UPDATE "Resume"
          SET "rawText" = 'Post-snapshot synthetic edit',
              "updatedAt" = "updatedAt" + INTERVAL '1 second'
        WHERE "id" = $1`,
      graph.resumeId
    );
    const [snapshot, editedSource] = await Promise.all([
      setup.evidenceSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { sourceResumeUpdatedAt: true }
      }),
      setup.resume.findUniqueOrThrow({
        where: { id: graph.resumeId },
        select: { rawText: true, updatedAt: true }
      })
    ]);
    assert.equal(snapshot.sourceResumeUpdatedAt.toISOString(), source.updatedAt.toISOString());
    assert.equal(editedSource.rawText, "Post-snapshot synthetic edit");
    assert.ok(editedSource.updatedAt > snapshot.sourceResumeUpdatedAt);
  } finally {
    await setup.user.deleteMany({ where: { id: graph.userId } });
    await Promise.all([setup.$disconnect(), snapshotClient.$disconnect(), writer.$disconnect()]);
  }
});

test("snapshot, source, analysis, job, and account deletion follow the explicit cascade and SET NULL graph", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const graph = await createSourceGraph(client, "deletion-graph");
  const analysisGraph = await createSourceGraph(client, "deletion-analysis");
  const jobGraph = await createSourceGraph(client, "deletion-job");
  const accountGraph = await createSourceGraph(client, "deletion-account");

  try {
    const snapshotId = await createSnapshot(client, graph, "deletion-direct");
    const consumingAnalysis = await client.aIAnalysis.create({
      data: {
        userId: graph.userId,
        jobPostingId: graph.jobId,
        evidenceSnapshotId: snapshotId,
        type: "JOB_MATCH",
        model: "synthetic-model",
        promptName: "consuming-analysis",
        input: {},
        output: {}
      },
      select: { id: true }
    });
    const resumeVersion = await client.resumeVersion.create({
      data: {
        userId: graph.userId,
        resumeId: graph.resumeId,
        jobPostingId: graph.jobId,
        evidenceSnapshotId: snapshotId,
        title: "Synthetic bound resume",
        skills: [],
        fullText: "Synthetic only."
      },
      select: { id: true }
    });
    const document = await client.generatedDocument.create({
      data: {
        userId: graph.userId,
        jobPostingId: graph.jobId,
        evidenceSnapshotId: snapshotId,
        type: "COVER_LETTER",
        title: "Synthetic bound document",
        content: "Synthetic only."
      },
      select: { id: true }
    });
    await client.jobPosting.update({
      where: { id: graph.jobId },
      data: { currentEvidenceSnapshotId: snapshotId, evidenceSnapshotGeneration: { increment: 1 } }
    });

    await client.evidenceSnapshot.delete({ where: { id: snapshotId } });
    assert.deepEqual(
      await Promise.all([
        client.jobPosting.findUniqueOrThrow({
          where: { id: graph.jobId },
          select: { currentEvidenceSnapshotId: true, evidenceSnapshotGeneration: true }
        }),
        client.aIAnalysis.findUniqueOrThrow({
          where: { id: consumingAnalysis.id },
          select: { evidenceSnapshotId: true }
        }),
        client.resumeVersion.findUniqueOrThrow({
          where: { id: resumeVersion.id },
          select: { evidenceSnapshotId: true }
        }),
        client.generatedDocument.findUniqueOrThrow({
          where: { id: document.id },
          select: { evidenceSnapshotId: true }
        })
      ]),
      [
        { currentEvidenceSnapshotId: null, evidenceSnapshotGeneration: 1 },
        { evidenceSnapshotId: null },
        { evidenceSnapshotId: null },
        { evidenceSnapshotId: null }
      ]
    );

    const sourceCascadeSnapshot = await createSnapshot(client, graph, "deletion-source");
    await client.jobPosting.update({
      where: { id: graph.jobId },
      data: { currentEvidenceSnapshotId: sourceCascadeSnapshot, evidenceSnapshotGeneration: { increment: 1 } }
    });
    await client.resume.delete({ where: { id: graph.resumeId } });
    assert.equal(await client.evidenceSnapshot.count({ where: { id: sourceCascadeSnapshot } }), 0);
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({
        where: { id: graph.jobId },
        select: { currentEvidenceSnapshotId: true }
      })).currentEvidenceSnapshotId,
      null
    );
    assert.equal(await client.resumeVersion.count({ where: { id: resumeVersion.id } }), 1);
    assert.equal(await client.generatedDocument.count({ where: { id: document.id } }), 1);

    const analysisCascadeSnapshot = await createSnapshot(client, analysisGraph, "deletion-analysis");
    const analysisBoundDocument = await client.generatedDocument.create({
      data: {
        userId: analysisGraph.userId,
        jobPostingId: analysisGraph.jobId,
        evidenceSnapshotId: analysisCascadeSnapshot,
        type: "COVER_LETTER",
        title: "Analysis-cascade synthetic document",
        content: "Synthetic only."
      },
      select: { id: true }
    });
    await client.jobPosting.update({
      where: { id: analysisGraph.jobId },
      data: { currentEvidenceSnapshotId: analysisCascadeSnapshot, evidenceSnapshotGeneration: { increment: 1 } }
    });
    await client.aIAnalysis.delete({ where: { id: analysisGraph.analysisId } });
    assert.equal(await client.evidenceSnapshot.count({ where: { id: analysisCascadeSnapshot } }), 0);
    assert.deepEqual(
      await Promise.all([
        client.jobPosting.findUniqueOrThrow({
          where: { id: analysisGraph.jobId },
          select: { currentEvidenceSnapshotId: true }
        }),
        client.generatedDocument.findUniqueOrThrow({
          where: { id: analysisBoundDocument.id },
          select: { evidenceSnapshotId: true }
        })
      ]),
      [{ currentEvidenceSnapshotId: null }, { evidenceSnapshotId: null }]
    );

    const jobCascadeSnapshot = await createSnapshot(client, jobGraph, "deletion-job");
    const jobBoundResume = await client.resumeVersion.create({
      data: {
        userId: jobGraph.userId,
        resumeId: jobGraph.resumeId,
        jobPostingId: jobGraph.jobId,
        evidenceSnapshotId: jobCascadeSnapshot,
        title: "Job-cascade synthetic resume",
        skills: [],
        fullText: "Synthetic only."
      },
      select: { id: true }
    });
    const jobBoundDocument = await client.generatedDocument.create({
      data: {
        userId: jobGraph.userId,
        jobPostingId: jobGraph.jobId,
        evidenceSnapshotId: jobCascadeSnapshot,
        type: "COVER_LETTER",
        title: "Job-cascade synthetic document",
        content: "Synthetic only."
      },
      select: { id: true }
    });
    await client.jobPosting.delete({ where: { id: jobGraph.jobId } });
    assert.equal(await client.evidenceSnapshot.count({ where: { id: jobCascadeSnapshot } }), 0);
    assert.deepEqual(
      await Promise.all([
        client.resumeVersion.findUniqueOrThrow({
          where: { id: jobBoundResume.id },
          select: { jobPostingId: true, evidenceSnapshotId: true }
        }),
        client.generatedDocument.findUniqueOrThrow({
          where: { id: jobBoundDocument.id },
          select: { jobPostingId: true, evidenceSnapshotId: true }
        })
      ]),
      [
        { jobPostingId: null, evidenceSnapshotId: null },
        { jobPostingId: null, evidenceSnapshotId: null }
      ]
    );

    const accountCascadeSnapshot = await createSnapshot(client, accountGraph, "deletion-account");
    await client.user.delete({ where: { id: accountGraph.userId } });
    assert.equal(await client.evidenceSnapshot.count({ where: { id: accountCascadeSnapshot } }), 0);
    assert.equal(await client.jobPosting.count({ where: { id: accountGraph.jobId } }), 0);
    assert.equal(await client.resume.count({ where: { id: accountGraph.resumeId } }), 0);
    assert.equal(await client.aIAnalysis.count({ where: { id: accountGraph.analysisId } }), 0);
  } finally {
    await client.user.deleteMany({
      where: {
        id: {
          in: [graph.userId, analysisGraph.userId, jobGraph.userId, accountGraph.userId]
        }
      }
    });
    await client.$disconnect();
  }
});
