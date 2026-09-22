import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { JSDOM } from "jsdom";

const SYNTHETIC_TARGET = "https://employer.example.test/applications/synthetic-human-submit-v1";
const SYNTHETIC_ENDPOINT = "https://employer.example.test/__synthetic-human-submit";
const DEFAULT_TIMEOUT_MS = 30_000;

async function loadSuiteSelector() {
  return import("../scripts/postgres-test-suite");
}

async function loadNextTestServer() {
  return import("./browser/next-test-server");
}

async function loadFixture() {
  return import("./e2e/synthetic-employer-fixture");
}

async function loadWorkflowHarness() {
  return import("./e2e/synthetic-workflow-harness");
}

async function recordGeneratedNextEnvironmentState(captured: object): Promise<void> {
  const recordGeneratedState = Reflect.get(captured, "recordGeneratedState");
  if (typeof recordGeneratedState === "function") await recordGeneratedState.call(captured);
}

test("the default PostgreSQL selection preserves the complete trusted inventory and ordinary timeout", async () => {
  const { selectPostgresTestSuite } = await loadSuiteSelector();
  const trustedInventory = [
    "/repo/tests/postgres/alpha.test.ts",
    "/repo/tests/postgres/bravo.test.ts"
  ] as const;

  assert.deepEqual(selectPostgresTestSuite([], trustedInventory, DEFAULT_TIMEOUT_MS), {
    kind: "default",
    testFiles: trustedInventory,
    timeoutMs: 30_000,
    syntheticFullWorkflow: false
  });
});

test("the only synthetic selector resolves the one frozen future test with its isolated timeout", async () => {
  const { selectPostgresTestSuite } = await loadSuiteSelector();

  assert.deepEqual(
    selectPostgresTestSuite(["--suite", "synthetic-human-submit"], ["trusted-default.test.ts"], DEFAULT_TIMEOUT_MS),
    {
      kind: "synthetic-human-submit",
      testFiles: ["tests/e2e/synthetic-human-submit.test.ts"],
      timeoutMs: 120_000,
      syntheticFullWorkflow: true
    }
  );
});

test("PostgreSQL selection rejects partial, duplicate, extra, unknown, and path-shaped arguments", async () => {
  const { PostgresTestSuiteSelectionError, selectPostgresTestSuite } = await loadSuiteSelector();
  const rejectedArguments = [
    ["--suite"],
    ["--suite", "foo"],
    ["--suite", "synthetic"],
    ["--suite", "../anything"],
    ["--suite", "tests/e2e/foo.test.ts"],
    ["--suite", "synthetic-human-submit", "extra"],
    ["--suite", "synthetic-human-submit", "--other", "value"],
    ["--suite", "synthetic-human-submit", "--suite", "synthetic-human-submit"],
    ["--other", "value"]
  ] as const;

  for (const args of rejectedArguments) {
    assert.throws(
      () => selectPostgresTestSuite(args, ["trusted-default.test.ts"], DEFAULT_TIMEOUT_MS),
      PostgresTestSuiteSelectionError,
      JSON.stringify(args)
    );
  }
});

test("selected test-file validation fails closed when the synthetic test is absent", async () => {
  const { assertPostgresTestSuiteFilesExist, selectPostgresTestSuite } = await loadSuiteSelector();
  const suite = selectPostgresTestSuite(
    ["--suite", "synthetic-human-submit"],
    ["trusted-default.test.ts"],
    DEFAULT_TIMEOUT_MS
  );
  const emptyRepository = await mkdtemp(path.join(tmpdir(), "apply-pilot-missing-synthetic-e2e-"));

  try {
    await assert.rejects(
      assertPostgresTestSuiteFilesExist(emptyRepository, suite),
      /Selected PostgreSQL test file does not exist: tests\/e2e\/synthetic-human-submit\.test\.ts; refusing database preparation\./
    );
  } finally {
    await rm(emptyRepository, { recursive: true, force: true });
  }
});

test("the synthetic marker is absent from reset and default children and present only in the synthetic test child", async () => {
  const { configurePostgresTestSuiteEnvironment, selectPostgresTestSuite } = await loadSuiteSelector();
  const resetEnvironment: Record<string, string | undefined> = { SAFE_PARENT: "kept" };
  const ordinaryTestEnvironment: Record<string, string | undefined> = { ...resetEnvironment };
  const syntheticTestEnvironment: Record<string, string | undefined> = { ...resetEnvironment };

  configurePostgresTestSuiteEnvironment(
    ordinaryTestEnvironment,
    selectPostgresTestSuite([], ["trusted-default.test.ts"], DEFAULT_TIMEOUT_MS)
  );
  configurePostgresTestSuiteEnvironment(
    syntheticTestEnvironment,
    selectPostgresTestSuite(
      ["--suite", "synthetic-human-submit"],
      ["trusted-default.test.ts"],
      DEFAULT_TIMEOUT_MS
    )
  );

  assert.equal("SYNTHETIC_FULL_WORKFLOW_E2E" in resetEnvironment, false);
  assert.equal("SYNTHETIC_FULL_WORKFLOW_E2E" in ordinaryTestEnvironment, false);
  assert.equal(ordinaryTestEnvironment.SAFE_PARENT, "kept");
  assert.equal(syntheticTestEnvironment.SYNTHETIC_FULL_WORKFLOW_E2E, "1");
  assert.equal(syntheticTestEnvironment.SAFE_PARENT, "kept");
});

test("the Next helper reserves only a loopback port and formats only a 127.0.0.1 origin", async () => {
  const { buildNextTestServerOrigin, reserveNextTestServerPort } = await loadNextTestServer();
  const port = await reserveNextTestServerPort();

  assert.equal(Number.isInteger(port), true);
  assert.ok(port > 0 && port <= 65_535);
  assert.equal(buildNextTestServerOrigin(port), `http://127.0.0.1:${port}`);
  assert.throws(() => buildNextTestServerOrigin(0), /valid ephemeral TCP port/);
});

test("Next server logs retain a bounded tail", async () => {
  const { appendBoundedNextServerLog } = await loadNextTestServer();

  assert.equal(appendBoundedNextServerLog("abc", "def", 5), "bcdef");
  assert.equal(appendBoundedNextServerLog("secret-prefix", "safe-tail", 4), "tail");
});

test("every Next readiness and log option rejects non-finite, non-positive, fractional, and excessive bounds", async () => {
  const {
    appendBoundedNextServerLog,
    NextTestServerError,
    waitForNextTestServerReadiness
  } = await loadNextTestServer();
  const invalidValues = (maximum: number) => [NaN, Infinity, -Infinity, 0, -1, 1.5, maximum + 1];
  const readinessBase = {
    origin: "http://127.0.0.1:41234",
    childState: () => ({ exitCode: null, signalCode: null, spawnError: undefined }),
    getLogs: () => "",
    request: async () => ({ status: 200 }),
    now: () => 0,
    delay: async () => undefined
  };
  const readinessBounds = [
    {
      name: "startup timeout",
      maximum: 60_000,
      invoke: (value: number) => waitForNextTestServerReadiness({
        ...readinessBase,
        timeoutMs: value,
        pollIntervalMs: 1,
        maxFailureLogCharacters: 1
      })
    },
    {
      name: "poll interval",
      maximum: 5_000,
      invoke: (value: number) => waitForNextTestServerReadiness({
        ...readinessBase,
        timeoutMs: 1,
        pollIntervalMs: value,
        maxFailureLogCharacters: 1
      })
    },
    {
      name: "failure-log bound",
      maximum: 1_048_576,
      invoke: (value: number) => waitForNextTestServerReadiness({
        ...readinessBase,
        timeoutMs: 1,
        pollIntervalMs: 1,
        maxFailureLogCharacters: value
      })
    }
  ] as const;
  const unexpectedlyAccepted: string[] = [];

  for (const bound of readinessBounds) {
    for (const value of invalidValues(bound.maximum)) {
      try {
        await assert.rejects(bound.invoke(value), NextTestServerError);
      } catch {
        unexpectedlyAccepted.push(`${bound.name}=${String(value)}`);
      }
    }
  }
  for (const value of invalidValues(1_048_576)) {
    try {
      assert.throws(() => appendBoundedNextServerLog("", "chunk", value), NextTestServerError);
    } catch {
      unexpectedlyAccepted.push(`log bound=${String(value)}`);
    }
  }

  assert.deepEqual(unexpectedlyAccepted, []);
});

