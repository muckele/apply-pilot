import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DatabaseTargetSafetyError,
  LOCAL_DEVELOPMENT_DATABASE_NAME,
  assertLoopbackHostResolution,
  validateDisposableLocalPostgresUrl,
  validateLocalDestructiveEnvironment,
  validateMatchingDisposableLocalPostgresPair,
  type LocalDatabaseEnvironment
} from "@/scripts/database-target-safety";
import {
  POSTGRES_TEST_DATABASE_NAME,
  PostgresTestSafetyError,
  validatePostgresTestEnvironment,
  type PostgresTestEnvironment
} from "@/tests/postgres/postgres-test-harness";

const APPROVED_URL = `postgresql://postgres:postgres@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?schema=public`;
const LOCAL_URL = `postgresql://postgres:postgres@127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}?schema=public`;
const LOCAL_DIRECT_URL = `postgres://postgres:postgres@127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}`;
const NEON_POOLED_URL = `postgresql://user:secret@ep-example-pooler.us-east-1.aws.neon.tech/${LOCAL_DEVELOPMENT_DATABASE_NAME}?sslmode=require`;
const NEON_DIRECT_URL = `postgresql://user:secret@ep-example.us-east-1.aws.neon.tech/${LOCAL_DEVELOPMENT_DATABASE_NAME}?sslmode=require`;

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

function localEnvironment(overrides: LocalDatabaseEnvironment = {}): LocalDatabaseEnvironment {
  return {
    APPLY_PILOT_LOCAL_DESTRUCTIVE: "1",
    LOCAL_DATABASE_URL: LOCAL_URL,
    LOCAL_DIRECT_URL: LOCAL_DIRECT_URL,
    ...overrides
  };
}

function localSafetyError(messageFragment: string) {
  return (error: unknown) =>
    error instanceof DatabaseTargetSafetyError && error.message.includes(messageFragment);
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

test("local destructive target safety accepts only exact loopback PostgreSQL URLs", () => {
  const acceptedUrls = [
    `postgresql://postgres:postgres@localhost:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}`,
    LOCAL_URL,
    `postgresql://postgres:postgres@[::1]:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}?schema=public`
  ];

  for (const url of acceptedUrls) {
    const result = validateDisposableLocalPostgresUrl("LOCAL_DATABASE_URL", url);
    assert.equal(result.databaseName, LOCAL_DEVELOPMENT_DATABASE_NAME);
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(result.hostname));
  }
});

test("local destructive target safety rejects deceptive and remote hosts", () => {
  const rejectedUrls = [
    `postgresql://postgres:postgres@localhost.evil.example:5432/${LOCAL_DEVELOPMENT_DATABASE_NAME}`,
    `postgresql://postgres:postgres@evil-localhost.example:5432/${LOCAL_DEVELOPMENT_DATABASE_NAME}`,
    NEON_POOLED_URL,
    NEON_DIRECT_URL,
    `postgresql://postgres:postgres@db.example.com:5432/${LOCAL_DEVELOPMENT_DATABASE_NAME}`,
    `postgresql://postgres:postgres@192.168.1.20:5432/${LOCAL_DEVELOPMENT_DATABASE_NAME}`
  ];

  for (const url of rejectedUrls) {
    assert.throws(
      () => validateDisposableLocalPostgresUrl("LOCAL_DATABASE_URL", url),
      localSafetyError("exact loopback host")
    );
  }
});

test("local destructive target safety rejects malformed URLs, protocols, paths, fragments, and parameters", () => {
  const rejectedCases: Array<[string, string]> = [
    ["not a URL", "valid PostgreSQL URL"],
    [`https://127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}`, "postgres: or postgresql:"],
    [`postgresql://postgres:postgres@127.0.0.1:55433/wrong_database`, "must target exactly"],
    [`postgresql://postgres:postgres@127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}%ZZ`, "valid PostgreSQL URL"],
    [`${LOCAL_URL}#unsafe`, "must not contain a fragment"],
    [`${LOCAL_URL}&schema=public`, "schema must be absent or exactly"],
    [
      `postgresql://postgres:postgres@127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}?schema=private`,
      "schema must be absent or exactly"
    ],
    [
      `postgresql://postgres:postgres@127.0.0.1:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}?sslmode=require`,
      "query parameter sslmode is not allowed"
    ]
  ];

  for (const [url, message] of rejectedCases) {
    assert.throws(
      () => validateDisposableLocalPostgresUrl("LOCAL_DATABASE_URL", url),
      localSafetyError(message),
      url.replace(/:[^:@/]+@/, ":<redacted>@")
    );
  }
});

