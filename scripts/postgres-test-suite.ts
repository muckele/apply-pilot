import { stat } from "node:fs/promises";
import path from "node:path";

export const SYNTHETIC_FULL_WORKFLOW_E2E_MARKER = "SYNTHETIC_FULL_WORKFLOW_E2E";
export const SYNTHETIC_HUMAN_SUBMIT_TEST_FILE = "tests/e2e/synthetic-human-submit.test.ts";
export const SYNTHETIC_HUMAN_SUBMIT_TIMEOUT_MS = 120_000;

export type PostgresTestSuite =
  | Readonly<{
      kind: "default";
      testFiles: readonly string[];
      timeoutMs: number;
      syntheticFullWorkflow: false;
    }>
  | Readonly<{
      kind: "synthetic-human-submit";
      testFiles: readonly [typeof SYNTHETIC_HUMAN_SUBMIT_TEST_FILE];
      timeoutMs: typeof SYNTHETIC_HUMAN_SUBMIT_TIMEOUT_MS;
      syntheticFullWorkflow: true;
    }>;

export class PostgresTestSuiteSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresTestSuiteSelectionError";
  }
}

export function selectPostgresTestSuite(
  args: readonly string[],
  defaultTestFiles: readonly string[],
  defaultTimeoutMs: number
): PostgresTestSuite {
  if (args.length === 0) {
    return Object.freeze({
      kind: "default",
      testFiles: Object.freeze([...defaultTestFiles]),
      timeoutMs: defaultTimeoutMs,
      syntheticFullWorkflow: false
    });
  }

  if (args.length === 2 && args[0] === "--suite" && args[1] === "synthetic-human-submit") {
    return Object.freeze({
      kind: "synthetic-human-submit",
      testFiles: Object.freeze([SYNTHETIC_HUMAN_SUBMIT_TEST_FILE] as const),
      timeoutMs: SYNTHETIC_HUMAN_SUBMIT_TIMEOUT_MS,
      syntheticFullWorkflow: true
    });
  }

  throw new PostgresTestSuiteSelectionError(
    'Unsupported PostgreSQL test arguments; expected no arguments or exactly "--suite synthetic-human-submit".'
  );
}

export async function assertPostgresTestSuiteFilesExist(
  repositoryRoot: string,
  suite: PostgresTestSuite
): Promise<void> {
  for (const testFile of suite.testFiles) {
    const pathname = path.isAbsolute(testFile) ? testFile : path.join(repositoryRoot, testFile);
    try {
      const file = await stat(pathname);
      if (!file.isFile()) throw new Error("not a file");
    } catch {
      throw new PostgresTestSuiteSelectionError(
        `Selected PostgreSQL test file does not exist: ${testFile}; refusing database preparation.`
      );
    }
  }
}

export function configurePostgresTestSuiteEnvironment(
  environment: Record<string, string | undefined>,
  suite: PostgresTestSuite
): void {
  if (suite.syntheticFullWorkflow) environment[SYNTHETIC_FULL_WORKFLOW_E2E_MARKER] = "1";
  else delete environment[SYNTHETIC_FULL_WORKFLOW_E2E_MARKER];
}