test("every Next shutdown option rejects non-finite, non-positive, fractional, and excessive bounds", async () => {
  const { NextTestServerError, stopNextTestServerChild } = await loadNextTestServer();
  const invalidValues = (maximum: number) => [NaN, Infinity, -Infinity, 0, -1, 1.5, maximum + 1];
  const syntheticLiveChild = (): ChildProcess => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => {
        child.exitCode = 0;
        return true;
      }
    };
    return child as unknown as ChildProcess;
  };
  const shutdownBounds = [
    {
      name: "graceful shutdown timeout",
      maximum: 30_000,
      invoke: (value: number) => stopNextTestServerChild(syntheticLiveChild(), {
        gracefulTimeoutMs: value,
        forceTimeoutMs: 1
      })
    },
    {
      name: "forced shutdown timeout",
      maximum: 10_000,
      invoke: (value: number) => stopNextTestServerChild(syntheticLiveChild(), {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: value
      })
    }
  ] as const;
  const unexpectedlyAccepted: string[] = [];

  for (const bound of shutdownBounds) {
    for (const value of invalidValues(bound.maximum)) {
      try {
        await assert.rejects(bound.invoke(value), NextTestServerError);
      } catch {
        unexpectedlyAccepted.push(`${bound.name}=${String(value)}`);
      }
    }
  }

  assert.deepEqual(unexpectedlyAccepted, []);
});

test("an explicit Next child environment cannot regain ambient database authority", async () => {
  const { resolveNextTestServerEnvironment } = await loadNextTestServer();
  const resolved = resolveNextTestServerEnvironment(
    { NODE_ENV: "development", SAFE_EXPLICIT: "kept" },
    {
      NODE_ENV: "test",
      SAFE_PARENT: "must-not-return",
      DATABASE_URL: "postgresql://ambient.example.invalid/never",
      DIRECT_URL: "postgresql://ambient-direct.example.invalid/never"
    }
  );

  assert.deepEqual(resolved, { NODE_ENV: "development", SAFE_EXPLICIT: "kept" });
});

test("Next readiness fails at its explicit deadline and reports only bounded logs", async () => {
  const { waitForNextTestServerReadiness } = await loadNextTestServer();
  let clock = 0;

  await assert.rejects(
    waitForNextTestServerReadiness({
      origin: "http://127.0.0.1:41234",
      childState: () => ({ exitCode: null, signalCode: null, spawnError: undefined }),
      getLogs: () => "0123456789",
      request: async () => {
        throw new Error("not listening");
      },
      now: () => {
        clock += 6;
        return clock;
      },
      delay: async () => undefined,
      timeoutMs: 10,
      pollIntervalMs: 1,
      maxFailureLogCharacters: 4
    }),
    (error: unknown) => {
      assert.match(String(error), /Timed out waiting for Next server/);
      assert.equal(String(error).includes("012345"), false);
      assert.match(String(error), /6789/);
      return true;
    }
  );
});

test("Next readiness fails immediately when its child exits", async () => {
  const { waitForNextTestServerReadiness } = await loadNextTestServer();
  let requests = 0;

  await assert.rejects(
    waitForNextTestServerReadiness({
      origin: "http://127.0.0.1:41234",
      childState: () => ({ exitCode: 7, signalCode: null, spawnError: undefined }),
      getLogs: () => "bounded child output",
      request: async () => {
        requests += 1;
        return { status: 200 };
      }
    }),
    /Next server exited before becoming ready with code 7/
  );
  assert.equal(requests, 0);
});

