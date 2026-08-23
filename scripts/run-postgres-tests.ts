import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  POSTGRES_TEST_NODE_TIMEOUT_MS,
  PostgresTestSafetyError,
  assertPostgresTestMajorVersion,
  normalizePostgresTestError,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "../tests/postgres/postgres-test-harness";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const postgresTestsDirectory = path.join(repositoryRoot, "tests", "postgres");

class PostgresTestRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresTestRunnerError";
  }
}

function safeChildEnvironment(testDatabaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl,
    DIRECT_URL: testDatabaseUrl,
    AI_ENABLED: "false",
    AI_MOCK_MODE: "true",
    OPENAI_MOCK_MODE: "true",
    GEMINI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENAI_API_KEY: ""
  };
}

async function runCommand(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
      shell: false
    });
    child.once("error", () => reject(new PostgresTestRunnerError("Failed to start a required local test command.")));
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new PostgresTestRunnerError(`Child process terminated by signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function discoverPostgresTests(): Promise<string[]> {
  const entries = await readdir(postgresTestsDirectory, { withFileTypes: true });
  const tests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(postgresTestsDirectory, entry.name))
    .sort();
  if (tests.length === 0) {
    throw new PostgresTestRunnerError(
      "No PostgreSQL test files were found under tests/postgres; refusing to report success."
    );
  }
  return tests;
}

async function main(): Promise<void> {
  const config = validatePostgresTestEnvironment(process.env);
  const liveDatabase = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(liveDatabase);
  console.log(
    `[postgres-test] verified database=${liveDatabase.databaseName} ` +
      `version_num=${liveDatabase.serverVersionNum} isolation=${liveDatabase.isolation}`
  );

  const environment = safeChildEnvironment(config.url);
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const migrationExitCode = await runCommand(
    npxCommand,
    ["prisma", "migrate", "reset", "--force", "--skip-seed"],
    environment
  );
  if (migrationExitCode !== 0) {
    throw new PostgresTestRunnerError(
      `Disposable PostgreSQL migration reset failed with exit code ${migrationExitCode}; tests were not run.`
    );
  }

  const testFiles = await discoverPostgresTests();
  const testExitCode = await runCommand(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      `--test-timeout=${POSTGRES_TEST_NODE_TIMEOUT_MS}`,
      ...testFiles
    ],
    environment
  );
  if (testExitCode !== 0) process.exitCode = testExitCode;
}

main().catch((error: unknown) => {
  if (error instanceof PostgresTestSafetyError || error instanceof PostgresTestRunnerError) {
    console.error(`[postgres-test] ${error.message}`);
  } else {
    const diagnostic = normalizePostgresTestError(error, "runner", "pre-reset-or-test-launch");
    console.error(
      `[postgres-test] runner failed; prismaCode=${diagnostic.prismaCode ?? "none"} ` +
        `sqlState=${diagnostic.postgresSqlState ?? "none"}.`
    );
  }
  process.exitCode = 1;
});
