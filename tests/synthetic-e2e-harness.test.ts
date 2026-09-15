import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
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

test("selected test-file validation fails closed on the intentionally absent synthetic handoff before DB work", async () => {
  const { assertPostgresTestSuiteFilesExist, selectPostgresTestSuite } = await loadSuiteSelector();
  const suite = selectPostgresTestSuite(
    ["--suite", "synthetic-human-submit"],
    ["trusted-default.test.ts"],
    DEFAULT_TIMEOUT_MS
  );

  await assert.rejects(
    assertPostgresTestSuiteFilesExist(process.cwd(), suite),
    /Selected PostgreSQL test file does not exist: tests\/e2e\/synthetic-human-submit\.test\.ts; refusing database preparation\./
  );
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
  assert.equal(environment.DATABASE_URL, explicitUrl);
  assert.equal(environment.DIRECT_URL, explicitUrl);
  for (const key of [
    "TEST_DATABASE_URL",
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "SERPAPI_API_KEY",
    "THEIRSTACK_API_KEY",
    "USAJOBS_API_KEY",
    "WORKABLE_API_TOKEN",
    "CRON_SECRET",
    "AUTH_URL",
    "APP_BASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_SECRET",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "MOONSHOT_API_KEY",
    "SOME_FUTURE_UNKNOWN_SECRET"
  ]) {
    assert.equal(key in environment, false, key);
  }
  assert.equal(Object.values(environment).includes(inheritedSecret), false);
  assert.deepEqual(Object.keys(environment).sort(), [
    "AI_ENABLED",
    "AI_MOCK_MODE",
    "ALLOW_DEMO_USER",
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