test("Next child cleanup waits for a real process and is safely repeatable", async () => {
  const { stopNextTestServerChild } = await loadNextTestServer();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    shell: false
  });
  await once(child, "spawn");

  try {
    await stopNextTestServerChild(child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 });
    await stopNextTestServerChild(child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 });
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("Next server cleanup restores the tracked generated environment declaration exactly", async () => {
  const { captureNextEnvironmentFile } = await loadNextTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "apply-pilot-next-env-"));
  const pathname = path.join(directory, "next-env.d.ts");
  const original = "import \"./.next/types/routes.d.ts\";\n";

  try {
    await writeFile(pathname, original, "utf8");
    const captured = await captureNextEnvironmentFile(directory);
    await writeFile(pathname, "import \"./.next/dev/types/routes.d.ts\";\n", "utf8");
    await recordGeneratedNextEnvironmentState(captured);

    await captured.restore();
    await captured.restore();

    assert.equal(await readFile(pathname, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Next environment restoration preserves and reports a concurrent edit to an existing file", async () => {
  const { captureNextEnvironmentFile, NextTestServerError } = await loadNextTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "apply-pilot-next-env-conflict-existing-"));
  const pathname = path.join(directory, "next-env.d.ts");
  const original = "// original next environment declaration\n";
  const generated = "// Next-generated declaration\n";
  const concurrent = "// CONCURRENT_EXISTING_EDIT_SENTINEL\n";

  try {
    await writeFile(pathname, original, "utf8");
    const captured = await captureNextEnvironmentFile(directory);
    await writeFile(pathname, generated, "utf8");
    await recordGeneratedNextEnvironmentState(captured);
    await writeFile(pathname, concurrent, "utf8");

    let restorationError: unknown;
    try {
      await captured.restore();
    } catch (error) {
      restorationError = error;
    }

    assert.equal(await readFile(pathname, "utf8"), concurrent);
    assert.ok(restorationError instanceof NextTestServerError);
    assert.match(restorationError.message, /changed.*refusing to overwrite/i);
    assert.equal(restorationError.message.includes(original.trim()), false);
    assert.equal(restorationError.message.includes(generated.trim()), false);
    assert.equal(restorationError.message.includes(concurrent.trim()), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Next environment restoration preserves and reports a concurrent file created from an absent state", async () => {
  const { captureNextEnvironmentFile, NextTestServerError } = await loadNextTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "apply-pilot-next-env-conflict-absent-"));
  const pathname = path.join(directory, "next-env.d.ts");
  const generated = "// Next-generated declaration from absent state\n";
  const concurrent = "// CONCURRENT_ABSENT_CREATE_SENTINEL\n";

  try {
    const captured = await captureNextEnvironmentFile(directory);
    await writeFile(pathname, generated, "utf8");
    await recordGeneratedNextEnvironmentState(captured);
    await writeFile(pathname, concurrent, "utf8");

    let restorationError: unknown;
    try {
      await captured.restore();
    } catch (error) {
      restorationError = error;
    }

    assert.equal(await readFile(pathname, "utf8"), concurrent);
    assert.ok(restorationError instanceof NextTestServerError);
    assert.match(restorationError.message, /changed.*refusing to overwrite/i);
    assert.equal(restorationError.message.includes(generated.trim()), false);
    assert.equal(restorationError.message.includes(concurrent.trim()), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the employer fixture renders one exact synthetic form without external or ATS content", async () => {
  const {
    SYNTHETIC_EMPLOYER_NAME,
    SYNTHETIC_EMPLOYER_ROLE,
    SYNTHETIC_EMPLOYER_SUBMISSION_URL,
    SYNTHETIC_EMPLOYER_TARGET_URL,
    renderSyntheticEmployerFixture
  } = await loadFixture();
  const html = renderSyntheticEmployerFixture();
  const dom = new JSDOM(html);
  const document = dom.window.document;

  assert.equal(SYNTHETIC_EMPLOYER_TARGET_URL, SYNTHETIC_TARGET);
  assert.equal(SYNTHETIC_EMPLOYER_SUBMISSION_URL, SYNTHETIC_ENDPOINT);
  assert.equal(SYNTHETIC_EMPLOYER_NAME, "Example Systems");
  assert.equal(SYNTHETIC_EMPLOYER_ROLE, "Synthetic Customer Success Engineer");
  assert.equal(document.querySelectorAll("form").length, 1);
  assert.equal(document.querySelectorAll("form[action]").length, 0);
  assert.equal(document.querySelector("form")?.hasAttribute("novalidate"), false);
  assert.equal(document.querySelectorAll("script[src], link[rel='stylesheet'], img, iframe").length, 0);
  assert.equal(document.querySelectorAll("input[type='url']").length, 2);
  assert.equal(document.querySelectorAll("textarea").length, 1);
  assert.equal(document.querySelectorAll("input[type='checkbox'][required]").length, 1);
  assert.equal(document.querySelectorAll("button[type='submit']").length, 1);
  assert.equal(document.querySelector("input[name='portfolioUrl']")?.getAttribute("value"), "");
  assert.equal(
    document.querySelector("input[name='profileUrl']")?.getAttribute("value"),
    "https://existing-profile.example.test/alex"
  );
  assert.match(document.body.textContent ?? "", /LinkedIn profile URL/);
  assert.match(document.body.textContent ?? "", /When can you start\?/);
  assert.match(document.body.textContent ?? "", /I certify that I reviewed this synthetic application/);
  assert.equal(document.querySelector("button[type='submit']")?.textContent?.trim(), "Submit synthetic application");
  assert.doesNotMatch(html, /greenhouse|lever|workday|google-analytics|segment\.com/i);
});

test("fixture instrumentation starts with every submission and navigation tripwire clear", async () => {
  const { readSyntheticEmployerWindowSnapshot, renderSyntheticEmployerFixture } = await loadFixture();
  const dom = new JSDOM(renderSyntheticEmployerFixture(), {
    runScripts: "dangerously",
    url: SYNTHETIC_TARGET
  });

  assert.deepEqual(readSyntheticEmployerWindowSnapshot(dom.window), {
    submitEventCount: 0,
    submitControlClickCount: 0,
    requestSubmitCallCount: 0,
    formSubmitCallCount: 0,
    formDataEventCount: 0,
    mainFrameNavigationCount: 0,
    popupCount: 0,
    humanStepArmed: false,
    lastSubmitClickWasTrusted: false,
    violationCount: 0,
    submissionRequestState: "NOT_STARTED"
  });
});

test("fixture programmatic submission pathways are counted and blocked before the human boundary", async () => {
  const { readSyntheticEmployerWindowSnapshot, renderSyntheticEmployerFixture } = await loadFixture();
  const dom = new JSDOM(renderSyntheticEmployerFixture(), {
    runScripts: "dangerously",
    url: SYNTHETIC_TARGET
  });
  const form = dom.window.document.querySelector("form");
  assert.ok(form);

  form.requestSubmit();
  form.submit();

  const snapshot = readSyntheticEmployerWindowSnapshot(dom.window);
  assert.equal(snapshot.requestSubmitCallCount, 1);
  assert.equal(snapshot.formSubmitCallCount, 1);
  assert.equal(snapshot.submitEventCount, 0);
  assert.equal(snapshot.violationCount, 2);
  assert.equal(snapshot.submissionRequestState, "NOT_STARTED");
});

test("the no-submission assertion includes the endpoint counter and every pre-human tripwire", async () => {
  const { assertNoSyntheticEmployerSubmission, createInitialSyntheticEmployerSnapshot } = await loadFixture();
  const initial = createInitialSyntheticEmployerSnapshot();

  assert.doesNotThrow(() => assertNoSyntheticEmployerSubmission(initial, 0));
  for (const key of [
    "submitEventCount",
    "submitControlClickCount",
    "requestSubmitCallCount",
    "formSubmitCallCount",
    "formDataEventCount",
    "mainFrameNavigationCount",
    "popupCount",
    "violationCount"
  ] as const) {
    assert.throws(
      () => assertNoSyntheticEmployerSubmission({ ...initial, [key]: 1 }, 0),
      /Synthetic employer submission boundary was crossed/,
      key
    );
  }
  assert.throws(() => assertNoSyntheticEmployerSubmission(initial, 1), /syntheticSubmissionEndpointCount=1/);
});

test("arming the synthetic human step fails closed without the guarded runner marker", async () => {
  const { armSyntheticHumanSubmission } = await loadFixture();
  const prior = process.env.SYNTHETIC_FULL_WORKFLOW_E2E;
  delete process.env.SYNTHETIC_FULL_WORKFLOW_E2E;
  let evaluated = false;

  try {
    await assert.rejects(
      armSyntheticHumanSubmission({
        url: () => SYNTHETIC_TARGET,
        evaluate: async () => {
          evaluated = true;
        }
      }),
      /guarded synthetic full-workflow suite/
    );
    assert.equal(evaluated, false);
  } finally {
    if (prior === undefined) delete process.env.SYNTHETIC_FULL_WORKFLOW_E2E;
    else process.env.SYNTHETIC_FULL_WORKFLOW_E2E = prior;
  }
});

test("the synthetic child environment inherits only approved runtime keys and no provider or auth secrets", async () => {
  const { buildSyntheticWorkflowChildEnvironment } = await loadWorkflowHarness();
  const explicitUrl = "postgresql://postgres:postgres@127.0.0.1:55433/apply_pilot_test?schema=public";
  const inheritedSecret = "INHERITED_SYNTHETIC_ENVIRONMENT_SECRET";
  const environment = buildSyntheticWorkflowChildEnvironment(explicitUrl, {
    PATH: "/safe/bin",
    DATABASE_URL: "postgresql://ambient.example.invalid/never",
    DIRECT_URL: "postgresql://ambient-direct.example.invalid/never",
    TEST_DATABASE_URL: inheritedSecret,
    SYNTHETIC_FULL_WORKFLOW_E2E: "1",
    ADZUNA_APP_ID: inheritedSecret,
    ADZUNA_APP_KEY: inheritedSecret,
    SERPAPI_API_KEY: inheritedSecret,
    THEIRSTACK_API_KEY: inheritedSecret,
    USAJOBS_API_KEY: inheritedSecret,
    WORKABLE_API_TOKEN: inheritedSecret,
    CRON_SECRET: inheritedSecret,
    AUTH_URL: inheritedSecret,
    APP_BASE_URL: inheritedSecret,
    GOOGLE_CLIENT_ID: inheritedSecret,
    GOOGLE_CLIENT_SECRET: inheritedSecret,
    AUTH_GOOGLE_ID: inheritedSecret,
    AUTH_GOOGLE_SECRET: inheritedSecret,
    AUTH_SECRET: inheritedSecret,
    OPENAI_API_KEY: inheritedSecret,
    GEMINI_API_KEY: inheritedSecret,
    MOONSHOT_API_KEY: inheritedSecret,
    SOME_FUTURE_UNKNOWN_SECRET: inheritedSecret
  });

  assert.equal(environment.PATH, "/safe/bin");
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.ALLOW_DEMO_USER, "true");
  assert.equal(environment.DEFAULT_DEMO_USER_ID, "synthetic-human-submit-user");
  assert.equal(environment.AUTH_TRUST_HOST, "true");
  assert.equal(environment.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(environment.AI_ENABLED, "false");
  assert.equal(environment.AI_MOCK_MODE, "true");
  assert.equal(environment.OPENAI_MOCK_MODE, "true");
  assert.equal(environment.APPLICATION_AUTOMATION_ENABLED, "true");
  assert.equal(environment.DATABASE_URL, explicitUrl);
  assert.equal(environment.DIRECT_URL, explicitUrl);
  const neutralizedEnvironmentNames = [
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "ADZUNA_COUNTRY",
    "AI_ALLOWED_MODELS",
    "AI_AUTOMATION_CAP_CENTS",
    "AI_CONFIRMATION_THRESHOLD_CENTS",
    "AI_EVAL_DELAY_MS",
    "AI_EVAL_PLAN_TOP",
    "AI_EVAL_TAILOR_TOP",
    "AI_EVAL_USER_EMAIL",
    "AI_EVALUATION_ACKNOWLEDGED",
    "AI_HARD_CAP_CENTS",
    "AI_MAX_REQUEST_COST_CENTS",
    "AI_PROVIDER",
    "AI_PROVIDER_OVERRIDES",
    "APP_BASE_URL",
    "APPLY_PILOT_LOCAL_DESTRUCTIVE",
    "AUTH_ALLOWED_EMAILS",
    "AUTH_ALLOW_PUBLIC_SIGNUPS",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_SECRET",
    "AUTH_URL",
    "BLOB_READ_WRITE_TOKEN",
    "COMMIT5_POSTGRES_TEST",
    "CRON_MAX_SOURCES_PER_RUN",
    "CRON_MIN_SOURCE_INTERVAL_MINUTES",
    "CRON_RUNNING_LOCK_MINUTES",
    "CRON_SECRET",
    "FILE_STORAGE_DRIVER",
    "GEMINI_API_KEY",
    "GEMINI_FAST_MODEL",
    "GEMINI_QUALITY_MODEL",
    "GMAIL_REDIRECT_URI",
    "GMAIL_SCOPES",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "JOB_SOURCE_MAX_POSTED_AGE_DAYS",
    "KIMI_EVAL_DATA_ACKNOWLEDGED",
    "KIMI_EVAL_MODE",
    "KIMI_MODEL",
    "KIMI_REASONING_EFFORT",
    "LOCAL_DATABASE_URL",
    "LOCAL_DIRECT_URL",
    "MOONSHOT_API_KEY",
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "OPENAI_ALLOWED_MODELS",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "SERPAPI_API_KEY",
    "SERPAPI_MAX_QUERIES_PER_RUN",
    "TEST_DATABASE_URL",
    "THEIRSTACK_API_KEY",
    "THEIRSTACK_POSTED_MAX_AGE_DAYS",
    "TOKEN_ENCRYPTION_KEY",
    "USAJOBS_API_KEY",
    "USAJOBS_USER_AGENT",
    "WORKABLE_API_TOKEN",
  ] as const;
  for (const key of neutralizedEnvironmentNames) {
    assert.equal(environment[key], "", key);
  }
  assert.equal("SOME_FUTURE_UNKNOWN_SECRET" in environment, false);
  assert.equal(Object.values(environment).includes(inheritedSecret), false);
  assert.deepEqual(Object.keys(environment).sort(), [
    ...neutralizedEnvironmentNames,
    "AI_ENABLED",
    "AI_MOCK_MODE",
    "ALLOW_DEMO_USER",
    "APPLICATION_AUTOMATION_ENABLED",
    "AUTH_TRUST_HOST",
    "DATABASE_URL",
    "DEFAULT_DEMO_USER_ID",
    "DIRECT_URL",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "OPENAI_MOCK_MODE",
    "PATH",
    "SYNTHETIC_FULL_WORKFLOW_E2E"
  ].sort());
});

test("Next dotenv loading cannot restore neutralized provider or auth credentials", async () => {
  const { buildSyntheticWorkflowChildEnvironment } = await loadWorkflowHarness();
  const directory = await mkdtemp(path.join(tmpdir(), "apply-pilot-synthetic-dotenv-"));
  const explicitUrl = "postgresql://postgres:postgres@127.0.0.1:55433/apply_pilot_test?schema=public";
  const sentinelEnvironment = {
    SERPAPI_API_KEY: "DOTENV_PROVIDER_SECRET_SENTINEL",
    ADZUNA_APP_KEY: "DOTENV_ADZUNA_SECRET_SENTINEL",
    THEIRSTACK_API_KEY: "DOTENV_THEIRSTACK_SECRET_SENTINEL",
    USAJOBS_API_KEY: "DOTENV_USAJOBS_SECRET_SENTINEL",
    WORKABLE_API_TOKEN: "DOTENV_WORKABLE_SECRET_SENTINEL",
    GOOGLE_CLIENT_ID: "DOTENV_GOOGLE_CLIENT_ID_SENTINEL",
    GOOGLE_CLIENT_SECRET: "DOTENV_GOOGLE_CLIENT_SECRET_SENTINEL",
    AUTH_GOOGLE_ID: "DOTENV_AUTH_GOOGLE_ID_SENTINEL",
    AUTH_GOOGLE_SECRET: "DOTENV_AUTH_GOOGLE_SECRET_SENTINEL",
    AUTH_SECRET: "DOTENV_AUTH_SECRET_SENTINEL",
    CRON_SECRET: "DOTENV_CRON_SECRET_SENTINEL"
  } as const;

  try {
    await writeFile(
      path.join(directory, ".env.local"),
      Object.entries(sentinelEnvironment).map(([name, value]) => `${name}=${value}`).join("\n") + "\n",
      "utf8"
    );
    const environment = buildSyntheticWorkflowChildEnvironment(explicitUrl, {
      PATH: process.env.PATH,
      SYNTHETIC_FULL_WORKFLOW_E2E: "1"
    });
    const loaderScript = [
      "const { loadEnvConfig } = require(process.argv[1]);",
      "const directory = process.argv[2];",
      "const names = JSON.parse(process.argv[3]);",
      "loadEnvConfig(directory, true, { info() {}, error() {} }, true);",
      "process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name]]))));"
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        loaderScript,
        path.join(process.cwd(), "node_modules", "@next", "env"),
        directory,
        JSON.stringify(Object.keys(sentinelEnvironment))
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: environment,
        shell: false
      }
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      SERPAPI_API_KEY: "",
      ADZUNA_APP_KEY: "",
      THEIRSTACK_API_KEY: "",
      USAJOBS_API_KEY: "",
      WORKABLE_API_TOKEN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      AUTH_GOOGLE_ID: "",
      AUTH_GOOGLE_SECRET: "",
      AUTH_SECRET: "",
      CRON_SECRET: ""
    });
    for (const sentinel of Object.values(sentinelEnvironment)) {
      assert.equal(child.stdout.includes(sentinel), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the synthetic child environment cannot be built outside the guarded suite or without an explicit URL", async () => {
  const { buildSyntheticWorkflowChildEnvironment } = await loadWorkflowHarness();

  assert.throws(
    () => buildSyntheticWorkflowChildEnvironment("postgresql://explicit", { SYNTHETIC_FULL_WORKFLOW_E2E: "0" }),
    /guarded synthetic full-workflow suite/
  );
  assert.throws(
    () => buildSyntheticWorkflowChildEnvironment("", { SYNTHETIC_FULL_WORKFLOW_E2E: "1", DATABASE_URL: "ambient" }),
    /explicit validated PostgreSQL test URL/
  );
});

test("the network classifier admits only the allocated loopback origin and two exact synthetic URLs", async () => {
  const { classifySyntheticWorkflowUrl } = await loadWorkflowHarness();
  const applyPilotOrigin = "http://127.0.0.1:43123";
  const accepted = [
    [`${applyPilotOrigin}/`, "APPLY_PILOT"],
    [`${applyPilotOrigin}/_next/static/chunk.js`, "APPLY_PILOT"],
    [`${applyPilotOrigin}/api/auth/session?update=1`, "APPLY_PILOT"],
    [SYNTHETIC_TARGET, "SYNTHETIC_TARGET"],
    [SYNTHETIC_ENDPOINT, "SYNTHETIC_SUBMISSION"]
  ] as const;

  for (const [url, purpose] of accepted) {
    assert.deepEqual(classifySyntheticWorkflowUrl(url, applyPilotOrigin), { allowed: true, purpose });
  }
});

test("the network classifier rejects external, private, wrong-port, and noncanonical employer destinations", async () => {
  const { classifySyntheticWorkflowUrl } = await loadWorkflowHarness();
  const applyPilotOrigin = "http://127.0.0.1:43123";
  const rejected = [
    "https://google.com/",
    "https://greenhouse.io/",
    "https://api.openai.com/",
    "https://example.com/",
    "http://192.168.1.10/",
    "http://localhost:43123/",
    "http://127.0.0.1:43124/",
    "https://employer.example.test/",
    "https://employer.example.test/applications/other",
    "https://employer.example.test/__synthetic-human-submit?extra=1"
  ];

  for (const url of rejected) {
    assert.deepEqual(classifySyntheticWorkflowUrl(url, applyPilotOrigin), { allowed: false, purpose: "REJECTED" }, url);
  }
  assert.throws(
    () => classifySyntheticWorkflowUrl(SYNTHETIC_TARGET, "http://0.0.0.0:43123"),
    /exact allocated 127\.0\.0\.1 origin/
  );
  assert.throws(
    () => classifySyntheticWorkflowUrl(SYNTHETIC_TARGET, "http://127.0.0.1:0"),
    /exact allocated 127\.0\.0\.1 origin/
  );
});

test("diagnostic summaries expose only the bounded allowlist and never serialize secrets or raw records", async () => {
  const { buildSyntheticDiagnosticSummary } = await loadWorkflowHarness();
  const secret = "DIAGNOSTIC_SECRET_SENTINEL";
  const summary = buildSyntheticDiagnosticSummary({
    phase: "PRE_HUMAN_SUBMISSION",
    runState: "READY_FOR_USER_SUBMISSION",
    runStateVersion: 7,
    inspectionVersion: 3,
    packetVersion: 4,
    hasFillAttempt: true,
    fillResultCounts: { attempted: 3, succeeded: 2, failed: 0, skipped: 1, manual: 1, secret },
    hasCompletedAt: false,
    applicationStatus: "reviewing",
    hasDateApplied: false,
    controlUrl: "http://127.0.0.1:43123/application-runs/synthetic",
    targetUrl: SYNTHETIC_TARGET,
    DATABASE_URL: secret,
    DIRECT_URL: secret,
    TEST_DATABASE_URL: secret,
    AUTH_SECRET: secret,
    cookies: secret,
    executionToken: secret,
    environment: { SECRET: secret },
    rawPacket: { answer: secret },
    rawAudit: { value: secret },
    employerValues: { profile: secret }
  });
  const serialized = JSON.stringify(summary);

  assert.deepEqual(Object.keys(summary), [
    "phase",
    "runState",
    "runStateVersion",
    "inspectionVersion",
    "packetVersion",
    "hasFillAttempt",
    "fillResultCounts",
    "hasCompletedAt",
    "applicationStatus",
    "hasDateApplied",
    "controlUrl",
    "targetUrl"
  ]);
  assert.deepEqual(summary.fillResultCounts, { attempted: 3, succeeded: 2, failed: 0, skipped: 1, manual: 1 });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("DATABASE_URL"), false);
  assert.equal(serialized.includes("rawPacket"), false);

  const querySecret = "CONTROL_URL_SECRET_SENTINEL";
  const unsafeControlUrl = buildSyntheticDiagnosticSummary({
    controlUrl: `http://127.0.0.1:43123/application-runs/synthetic?executionToken=${querySecret}`
  });
  assert.equal(unsafeControlUrl.controlUrl, null);
  assert.equal(JSON.stringify(unsafeControlUrl).includes(querySecret), false);
});

test("diagnostic artifact paths stay beneath the ignored synthetic root", async () => {
  const { buildSyntheticDiagnosticArtifactPath } = await loadWorkflowHarness();

  assert.equal(
    buildSyntheticDiagnosticArtifactPath("failure-001.json", "/repo"),
    path.join("/repo", "test-results", "synthetic-human-submit", "failure-001.json")
  );
  for (const filename of ["../secret.json", "/tmp/secret.json", "nested/secret.json", "failure.txt", ".json"]) {
    assert.throws(() => buildSyntheticDiagnosticArtifactPath(filename, "/repo"), /safe JSON artifact filename/);
  }
});

test("partial synthetic seeding retains an exact cleanup owner registered before the first write", async () => {
  const harness = await loadWorkflowHarness();
  const runWithPreRegisteredCleanup = Reflect.get(harness, "runWithPreRegisteredCleanup");
  assert.equal(typeof runWithPreRegisteredCleanup, "function");
  const stack = new harness.SyntheticCleanupStack({ perCleanupTimeoutMs: 50 });
  const rows = new Set(["unrelated-user"]);
  const primaryFailure = new Error("injected partial seed failure");
  let cleanupAttempts = 0;

  await assert.rejects(
    runWithPreRegisteredCleanup(
      stack,
      "delete-synthetic-user",
      async () => {
        cleanupAttempts += 1;
        rows.delete("synthetic-human-submit-user");
      },
      async () => {
        rows.add("synthetic-human-submit-user");
        throw primaryFailure;
      }
    ),
    (error: unknown) => error === primaryFailure
  );

  assert.deepEqual(await stack.cleanup(), []);
  assert.deepEqual([...rows], ["unrelated-user"]);
  assert.equal(cleanupAttempts, 1);
  assert.deepEqual(await stack.cleanup(), []);
  assert.equal(cleanupAttempts, 1);
});

test("an acquired browser runtime has raw cleanup ownership before fallible setup resumes", async () => {
  const harness = await loadWorkflowHarness();
  const acquireCleanupOwnedResource = Reflect.get(harness, "acquireCleanupOwnedResource");
  assert.equal(typeof acquireCleanupOwnedResource, "function");
  const stack = new harness.SyntheticCleanupStack({ perCleanupTimeoutMs: 50 });
  const setupFailure = new Error("injected post-acquisition setup failure");
  const runtime = {
    closeAttempts: 0,
    async close() {
      this.closeAttempts += 1;
    }
  };
  let primaryFailure: unknown;

  try {
    const owned = await acquireCleanupOwnedResource(
      stack,
      "close-browser-runtime",
      async () => runtime,
      (acquired: typeof runtime) => acquired.close()
    );
    assert.equal(owned.resource, runtime);
    throw setupFailure;
  } catch (error) {
    primaryFailure = error;
  } finally {
    assert.deepEqual(await stack.cleanup(), []);
  }

  assert.equal(primaryFailure, setupFailure);
  assert.equal(runtime.closeAttempts, 1);
  assert.deepEqual(await stack.cleanup(), []);
  assert.equal(runtime.closeAttempts, 1);
});

test("a throwing production close still attempts the raw browser runtime close", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 50 });
  const productionCloseSecret = "PRODUCTION_CLOSE_SECRET_SENTINEL";
  let rawCloseAttempts = 0;
  const owned = await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => ({ kind: "synthetic-runtime" as const }),
    async () => {
      rawCloseAttempts += 1;
    }
  );
  owned.setPreferredCleanup(async () => {
    throw new Error(productionCloseSecret);
  });

  const failures = await stack.cleanup();

  assert.equal(rawCloseAttempts, 1);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
  assert.equal(JSON.stringify(failures).includes(productionCloseSecret), false);
});