test("local destructive pair safety requires one matching exact local target", () => {
  const pair = validateMatchingDisposableLocalPostgresPair(LOCAL_URL, LOCAL_DIRECT_URL);
  assert.equal(pair.database.hostname, "127.0.0.1");
  assert.equal(pair.direct.hostname, "127.0.0.1");
  assert.equal(pair.database.effectivePort, "55433");
  assert.equal(pair.direct.effectivePort, "55433");

  const mismatches: Array<[string | undefined, string | undefined, string]> = [
    [LOCAL_URL, undefined, "LOCAL_DIRECT_URL is required"],
    [undefined, LOCAL_DIRECT_URL, "LOCAL_DATABASE_URL is required"],
    [LOCAL_URL, NEON_DIRECT_URL, "exact loopback host"],
    [NEON_POOLED_URL, LOCAL_DIRECT_URL, "exact loopback host"],
    [NEON_POOLED_URL, NEON_DIRECT_URL, "exact loopback host"],
    [
      LOCAL_URL,
      LOCAL_DIRECT_URL.replace(LOCAL_DEVELOPMENT_DATABASE_NAME, "different_database"),
      "must target exactly"
    ],
    [LOCAL_URL, LOCAL_DIRECT_URL.replace(":55433", ":55434"), "same local target"]
  ];

  for (const [databaseUrl, directUrl, message] of mismatches) {
    assert.throws(
      () => validateMatchingDisposableLocalPostgresPair(databaseUrl, directUrl),
      localSafetyError(message)
    );
  }
});

test("local destructive environment requires its marker and dedicated pair without generic fallbacks", () => {
  assert.throws(
    () => validateLocalDestructiveEnvironment(localEnvironment({ APPLY_PILOT_LOCAL_DESTRUCTIVE: undefined })),
    localSafetyError("must be exactly")
  );
  assert.throws(
    () => validateLocalDestructiveEnvironment(localEnvironment({ APPLY_PILOT_LOCAL_DESTRUCTIVE: "true" })),
    localSafetyError("must be exactly")
  );
  assert.throws(
    () => validateLocalDestructiveEnvironment(localEnvironment({ LOCAL_DATABASE_URL: undefined })),
    localSafetyError("LOCAL_DATABASE_URL is required")
  );
  assert.throws(
    () => validateLocalDestructiveEnvironment(localEnvironment({ LOCAL_DIRECT_URL: undefined })),
    localSafetyError("LOCAL_DIRECT_URL is required")
  );
  assert.throws(
    () => validateLocalDestructiveEnvironment(localEnvironment({ TEST_DATABASE_URL: APPROVED_URL })),
    localSafetyError("TEST_DATABASE_URL must be unset")
  );

  const result = validateLocalDestructiveEnvironment(
    localEnvironment({
      DATABASE_URL: NEON_POOLED_URL,
      DIRECT_URL: NEON_DIRECT_URL
    })
  );
  assert.equal(result.database.url, LOCAL_URL);
  assert.equal(result.direct.url, LOCAL_DIRECT_URL);
});

test("localhost DNS verification fails closed if any resolved address is not loopback", async () => {
  const localhost = validateDisposableLocalPostgresUrl(
    "LOCAL_DATABASE_URL",
    `postgresql://postgres:postgres@localhost:55433/${LOCAL_DEVELOPMENT_DATABASE_NAME}`
  );
  await assert.doesNotReject(() =>
    assertLoopbackHostResolution([localhost], async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 }
    ])
  );
  await assert.rejects(
    () => assertLoopbackHostResolution([localhost], async () => [{ address: "203.0.113.9", family: 4 }]),
    localSafetyError("loopback-only")
  );
});
