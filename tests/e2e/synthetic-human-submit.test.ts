import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type { PrismaClient } from "@prisma/client";
import {
  chromium,
  type Browser,
  type BrowserServer,
  type BrowserContext,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type Route
} from "playwright";

import {
  launchApplicationBrowserRuntimeWithLauncherForTest,
  type ApplicationBrowserRuntime
} from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { createApplicationFormInspectionController } from "@/lib/application-browser/form-inspection-controller";
import { createSameOriginClient } from "@/lib/application-browser/same-origin-client";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status
} from "@/lib/application-browser/types";
import { runApplicationBrowserCompanion } from "@/scripts/application-browser-companion";
import {
  startNextTestServer,
  type NextTestServer
} from "@/tests/browser/next-test-server";
import {
  POSTGRES_TEST_STATEMENT_TIMEOUT,
  createPostgresTestActor,
  disconnectPostgresTestActors
} from "@/tests/postgres/postgres-test-harness";

import {
  SYNTHETIC_EMPLOYER_NAME,
  SYNTHETIC_EMPLOYER_ROLE,
  SYNTHETIC_EMPLOYER_TARGET_URL,
  armSyntheticHumanSubmission,
  assertNoSyntheticEmployerSubmission,
  readSyntheticEmployerSnapshot,
  renderSyntheticEmployerFixture,
  type SyntheticEmployerSnapshot
} from "./synthetic-employer-fixture";
import {
  SyntheticCleanupStack,
  acquireCleanupOwnedResource,
  assertSyntheticCleanupOutcome,
  buildSyntheticDiagnosticArtifactPath,
  buildSyntheticDiagnosticSummary,
  buildSyntheticWorkflowChildEnvironment,
  classifySyntheticWorkflowUrl,
  countSyntheticWorkflowRequest,
  createSyntheticWorkflowRequestCounters,
  deleteSyntheticWorkflowRateLimitRows,
  remainingSyntheticDatabaseStatementTimeoutMs,
  runEngineBoundDatabaseCleanup,
  runWithPreRegisteredCleanup,
  type SyntheticWorkflowRequestCounters
} from "./synthetic-workflow-harness";

const TEST_TIMEOUT_MS = 90_000;
const OPERATION_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 50;
const CLEANUP_OUTER_TIMEOUT_MS = 15_000;
const BROWSER_PREFERRED_CLEANUP_TIMEOUT_MS = 9_000;
const BROWSER_GRACEFUL_CLEANUP_TIMEOUT_MS = 2_000;
const BROWSER_FORCE_CLEANUP_TIMEOUT_MS = 2_000;
const CLEANUP_SCHEDULING_MARGIN_MS = 1_000;
const DATABASE_TRANSACTION_TIMEOUT_MS = 7_000;
const DATABASE_STATEMENT_CANCELLATION_GRACE_MS = 250;
const DATABASE_AGGREGATE_CLEANUP_TIMEOUT_MS = 8_000;
const DATABASE_DISCONNECT_TIMEOUT_MS = 3_000;
const SYNTHETIC_USER_ID = "synthetic-human-submit-user";
const SYNTHETIC_APPLICATION_IDEMPOTENCY_KEY = "synthetic-human-submit-v1";
const EXISTING_PROFILE_SENTINEL = "https://existing-profile.example.test/alex";
const PERSONAL_SUBMISSION_ATTESTATION = "USER_PERSONALLY_SUBMITTED_ON_EMPLOYER_SITE";

type JsonRecord = Record<string, unknown>;
type CompanionDependencies = NonNullable<Parameters<typeof runApplicationBrowserCompanion>[1]>;
type CoordinatorExecute = (command: B1Command, assertActive: () => void) => Promise<B1Status>;

type RequestSummary = {
  fillAcquisitionCount: number;
  fillFinalizationCount: number;
  fillRecoveryCount: number;
  completionRequestCount: number;
  fillAcquisitionBodies: string[];
  fillFinalizationBodies: string[];
  completionBodies: string[];
  rejectedBrowserUrls: string[];
};

type SyntheticSubmissionObservation = Readonly<{
  method: string;
  contentType: string | undefined;
  body: string | null;
}>;

type SyntheticOwnedBrowserRuntime = Readonly<{
  runtime: ApplicationBrowserRuntime;
  connectedBrowser: Browser;
  server: BrowserServer;
  process: ChildProcess;
}>;