test("a bounded production close timeout still attempts the raw browser runtime close", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 100 });
  let rawCloseAttempts = 0;
  const owned = await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => ({ kind: "synthetic-runtime" as const }),
    async () => {
      rawCloseAttempts += 1;
    },
    { preferredCleanupTimeoutMs: 10 }
  );
  owned.setPreferredCleanup(async () => new Promise<void>(() => undefined));
  const startedAt = Date.now();

  const failures = await stack.cleanup();

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(rawCloseAttempts, 1);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
});

test("a never-settling raw browser close reaches force cleanup before the outer deadline", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 100 });
  const runtime = { closed: false };
  let forceCleanupAttempts = 0;

  await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => runtime,
    async () => new Promise<void>(() => undefined),
    {
      gracefulCleanupTimeoutMs: 10,
      forceCleanupTimeoutMs: 10,
      forceCleanup: async (acquired: typeof runtime) => {
        forceCleanupAttempts += 1;
        acquired.closed = true;
      }
    }
  );

  const failures = await stack.cleanup();

  assert.equal(forceCleanupAttempts, 1);
  assert.equal(runtime.closed, true);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
});

test("force cleanup is awaited exactly once and verified before owned cleanup settles", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 100 });
  const runtime = { closed: false };
  let forceCleanupAttempts = 0;
  let verificationAttempts = 0;
  let releaseForceCleanup!: () => void;
  const forceCleanupReleased = new Promise<void>((resolve) => {
    releaseForceCleanup = resolve;
  });
  let announceForceCleanup!: () => void;
  const forceCleanupStarted = new Promise<void>((resolve) => {
    announceForceCleanup = resolve;
  });

  await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => runtime,
    async () => new Promise<void>(() => undefined),
    {
      gracefulCleanupTimeoutMs: 5,
      forceCleanupTimeoutMs: 50,
      forceCleanup: async (acquired: typeof runtime) => {
        forceCleanupAttempts += 1;
        announceForceCleanup();
        await forceCleanupReleased;
        acquired.closed = true;
      },
      verifyClosed: async (acquired: typeof runtime) => {
        verificationAttempts += 1;
        return acquired.closed;
      }
    }
  );

  let cleanupSettled = false;
  const cleanupPromise = stack.cleanup().then((failures) => {
    cleanupSettled = true;
    return failures;
  });
  await forceCleanupStarted;
  await Promise.resolve();

  assert.equal(cleanupSettled, false);
  assert.equal(forceCleanupAttempts, 1);
  assert.equal(runtime.closed, false);

  releaseForceCleanup();
  const failures = await cleanupPromise;

  assert.equal(forceCleanupAttempts, 1);
  assert.equal(verificationAttempts, 1);
  assert.equal(runtime.closed, true);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
});

