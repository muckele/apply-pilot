import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const repositoryPrismaDirectory = path.join(repositoryRoot, "prisma");
const repositoryMigrationsDirectory = path.join(repositoryPrismaDirectory, "migrations");
const fillMigrationSuffix = "_add_fill_and_review_attempt_fence";

type CommandResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

type TransitionWorkspace = {
  admin: PrismaClient;
  child: PrismaClient;
  childUrl: string;
  fillMigrationName: string;
  schemaName: string;
  tempMigrationsDirectory: string;
  tempRoot: string;
  tempSchemaPath: string;
  cleanup(): Promise<void>;
};

type IndexMetadata = {
  indexName: string;
  indexDefinition: string;
};

async function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000
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
    child.once("error", () => reject(new Error("Required Increment 3 PostgreSQL child command could not start.")));
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

async function resolveFillMigrationName(): Promise<string> {
  const migrationEntries = await readdir(repositoryMigrationsDirectory, { withFileTypes: true });
  const fillMigrationNames = migrationEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(fillMigrationSuffix))
    .map((entry) => entry.name);
  assert.deepEqual(fillMigrationNames, ["20260901120000_add_fill_and_review_attempt_fence"]);
  return fillMigrationNames[0];
}

async function createTransitionWorkspace(): Promise<TransitionWorkspace> {
  const fillMigrationName = await resolveFillMigrationName();
  const baseUrl = await assertGuardedDatabase();
  const schemaName = `fill_migration_${randomUUID().replaceAll("-", "")}`;
  assert.match(schemaName, /^fill_migration_[a-f0-9]{32}$/);

  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);

  const parsedChildUrl = new URL(baseUrl);
  parsedChildUrl.searchParams.set("schema", schemaName);
  const childUrl = parsedChildUrl.toString();
  const child = new PrismaClient({ datasources: { db: { url: childUrl } } });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "apply-pilot-fill-migration-"));
  const tempPrismaDirectory = path.join(tempRoot, "prisma");
  const tempMigrationsDirectory = path.join(tempPrismaDirectory, "migrations");
  const tempSchemaPath = path.join(tempPrismaDirectory, "schema.prisma");

  try {
    await mkdir(tempMigrationsDirectory, { recursive: true });
    await cp(path.join(repositoryPrismaDirectory, "schema.prisma"), tempSchemaPath);
    await cp(
      path.join(repositoryMigrationsDirectory, "migration_lock.toml"),
      path.join(tempMigrationsDirectory, "migration_lock.toml")
    );

    const migrationEntries = await readdir(repositoryMigrationsDirectory, { withFileTypes: true });
    const priorMigrationNames = migrationEntries
      .filter((entry) => entry.isDirectory() && entry.name < fillMigrationName)
      .map((entry) => entry.name)
      .sort();
    assert.equal(priorMigrationNames.at(-1), "20260826200738_add_form_inspection_answer_packets");
    for (const migrationName of priorMigrationNames) {
      await cp(
        path.join(repositoryMigrationsDirectory, migrationName),
        path.join(tempMigrationsDirectory, migrationName),
        { recursive: true }
      );
    }

    const preFillDeploy = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", tempSchemaPath],
      childEnvironment(childUrl)
    );
    assert.equal(preFillDeploy.timedOut, false);
    assert.equal(preFillDeploy.exitCode, 0, preFillDeploy.output);

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
    fillMigrationName,
    schemaName,
    tempMigrationsDirectory,
    tempRoot,
    tempSchemaPath,
    async cleanup() {
      await child.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.$disconnect();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

async function insertExistingGraph(client: PrismaClient, prefix: string): Promise<void> {
  const now = new Date();
  await client.$transaction([
    client.$executeRaw(Prisma.sql`
      INSERT INTO "User" ("id", "email", "updatedAt")
      VALUES (${`${prefix}_user`}, ${`${prefix}@example.test`}, ${now})
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "ApplicationAutomationPolicy" ("id", "userId", "updatedAt")
      VALUES (${`${prefix}_policy`}, ${`${prefix}_user`}, ${now})
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "JobPosting" (
        "id", "userId", "title", "normalizedTitle", "company", "normalizedCompany",
        "normalizedLocation", "sourceUrl", "normalizedApplyUrl", "description",
        "requirements", "preferredQualifications", "benefits", "detectedTechStack",
        "sourceType", "missingKeywords", "supportedKeywords", "concerns", "updatedAt"
      ) VALUES (
        ${`${prefix}_job`}, ${`${prefix}_user`}, 'Fill Migration Role', 'fill migration role',
        'Fill Migration Company', 'fill migration company', 'remote',
        'https://example.test/job', 'https://example.test/apply', 'fixture',
        ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
        'MANUAL', ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ${now}
      )
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "Application" ("id", "userId", "jobPostingId", "updatedAt")
      VALUES (${`${prefix}_application`}, ${`${prefix}_user`}, ${`${prefix}_job`}, ${now})
    `),
    client.$executeRaw(Prisma.sql`
      INSERT INTO "ApplicationRun" (
        "id", "userId", "jobPostingId", "applicationId", "idempotencyKey",
        "activeRunKey", "applyUrlSnapshot", "applyHost", "updatedAt"
      ) VALUES (
        ${`${prefix}_run`}, ${`${prefix}_user`}, ${`${prefix}_job`}, ${`${prefix}_application`},
        ${`${prefix}_idempotency`}, ${`${prefix}_active`},
        'https://example.test/apply', 'example.test', ${now}
      )
    `)
  ]);
}

async function applicationRunIndexes(client: PrismaClient): Promise<IndexMetadata[]> {
  return client.$queryRaw<IndexMetadata[]>(Prisma.sql`
    SELECT indexname AS "indexName", indexdef AS "indexDefinition"
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'ApplicationRun'
    ORDER BY indexname
  `);
}

test("fill-attempt migration preserves prior rows and adds only the opt-in fence schema", async () => {
  const workspace = await createTransitionWorkspace();
  const beforePrefix = `before_${randomUUID().slice(0, 8)}`;
  const afterPrefix = `after_${randomUUID().slice(0, 8)}`;

  try {
    await insertExistingGraph(workspace.child, beforePrefix);
    const indexesBefore = await applicationRunIndexes(workspace.child);

    await cp(
      path.join(repositoryMigrationsDirectory, workspace.fillMigrationName),
      path.join(workspace.tempMigrationsDirectory, workspace.fillMigrationName),
      { recursive: true }
    );
    const deploy = await runCommand(
      path.join(repositoryRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--schema", workspace.tempSchemaPath],
      childEnvironment(workspace.childUrl)
    );
    assert.equal(deploy.timedOut, false);
    assert.equal(deploy.exitCode, 0, deploy.output);

    const existingPolicy = await workspace.child.$queryRaw<Array<{ mode: string }>>(Prisma.sql`
      SELECT "mode"::TEXT AS "mode"
      FROM "ApplicationAutomationPolicy"
      WHERE "id" = ${`${beforePrefix}_policy`}
    `);
    assert.deepEqual(existingPolicy, [{ mode: "PREPARE_ONLY" }]);

    const existingRun = await workspace.child.$queryRaw<
      Array<{ fillAttemptId: string | null; fillLeaseExpiresAt: Date | null; id: string }>
    >(Prisma.sql`
      SELECT "id", "fillAttemptId", "fillLeaseExpiresAt"
      FROM "ApplicationRun"
      WHERE "id" = ${`${beforePrefix}_run`}
    `);
    assert.deepEqual(existingRun, [{
      id: `${beforePrefix}_run`,
      fillAttemptId: null,
      fillLeaseExpiresAt: null
    }]);

    const enumLabels = await workspace.child.$queryRaw<Array<{ label: string }>>(Prisma.sql`
      SELECT enum.enumlabel AS "label"
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      INNER JOIN pg_enum AS enum ON enum.enumtypid = type.oid
      WHERE namespace.nspname = current_schema()
        AND type.typname = 'AutomationMode'
      ORDER BY enum.enumsortorder
    `);
    assert.deepEqual(enumLabels.map(({ label }) => label), ["PREPARE_ONLY", "FILL_AND_REVIEW"]);

    const columns = await workspace.child.$queryRaw<
      Array<{
        columnDefault: string | null;
        columnName: string;
        dataType: string;
        datetimePrecision: number | null;
        isNullable: string;
      }>
    >(Prisma.sql`
      SELECT
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        datetime_precision AS "datetimePrecision",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ApplicationRun'
        AND column_name IN ('fillAttemptId', 'fillLeaseExpiresAt')
      ORDER BY column_name
    `);
    assert.deepEqual(columns, [
      {
        columnName: "fillAttemptId",
        dataType: "text",
        isNullable: "YES",
        datetimePrecision: null,
        columnDefault: null
      },
      {
        columnName: "fillLeaseExpiresAt",
        dataType: "timestamp without time zone",
        isNullable: "YES",
        datetimePrecision: 3,
        columnDefault: null
      }
    ]);

    const policyDefault = await workspace.child.$queryRaw<Array<{ columnDefault: string | null }>>(Prisma.sql`
      SELECT column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ApplicationAutomationPolicy'
        AND column_name = 'mode'
    `);
    assert.equal(policyDefault.length, 1);
    assert.match(policyDefault[0].columnDefault ?? "", /PREPARE_ONLY/);

    await insertExistingGraph(workspace.child, afterPrefix);
    const newDefaults = await workspace.child.$queryRaw<
      Array<{ fillAttemptId: string | null; fillLeaseExpiresAt: Date | null; mode: string }>
    >(Prisma.sql`
      SELECT
        policy."mode"::TEXT AS "mode",
        run."fillAttemptId",
        run."fillLeaseExpiresAt"
      FROM "ApplicationAutomationPolicy" AS policy
      INNER JOIN "ApplicationRun" AS run ON run."userId" = policy."userId"
      WHERE policy."id" = ${`${afterPrefix}_policy`}
        AND run."id" = ${`${afterPrefix}_run`}
    `);
    assert.deepEqual(newDefaults, [{
      mode: "PREPARE_ONLY",
      fillAttemptId: null,
      fillLeaseExpiresAt: null
    }]);

    await workspace.child.$executeRaw(Prisma.sql`
      UPDATE "ApplicationAutomationPolicy"
      SET "mode" = 'FILL_AND_REVIEW'::"AutomationMode"
      WHERE "id" = ${`${afterPrefix}_policy`}
    `);
    const persistedNewMode = await workspace.child.$queryRaw<Array<{ mode: string }>>(Prisma.sql`
      SELECT "mode"::TEXT AS "mode"
      FROM "ApplicationAutomationPolicy"
      WHERE "id" = ${`${afterPrefix}_policy`}
    `);
    assert.deepEqual(persistedNewMode, [{ mode: "FILL_AND_REVIEW" }]);

    assert.deepEqual(await applicationRunIndexes(workspace.child), indexesBefore);

    const fillTables = await workspace.child.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT table_name AS "name"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND lower(table_name) LIKE '%fill%'
      ORDER BY table_name
    `);
    assert.deepEqual(fillTables, []);

    const fillSchemaObjects = await workspace.child.$queryRaw<Array<{ kind: string; name: string }>>(Prisma.sql`
      SELECT 'index' AS "kind", indexname AS "name"
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND lower(indexname) LIKE '%fill%'
      UNION ALL
      SELECT 'trigger' AS "kind", trigger_name AS "name"
      FROM information_schema.triggers
      WHERE trigger_schema = current_schema()
        AND lower(trigger_name) LIKE '%fill%'
      UNION ALL
      SELECT 'function' AS "kind", routine_name AS "name"
      FROM information_schema.routines
      WHERE routine_schema = current_schema()
        AND lower(routine_name) LIKE '%fill%'
      ORDER BY "kind", "name"
    `);
    assert.deepEqual(fillSchemaObjects, []);
  } finally {
    await workspace.cleanup();
  }
});
