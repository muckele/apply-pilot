import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POSTGRES_TEST_DATABASE_NAME,
  PostgresTestSafetyError,
  validatePostgresTestEnvironment,
  type PostgresTestEnvironment
} from "@/tests/postgres/postgres-test-harness";

const APPROVED_URL = `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=public`;

function environment(overrides: PostgresTestEnvironment = {}): PostgresTestEnvironment {
  return {
    COMMIT5_POSTGRES_TEST: "1",
    NODE_ENV: "test",
    TEST_DATABASE_URL: APPROVED_URL,
    ...overrides
  };
}

function safetyError(messageFragment: string) {
  return (error: unknown) =>
    error instanceof PostgresTestSafetyError && error.message.includes(messageFragment);
}

test("PostgreSQL test safety accepts only the approved loopback database forms", () => {
  const acceptedUrls = [
    `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`,
    APPROVED_URL,
    `postgres://postgres:postgres@localhost:55432/${POSTGRES_TEST_DATABASE_NAME}`,
    `postgresql://postgres:postgres@[::1]:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=public`
  ];

  for (const url of acceptedUrls) {
    const result = validatePostgresTestEnvironment(environment({ TEST_DATABASE_URL: url }));
    assert.equal(result.databaseName, POSTGRES_TEST_DATABASE_NAME);
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(result.hostname));
  }
});

test("PostgreSQL test safety requires the explicit marker and dedicated URL", () => {
  assert.throws(
    () => validatePostgresTestEnvironment(environment({ COMMIT5_POSTGRES_TEST: undefined })),
    safetyError("must be exactly")
  );
  assert.throws(
    () => validatePostgresTestEnvironment(environment({ COMMIT5_POSTGRES_TEST: "true" })),
    safetyError("must be exactly")
  );
  assert.throws(
    () => validatePostgresTestEnvironment(environment({ TEST_DATABASE_URL: undefined })),
    safetyError("TEST_DATABASE_URL is required")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment({
        COMMIT5_POSTGRES_TEST: "1",
        NODE_ENV: "test",
        DATABASE_URL: APPROVED_URL,
        DIRECT_URL: APPROVED_URL
      }),
    safetyError("never fallbacks")
  );
});

test("PostgreSQL test safety rejects production, malformed, and non-PostgreSQL targets", () => {
  assert.throws(
    () => validatePostgresTestEnvironment(environment({ NODE_ENV: "production" })),
    safetyError("NODE_ENV=production")
  );
  assert.throws(
    () => validatePostgresTestEnvironment(environment({ TEST_DATABASE_URL: "not a URL" })),
    safetyError("valid PostgreSQL URL")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({ TEST_DATABASE_URL: `https://127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}` })
      ),
    safetyError("postgres: or postgresql:")
  );
});

test("PostgreSQL test safety rejects Neon, nonloopback, and ordinary local databases", () => {
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({
          TEST_DATABASE_URL: `postgresql://user:secret@example.neon.tech/${POSTGRES_TEST_DATABASE_NAME}?schema=public`
        })
      ),
    safetyError("must target localhost")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({ TEST_DATABASE_URL: `postgresql://postgres:postgres@192.168.1.20/${POSTGRES_TEST_DATABASE_NAME}` })
      ),
    safetyError("must target localhost")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({ TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/jobmatch_crm?schema=public" })
      ),
    safetyError("must target exactly")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({ TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/wrong_test_database" })
      ),
    safetyError("must target exactly")
  );
});

test("PostgreSQL test safety accepts no caller-controlled connection behavior", () => {
  const forbiddenParameters = [
    "connection_limit=1",
    "application_name=attacker",
    "options=-c%20statement_timeout%3D0",
    "pgbouncer=true",
    "pool_timeout=0",
    "sslmode=require",
    "unknown=value"
  ];

  for (const parameter of forbiddenParameters) {
    assert.throws(
      () =>
        validatePostgresTestEnvironment(
          environment({
            TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=public&${parameter}`
          })
        ),
      safetyError("is not allowed"),
      parameter
    );
  }
});

test("PostgreSQL test safety rejects invalid or duplicate schema parameters", () => {
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({
          TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=private`
        })
      ),
    safetyError("schema must be absent or exactly")
  );
  assert.throws(
    () =>
      validatePostgresTestEnvironment(
        environment({
          TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=public&schema=public`
        })
      ),
    safetyError("schema must be absent or exactly")
  );
});