test("a never-settling force cleanup fails within its own deadline", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 100 });
  const runtime = { closed: false };
  let forceCleanupAttempts = 0;
  let forceAbortObserved = false;

  await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => runtime,
    async () => new Promise<void>(() => undefined),
    {
      gracefulCleanupTimeoutMs: 5,
      forceCleanupTimeoutMs: 10,
      forceCleanup: async (_acquired: typeof runtime, signal: AbortSignal) => {
        forceCleanupAttempts += 1;
        signal.addEventListener("abort", () => {
          forceAbortObserved = true;
        }, { once: true });
        return new Promise<void>(() => undefined);
      },
      verifyClosed: async (acquired: typeof runtime) => acquired.closed
    }
  );
  const startedAt = Date.now();

  const failures = await stack.cleanup();

  assert.ok(Date.now() - startedAt < 80);
  assert.equal(forceCleanupAttempts, 1);
  assert.equal(forceAbortObserved, true);
  assert.equal(runtime.closed, false);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
});

test("database cleanup awaits its engine timeout and disconnects before further mutations can run", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  const statementDelayMs = 10;
  let mutationCount = 0;
  let transactionActive = false;
  let disconnectAttempts = 0;

  await assert.rejects(runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    (transactionTimeoutMs: number) => new Promise<void>((resolve, reject) => {
      transactionActive = true;
      const engineTimer = setTimeout(() => {
        transactionActive = false;
        reject(new Error("simulated Prisma engine transaction timeout"));
      }, transactionTimeoutMs);
      void (async () => {
        for (let step = 0; step < 3; step += 1) {
          await new Promise((stepComplete) => setTimeout(stepComplete, statementDelayMs));
          if (!transactionActive) return;
          mutationCount += 1;
        }
        clearTimeout(engineTimer);
        transactionActive = false;
        resolve();
      })();
    }),
    async () => {
      disconnectAttempts += 1;
      transactionActive = false;
    },
    {
      transactionTimeoutMs: 15,
      statementCancellationGraceMs: 5,
      aggregateTimeoutMs: 30,
      disconnectTimeoutMs: 10,
      schedulingMarginMs: 5,
      outerTimeoutMs: 50
    }
  ));
  const mutationCountAtReturn = mutationCount;

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(disconnectAttempts, 1);
  assert.equal(transactionActive, false);
  assert.equal(mutationCountAtReturn, 1);
  assert.equal(mutationCount, mutationCountAtReturn);
});