type DiagnosticState = {
  phase: string;
  runState: string | null;
  runStateVersion: number | null;
  inspectionVersion: number | null;
  packetVersion: number | null;
  hasFillAttempt: boolean;
  fillResultCounts: {
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    manual: number;
  };
  hasCompletedAt: boolean;
  applicationStatus: string | null;
  hasDateApplied: boolean;
  controlUrl: string | null;
  targetUrl: string | null;
};

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  assert.ok(Array.isArray(value), `${label} must be an array.`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

async function responseJson(response: Response, label: string): Promise<JsonRecord> {
  const value = await response.json();
  return record(value, label);
}

async function requireSuccessfulJson(url: string, label: string): Promise<JsonRecord> {
  const response = await fetch(url, { cache: "no-store" });
  assert.equal(response.status, 200, `${label} status`);
  return responseJson(response, label);
}

async function readOwnerRun(origin: string, runId: string): Promise<JsonRecord> {
  const value = await requireSuccessfulJson(
    `${origin}/api/application-runs/${encodeURIComponent(runId)}`,
    "owner-scoped ApplicationRun response"
  );
  return record(value.run, "owner-scoped ApplicationRun");
}

async function readOwnerPacket(origin: string, runId: string): Promise<JsonRecord> {
  const value = await requireSuccessfulJson(
    `${origin}/api/application-runs/${encodeURIComponent(runId)}/answer-packet`,
    "owner-scoped answer-packet response"
  );
  assert.equal(value.runId, runId);
  return record(value.current, "current answer packet");
}

async function readOwnerFillStatus(origin: string, runId: string): Promise<JsonRecord> {
  return requireSuccessfulJson(
    `${origin}/api/application-runs/${encodeURIComponent(runId)}/fill-attempt`,
    "owner-scoped Fill status response"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForValue<T>(
  label: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = OPERATION_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${label}.`);
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function redactDiagnosticText(value: string, databaseUrl: string): string {
  return value
    .split(databaseUrl).join("[REDACTED_DATABASE_URL]")
    .replace(/postgres(?:ql)?:\/\/[^\s'\"]+/gi, "[REDACTED_DATABASE_URL]")
    .slice(-65_536);
}

function browserProcessHasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function syntheticBrowserRuntimeIsClosed(resource: SyntheticOwnedBrowserRuntime): boolean {
  return browserProcessHasExited(resource.process) && !resource.connectedBrowser.isConnected();
}

async function launchSyntheticOwnedBrowserRuntime(): Promise<SyntheticOwnedBrowserRuntime> {
  const server = await chromium.launchServer({ headless: false, host: "127.0.0.1" });
  const process = server.process();
  let connectedBrowser: Browser | undefined;
  try {
    const runtime = await launchApplicationBrowserRuntimeWithLauncherForTest({
      async launch(options) {
        assert.equal(options.headless, false);
        connectedBrowser = await chromium.connect(server.wsEndpoint());
        return connectedBrowser;
      }
    });
    assert.ok(connectedBrowser, "The synthetic runtime must retain its connected browser owner.");
    return Object.freeze({ runtime, connectedBrowser, server, process });
  } catch (error) {
    let killFailure: unknown;
    try {
      if (!browserProcessHasExited(process)) await server.kill();
    } catch (killError) {
      killFailure = killError;
    }
    if (killFailure !== undefined) {
      throw new AggregateError(
        [error, killFailure],
        "Synthetic browser acquisition and exact process cleanup both failed.",
        { cause: error }
      );
    }
    throw error;
  }
}

async function seedSyntheticPrerequisites(client: PrismaClient): Promise<{ applicationId: string }> {
  await client.user.create({
    data: {
      id: SYNTHETIC_USER_ID,
      name: "Alex Example",
      email: "alex.example@example.test",
      profile: {
        create: {
          careerGoals: "Synthetic customer success engineering role.",
          preferredRoles: [SYNTHETIC_EMPLOYER_ROLE],
          preferredLocations: ["Remote"],
          industriesOfInterest: ["Synthetic software"],
          dealBreakers: [],
          skillsToEmphasize: ["TypeScript"],
          skillsNotToExaggerate: []
        }
      }
    }
  });

  await client.applicationAutomationPolicy.create({
    data: {
      userId: SYNTHETIC_USER_ID,
      enabled: true,
      mode: "FILL_AND_REVIEW",
      minimumFitScore: 90,
      minimumConfidenceScore: 90,
      allowedHosts: ["employer.example.test"],
      blockedHosts: [],
      permittedAdapters: [],
      coverLetterRequired: false,
      sensitiveAnswerPolicy: "EXCLUDE",
      finalReviewRequired: true
    }
  });

  const jobPosting = await client.jobPosting.create({
    data: {
      userId: SYNTHETIC_USER_ID,
      title: SYNTHETIC_EMPLOYER_ROLE,
      normalizedTitle: "synthetic-customer-success-engineer",
      company: SYNTHETIC_EMPLOYER_NAME,
      normalizedCompany: "example-systems",
      location: "Remote",
      normalizedLocation: "remote",
      remoteStatus: "REMOTE",
      sourceUrl: SYNTHETIC_EMPLOYER_TARGET_URL,
      applyUrl: SYNTHETIC_EMPLOYER_TARGET_URL,
      normalizedApplyUrl: SYNTHETIC_EMPLOYER_TARGET_URL,
      description: "Synthetic role requiring verified TypeScript experience.",
      requirements: ["TypeScript"],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: ["TypeScript"],
      sourceType: "MANUAL",
      overallFitScore: 95,
      confidenceScore: 95,
      missingKeywords: [],
      supportedKeywords: ["TypeScript"],
      concerns: []
    },
    select: { id: true }
  });

  const resumeVersion = await client.resumeVersion.create({
    data: {
      userId: SYNTHETIC_USER_ID,
      jobPostingId: jobPosting.id,
      title: "Alex Example — Synthetic Resume",
      summary: "Synthetic candidate with verified TypeScript experience.",
      skills: ["TypeScript"],
      fullText: "Alex Example has verified TypeScript experience."
    },
    select: { id: true }
  });

  const application = await client.application.create({
    data: {
      userId: SYNTHETIC_USER_ID,
      jobPostingId: jobPosting.id,
      resumeVersionId: resumeVersion.id,
      status: "SAVED",
      dateApplied: null
    },
    select: { id: true }
  });

  await client.applicationAnswer.createMany({
    data: [
      {
        userId: SYNTHETIC_USER_ID,
        category: "LINKS",
        question: "Portfolio URL",
        normalizedQuestion: "portfolio-url",
        answer: "https://portfolio.example.test/alex"
      },
      {
        userId: SYNTHETIC_USER_ID,
        category: "LINKS",
        question: "LinkedIn profile URL",
        normalizedQuestion: "profile-url",
        answer: "https://profile.example.test/alex"
      },
      {
        userId: SYNTHETIC_USER_ID,
        category: "AVAILABILITY",
        question: "When can you start?",
        normalizedQuestion: "when-can-you-start",
        answer: "Two weeks after a signed offer."
      }
    ]
  });

  return { applicationId: application.id };
}

function answerByQuestion(packet: JsonRecord, question: string): JsonRecord {
  const answer = records(packet.answers, "answer-packet answers")
    .find((candidate) => candidate.question === question);
  assert.ok(answer, `Expected answer-packet field ${question}.`);
  return answer;
}

function countFillResults(steps: JsonRecord[]): Readonly<{
  FILLED: number;
  PRESERVED_EXISTING: number;
  MANUAL: number;
  FAILED: number;
  NOT_ATTEMPTED: number;
}> {
  const counts = {
    FILLED: 0,
    PRESERVED_EXISTING: 0,
    MANUAL: 0,
    FAILED: 0,
    NOT_ATTEMPTED: 0
  };
  for (const step of steps) {
    const result = step.result;
    assert.ok(typeof result === "string" && result in counts, "Unexpected Fill step result.");
    counts[result as keyof typeof counts] += 1;
  }
  return counts;
}

async function captureFailureArtifacts(input: Readonly<{
  repositoryRoot: string;
  databaseUrl: string;
  nextServer: NextTestServer | null;
  controlPage: Page | null;
  employerPage: Page | null;
  diagnostic: DiagnosticState;
  fixtureSnapshot: SyntheticEmployerSnapshot | null;
  networkCounters: SyntheticWorkflowRequestCounters;
  requestSummary: RequestSummary;
  fillSummary: JsonRecord | null;
  browserConsole: readonly JsonRecord[];
  pageErrors: readonly JsonRecord[];
  companionLog: string;
}>): Promise<void> {
  const statePath = buildSyntheticDiagnosticArtifactPath("state-summary.json", input.repositoryRoot);
  const artifactDirectory = path.dirname(statePath);
  await mkdir(artifactDirectory, { recursive: true });

  const writes: Promise<unknown>[] = [
    writeFile(statePath, `${JSON.stringify(buildSyntheticDiagnosticSummary(input.diagnostic), null, 2)}\n`, "utf8"),
    writeFile(
      buildSyntheticDiagnosticArtifactPath("fixture-counters.json", input.repositoryRoot),
      `${JSON.stringify(input.fixtureSnapshot, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      buildSyntheticDiagnosticArtifactPath("request-summary.json", input.repositoryRoot),
      `${JSON.stringify({ networkCounters: input.networkCounters, ...input.requestSummary }, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      buildSyntheticDiagnosticArtifactPath("fill-summary.json", input.repositoryRoot),
      `${JSON.stringify(input.fillSummary, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      buildSyntheticDiagnosticArtifactPath("browser-console.json", input.repositoryRoot),
      `${JSON.stringify(input.browserConsole, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      buildSyntheticDiagnosticArtifactPath("page-errors.json", input.repositoryRoot),
      `${JSON.stringify(input.pageErrors, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      path.join(artifactDirectory, "next-server.log"),
      redactDiagnosticText(input.nextServer?.getLogs() ?? "", input.databaseUrl),
      "utf8"
    ),
    writeFile(
      path.join(artifactDirectory, "companion.log"),
      redactDiagnosticText(input.companionLog, input.databaseUrl),
      "utf8"
    )
  ];

  if (input.controlPage && !input.controlPage.isClosed()) {
    writes.push(input.controlPage.screenshot({
      path: path.join(artifactDirectory, "apply-pilot-control.png"),
      fullPage: true
    }));
  }
  if (input.employerPage && !input.employerPage.isClosed()) {
    writes.push(input.employerPage.screenshot({
      path: path.join(artifactDirectory, "synthetic-employer.png"),
      fullPage: true
    }));
  }

  await Promise.allSettled(writes);
}

test("production ApplicationRun reaches Human-Submit completion only after both human actions", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  const cleanup = new SyntheticCleanupStack({ perCleanupTimeoutMs: CLEANUP_OUTER_TIMEOUT_MS });
  const repositoryRoot = process.cwd();
  const requestSummary: RequestSummary = {
    fillAcquisitionCount: 0,
    fillFinalizationCount: 0,
    fillRecoveryCount: 0,
    completionRequestCount: 0,
    fillAcquisitionBodies: [],
    fillFinalizationBodies: [],
    completionBodies: [],
    rejectedBrowserUrls: []
  };
  const diagnostic: DiagnosticState = {
    phase: "SETUP",
    runState: null,
    runStateVersion: null,
    inspectionVersion: null,
    packetVersion: null,
    hasFillAttempt: false,
    fillResultCounts: { attempted: 0, succeeded: 0, failed: 0, skipped: 0, manual: 0 },
    hasCompletedAt: false,
    applicationStatus: null,
    hasDateApplied: false,
    controlUrl: null,
    targetUrl: null
  };
  const browserConsole: JsonRecord[] = [];
  const pageErrors: JsonRecord[] = [];
  let networkCounters = createSyntheticWorkflowRequestCounters();
  let nextServer: NextTestServer | null = null;
  let runtime: ApplicationBrowserRuntime | null = null;
  let controlPage: Page | null = null;
  let employerPage: Page | null = null;
  let targetController: ReturnType<typeof createPlaywrightTargetController> | null = null;
  let capturedCloseExecution: CoordinatorExecute | null = null;
  let companionPromise: Promise<void> | null = null;
  let companionSettled = false;
  let companionFailure: unknown;
  let companionLog = "";
  let fixtureSnapshot: SyntheticEmployerSnapshot | null = null;
  let fillSummary: JsonRecord | null = null;
  let runId: string | null = null;
  let primaryFailure: unknown;
  let validatedDatabaseUrl = "";

  try {
    const actor = await createPostgresTestActor("synthetic-human-submit");
    cleanup.add("disconnect-postgres-actor", () => disconnectPostgresTestActors([actor]));

    const fixture = await runWithPreRegisteredCleanup(
      cleanup,
      "delete-synthetic-user",
      (signal) => runEngineBoundDatabaseCleanup(
        signal,
        (transactionTimeoutMs, statementCancellationTimeoutMs) =>
          actor.client.$transaction(async (transaction) => {
            const statementDeadlineAtMs = Date.now() + statementCancellationTimeoutMs;
            const runBoundedMutation = async (operation: () => Promise<unknown>): Promise<void> => {
              const remainingMs = remainingSyntheticDatabaseStatementTimeoutMs(statementDeadlineAtMs);
              await transaction.$executeRawUnsafe(
                `SET LOCAL statement_timeout = '${remainingMs}ms'`
              );
              await operation();
              await transaction.$executeRawUnsafe(
                `SET LOCAL statement_timeout = '${POSTGRES_TEST_STATEMENT_TIMEOUT}'`
              );
            };

            await runBoundedMutation(() => transaction.auditLog.deleteMany({
              where: {
                OR: [
                  { userId: SYNTHETIC_USER_ID },
                  ...(runId === null ? [] : [{ resourceId: runId }])
                ]
              }
            }));
            await runBoundedMutation(() => deleteSyntheticWorkflowRateLimitRows(
              transaction.rateLimitBucket,
              SYNTHETIC_USER_ID
            ));
            await runBoundedMutation(() => transaction.user.deleteMany({
              where: { id: { in: [SYNTHETIC_USER_ID] } }
            }));
          }, {
            maxWait: 250,
            timeout: transactionTimeoutMs
          }),
        () => disconnectPostgresTestActors([actor], DATABASE_DISCONNECT_TIMEOUT_MS),
        {
          transactionTimeoutMs: DATABASE_TRANSACTION_TIMEOUT_MS,
          statementCancellationGraceMs: DATABASE_STATEMENT_CANCELLATION_GRACE_MS,
          aggregateTimeoutMs: DATABASE_AGGREGATE_CLEANUP_TIMEOUT_MS,
          disconnectTimeoutMs: DATABASE_DISCONNECT_TIMEOUT_MS,
          schedulingMarginMs: CLEANUP_SCHEDULING_MARGIN_MS,
          outerTimeoutMs: CLEANUP_OUTER_TIMEOUT_MS
        }
      ),
      () => seedSyntheticPrerequisites(actor.client)
    );

    const seededIdentity = await actor.client.user.findUniqueOrThrow({
      where: { id: SYNTHETIC_USER_ID },
      select: {
        id: true,
        name: true,
        email: true,
        profile: {
          select: {
            careerGoals: true,
            preferredRoles: true,
            preferredLocations: true,
            industriesOfInterest: true,
            dealBreakers: true,
            skillsToEmphasize: true,
            skillsNotToExaggerate: true
          }
        }
      }
    });

    validatedDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";
    assert.ok(validatedDatabaseUrl, "The guarded runner must provide TEST_DATABASE_URL.");
    const nextEnvironment = buildSyntheticWorkflowChildEnvironment(validatedDatabaseUrl);
    assert.equal(nextEnvironment.DEFAULT_DEMO_USER_ID, SYNTHETIC_USER_ID);
    assert.equal(nextEnvironment.APPLICATION_AUTOMATION_ENABLED, "true");
    assert.equal(nextEnvironment.AI_ENABLED, "false");
    assert.equal(nextEnvironment.AI_MOCK_MODE, "true");
    assert.equal(nextEnvironment.OPENAI_MOCK_MODE, "true");
    nextServer = await startNextTestServer({ environment: nextEnvironment, readinessPath: "/" });
    const acquiredNextServer = nextServer;
    cleanup.add("stop-next-server", () => acquiredNextServer.stop());

    diagnostic.phase = "CREATE_RUN";
    const creationResponse = await fetch(`${nextServer.origin}/api/application-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        applicationId: fixture.applicationId,
        idempotencyKey: SYNTHETIC_APPLICATION_IDEMPOTENCY_KEY
      })
    });
    assert.equal(creationResponse.status, 201);
    const creation = await responseJson(creationResponse, "ApplicationRun creation response");
    assert.equal(creation.replayed, false);
    const createdRun = record(creation.run, "created ApplicationRun");
    assert.equal(createdRun.state, "DRAFT");
    assert.equal(createdRun.applyUrlSnapshot, SYNTHETIC_EMPLOYER_TARGET_URL);
    assert.equal(createdRun.applyHost, "employer.example.test");
    assert.equal(typeof createdRun.id, "string");
    runId = createdRun.id as string;

    diagnostic.phase = "PREPARE_RUN";
    const preparationResponse = await fetch(
      `${nextServer.origin}/api/application-runs/${encodeURIComponent(runId)}/prepare`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    if (preparationResponse.status !== 200) {
      const responseBody = await preparationResponse.clone().json().catch(() => null);
      const persistedRun = await actor.client.applicationRun.findUnique({
        where: { id: runId },
        select: { id: true, userId: true, state: true }
      });
      assert.fail(`ApplicationRun preparation failed: ${JSON.stringify({
        status: preparationResponse.status,
        responseBody,
        persistedRun
      })}`);
    }
    const preparation = await responseJson(preparationResponse, "ApplicationRun preparation response");
    const preparedRun = record(preparation.run, "prepared ApplicationRun");
    assert.equal(preparedRun.state, "READY");
    const persistedPreparedRun = await actor.client.applicationRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        state: true,
        stateVersion: true,
        plannerProvider: true,
        plannerModel: true,
        applicationPlanSnapshot: true,
        requirementCatalogSnapshot: true,
        evidenceCatalogSnapshot: true,
        fillAttemptId: true,
        completedAt: true
      }
    });
    assert.equal(persistedPreparedRun.state, "READY");
    assert.equal(persistedPreparedRun.plannerProvider, "local");
    assert.equal(persistedPreparedRun.plannerModel, "heuristic-local");
    assert.notEqual(persistedPreparedRun.applicationPlanSnapshot, null);
    assert.notEqual(persistedPreparedRun.requirementCatalogSnapshot, null);
    assert.notEqual(persistedPreparedRun.evidenceCatalogSnapshot, null);
    assert.equal(persistedPreparedRun.fillAttemptId, null);
    assert.equal(persistedPreparedRun.completedAt, null);
    diagnostic.runState = persistedPreparedRun.state;
    diagnostic.runStateVersion = persistedPreparedRun.stateVersion;

    assert.deepEqual(
      await actor.client.user.findUniqueOrThrow({
        where: { id: SYNTHETIC_USER_ID },
        select: {
          id: true,
          name: true,
          email: true,
          profile: {
            select: {
              careerGoals: true,
              preferredRoles: true,
              preferredLocations: true,
              industriesOfInterest: true,
              dealBreakers: true,
              skillsToEmphasize: true,
              skillsNotToExaggerate: true
            }
          }
        }
      }),
      seededIdentity,
      "The demo-user fallback must not replace or mutate the preseeded synthetic identity."
    );

    diagnostic.phase = "START_COMPANION";
    const runtimeOwnership = await acquireCleanupOwnedResource(
      cleanup,
      "close-browser-runtime",
      () => launchSyntheticOwnedBrowserRuntime(),
      async (acquired) => {
        await acquired.runtime.close();
        await acquired.server.close();
      },
      {
        preferredCleanupTimeoutMs: BROWSER_PREFERRED_CLEANUP_TIMEOUT_MS,
        gracefulCleanupTimeoutMs: BROWSER_GRACEFUL_CLEANUP_TIMEOUT_MS,
        forceCleanupTimeoutMs: BROWSER_FORCE_CLEANUP_TIMEOUT_MS,
        schedulingMarginMs: CLEANUP_SCHEDULING_MARGIN_MS,
        forceCleanup: async (acquired) => {
          if (!browserProcessHasExited(acquired.process)) await acquired.server.kill();
        },
        verifyClosed: syntheticBrowserRuntimeIsClosed
      }
    );
    runtime = runtimeOwnership.resource.runtime;
    const acquiredRuntime = runtime;
    const context = runtime.context as BrowserContext;
    controlPage = runtime.controlPage as Page;
    const acquiredControlPage = controlPage;
    controlPage.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    diagnostic.controlUrl = controlPage.url();

    const registerPageDiagnostics = (page: Page): void => {
      page.on("console", (message) => {
        if (browserConsole.length >= 200) return;
        browserConsole.push({
          page: page === acquiredControlPage ? "CONTROL" : "EMPLOYER",
          type: message.type().slice(0, 32),
          text: message.text().slice(0, 1_000)
        });
      });
      page.on("pageerror", (error) => {
        if (pageErrors.length >= 100) return;
        pageErrors.push({
          page: page === acquiredControlPage ? "CONTROL" : "EMPLOYER",
          name: error.name.slice(0, 64),
          message: error.message.slice(0, 1_000)
        });
      });
    };
    registerPageDiagnostics(controlPage);
    context.on("page", registerPageDiagnostics);

    let resolveSyntheticSubmission!: (value: SyntheticSubmissionObservation) => void;
    const syntheticSubmissionObserved = new Promise<SyntheticSubmissionObservation>((resolve) => {
      resolveSyntheticSubmission = resolve;
    });
    let syntheticSubmissionResolved = false;
    const fulfillSyntheticSubmission = async (
      route: Route,
      request: PlaywrightRequest
    ): Promise<void> => {
      networkCounters = countSyntheticWorkflowRequest(
        networkCounters,
        classifySyntheticWorkflowUrl(request.url(), acquiredNextServer.origin)
      );
      const observation = Object.freeze({
        method: request.method(),
        contentType: request.headers()["content-type"],
        body: request.postData()
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: "{\"accepted\":true}"
      });
      if (!syntheticSubmissionResolved) {
        syntheticSubmissionResolved = true;
        resolveSyntheticSubmission(observation);
      }
    };

    await context.route("**/*", async (route, request) => {
      const classification = classifySyntheticWorkflowUrl(request.url(), acquiredNextServer.origin);
      if (classification.purpose === "SYNTHETIC_SUBMISSION") {
        await fulfillSyntheticSubmission(route, request);
        return;
      }
      if (classification.purpose === "SYNTHETIC_TARGET") {
        requestSummary.rejectedBrowserUrls.push(safeBrowserUrl(request.url()));
        networkCounters = countSyntheticWorkflowRequest(
          networkCounters,
          { allowed: false, purpose: "REJECTED" }
        );
        await route.abort("blockedbyclient");
        return;
      }
      networkCounters = countSyntheticWorkflowRequest(networkCounters, classification);
      if (!classification.allowed) {
        requestSummary.rejectedBrowserUrls.push(safeBrowserUrl(request.url()));
        await route.abort("blockedbyclient");
        return;
      }
      const completionUrl = `${acquiredNextServer.origin}/api/application-runs/${encodeURIComponent(runId as string)}/complete-by-user`;
      if (request.url() === completionUrl && request.method() === "POST") {
        requestSummary.completionRequestCount += 1;
        requestSummary.completionBodies.push(request.postData() ?? "");
      }
      await route.continue();
    });

    const dependencies: CompanionDependencies = {
      async launchRuntime() {
        return acquiredRuntime;
      },
      createClient(clientInput) {
        const fillAttemptUrl = `${acquiredNextServer.origin}/api/application-runs/${encodeURIComponent(runId as string)}/fill-attempt`;
        const countedRequestContext: typeof clientInput.requestContext = {
          get: (url, options) => clientInput.requestContext.get(url, options),
          post: (url, options) => {
            if (url === fillAttemptUrl) {
              requestSummary.fillAcquisitionCount += 1;
              requestSummary.fillAcquisitionBodies.push(options.data);
            }
            return clientInput.requestContext.post(url, options);
          },
          patch: (url, options) => {
            if (url === fillAttemptUrl) {
              let action: unknown;
              try {
                action = record(JSON.parse(options.data), "Fill PATCH body").action;
              } catch {
                action = null;
              }
              if (action === "FINALIZE") {
                requestSummary.fillFinalizationCount += 1;
                requestSummary.fillFinalizationBodies.push(options.data);
              } else if (action === "RECOVER_EXPIRED") {
                requestSummary.fillRecoveryCount += 1;
              }
            }
            return clientInput.requestContext.patch(url, options);
          }
        };
        return createSameOriginClient({ ...clientInput, requestContext: countedRequestContext });
      },
      createTargetController(targetInput) {
        const controller = createPlaywrightTargetController({
          ...targetInput,
          testOnlyFulfillMainDocument: async (request, route) => {
            const classification = classifySyntheticWorkflowUrl(
              request.url(),
              acquiredNextServer.origin
            );
            assert.deepEqual(classification, { allowed: true, purpose: "SYNTHETIC_TARGET" });
            assert.equal(request.url(), SYNTHETIC_EMPLOYER_TARGET_URL);
            assert.equal(request.isNavigationRequest(), true);
            assert.equal(request.resourceType(), "document");
            networkCounters = countSyntheticWorkflowRequest(networkCounters, classification);
            await route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: renderSyntheticEmployerFixture()
            });
          }
        });
        targetController = controller;
        return controller;
      },
      createFormInspectionController: createApplicationFormInspectionController,
      installBridge(bridgeInput) {
        capturedCloseExecution = bridgeInput.execute;
        return installControlBridge(bridgeInput);
      },
      writeOutput(message) {
        companionLog = `${companionLog}${message}`.slice(-16_384);
      }
    };

    companionPromise = runApplicationBrowserCompanion(
      ["--app-origin", nextServer.origin, "--run-id", runId],
      dependencies
    ).then(
      () => {
        companionSettled = true;
      },
      (error: unknown) => {
        companionSettled = true;
        companionFailure = error;
        throw error;
      }
    );
    void companionPromise.catch(() => undefined);

    runtimeOwnership.setPreferredCleanup(async () => {
      if (companionSettled) {
        return;
      }
      if (!acquiredControlPage.isClosed()) {
        const closeButton = acquiredControlPage.getByRole("button", {
          name: "Close workflow",
          exact: true
        });
        if (await closeButton.isVisible().catch(() => false) &&
            await closeButton.isEnabled().catch(() => false)) {
          await closeButton.click().catch(() => undefined);
          if (companionPromise) {
            await settleWithin(companionPromise, 8_000, "UI browser workflow close");
          }
          return;
        }
      }
      const closeExecution = capturedCloseExecution;
      if (closeExecution) {
        await settleWithin(
          closeExecution({ type: "CLOSE_WORKFLOW" }, () => undefined),
          5_000,
          "production browser workflow close"
        );
        if (companionPromise) {
          await settleWithin(companionPromise, 5_000, "application browser companion settlement");
        }
        return;
      }
    });

    const openButton = controlPage.getByRole("button", { name: "Open frozen target", exact: true });
    await openButton.waitFor({ state: "visible" });
    await waitForValue(
      "the real control bridge",
      () => controlPage?.evaluate(
        (name) => typeof (window as unknown as Record<string, unknown>)[name],
        APPLICATION_BROWSER_BINDING_NAME
      ),
      (value) => value === "function"
    );
    const refreshStatusButton = controlPage.getByRole("button", {
      name: "Refresh status",
      exact: true
    });
    assert.equal(await refreshStatusButton.isEnabled(), true);
    await refreshStatusButton.click();
    await waitForValue("Open frozen target UI authority", () => openButton.isEnabled(), Boolean);
    diagnostic.controlUrl = controlPage.url();

    diagnostic.phase = "OPEN_TARGET";
    await openButton.click();
    const openedEmployerPage = await waitForValue<Page | null>(
      "the production target controller page",
      () => targetController?.page() ?? null,
      (page) => page !== null
    );
    assert.ok(openedEmployerPage);
    employerPage = openedEmployerPage;
    assert.ok(employerPage);
    employerPage.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    diagnostic.targetUrl = employerPage.url();
    assert.equal(employerPage.url(), SYNTHETIC_EMPLOYER_TARGET_URL);
    assert.equal(await employerPage.opener(), null);
    assert.equal(
      await employerPage.evaluate(
        (name) => typeof (window as unknown as Record<string, unknown>)[name],
        APPLICATION_BROWSER_BINDING_NAME
      ),
      "undefined"
    );
    assert.equal(networkCounters.syntheticTargetRequestCount, 1);

    const acquiredEmployerPage = employerPage;
    await employerPage.route("**/*", async (route, request) => {
      const classification = classifySyntheticWorkflowUrl(request.url(), acquiredNextServer.origin);
      if (classification.purpose === "SYNTHETIC_SUBMISSION") {
        await fulfillSyntheticSubmission(route, request);
        return;
      }
      if (!classification.allowed) {
        networkCounters = countSyntheticWorkflowRequest(networkCounters, classification);
        requestSummary.rejectedBrowserUrls.push(safeBrowserUrl(request.url()));
        await route.abort("blockedbyclient");
        return;
      }
      if (classification.purpose === "SYNTHETIC_TARGET") {
        await route.fallback();
        return;
      }
      networkCounters = countSyntheticWorkflowRequest(networkCounters, classification);
      await route.continue();
    });

    fixtureSnapshot = await readSyntheticEmployerSnapshot(employerPage);
    assertNoSyntheticEmployerSubmission(
      fixtureSnapshot,
      networkCounters.syntheticSubmissionEndpointCount
    );

    diagnostic.phase = "INSPECT_FORM";
    const inspectButton = controlPage.getByRole("button", { name: "Inspect form", exact: true });
    await inspectButton.waitFor({ state: "visible" });
    assert.equal(await inspectButton.isEnabled(), true);
    await inspectButton.click();
    const inspectedRun = await waitForValue(
      "the durable REVIEW_REQUIRED inspection state",
      () => actor.client.applicationRun.findUniqueOrThrow({
        where: { id: runId as string },
        select: {
          state: true,
          stateVersion: true,
          currentFormInspectionVersion: true,
          currentAnswerPacketVersion: true
        }
      }),
      (value) => value.state === "REVIEW_REQUIRED" &&
        value.currentFormInspectionVersion > 0 &&
        value.currentAnswerPacketVersion > 0
    );
    diagnostic.runState = inspectedRun.state;
    diagnostic.runStateVersion = inspectedRun.stateVersion;
    diagnostic.inspectionVersion = inspectedRun.currentFormInspectionVersion;
    diagnostic.packetVersion = inspectedRun.currentAnswerPacketVersion;

    await controlPage.getByRole("heading", { name: "Portfolio URL", exact: true })
      .waitFor({ state: "visible" });
    const packet = await readOwnerPacket(nextServer.origin, runId);
    assert.equal(packet.inspectionVersion, inspectedRun.currentFormInspectionVersion);
    assert.equal(packet.answerPacketVersion, inspectedRun.currentAnswerPacketVersion);
    assert.equal(packet.reviewedAt, null);
    const packetSummary = record(packet.summary, "answer-packet summary");
    assert.deepEqual({
      fieldCount: packetSummary.fieldCount,
      proposableCount: packetSummary.proposableCount,
      pendingReviewCount: packetSummary.pendingReviewCount,
      manualOnlyCount: packetSummary.manualOnlyCount,
      manualRequiredCount: packetSummary.manualRequiredCount,
      readyForRunResolution: packetSummary.readyForRunResolution
    }, {
      fieldCount: 4,
      proposableCount: 3,
      pendingReviewCount: 3,
      manualOnlyCount: 1,
      manualRequiredCount: 1,
      readyForRunResolution: false
    });

    const expectedProposals = [
      {
        question: "Portfolio URL",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        value: "https://portfolio.example.test/alex"
      },
      {
        question: "LinkedIn profile URL",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        value: "https://profile.example.test/alex"
      },
      {
        question: "When can you start?",
        fieldType: "TEXTAREA",
        classification: "AVAILABILITY",
        value: "Two weeks after a signed offer."
      }
    ] as const;
    for (const expected of expectedProposals) {
      const answer = answerByQuestion(packet, expected.question);
      assert.equal(answer.fieldType, expected.fieldType);
      assert.equal(answer.classification, expected.classification);
      assert.equal(answer.disposition, "PROPOSABLE");
      assert.equal(answer.status, "PENDING");
      assert.equal(answer.requiresReview, true);
      assert.deepEqual(answer.proposal, { kind: "SCALAR", value: expected.value });
    }
    const manualAnswer = answerByQuestion(
      packet,
      "I certify that I reviewed this synthetic application"
    );
    assert.equal(manualAnswer.fieldType, "CHECKBOX_BOOLEAN");
    assert.equal(manualAnswer.classification, "LEGAL_ATTESTATION");
    assert.equal(manualAnswer.disposition, "MANUAL_ONLY");
    assert.equal(manualAnswer.dispositionReason, "LEGAL_ATTESTATION");
    assert.equal(manualAnswer.proposal, null);
    await controlPage.getByRole("heading", { name: "Manual fields", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(
      await controlPage.getByText(
        "I certify that I reviewed this synthetic application",
        { exact: true }
      ).first().isVisible(),
      true
    );

    diagnostic.phase = "REVIEW_ANSWERS";
    for (const expected of expectedProposals) {
      const answer = answerByQuestion(packet, expected.question);
      const article = controlPage.locator("article").filter({
        has: controlPage.getByRole("heading", { name: expected.question, exact: true })
      });
      const approveButton: Locator = controlPage.getByRole("button", {
        name: `Approve proposed answer for ${expected.question}`,
        exact: true
      });
      assert.equal(await approveButton.isEnabled(), true);
      await approveButton.click();
      await article.getByText("APPROVED", { exact: true }).waitFor({ state: "visible" });
      await waitForValue(
        `the durable APPROVED status for ${expected.question}`,
        () => actor.client.applicationRunAnswer.findUniqueOrThrow({
          where: { id: answer.id as string },
          select: { status: true, reviewedByUser: true, reviewedAt: true }
        }),
        (value) => value.status === "APPROVED" &&
          value.reviewedByUser &&
          value.reviewedAt !== null
      );
    }

    diagnostic.phase = "RESOLVE_REVIEW";
    const resolveReview = controlPage.getByRole("button", { name: "Resolve review", exact: true });
    await waitForValue("Resolve review UI authority", () => resolveReview.isEnabled(), Boolean);
    await resolveReview.click();
    await controlPage.getByText("Review resolved.", { exact: true }).waitFor({ state: "visible" });
    const resolvedRun = await waitForValue(
      "the durable READY review resolution",
      () => actor.client.applicationRun.findUniqueOrThrow({
        where: { id: runId as string },
        select: {
          state: true,
          stateVersion: true,
          reviewAcknowledgedAt: true,
          fillAttemptId: true,
          completedAt: true
        }
      }),
      (value) => value.state === "READY"
    );
    const reviewedPacket = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: {
        runId_version: {
          runId,
          version: inspectedRun.currentAnswerPacketVersion
        }
      },
      select: { reviewedAt: true }
    });
    assert.notEqual(reviewedPacket.reviewedAt, null);
    assert.equal(resolvedRun.fillAttemptId, null);
    assert.equal(resolvedRun.completedAt, null);
    diagnostic.runState = resolvedRun.state;
    diagnostic.runStateVersion = resolvedRun.stateVersion;

    diagnostic.phase = "PRE_FILL";
    const fillButton = controlPage.getByRole("button", {
      name: "Fill approved fields",
      exact: true
    });
    await waitForValue("explicit Fill UI authority", () => fillButton.isEnabled(), Boolean);
    fixtureSnapshot = await readSyntheticEmployerSnapshot(employerPage);
    assertNoSyntheticEmployerSubmission(
      fixtureSnapshot,
      networkCounters.syntheticSubmissionEndpointCount
    );
    assert.equal(await employerPage.getByLabel(
      "I certify that I reviewed this synthetic application",
      { exact: true }
    ).isChecked(), false);
    assert.equal(requestSummary.fillAcquisitionCount, 0);
    assert.equal(requestSummary.fillFinalizationCount, 0);
    assert.equal(requestSummary.completionRequestCount, 0);

    diagnostic.phase = "FILL";
    await fillButton.click();
    await controlPage.getByRole("heading", {
      name: "Automated Fill attempt finished",
      exact: true
    }).waitFor({ state: "visible" });
    const filledRun = await waitForValue(
      "the durable READY_FOR_USER_SUBMISSION Fill result",
      () => actor.client.applicationRun.findUniqueOrThrow({
        where: { id: runId as string },
        select: {
          state: true,
          stateVersion: true,
          fillAttemptId: true,
          fillLeaseExpiresAt: true,
          completedAt: true
        }
      }),
      (value) => value.state === "READY_FOR_USER_SUBMISSION" &&
        value.fillAttemptId !== null &&
        value.fillLeaseExpiresAt === null
    );
    assert.equal(requestSummary.fillAcquisitionCount, 1);
    assert.equal(requestSummary.fillFinalizationCount, 1);
    assert.equal(requestSummary.fillRecoveryCount, 0);
    const permanentFillAttemptId = filledRun.fillAttemptId;
    assert.ok(permanentFillAttemptId);
    assert.equal(filledRun.completedAt, null);
    diagnostic.runState = filledRun.state;
    diagnostic.runStateVersion = filledRun.stateVersion;
    diagnostic.hasFillAttempt = true;

    fillSummary = await readOwnerFillStatus(nextServer.origin, runId);
    assert.equal(fillSummary.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(fillSummary.fillAttemptId, permanentFillAttemptId);
    assert.equal(fillSummary.fillLeaseExpiresAt, null);
    assert.equal(fillSummary.outcome, "COMPLETED");
    assert.equal(fillSummary.errorCode, null);
    const fillSteps = records(fillSummary.steps, "durable Fill steps");
    const fillCounts = countFillResults(fillSteps);
    assert.deepEqual(fillCounts, {
      FILLED: 2,
      PRESERVED_EXISTING: 1,
      MANUAL: 0,
      FAILED: 0,
      NOT_ATTEMPTED: 0
    });
    diagnostic.fillResultCounts = {
      attempted: fillSteps.length,
      succeeded: fillCounts.FILLED,
      failed: fillCounts.FAILED,
      skipped: fillCounts.PRESERVED_EXISTING,
      manual: fillCounts.MANUAL
    };

    assert.equal(
      await employerPage.getByLabel("Portfolio URL", { exact: true }).inputValue(),
      "https://portfolio.example.test/alex"
    );
    assert.equal(
      await employerPage.getByLabel("LinkedIn profile URL", { exact: true }).inputValue(),
      EXISTING_PROFILE_SENTINEL
    );
    assert.equal(
      await employerPage.getByLabel("When can you start?", { exact: true }).inputValue(),
      "Two weeks after a signed offer."
    );
    assert.equal(await employerPage.getByLabel(
      "I certify that I reviewed this synthetic application",
      { exact: true }
    ).isChecked(), false);

    fixtureSnapshot = await readSyntheticEmployerSnapshot(employerPage);
    assertNoSyntheticEmployerSubmission(
      fixtureSnapshot,
      networkCounters.syntheticSubmissionEndpointCount
    );
    assert.equal(employerPage.url(), SYNTHETIC_EMPLOYER_TARGET_URL);
    assert.equal(await fillButton.isDisabled(), true);
    assert.equal(requestSummary.fillAcquisitionCount, 1);
    assert.equal(requestSummary.fillFinalizationCount, 1);

    const applicationBeforeHuman = await actor.client.application.findUniqueOrThrow({
      where: { id: fixture.applicationId },
      select: { status: true, dateApplied: true }
    });
    assert.equal(applicationBeforeHuman.status, "SAVED");
    assert.equal(applicationBeforeHuman.dateApplied, null);
    assert.equal(await actor.client.auditLog.count({
      where: {
        userId: SYNTHETIC_USER_ID,
        action: "application-run.complete-by-user",
        resourceId: runId
      }
    }), 0);
    assert.equal(await actor.client.applicationEvent.count({
      where: {
        userId: SYNTHETIC_USER_ID,
        applicationId: fixture.applicationId,
        type: "STATUS_CHANGED",
        title: "Personal submission recorded"
      }
    }), 0);
    assert.equal(requestSummary.completionRequestCount, 0);

    diagnostic.phase = "HUMAN_MANUAL_FIELD";
    // HUMAN ACTION — SYNTHETIC EMPLOYER MANUAL FIELD
    await employerPage.getByLabel(
      "I certify that I reviewed this synthetic application",
      { exact: true }
    ).check();
    assert.equal(await employerPage.getByLabel(
      "I certify that I reviewed this synthetic application",
      { exact: true }
    ).isChecked(), true);
    assert.equal(
      (await actor.client.applicationRun.findUniqueOrThrow({
        where: { id: runId },
        select: { state: true }
      })).state,
      "READY_FOR_USER_SUBMISSION"
    );

    diagnostic.phase = "HUMAN_EMPLOYER_SUBMIT";
    // HUMAN ACTION — SYNTHETIC EMPLOYER SUBMIT
    await armSyntheticHumanSubmission(employerPage);
    await employerPage.getByRole("button", {
      name: "Submit synthetic application",
      exact: true
    }).click();
    const submissionObservation = await settleWithin(
      syntheticSubmissionObserved,
      OPERATION_TIMEOUT_MS,
      "the one-shot synthetic employer endpoint"
    );
    fixtureSnapshot = await waitForValue(
      "the synthetic employer submission response",
      () => readSyntheticEmployerSnapshot(acquiredEmployerPage),
      (snapshot) => snapshot.submissionRequestState === "SUCCEEDED"
    );
    assert.deepEqual(fixtureSnapshot, {
      submitEventCount: 1,
      submitControlClickCount: 1,
      requestSubmitCallCount: 0,
      formSubmitCallCount: 0,
      formDataEventCount: 1,
      mainFrameNavigationCount: 0,
      popupCount: 0,
      humanStepArmed: false,
      lastSubmitClickWasTrusted: true,
      violationCount: 0,
      submissionRequestState: "SUCCEEDED"
    });
    assert.equal(networkCounters.syntheticSubmissionEndpointCount, 1);
    assert.deepEqual(submissionObservation, {
      method: "POST",
      contentType: "application/json",
      body: "{\"submission\":\"synthetic-human-submit-v1\"}"
    });
    assert.equal(employerPage.url(), SYNTHETIC_EMPLOYER_TARGET_URL);

    diagnostic.phase = "EMPLOYER_SUBMIT_NEGATIVE_PROOF";
    const afterEmployerSubmitRun = await actor.client.applicationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { state: true, completedAt: true, fillAttemptId: true }
    });
    assert.equal(afterEmployerSubmitRun.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(afterEmployerSubmitRun.completedAt, null);
    assert.equal(afterEmployerSubmitRun.fillAttemptId, permanentFillAttemptId);
    assert.deepEqual(
      await actor.client.application.findUniqueOrThrow({
        where: { id: fixture.applicationId },
        select: { status: true, dateApplied: true }
      }),
      { status: "SAVED", dateApplied: null }
    );
    assert.equal(await actor.client.auditLog.count({
      where: {
        userId: SYNTHETIC_USER_ID,
        action: "application-run.complete-by-user",
        resourceId: runId
      }
    }), 0);
    assert.equal(await actor.client.applicationEvent.count({
      where: {
        userId: SYNTHETIC_USER_ID,
        applicationId: fixture.applicationId,
        type: "STATUS_CHANGED",
        title: "Personal submission recorded"
      }
    }), 0);
    assert.equal(requestSummary.completionRequestCount, 0);

    diagnostic.phase = "PERSONAL_SUBMISSION_STEP_ONE";
    await controlPage.bringToFront();
    const personalSubmissionButton = controlPage.getByRole("button", {
      name: "I personally submitted this application",
      exact: true
    });
    await personalSubmissionButton.waitFor({ state: "visible" });
    assert.equal(await personalSubmissionButton.isEnabled(), true);
    await personalSubmissionButton.click();
    await controlPage.getByText(
      "Confirm only if you personally submitted on the employer site. This records your attestation; it does not verify the employer's submission result.",
      { exact: true }
    ).waitFor({ state: "visible" });
    assert.equal(requestSummary.completionRequestCount, 0);
    assert.equal((await readOwnerRun(nextServer.origin, runId)).state, "READY_FOR_USER_SUBMISSION");

    diagnostic.phase = "PERSONAL_SUBMISSION_STEP_TWO";
    const confirmPersonalSubmission = controlPage.getByRole("button", {
      name: "Confirm personal submission",
      exact: true
    });
    assert.equal(await confirmPersonalSubmission.isEnabled(), true);
    await confirmPersonalSubmission.click();
    await controlPage.getByText("Personal submission recorded", { exact: true })
      .waitFor({ state: "visible" });
    assert.equal(requestSummary.completionRequestCount, 1);
    assert.deepEqual(requestSummary.completionBodies, [
      JSON.stringify({ attestation: PERSONAL_SUBMISSION_ATTESTATION })
    ]);

    diagnostic.phase = "TERMINAL_ASSERTIONS";
    const terminalRunApi = await readOwnerRun(nextServer.origin, runId);
    assert.equal(terminalRunApi.state, "COMPLETED_BY_USER");
    assert.equal(typeof terminalRunApi.completedAt, "string");
    const terminalRun = await actor.client.applicationRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        state: true,
        stateVersion: true,
        completedAt: true,
        activeRunKey: true,
        fillAttemptId: true,
        fillLeaseExpiresAt: true
      }
    });
    assert.equal(terminalRun.state, "COMPLETED_BY_USER");
    assert.notEqual(terminalRun.completedAt, null);
    assert.equal(terminalRun.activeRunKey, null);
    assert.equal(terminalRun.fillLeaseExpiresAt, null);
    assert.equal(terminalRun.fillAttemptId, permanentFillAttemptId);
    assert.equal(terminalRunApi.completedAt, terminalRun.completedAt?.toISOString());

    const terminalApplication = await actor.client.application.findUniqueOrThrow({
      where: { id: fixture.applicationId },
      select: { status: true, dateApplied: true }
    });
    assert.equal(terminalApplication.status, "APPLIED");
    assert.notEqual(terminalApplication.dateApplied, null);
    assert.equal(terminalApplication.dateApplied?.getTime(), terminalRun.completedAt?.getTime());

    const completionAudits = await actor.client.auditLog.findMany({
      where: {
        userId: SYNTHETIC_USER_ID,
        action: "application-run.complete-by-user",
        resource: "ApplicationRun",
        resourceId: runId
      },
      select: { metadata: true }
    });
    assert.equal(completionAudits.length, 1);
    assert.deepEqual(completionAudits[0].metadata, {
      runId,
      applicationId: fixture.applicationId,
      attestation: PERSONAL_SUBMISSION_ATTESTATION,
      previousState: "READY_FOR_USER_SUBMISSION",
      nextState: "COMPLETED_BY_USER",
      previousStateVersion: filledRun.stateVersion,
      nextStateVersion: filledRun.stateVersion + 1,
      completedAt: terminalRun.completedAt?.toISOString()
    });
    const completionEvents = await actor.client.applicationEvent.findMany({
      where: {
        userId: SYNTHETIC_USER_ID,
        applicationId: fixture.applicationId,
        type: "STATUS_CHANGED",
        title: "Personal submission recorded"
      },
      select: { metadata: true }
    });
    assert.equal(completionEvents.length, 1);
    assert.deepEqual(completionEvents[0].metadata, {
      runId,
      previousState: "READY_FOR_USER_SUBMISSION",
      nextState: "COMPLETED_BY_USER",
      previousStateVersion: filledRun.stateVersion,
      nextStateVersion: filledRun.stateVersion + 1,
      completedAt: terminalRun.completedAt?.toISOString()
    });

    assert.equal(
      await controlPage.getByRole("button", {
        name: "I personally submitted this application",
        exact: true
      }).count(),
      0
    );
    assert.equal(
      await controlPage.getByRole("button", {
        name: "Confirm personal submission",
        exact: true
      }).count(),
      0
    );
    assert.equal(await fillButton.isDisabled(), true);
    assert.equal(
      await controlPage.getByText("Personal submission recorded", { exact: true }).isVisible(),
      true
    );
    assert.equal(requestSummary.completionRequestCount, 1);
    assert.equal(requestSummary.fillAcquisitionCount, 1);
    assert.equal(requestSummary.fillFinalizationCount, 1);
    assert.equal(networkCounters.syntheticSubmissionEndpointCount, 1);
    assert.equal(networkCounters.syntheticTargetRequestCount, 1);
    assert.equal(networkCounters.rejectedRequestCount, 0);
    assert.deepEqual(requestSummary.rejectedBrowserUrls, []);

    const persistedPrivacyEvidence = await Promise.all([
      actor.client.applicationRunFormInspection.findMany({
        where: { runId },
        select: { normalizedSnapshot: true }
      }),
      actor.client.applicationRunAnswer.findMany({
        where: { runId },
        select: { proposal: true, proposedValue: true }
      }),
      actor.client.auditLog.findMany({
        where: { OR: [{ userId: SYNTHETIC_USER_ID }, { resourceId: runId }] },
        select: { metadata: true }
      }),
      actor.client.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
        select: { metadata: true }
      })
    ]);
    assert.equal(JSON.stringify({
      formInspectionJson: persistedPrivacyEvidence[0],
      answerPacketJson: persistedPrivacyEvidence[1],
      auditJson: persistedPrivacyEvidence[2],
      applicationEventJson: persistedPrivacyEvidence[3]
    }).includes(EXISTING_PROFILE_SENTINEL), false);

    assert.deepEqual(
      await actor.client.user.findUniqueOrThrow({
        where: { id: SYNTHETIC_USER_ID },
        select: {
          id: true,
          name: true,
          email: true,
          profile: {
            select: {
              careerGoals: true,
              preferredRoles: true,
              preferredLocations: true,
              industriesOfInterest: true,
              dealBreakers: true,
              skillsToEmphasize: true,
              skillsNotToExaggerate: true
            }
          }
        }
      }),
      seededIdentity
    );

    diagnostic.runState = terminalRun.state;
    diagnostic.runStateVersion = terminalRun.stateVersion;
    diagnostic.hasCompletedAt = true;
    diagnostic.applicationStatus = terminalApplication.status;
    diagnostic.hasDateApplied = terminalApplication.dateApplied !== null;
    diagnostic.phase = "CLOSE_WORKFLOW";

    const closeButton = controlPage.getByRole("button", { name: "Close workflow", exact: true });
    assert.equal(await closeButton.isEnabled(), true);
    await closeButton.click();
    assert.ok(companionPromise);
    await settleWithin(companionPromise, OPERATION_TIMEOUT_MS, "application browser companion close");
    assert.equal(companionFailure, undefined);
    assert.equal(companionSettled, true);
    diagnostic.phase = "COMPLETE";
  } catch (error) {
    primaryFailure = error;
    if (employerPage && !employerPage.isClosed()) {
      fixtureSnapshot = await readSyntheticEmployerSnapshot(employerPage).catch(() => fixtureSnapshot);
    }
    await captureFailureArtifacts({
      repositoryRoot,
      databaseUrl: validatedDatabaseUrl,
      nextServer,
      controlPage,
      employerPage,
      diagnostic,
      fixtureSnapshot,
      networkCounters,
      requestSummary,
      fillSummary,
      browserConsole,
      pageErrors,
      companionLog
    }).catch(() => undefined);
    throw error;
  } finally {
    const cleanupFailures = await cleanup.cleanup();
    assertSyntheticCleanupOutcome(primaryFailure, cleanupFailures);
  }
});
