import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApplicationAutomationPolicy, PrismaClient } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationPlanInput } from "@/lib/ai/application-plan";
import { createApplicationRunOrchestrator } from "@/lib/application-runs/orchestration";
import { automationPolicyDefaultValues } from "@/lib/application-runs/service";

const USER_ID = "user-1";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const JOB_ID = "clz8w7m9a0001qwer1234tyui";
const RESUME_ID = "clz8w7m9a0003qwer1234tyui";
const COVER_ID = "clz8w7m9a0004qwer1234tyui";
const NOW = new Date("2026-08-20T18:00:00.000Z");

type FakePolicy = ApplicationAutomationPolicy;
type FakeResumeVersion = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  summary: string | null;
  skills: string[];
  fullText: string;
  resume: {
    userId: string;
    summary: string | null;
    skills: string[];
    achievements: string[];
    workHistory: unknown;
    projects: unknown;
    education: unknown;
    certifications: unknown;
  } | null;
};
type FakeCoverLetterVersion = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  type: string;
  content: string;
};
type FakeState = {
  policy: FakePolicy | null;
  run: ReturnType<typeof baseRun>;
  audits: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
};

function basePolicy(overrides: Partial<FakePolicy> = {}): FakePolicy {
  return {
    id: "policy-1",
    userId: USER_ID,
    ...automationPolicyDefaultValues(),
    enabled: true,
    coverLetterRequired: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function baseRun() {
  return {
    id: RUN_ID,
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "DRAFT",
    stateVersion: 0,
    idempotencyKey: "request-123",
    activeRunKey: APPLICATION_ID,
    prepareAttemptId: null as string | null,
    prepareLeaseExpiresAt: null as Date | null,
    firstPreparingAt: null as Date | null,
    applyUrlSnapshot: "https://jobs.example.com/apply/123",
    applyHost: "jobs.example.com",
    detectedAdapter: null,
    policySnapshot: null as unknown,
    policyHash: null as string | null,
    fitScoreSnapshot: null as number | null,
    matchConfidenceScoreSnapshot: null as number | null,
    plannerConfidenceScoreSnapshot: null as number | null,
    resumeVersionId: null as string | null,
    resumeContentHash: null as string | null,
    coverLetterVersionId: null as string | null,
    coverLetterContentHash: null as string | null,
    applicationPlanSnapshot: null as unknown,
    requirementCatalogSnapshot: null as unknown,
    evidenceCatalogSnapshot: null as unknown,
    plannerProvider: null as string | null,
    plannerModel: null as string | null,
    plannerPromptVersion: null as string | null,
    plannerRequestHash: null as string | null,
    reviewReasons: [] as string[],
    reviewAcknowledgedAt: null as Date | null,
    blockingReason: null as string | null,
    errorCategory: null as string | null,
    preparedAt: null as Date | null,
    completedAt: null as Date | null,
    cancelledAt: null as Date | null,
    createdAt: NOW,
    updatedAt: NOW,
    application: {
      id: APPLICATION_ID,
      userId: USER_ID,
      jobPostingId: JOB_ID,
      resumeVersionId: RESUME_ID as string | null,
      coverLetterVersionId: null as string | null,
      resumeVersion: {
        id: RESUME_ID,
        userId: USER_ID,
        jobPostingId: JOB_ID as string | null,
        summary: "Customer-facing engineer",
        skills: ["TypeScript", "SQL"],
        fullText: "Authoritative assigned resume contents",
        resume: {
          userId: USER_ID,
          summary: "Master summary that must not replace the assigned version summary",
          skills: ["TypeScript", "SQL"],
          achievements: ["Reduced onboarding time by 20%"],
          workHistory: [{ title: "Solutions Engineer", company: "Acme", highlights: ["Built APIs"] }],
          projects: [{ name: "Apply Pilot", technologies: ["TypeScript"] }],
          education: [{ degree: "BS", field: "Computer Science" }],
          certifications: [{ name: "AWS" }]
        }
      } as FakeResumeVersion | null,
      coverLetterVersion: null as FakeCoverLetterVersion | null
    },
    jobPosting: {
      id: JOB_ID,
      userId: USER_ID,
      title: "Solutions Engineer",
      company: "Example Co",
      location: "Los Angeles, CA",
      remoteStatus: "HYBRID",
      salaryMin: 120000,
      salaryMax: 150000,
      description: "Build customer solutions with TypeScript and SQL.",
      requirements: ["TypeScript", "SQL"],
      preferredQualifications: ["Customer discovery"],
      detectedTechStack: ["TypeScript", "PostgreSQL"],
      overallFitScore: 92 as number | null,
      confidenceScore: 91 as number | null
    },
    user: {
      profile: {
        careerGoals: "Build trusted customer-facing systems",
        preferredRoles: ["Solutions Engineer"],
        preferredLocations: ["Los Angeles, CA"],
        remotePreference: "FLEXIBLE",
        salaryTargetMin: 120000,
        skillsToEmphasize: ["TypeScript"],
        skillsNotToExaggerate: ["Kubernetes"]
      }
    }
  };
}

// This fake proves application-level ordering, fences, and rollback behavior. It does
// not emulate PostgreSQL row-lock compatibility, waiter wake-up, isolation, deadlock
// detection, foreign-key parent locks, or P2002 races; those remain Commit 5 tests.
function createFake(overrides: {
  policy?: FakePolicy | null;
  run?: ReturnType<typeof baseRun>;
  recentCount?: number;
  failAuditAction?: string;
  failEventTitle?: string;
  userExists?: boolean;
} = {}) {
  let state: FakeState = {
    policy: Object.hasOwn(overrides, "policy") ? (overrides.policy ?? null) : basePolicy(),
    run: overrides.run ?? baseRun(),
    audits: [],
    events: []
  };
  let transactionNumber = 0;
  let transactionOpen = false;
  const operations: string[] = [];
  const updateWheres: Array<Record<string, unknown>> = [];
  const updateDatas: Array<Record<string, unknown>> = [];
  const recentCount = overrides.recentCount ?? 0;

  const matchesRun = (run: FakeState["run"], where: Record<string, unknown> | undefined) => {
    if (!where) return true;
    for (const key of ["id", "userId", "state", "stateVersion", "prepareAttemptId"] as const) {
      if (Object.hasOwn(where, key) && run[key] !== where[key]) return false;
    }
    return true;
  };

  const applyData = (run: FakeState["run"], data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (key === "stateVersion" && value && typeof value === "object" && "increment" in value) {
        run.stateVersion += Number((value as { increment: number }).increment);
      } else {
        (run as unknown as Record<string, unknown>)[key] = value;
      }
    }
    run.updatedAt = NOW;
  };

  const policyDelegate = (working: FakeState, label: string) => ({
    async findUnique() {
      operations.push(`${label}:policy-reread`);
      return working.policy ? structuredClone(working.policy) : null;
    },
    async create(args: { data: Record<string, unknown> }) {
      operations.push(`${label}:policy-create`);
      working.policy = basePolicy({
        ...(args.data as Partial<FakePolicy>),
        id: "policy-created",
        enabled: false
      });
      return structuredClone(working.policy);
    }
  });

  const runDelegate = (working: FakeState, label: string) => ({
    async findFirst(args: { where?: Record<string, unknown> }) {
      operations.push(`${label}:run-reread`);
      return matchesRun(working.run, args.where) ? structuredClone(working.run) : null;
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      operations.push(`${label}:run-update`);
      updateWheres.push(structuredClone(args.where));
      updateDatas.push(structuredClone(args.data));
      if (!matchesRun(working.run, args.where)) return { count: 0 };
      applyData(working.run, args.data);
      return { count: 1 };
    },
    async count() {
      operations.push(`${label}:run-count`);
      return recentCount;
    }
  });

  const outsideRunDelegate = {
    async findFirst(args: { where?: Record<string, unknown> }) {
      operations.push("outside:run-preflight");
      return matchesRun(state.run, args.where) ? structuredClone(state.run) : null;
    }
  };

  const client = {
    applicationAutomationPolicy: {
      async findUnique() {
        operations.push("outside:policy-existence");
        return state.policy ? structuredClone(state.policy) : null;
      }
    },
    applicationRun: outsideRunDelegate,
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      transactionNumber += 1;
      const label = `tx${transactionNumber}`;
      const working = structuredClone(state);
      operations.push(`${label}:begin`);
      transactionOpen = true;
      const tx = {
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          const sql = strings.join("?").replace(/\s+/g, " ").trim();
          if (sql.includes('FROM "User"')) {
            operations.push(`${label}:lock-user-no-key-update`);
            assert.match(sql, /FOR NO KEY UPDATE/);
            return overrides.userExists === false ? [] : [{ id: values[0] }];
          }
          if (sql.includes('FROM "ApplicationAutomationPolicy"')) {
            operations.push(`${label}:lock-policy`);
            assert.match(sql, /FOR UPDATE/);
            return working.policy ? [{ id: working.policy.id }] : [];
          }
          if (sql.includes('FROM "ApplicationRun"')) {
            operations.push(`${label}:lock-run`);
            assert.match(sql, /"id" = .* AND "userId" = .* FOR UPDATE/);
            return working.run.id === values[0] && working.run.userId === values[1]
              ? [{ id: working.run.id }]
              : [];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        applicationAutomationPolicy: policyDelegate(working, label),
        applicationRun: runDelegate(working, label),
        auditLog: {
          async create(args: { data: Record<string, unknown> }) {
            operations.push(`${label}:audit:${String(args.data.action)}`);
            if (args.data.action === overrides.failAuditAction) throw new Error("fake audit failure");
            working.audits.push(structuredClone(args.data));
            return args.data;
          }
        },
        applicationEvent: {
          async create(args: { data: Record<string, unknown> }) {
            operations.push(`${label}:event:${String(args.data.title)}`);
            if (args.data.title === overrides.failEventTitle) throw new Error("fake event failure");
            working.events.push(structuredClone(args.data));
            return args.data;
          }
        }
      };
      try {
        const result = await callback(tx);
        state = working;
        transactionOpen = false;
        operations.push(`${label}:commit`);
        return result;
      } catch (error) {
        transactionOpen = false;
        operations.push(`${label}:rollback`);
        throw error;
      }
    }
  };

  return {
    client: client as unknown as PrismaClient,
    operations,
    updateWheres,
    updateDatas,
    get state() {
      return state;
    },
    get transactionOpen() {
      return transactionOpen;
    },
    mutate(mutator: (current: FakeState) => void) {
      mutator(state);
    }
  };
}

function cleanPlan(overrides: Record<string, unknown> = {}) {
  return {
    targetRoleSummary: "A grounded plan",
    evidenceMap: [
      {
        requirementId: "req-1",
        requirement: "TypeScript",
        evidenceIds: ["skill-1"],
        evidence: ["TypeScript"],
        gap: false
      }
    ],
    resumeStrategy: ["Lead with verified TypeScript evidence"],
    coverLetterAngle: "Connect verified evidence to the role",
    riskFlags: [],
    recommendedNextActions: ["Review the evidence map"],
    confidenceScore: 95,
    unknownRequirementIds: [],
    unknownEvidenceIds: [],
    exaggeratedEvidenceIds: [],
    inventedNumericClaims: [],
    model: "kimi-k2.5",
    provider: "kimi" as const,
    promptVersion: "1",
    requestHash: "request-hash",
    usage: {
      secretLookingUsageObject: true,
      inputTokens: 500,
      outputTokens: 200
    },
    ...overrides
  };
}

function orchestrator(
  fake: ReturnType<typeof createFake>,
  planner: (input: ApplicationPlanInput, userId?: string, options?: Record<string, unknown>) => Promise<ReturnType<typeof cleanPlan>>,
  envReader: () => Record<string, string | undefined> = () => ({ APPLICATION_AUTOMATION_ENABLED: "true" })
) {
  return createApplicationRunOrchestrator({
    prismaClient: fake.client,
    planner: planner as never,
    clock: () => NOW,
    attemptIdGenerator: () => "attempt-fixed",
    automationEnv: envReader
  }).prepareApplicationRun;
}

function expectPublicError(code: string) {
  return (error: unknown) => error instanceof PublicApiError && error.details?.code === code;
}

test("existing-policy TX1 commits before the real planner seam and TX2 persists only allowlisted provenance", async () => {
  const fake = createFake();
  let plannerInput: ApplicationPlanInput | null = null;
  const prepare = orchestrator(fake, async (input, userId, options) => {
    assert.equal(fake.transactionOpen, false, "planner must never run inside an interactive transaction");
    fake.operations.push("planner");
    plannerInput = input;
    assert.equal(userId, USER_ID);
    assert.deepEqual(options, { automation: true, highCostConfirmed: true });
    return cleanPlan({
      state: "FILLING",
      stateVersion: 999,
      activeRunKey: "attacker",
      prepareAttemptId: "attacker",
      firstPreparingAt: null,
      userId: "attacker"
    });
  });

  const result = await prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: true });

  assert.equal(result.state, "READY");
  assert.equal(fake.state.run.state, "READY");
  assert.equal(fake.state.run.stateVersion, 2);
  assert.equal(fake.state.run.prepareAttemptId, null);
  assert.equal(fake.state.run.prepareLeaseExpiresAt, null);
  assert.equal(fake.state.run.firstPreparingAt?.toISOString(), NOW.toISOString());
  assert.equal(fake.state.run.resumeVersionId, RESUME_ID);
  assert.match(fake.state.run.resumeContentHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(fake.state.run.policyHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(fake.state.run.activeRunKey, APPLICATION_ID);
  assert.equal((fake.state.run.applicationPlanSnapshot as Record<string, unknown>).state, undefined);
  assert.equal((fake.state.run.applicationPlanSnapshot as Record<string, unknown>).usage, undefined);
  assert.equal((fake.state.run.applicationPlanSnapshot as Record<string, unknown>).userId, undefined);
  assert.ok(plannerInput);
  const serializedInput = JSON.stringify(plannerInput);
  assert.doesNotMatch(serializedInput, /rawText|contactInfo|filePath|email|phone|answer.?vault/i);
  assert.match(serializedInput, /Customer-facing engineer/);

  const plannerIndex = fake.operations.indexOf("planner");
  assert.ok(fake.operations.slice(0, plannerIndex).some((entry) => entry.endsWith(":commit")));
  assert.equal(fake.operations.filter((entry) => entry.includes("lock-user")).length, 0);
  for (const prefix of ["tx1", "tx2"]) {
    assert.ok(fake.operations.indexOf(`${prefix}:lock-policy`) < fake.operations.indexOf(`${prefix}:lock-run`));
    assert.ok(fake.operations.indexOf(`${prefix}:lock-policy`) < fake.operations.indexOf(`${prefix}:policy-reread`));
    assert.ok(fake.operations.indexOf(`${prefix}:lock-run`) < fake.operations.indexOf(`${prefix}:run-reread`));
  }
  assert.deepEqual(fake.updateWheres[0], {
    id: RUN_ID,
    userId: USER_ID,
    state: "DRAFT",
    stateVersion: 0,
    prepareAttemptId: null
  });
  assert.deepEqual(fake.updateWheres[1], {
    id: RUN_ID,
    userId: USER_ID,
    state: "PREPARING",
    prepareAttemptId: "attempt-fixed",
    stateVersion: 1
  });
  assert.equal(fake.updateDatas[0].prepareAttemptId, "attempt-fixed");
  assert.equal(
    (fake.updateDatas[0].prepareLeaseExpiresAt as Date).toISOString(),
    "2026-08-20T18:10:00.000Z"
  );
  assert.equal((fake.updateDatas[0].firstPreparingAt as Date).toISOString(), NOW.toISOString());
  assert.equal(fake.operations.filter((entry) => entry.includes(":run-count")).length, 1);
});

test("missing policy is ensured under User FOR NO KEY UPDATE, committed, then fail-closed TX1 locks policy before run", async () => {
  const fake = createFake({ policy: null });
  let plannerCalls = 0;
  const prepare = orchestrator(fake, async () => {
    plannerCalls += 1;
    return cleanPlan();
  });

  await assert.rejects(
    prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
    expectPublicError("AUTOMATION_DISABLED")
  );

  assert.equal(plannerCalls, 0);
  assert.equal(fake.state.policy?.enabled, false);
  assert.equal(fake.state.run.state, "BLOCKED");
  assert.equal(fake.state.run.firstPreparingAt, null);
  assert.equal(fake.operations.filter((entry) => entry.includes("lock-user-no-key-update")).length, 1);
  assert.ok(fake.operations.indexOf("tx1:lock-user-no-key-update") < fake.operations.indexOf("tx1:policy-reread"));
  assert.ok(fake.operations.indexOf("tx1:policy-reread") < fake.operations.indexOf("tx1:policy-create"));
  assert.ok(fake.operations.indexOf("tx1:commit") < fake.operations.indexOf("tx2:lock-policy"));
  assert.ok(fake.operations.indexOf("tx2:lock-policy") < fake.operations.indexOf("tx2:lock-run"));
  assert.equal(fake.operations.some((entry) => entry.startsWith("tx2:lock-user")), false);
  assert.equal(fake.operations.some((entry) => entry.includes(":run-count")), false);
});

test("deterministic TX1 capability, host, score, and explicit-document gates block atomically before cap/provider", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (fake: ReturnType<typeof createFake>) => void;
    env?: Record<string, string | undefined>;
    expectedCode: string;
  }> = [
    {
      name: "global automation disabled",
      mutate: () => undefined,
      env: { APPLICATION_AUTOMATION_ENABLED: "false" },
      expectedCode: "AUTOMATION_DISABLED"
    },
    {
      name: "user policy disabled",
      mutate: (fake) => { if (fake.state.policy) fake.state.policy.enabled = false; },
      expectedCode: "AUTOMATION_DISABLED"
    },
    {
      name: "static prohibited host",
      mutate: (fake) => {
        fake.state.run.applyHost = "www.linkedin.com";
        fake.state.run.applyUrlSnapshot = "https://www.linkedin.com/jobs/123";
      },
      expectedCode: "RUN_HOST_BLOCKED"
    },
    {
      name: "user blocked host",
      mutate: (fake) => { if (fake.state.policy) fake.state.policy.blockedHosts = ["example.com"]; },
      expectedCode: "RUN_HOST_BLOCKED"
    },
    {
      name: "stored host mismatch",
      mutate: (fake) => { fake.state.run.applyHost = "other.example.com"; },
      expectedCode: "RUN_HOST_BLOCKED"
    },
    {
      name: "fit below threshold",
      mutate: (fake) => { fake.state.run.jobPosting.overallFitScore = 84; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "null fit",
      mutate: (fake) => { fake.state.run.jobPosting.overallFitScore = null; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "confidence below threshold",
      mutate: (fake) => { fake.state.run.jobPosting.confidenceScore = 84; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "null confidence",
      mutate: (fake) => { fake.state.run.jobPosting.confidenceScore = null; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "missing explicit resume",
      mutate: (fake) => {
        fake.state.run.application.resumeVersionId = null;
        fake.state.run.application.resumeVersion = null;
      },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "cross-user resume",
      mutate: (fake) => { if (fake.state.run.application.resumeVersion) fake.state.run.application.resumeVersion.userId = "other"; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "wrong-posting resume",
      mutate: (fake) => { if (fake.state.run.application.resumeVersion) fake.state.run.application.resumeVersion.jobPostingId = "other"; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "required missing cover letter",
      mutate: (fake) => { if (fake.state.policy) fake.state.policy.coverLetterRequired = true; },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "wrong-type cover letter",
      mutate: (fake) => {
        if (fake.state.policy) fake.state.policy.coverLetterRequired = true;
        fake.state.run.application.coverLetterVersionId = COVER_ID;
        fake.state.run.application.coverLetterVersion = {
          id: COVER_ID, userId: USER_ID, jobPostingId: JOB_ID, type: "OTHER", content: "cover"
        } as never;
      },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "cross-user cover letter",
      mutate: (fake) => {
        if (fake.state.policy) fake.state.policy.coverLetterRequired = true;
        fake.state.run.application.coverLetterVersionId = COVER_ID;
        fake.state.run.application.coverLetterVersion = {
          id: COVER_ID, userId: "other", jobPostingId: JOB_ID, type: "COVER_LETTER", content: "cover"
        } as never;
      },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    },
    {
      name: "wrong-posting cover letter",
      mutate: (fake) => {
        if (fake.state.policy) fake.state.policy.coverLetterRequired = true;
        fake.state.run.application.coverLetterVersionId = COVER_ID;
        fake.state.run.application.coverLetterVersion = {
          id: COVER_ID, userId: USER_ID, jobPostingId: "other", type: "COVER_LETTER", content: "cover"
        } as never;
      },
      expectedCode: "RUN_PREPARATION_BLOCKED"
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = createFake();
      item.mutate(fake);
      let plannerCalls = 0;
      const prepare = orchestrator(fake, async () => {
        plannerCalls += 1;
        return cleanPlan();
      }, () => item.env ?? { APPLICATION_AUTOMATION_ENABLED: "true" });
      await assert.rejects(
        prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
        expectPublicError(item.expectedCode)
      );
      assert.equal(plannerCalls, 0);
      assert.equal(fake.state.run.state, "BLOCKED");
      assert.equal(fake.state.run.stateVersion, 1);
      assert.equal(fake.state.run.firstPreparingAt, null);
      assert.equal(fake.operations.some((entry) => entry.includes(":run-count")), false);
      assert.equal(fake.state.audits.length, 1);
      assert.equal(fake.state.events.length, 1);
    });
  }
});

test("optional cover-letter absence is allowed and assigned valid cover letters alone are hashed", async () => {
  const optional = createFake();
  const optionalResult = await orchestrator(optional, async () => cleanPlan())({
    userId: USER_ID,
    runId: RUN_ID,
    highCostConfirmed: false
  });
  assert.equal(optionalResult.state, "READY");
  assert.equal(optional.state.run.coverLetterVersionId, null);
  assert.equal(optional.state.run.coverLetterContentHash, null);

  const assigned = createFake();
  if (assigned.state.policy) assigned.state.policy.coverLetterRequired = true;
  assigned.state.run.application.coverLetterVersionId = COVER_ID;
  assigned.state.run.application.coverLetterVersion = {
    id: COVER_ID,
    userId: USER_ID,
    jobPostingId: JOB_ID,
    type: "COVER_LETTER",
    content: "Explicitly assigned cover letter"
  } as never;
  await orchestrator(assigned, async () => cleanPlan())({
    userId: USER_ID,
    runId: RUN_ID,
    highCostConfirmed: false
  });
  assert.equal(assigned.state.run.coverLetterVersionId, COVER_ID);
  assert.match(assigned.state.run.coverLetterContentHash ?? "", /^[a-f0-9]{64}$/);
});

test("nested parent Resume ownership fails closed without leaking foreign evidence", async () => {
  const foreignSentinel = "FOREIGN-RESUME-SENTINEL-DO-NOT-LEAK";
  const fake = createFake();
  const parentResume = fake.state.run.application.resumeVersion?.resume;
  assert.ok(parentResume);
  parentResume.userId = "user-2";
  parentResume.achievements = [foreignSentinel];
  parentResume.workHistory = [{
    title: foreignSentinel,
    company: "Foreign Company",
    highlights: [foreignSentinel]
  }];

  let plannerCalls = 0;
  let capturedPlannerInput: ApplicationPlanInput | null = null;
  const prepare = orchestrator(fake, async (input) => {
    plannerCalls += 1;
    capturedPlannerInput = input;
    return cleanPlan();
  });

  let exposedError: unknown;
  try {
    await prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false });
    assert.fail("cross-owner parent Resume must block preparation");
  } catch (error) {
    exposedError = error;
  }

  assert.ok(expectPublicError("RUN_PREPARATION_BLOCKED")(exposedError));
  assert.equal((exposedError as PublicApiError).details?.reason, "resume_required");
  assert.equal(plannerCalls, 0);
  assert.equal(capturedPlannerInput, null);
  assert.equal(fake.state.run.state, "BLOCKED");
  assert.equal(fake.state.run.blockingReason, "resume_required");
  assert.equal(fake.state.run.errorCategory, null);
  assert.equal(fake.state.run.stateVersion, 1);
  assert.equal(fake.state.run.firstPreparingAt, null);
  assert.equal(fake.state.run.prepareAttemptId, null);
  assert.equal(fake.state.run.prepareLeaseExpiresAt, null);
  assert.equal(fake.operations.some((entry) => entry.includes(":run-count")), false);
  assert.equal(fake.state.run.applicationPlanSnapshot, null);
  assert.equal(fake.state.run.requirementCatalogSnapshot, null);
  assert.equal(fake.state.run.evidenceCatalogSnapshot, null);
  assert.equal(fake.state.run.plannerProvider, null);
  assert.equal(fake.state.run.plannerModel, null);
  assert.equal(fake.state.run.plannerPromptVersion, null);
  assert.equal(fake.state.run.plannerRequestHash, null);
  assert.equal(fake.state.audits.length, 1);
  assert.equal(fake.state.events.length, 1);
  assert.doesNotMatch(
    JSON.stringify({
      capturedPlannerInput,
      audits: fake.state.audits,
      events: fake.state.events,
      exposedError: exposedError instanceof PublicApiError
        ? { message: exposedError.message, details: exposedError.details }
        : exposedError
    }),
    new RegExp(foreignSentinel)
  );
});

test("same-user and null parent Resumes remain selectable", async (t) => {
  await t.test("same-user parent Resume", async () => {
    const fake = createFake();
    let plannerCalls = 0;
    await orchestrator(fake, async () => {
      plannerCalls += 1;
      return cleanPlan();
    })({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false });
    assert.equal(plannerCalls, 1);
    assert.equal(fake.state.run.state, "READY");
  });

  await t.test("null parent Resume", async () => {
    const fake = createFake();
    if (fake.state.run.application.resumeVersion) {
      fake.state.run.application.resumeVersion.resume = null;
    }
    let plannerCalls = 0;
    await orchestrator(fake, async (input) => {
      plannerCalls += 1;
      assert.deepEqual(input.resume?.achievements, []);
      assert.equal(input.resume?.workHistory, undefined);
      return cleanPlan();
    })({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false });
    assert.equal(plannerCalls, 1);
    assert.equal(fake.state.run.state, "READY");
  });
});

test("daily cap is rolling and lifetime-slot based across first acquire, retry, and lease reclaim", async (t) => {
  await t.test("cap reached blocks without consuming firstPreparingAt", async () => {
    const fake = createFake({ recentCount: 5 });
    await assert.rejects(
      orchestrator(fake, async () => cleanPlan())({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      expectPublicError("RUN_DAILY_CAP_REACHED")
    );
    assert.equal(fake.state.run.firstPreparingAt, null);
    assert.equal(fake.operations.filter((entry) => entry.includes(":run-count")).length, 1);
  });

  for (const scenario of ["retry", "expired-lease", "missing-lease"] as const) {
    await t.test(`${scenario} preserves the original slot and skips the cap count`, async () => {
      const run = baseRun();
      run.firstPreparingAt = new Date("2026-08-19T18:00:00.000Z");
      if (scenario !== "retry") {
        run.state = "PREPARING";
        run.stateVersion = 4;
        run.prepareAttemptId = "old-attempt";
        run.prepareLeaseExpiresAt = scenario === "expired-lease"
          ? new Date(NOW.getTime() - 1)
          : null;
      } else {
        run.state = "FAILED";
        run.stateVersion = 2;
      }
      const originalFirst = run.firstPreparingAt;
      const fake = createFake({ run, recentCount: 999 });
      await orchestrator(fake, async () => cleanPlan())({
        userId: USER_ID,
        runId: RUN_ID,
        highCostConfirmed: false
      });
      assert.equal(fake.operations.some((entry) => entry.includes(":run-count")), false);
      assert.equal(fake.state.run.firstPreparingAt?.toISOString(), originalFirst.toISOString());
      assert.equal(fake.updateWheres[0].prepareAttemptId, scenario === "retry" ? null : "old-attempt");
    });
  }

  await t.test("a live PREPARING lease cannot be stolen", async () => {
    const run = baseRun();
    run.state = "PREPARING";
    run.stateVersion = 3;
    run.prepareAttemptId = "live-attempt";
    run.prepareLeaseExpiresAt = new Date(NOW.getTime() + 60_000);
    run.firstPreparingAt = NOW;
    const fake = createFake({ run });
    await assert.rejects(
      orchestrator(fake, async () => cleanPlan())({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      expectPublicError("RUN_PREPARATION_IN_PROGRESS")
    );
    assert.equal(fake.state.run.prepareAttemptId, "live-attempt");
    assert.equal(fake.operations.some((entry) => entry.includes(":run-update")), false);
  });
});

test("uncertainty commits REVIEW_REQUIRED with stable reason order", async () => {
  const fake = createFake();
  await orchestrator(fake, async () => cleanPlan({
    unknownRequirementIds: ["bad-req"],
    unknownEvidenceIds: ["bad-evidence"],
    exaggeratedEvidenceIds: ["skill-9"],
    inventedNumericClaims: ["99%"],
    confidenceScore: 10,
    evidenceMap: [{
      requirementId: "req-1",
      requirement: "TypeScript",
      evidenceIds: [],
      evidence: [],
      gap: true
    }]
  }))({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false });

  assert.equal(fake.state.run.state, "REVIEW_REQUIRED");
  assert.deepEqual(fake.state.run.reviewReasons, [
    "unknown_requirement_ids",
    "unknown_evidence_ids",
    "exaggerated_evidence_removed",
    "invented_numeric_claims",
    "planner_confidence_below_threshold",
    "evidence_gaps_present"
  ]);
});

test("TX2 exact stale fence has priority over success and automation disablement", async (t) => {
  const cases = [
    ["cancelled", (state: FakeState) => { state.run.state = "CANCELLED"; state.run.stateVersion += 1; state.run.prepareAttemptId = null; }],
    ["attempt superseded", (state: FakeState) => { state.run.prepareAttemptId = "new-attempt"; }],
    ["version changed", (state: FakeState) => { state.run.stateVersion += 1; }],
    ["state changed", (state: FakeState) => { state.run.state = "BLOCKED"; }]
  ] as const;
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fake = createFake();
      const prepare = orchestrator(fake, async () => {
        fake.mutate(mutate);
        if (fake.state.policy) fake.state.policy.enabled = false;
        return cleanPlan();
      });
      await assert.rejects(
        prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
        expectPublicError("RUN_PREPARATION_STALE")
      );
      assert.equal(fake.state.run.applicationPlanSnapshot, null);
      assert.equal(fake.state.audits.filter((entry) => entry.action === "application-run.prepare.complete").length, 0);
      assert.equal(fake.state.audits.filter((entry) => entry.action === "application-run.prepare.disabled-during-provider").length, 0);
    });
  }
});

test("TX2 current user and global kill switches discard provider output and block only a current fence", async (t) => {
  await t.test("user policy disabled during provider", async () => {
    const fake = createFake();
    const prepare = orchestrator(fake, async () => {
      if (fake.state.policy) fake.state.policy.enabled = false;
      return cleanPlan();
    });
    await assert.rejects(
      prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      expectPublicError("AUTOMATION_DISABLED")
    );
    assert.equal(fake.state.run.state, "BLOCKED");
    assert.equal(fake.state.run.blockingReason, "automation_disabled_during_preparation");
    assert.equal(fake.state.run.stateVersion, 2);
    assert.equal(fake.state.run.prepareAttemptId, null);
    assert.equal(fake.state.run.prepareLeaseExpiresAt, null);
    assert.equal(fake.state.run.firstPreparingAt?.toISOString(), NOW.toISOString());
    assert.equal(fake.state.run.applicationPlanSnapshot, null);
  });

  await t.test("global gate disabled during provider", async () => {
    const fake = createFake();
    let enabled = true;
    const prepare = orchestrator(fake, async () => {
      enabled = false;
      return cleanPlan();
    }, () => ({ APPLICATION_AUTOMATION_ENABLED: enabled ? "true" : "false" }));
    await assert.rejects(
      prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      expectPublicError("AUTOMATION_DISABLED")
    );
    assert.equal(fake.state.run.blockingReason, "automation_disabled_during_preparation");
  });
});

test("TX2 does not rerun non-kill-switch gates and retains original TX1 policy provenance", async () => {
  const fake = createFake();
  const originalMinimum = fake.state.policy?.minimumFitScore;
  const prepare = orchestrator(fake, async () => {
    fake.state.run.jobPosting.overallFitScore = 0;
    fake.state.run.jobPosting.confidenceScore = 0;
    fake.state.run.application.resumeVersionId = null;
    fake.state.run.application.resumeVersion = null;
    fake.state.run.applyHost = "www.linkedin.com";
    if (fake.state.policy) {
      fake.state.policy.minimumFitScore = 100;
      fake.state.policy.minimumConfidenceScore = 100;
      fake.state.policy.dailyApplicationCap = 0;
      fake.state.policy.coverLetterRequired = true;
      fake.state.policy.blockedHosts = ["example.com"];
      fake.state.policy.permittedAdapters = ["future-adapter"];
    }
    return cleanPlan();
  });
  await prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false });
  assert.equal(fake.state.run.state, "READY");
  assert.equal((fake.state.run.policySnapshot as Record<string, unknown>).minimumFitScore, originalMinimum);
  assert.equal(fake.state.run.fitScoreSnapshot, 92);
  assert.equal(fake.state.run.resumeVersionId, RESUME_ID);
});

test("provider and planner failures are safely classified, fenced, and never persist partial output", async (t) => {
  const failures: Array<{
    name: string;
    error: Error;
    state: string;
    category: string;
    publicCode: string;
  }> = [
    {
      name: "AI budget exceeded",
      error: new PublicApiError("budget", 429, { code: "AI_BUDGET_EXCEEDED" }),
      state: "BLOCKED",
      category: "ai_budget_exceeded",
      publicCode: "AI_BUDGET_EXCEEDED"
    },
    {
      name: "cost confirmation required",
      error: new PublicApiError("confirm", 428, { code: "AI_COST_CONFIRMATION_REQUIRED" }),
      state: "BLOCKED",
      category: "ai_cost_confirmation_required",
      publicCode: "AI_COST_CONFIRMATION_REQUIRED"
    },
    {
      name: "request cost limit",
      error: new PublicApiError("limit", 429, { code: "AI_REQUEST_COST_LIMIT" }),
      state: "BLOCKED",
      category: "ai_request_cost_limit",
      publicCode: "AI_REQUEST_COST_LIMIT"
    },
    {
      name: "duplicate request",
      error: new PublicApiError("duplicate", 409, { code: "AI_DUPLICATE_IN_PROGRESS" }),
      state: "BLOCKED",
      category: "ai_duplicate_in_progress",
      publicCode: "AI_DUPLICATE_IN_PROGRESS"
    },
    {
      name: "invalid schema output",
      error: Object.assign(new Error("raw invalid provider body"), { name: "GeneratedSchemaError" }),
      state: "FAILED",
      category: "planner_output_invalid",
      publicCode: "RUN_PREPARATION_FAILED"
    },
    {
      name: "usage reconciliation failure",
      error: new PublicApiError("usage raw", 503, { code: "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION" }),
      state: "FAILED",
      category: "ai_provider_usage_exceeded_reservation",
      publicCode: "RUN_PREPARATION_FAILED"
    },
    {
      name: "AI input too large",
      error: new PublicApiError("raw oversized input must not leak", 413, {
        code: "AI_INPUT_TOO_LARGE",
        rawInput: "raw oversized input must not leak"
      }),
      state: "FAILED",
      category: "planner_input_invalid",
      publicCode: "RUN_PREPARATION_FAILED"
    },
    {
      name: "provider network failure",
      error: new Error("raw secret provider response"),
      state: "FAILED",
      category: "planner_provider_failure",
      publicCode: "RUN_PREPARATION_FAILED"
    }
  ];

  for (const item of failures) {
    await t.test(item.name, async () => {
      const fake = createFake();
      const prepare = orchestrator(fake, async () => { throw item.error; });
      await assert.rejects(
        prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
        (error: unknown) => {
          assert.ok(expectPublicError(item.publicCode)(error));
          if (item.name === "AI input too large") {
            assert.ok(error instanceof PublicApiError);
            assert.equal(error.status, 502);
            assert.equal(error.message, "Application planning failed.");
            assert.deepEqual(error.details, {
              code: "RUN_PREPARATION_FAILED",
              category: "planner_input_invalid"
            });
          }
          return true;
        }
      );
      assert.equal(fake.state.run.state, item.state);
      assert.equal(
        item.state === "BLOCKED" ? fake.state.run.blockingReason : fake.state.run.errorCategory,
        item.category
      );
      assert.equal(fake.state.run.firstPreparingAt?.toISOString(), NOW.toISOString());
      assert.equal(fake.state.run.stateVersion, 2);
      assert.equal(fake.state.run.blockingReason, item.state === "BLOCKED" ? item.category : null);
      assert.equal(fake.state.run.prepareAttemptId, null);
      assert.equal(fake.state.run.prepareLeaseExpiresAt, null);
      assert.equal(fake.state.run.applicationPlanSnapshot, null);
      assert.equal(fake.state.run.requirementCatalogSnapshot, null);
      assert.equal(fake.state.run.evidenceCatalogSnapshot, null);
      assert.doesNotMatch(
        JSON.stringify({ audits: fake.state.audits, events: fake.state.events }),
        /raw secret|raw invalid|provider response|raw oversized input/i
      );
      assert.deepEqual(fake.updateWheres.at(-1), {
        id: RUN_ID,
        userId: USER_ID,
        state: "PREPARING",
        prepareAttemptId: "attempt-fixed",
        stateVersion: 1
      });
    });
  }
});

test("stale provider failure is discarded without overwriting cancellation", async () => {
  const fake = createFake();
  const prepare = orchestrator(fake, async () => {
    fake.state.run.state = "CANCELLED";
    fake.state.run.stateVersion = 2;
    fake.state.run.prepareAttemptId = null;
    throw new Error("late failure");
  });
  await assert.rejects(
    prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
    expectPublicError("RUN_PREPARATION_STALE")
  );
  assert.equal(fake.state.run.state, "CANCELLED");
  assert.equal(fake.state.audits.filter((entry) => String(entry.action).includes("failed")).length, 0);
});

test("stale AI_INPUT_TOO_LARGE is discarded without persisting planner_input_invalid", async () => {
  const fake = createFake();
  const prepare = orchestrator(fake, async () => {
    fake.state.run.state = "CANCELLED";
    fake.state.run.stateVersion = 2;
    fake.state.run.prepareAttemptId = null;
    throw new PublicApiError("raw oversized input must not leak", 413, {
      code: "AI_INPUT_TOO_LARGE"
    });
  });
  await assert.rejects(
    prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
    expectPublicError("RUN_PREPARATION_STALE")
  );
  assert.equal(fake.state.run.state, "CANCELLED");
  assert.equal(fake.state.run.errorCategory, null);
  assert.equal(fake.state.run.applicationPlanSnapshot, null);
  assert.equal(fake.state.run.requirementCatalogSnapshot, null);
  assert.equal(fake.state.run.evidenceCatalogSnapshot, null);
  assert.equal(fake.state.audits.filter((entry) => String(entry.action).includes("failed")).length, 0);
  assert.doesNotMatch(
    JSON.stringify({ audits: fake.state.audits, events: fake.state.events }),
    /raw oversized input|planner_input_invalid/i
  );
});

test("invalid planner confidence finalizes FAILED instead of manufacturing a review result", async () => {
  const fake = createFake();
  const prepare = orchestrator(fake, async () => cleanPlan({ confidenceScore: Number.NaN }));
  await assert.rejects(
    prepare({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
    expectPublicError("RUN_PREPARATION_FAILED")
  );
  assert.equal(fake.state.run.state, "FAILED");
  assert.equal(fake.state.run.errorCategory, "planner_confidence_invalid");
});

test("transaction-local audit/event failures roll back acquisition, success, and failure exits", async (t) => {
  await t.test("TX1 acquisition audit rollback", async () => {
    const fake = createFake({ failAuditAction: "application-run.prepare.acquire" });
    await assert.rejects(
      orchestrator(fake, async () => cleanPlan())({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      /fake audit failure/
    );
    assert.equal(fake.state.run.state, "DRAFT");
    assert.equal(fake.state.run.firstPreparingAt, null);
  });

  await t.test("TX2 completion event rollback", async () => {
    const fake = createFake({ failEventTitle: "Application run preparation ready" });
    await assert.rejects(
      orchestrator(fake, async () => cleanPlan())({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
      /fake event failure/
    );
    assert.equal(fake.state.run.state, "PREPARING");
    assert.equal(fake.state.run.stateVersion, 1);
  });

  await t.test("provider failure audit rollback", async () => {
    const fake = createFake({ failAuditAction: "application-run.prepare.failed" });
    await assert.rejects(
      orchestrator(fake, async () => { throw new Error("provider"); })({
        userId: USER_ID,
        runId: RUN_ID,
        highCostConfirmed: false
      }),
      /fake audit failure/
    );
    assert.equal(fake.state.run.state, "PREPARING");
    assert.equal(fake.state.run.stateVersion, 1);
  });
});

test("ownership and target relation failures remain non-enumerating after policy then run locks", async (t) => {
  for (const [name, mutate] of [
    ["application owner", (run: ReturnType<typeof baseRun>) => { run.application.userId = "other"; }],
    ["job owner", (run: ReturnType<typeof baseRun>) => { run.jobPosting.userId = "other"; }],
    ["application target", (run: ReturnType<typeof baseRun>) => { run.application.jobPostingId = "other"; }]
  ] as const) {
    await t.test(name, async () => {
      const run = baseRun();
      mutate(run);
      const fake = createFake({ run });
      await assert.rejects(
        orchestrator(fake, async () => cleanPlan())({ userId: USER_ID, runId: RUN_ID, highCostConfirmed: false }),
        expectPublicError("RUN_NOT_FOUND")
      );
      assert.ok(fake.operations.indexOf("tx1:lock-policy") < fake.operations.indexOf("tx1:lock-run"));
    });
  }
});