test("database cleanup keeps ownership of a live transaction when disconnect rejects", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  const disconnectFailure = new Error("simulated actor disconnect rejection");
  let releaseTransaction!: () => void;
  const transactionRelease = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let markTransactionSettled!: () => void;
  const transactionSettled = new Promise<void>((resolve) => {
    markTransactionSettled = resolve;
  });
  let markDisconnectAttempted!: () => void;
  const disconnectAttempted = new Promise<void>((resolve) => {
    markDisconnectAttempted = resolve;
  });
  let mutationCount = 0;
  let helperSettled = false;

  const outcomePromise = runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    async () => {
      await transactionRelease;
      mutationCount += 1;
      markTransactionSettled();
    },
    async () => {
      markDisconnectAttempted();
      throw disconnectFailure;
    },
    {
      transactionTimeoutMs: 5,
      statementCancellationGraceMs: 1,
      aggregateTimeoutMs: 20,
      disconnectTimeoutMs: 10,
      schedulingMarginMs: 5,
      outerTimeoutMs: 50
    }
  ).then(
    () => {
      helperSettled = true;
      return { status: "fulfilled" as const, error: undefined };
    },
    (error: unknown) => {
      helperSettled = true;
      return { status: "rejected" as const, error };
    }
  );

  await disconnectAttempted;
  await new Promise((resolve) => setImmediate(resolve));
  const helperSettledBeforeTransaction = helperSettled;
  const mutationsBeforeTransaction = mutationCount;
  releaseTransaction();
  await transactionSettled;
  const outcome = await outcomePromise;

  assert.equal(helperSettledBeforeTransaction, false);
  assert.equal(mutationsBeforeTransaction, 0);
  assert.equal(mutationCount, 1);
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.ok(outcome.error.errors.includes(disconnectFailure));
});

test("database cleanup keeps ownership of a live transaction when disconnect times out", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  let releaseTransaction!: () => void;
  const transactionRelease = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let markTransactionSettled!: () => void;
  const transactionSettled = new Promise<void>((resolve) => {
    markTransactionSettled = resolve;
  });
  let markDisconnectAttempted!: () => void;
  const disconnectAttempted = new Promise<void>((resolve) => {
    markDisconnectAttempted = resolve;
  });
  let mutationCount = 0;
  let helperSettled = false;

  const outcomePromise = runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    async () => {
      await transactionRelease;
      mutationCount += 1;
      markTransactionSettled();
    },
    async () => {
      markDisconnectAttempted();
      return new Promise<void>(() => undefined);
    },
    {
      transactionTimeoutMs: 5,
      statementCancellationGraceMs: 1,
      aggregateTimeoutMs: 20,
      disconnectTimeoutMs: 10,
      schedulingMarginMs: 5,
      outerTimeoutMs: 50
    }
  ).then(
    () => {
      helperSettled = true;
      return { status: "fulfilled" as const, error: undefined };
    },
    (error: unknown) => {
      helperSettled = true;
      return { status: "rejected" as const, error };
    }
  );

  await disconnectAttempted;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const helperSettledBeforeTransaction = helperSettled;
  const mutationsBeforeTransaction = mutationCount;
  releaseTransaction();
  await transactionSettled;
  const outcome = await outcomePromise;

  assert.equal(helperSettledBeforeTransaction, false);
  assert.equal(mutationsBeforeTransaction, 0);
  assert.equal(mutationCount, 1);
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.ok(outcome.error.errors.some(
    (error: unknown) => error instanceof Error &&
      error.message === "Synthetic database actor disconnect timed out."
  ));
});

test("database cleanup fails when transaction settlement exceeds its absolute deadline", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  let releaseTransaction!: () => void;
  const transactionRelease = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let markDisconnectAttempted!: () => void;
  const disconnectAttempted = new Promise<void>((resolve) => {
    markDisconnectAttempted = resolve;
  });
  let mutationCount = 0;
  let helperSettled = false;

  const outcomePromise = runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    async () => {
      await transactionRelease;
      mutationCount += 1;
    },
    async () => {
      markDisconnectAttempted();
    },
    {
      transactionTimeoutMs: 5,
      statementCancellationGraceMs: 1,
      aggregateTimeoutMs: 20,
      disconnectTimeoutMs: 5,
      schedulingMarginMs: 5,
      outerTimeoutMs: 50
    }
  ).then(
    () => {
      helperSettled = true;
      return { status: "fulfilled" as const, error: undefined };
    },
    (error: unknown) => {
      helperSettled = true;
      return { status: "rejected" as const, error };
    }
  );

  await disconnectAttempted;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(helperSettled, false);
  assert.equal(mutationCount, 0);
  releaseTransaction();
  const outcome = await outcomePromise;
  const mutationsAtReturn = mutationCount;
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.ok(outcome.error.errors.some(
    (error: unknown) => error instanceof Error &&
      error.message === "Synthetic database transaction settled after its absolute deadline."
  ));
  assert.equal(mutationsAtReturn, 1);
  assert.equal(mutationCount, mutationsAtReturn);
});

test("synthetic rate-limit cleanup deletes only its finite exact owned keys", async () => {
  const harness = await loadWorkflowHarness();
  const deleteSyntheticWorkflowRateLimitRows = Reflect.get(
    harness,
    "deleteSyntheticWorkflowRateLimitRows"
  );
  assert.equal(typeof deleteSyntheticWorkflowRateLimitRows, "function");
  const userId = "synthetic-human-submit-user";
  const exactOwnedKeys = [
    `application-automation-policy:read:${userId}`,
    `application-runs:create:${userId}`,
    `application-runs:read:${userId}`,
    `application-runs:prepare:${userId}`,
    `application-runs:form-inspection:publish:${userId}`,
    `application-runs:answer-packet:read:${userId}`,
    `application-runs:answers:review:${userId}`,
    `application-runs:resolve-review:${userId}`,
    `application-runs:fill-attempt:acquire:${userId}`,
    `application-runs:fill-attempt:status:${userId}`,
    `application-runs:fill-attempt:mutate:${userId}`,
    `application-runs:complete-by-user:${userId}`
  ];
  const unrelatedLookalike = `unrelated:${userId}:shared-owner`;
  const rows = new Set([...exactOwnedKeys, unrelatedLookalike, "unrelated:stable"]);
  const receivedFilters: Array<{ contains?: string; in?: string[] }> = [];
  const rateLimitBucket = {
    async deleteMany(input: Readonly<{
      where: Readonly<{
        key: Readonly<{ contains?: string; in?: string[] }>;
      }>;
    }>) {
      const filter = input.where.key;
      receivedFilters.push({
        ...(filter.contains === undefined ? {} : { contains: filter.contains }),
        ...(filter.in === undefined ? {} : { in: [...filter.in] })
      });
      for (const key of [...rows]) {
        if (
          (filter.contains !== undefined && key.includes(filter.contains)) ||
          (filter.in !== undefined && filter.in.includes(key))
        ) {
          rows.delete(key);
        }
      }
      return { count: 0 };
    }
  };

  await deleteSyntheticWorkflowRateLimitRows(rateLimitBucket, userId);
  await deleteSyntheticWorkflowRateLimitRows(rateLimitBucket, userId);

  assert.deepEqual(receivedFilters, [
    { in: exactOwnedKeys },
    { in: exactOwnedKeys }
  ]);
  assert.deepEqual([...rows].sort(), [unrelatedLookalike, "unrelated:stable"].sort());
});

test("owned cleanup cannot report success while its closure verifier says the resource is live", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 100 });
  const runtime = { closed: false };
  let forceCleanupAttempts = 0;
  let verificationAttempts = 0;

  await acquireCleanupOwnedResource(
    stack,
    "close-browser-runtime",
    async () => runtime,
    async () => undefined,
    {
      gracefulCleanupTimeoutMs: 10,
      forceCleanupTimeoutMs: 10,
      forceCleanup: async (acquired: typeof runtime) => {
        forceCleanupAttempts += 1;
        acquired.closed = true;
      },
      verifyClosed: async (acquired: typeof runtime) => {
        verificationAttempts += 1;
        return acquired.closed;
      }
    }
  );

  const failures = await stack.cleanup();

  assert.equal(forceCleanupAttempts, 1);
  assert.equal(verificationAttempts, 2);
  assert.equal(runtime.closed, true);
  assert.deepEqual(failures, [{ label: "close-browser-runtime", reason: "FAILED" }]);
});

test("browser cleanup deadlines must leave scheduling margin inside the outer envelope", async () => {
  const { SyntheticCleanupStack, acquireCleanupOwnedResource } = await loadWorkflowHarness();
  const validStack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 15 });
  let validAcquisitions = 0;
  await acquireCleanupOwnedResource(
    validStack,
    "valid-browser-budget",
    async () => {
      validAcquisitions += 1;
      return { closed: false };
    },
    async (resource: { closed: boolean }) => {
      resource.closed = true;
    },
    {
      preferredCleanupTimeoutMs: 9,
      gracefulCleanupTimeoutMs: 2,
      forceCleanupTimeoutMs: 2,
      schedulingMarginMs: 1,
      forceCleanup: async (resource: { closed: boolean }) => {
        resource.closed = true;
      },
      verifyClosed: async (resource: { closed: boolean }) => resource.closed
    }
  );
  assert.equal(validAcquisitions, 1);
  assert.deepEqual(await validStack.cleanup(), []);

  const invalidStack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 15 });
  let invalidAcquisitions = 0;
  await assert.rejects(
    acquireCleanupOwnedResource(
      invalidStack,
      "invalid-browser-budget",
      async () => {
        invalidAcquisitions += 1;
        return { closed: false };
      },
      async (resource: { closed: boolean }) => {
        resource.closed = true;
      },
      {
        preferredCleanupTimeoutMs: 9,
        gracefulCleanupTimeoutMs: 2,
        forceCleanupTimeoutMs: 2,
        schedulingMarginMs: 2,
        forceCleanup: async (resource: { closed: boolean }) => {
          resource.closed = true;
        },
        verifyClosed: async (resource: { closed: boolean }) => resource.closed
      }
    ),
    /strictly inside the outer cleanup deadline/
  );
  assert.equal(invalidAcquisitions, 0);
});

test("database cleanup deadlines keep the engine and disconnect phases inside the outer envelope", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  let transactionAttempts = 0;
  let disconnectAttempts = 0;
  const runWith = (options: Readonly<{
    transactionTimeoutMs: number;
    statementCancellationGraceMs: number;
    aggregateTimeoutMs: number;
    disconnectTimeoutMs: number;
    schedulingMarginMs: number;
    outerTimeoutMs: number;
  }>) => runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    async () => {
      transactionAttempts += 1;
    },
    async () => {
      disconnectAttempts += 1;
    },
    options
  );

  await assert.doesNotReject(runWith({
    transactionTimeoutMs: 7_000,
    statementCancellationGraceMs: 250,
    aggregateTimeoutMs: 8_000,
    disconnectTimeoutMs: 3_000,
    schedulingMarginMs: 1_000,
    outerTimeoutMs: 15_000
  }));
  assert.equal(transactionAttempts, 1);
  assert.equal(disconnectAttempts, 0);

  await assert.rejects(runWith({
    transactionTimeoutMs: 8_000,
    statementCancellationGraceMs: 250,
    aggregateTimeoutMs: 8_000,
    disconnectTimeoutMs: 3_000,
    schedulingMarginMs: 1_000,
    outerTimeoutMs: 15_000
  }), /transaction timeout must be strictly lower than its aggregate deadline/);
  await assert.rejects(runWith({
    transactionTimeoutMs: 7_000,
    statementCancellationGraceMs: 250,
    aggregateTimeoutMs: 10_000,
    disconnectTimeoutMs: 4_000,
    schedulingMarginMs: 1_000,
    outerTimeoutMs: 15_000
  }), /strictly inside the outer cleanup deadline/);
  assert.equal(transactionAttempts, 1);
  assert.equal(disconnectAttempts, 0);
});

test("database cleanup supplies an in-flight statement deadline between engine expiry and the watchdog", async () => {
  const harness = await loadWorkflowHarness();
  const runEngineBoundDatabaseCleanup = Reflect.get(harness, "runEngineBoundDatabaseCleanup");
  assert.equal(typeof runEngineBoundDatabaseCleanup, "function");
  let receivedTransactionTimeoutMs: number | undefined;
  let receivedStatementTimeoutMs: number | undefined;

  await runEngineBoundDatabaseCleanup(
    new AbortController().signal,
    async (transactionTimeoutMs: number, statementTimeoutMs: number) => {
      receivedTransactionTimeoutMs = transactionTimeoutMs;
      receivedStatementTimeoutMs = statementTimeoutMs;
    },
    async () => undefined,
    {
      transactionTimeoutMs: 7_000,
      statementCancellationGraceMs: 250,
      aggregateTimeoutMs: 8_000,
      disconnectTimeoutMs: 3_000,
      schedulingMarginMs: 1_000,
      outerTimeoutMs: 15_000
    }
  );

  assert.equal(receivedTransactionTimeoutMs, 7_000);
  assert.equal(receivedStatementTimeoutMs, 7_250);
});

test("serial database cleanup statements share one absolute cancellation deadline", async () => {
  const harness = await loadWorkflowHarness();
  const remainingSyntheticDatabaseStatementTimeoutMs = Reflect.get(
    harness,
    "remainingSyntheticDatabaseStatementTimeoutMs"
  );
  assert.equal(typeof remainingSyntheticDatabaseStatementTimeoutMs, "function");

  assert.equal(remainingSyntheticDatabaseStatementTimeoutMs(17_250, 10_000), 7_250);
  assert.equal(remainingSyntheticDatabaseStatementTimeoutMs(17_250, 17_249), 1);
  assert.throws(
    () => remainingSyntheticDatabaseStatementTimeoutMs(17_250, 17_250),
    /statement cancellation deadline expired/
  );
  assert.throws(
    () => remainingSyntheticDatabaseStatementTimeoutMs(17_250, 17_251),
    /statement cancellation deadline expired/
  );
});

test("cleanup outcome aggregation preserves the primary failure and never suppresses cleanup failure", async () => {
  const harness = await loadWorkflowHarness();
  const assertSyntheticCleanupOutcome = Reflect.get(harness, "assertSyntheticCleanupOutcome");
  assert.equal(typeof assertSyntheticCleanupOutcome, "function");
  const primaryFailure = new Error("injected primary workflow failure");
  const cleanupSecret = "CLEANUP_DETAIL_SECRET_SENTINEL";
  const cleanupFailures = [{
    label: "close-browser-runtime",
    reason: "FAILED",
    detail: cleanupSecret
  }] as const;

  assert.doesNotThrow(() => assertSyntheticCleanupOutcome(undefined, []));
  assert.doesNotThrow(() => assertSyntheticCleanupOutcome(primaryFailure, []));
  assert.throws(
    () => {
      try {
        throw primaryFailure;
      } finally {
        assertSyntheticCleanupOutcome(primaryFailure, []);
      }
    },
    (error: unknown) => error === primaryFailure
  );

  let cleanupOnly: unknown;
  try {
    assertSyntheticCleanupOutcome(undefined, cleanupFailures);
  } catch (error) {
    cleanupOnly = error;
  }
  assert.ok(cleanupOnly instanceof AggregateError);
  assert.equal(cleanupOnly.errors.length, 1);
  assert.match(String(cleanupOnly.errors[0]), /close-browser-runtime.*FAILED/);

  let combined: unknown;
  try {
    assertSyntheticCleanupOutcome(primaryFailure, cleanupFailures);
  } catch (error) {
    combined = error;
  }
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.cause, primaryFailure);
  assert.equal(combined.errors[0], primaryFailure);
  assert.match(String(combined.errors[1]), /close-browser-runtime.*FAILED/);
  assert.equal(
    [cleanupOnly.message, ...cleanupOnly.errors.map(String), combined.message, ...combined.errors.map(String)]
      .join("\n")
      .includes(cleanupSecret),
    false
  );
});

test("the cleanup stack is LIFO, bounded, redacts failures, and safely repeatable", async () => {
  const { SyntheticCleanupStack } = await loadWorkflowHarness();
  const order: string[] = [];
  const secret = "CLEANUP_SECRET_SENTINEL";
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 20 });
  stack.add("first", async () => {
    order.push("first");
  });
  stack.add("secret-label", async () => {
    order.push("failing");
    throw new Error(secret);
  });
  stack.add("last", async () => {
    order.push("last");
  });

  const first = await stack.cleanup();
  const second = await stack.cleanup();

  assert.deepEqual(order, ["last", "failing", "first"]);
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.label, "secret-label");
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test("the cleanup stack returns a timeout result for a non-cooperative cleanup", async () => {
  const { SyntheticCleanupStack } = await loadWorkflowHarness();
  const stack = new SyntheticCleanupStack({ perCleanupTimeoutMs: 10 });
  stack.add("stuck", async () => new Promise<void>(() => undefined));
  const startedAt = Date.now();

  const failures = await stack.cleanup();

  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(failures, [{ label: "stuck", reason: "TIMED_OUT" }]);
});

test("synthetic fixture snapshot parsing rejects malformed, extra, or authority-bearing data", async () => {
  const { parseSyntheticEmployerSnapshot } = await loadWorkflowHarness();
  const valid = {
    submitEventCount: 0,
    submitControlClickCount: 0,
    requestSubmitCallCount: 0,
    formSubmitCallCount: 0,
    formDataEventCount: 0,
    mainFrameNavigationCount: 0,
    popupCount: 0,
    humanStepArmed: false,
    lastSubmitClickWasTrusted: false,
    violationCount: 0,
    submissionRequestState: "NOT_STARTED"
  };

  assert.deepEqual(parseSyntheticEmployerSnapshot(valid), valid);
  assert.throws(() => parseSyntheticEmployerSnapshot({ ...valid, submitEventCount: -1 }), /fixture snapshot/);
  assert.throws(() => parseSyntheticEmployerSnapshot({ ...valid, executionToken: "never" }), /fixture snapshot/);
  assert.throws(() => parseSyntheticEmployerSnapshot({ ...valid, humanStepArmed: "true" }), /fixture snapshot/);
});
