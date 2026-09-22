import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  createApplicationRunAnswerPacketService,
  type ApplicationRunAnswerPacketServiceDependencies
} from "@/lib/application-runs/answer-packet-service";
import { FORM_INSPECTION_SCHEMA_VERSION } from "@/lib/application-runs/form-inspection";
import {
  createPostgresTestActor,
  createSyntheticTestUser,
  deleteSyntheticTestUsers,
  disconnectPostgresTestActors
} from "@/tests/postgres/postgres-test-harness";

const LOCK_TEST_TIMEOUT_MS = 30_000;
const APPLY_HOST = "jobs.example.com";
const APPLY_URL = `https://${APPLY_HOST}/apply/f3a-lock-test`;

type CapturedRawQuery = {
  table: "ApplicationAnswer" | "ResumeVersion" | "GeneratedDocument";
  sql: string;
  rows: Array<Record<string, unknown>>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sqlText(query: unknown): string {
  if (Array.isArray(query)) return query.join("?");
  if (query && typeof query === "object" && "strings" in query) {
    return Array.from((query as { strings: readonly string[] }).strings).join("?");
  }
  return String(query);
}

function formReport() {
  const constraints = {
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    step: null,
    acceptedFileTypes: [] as string[],
    multiple: false
  };
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Candidate",
        fields: [
          {
            question: "LinkedIn profile URL",
            helpText: null,
            fieldType: "URL",
            unsupportedReason: null,
            required: true,
            autocomplete: "url",
            constraints,
            choices: []
          },
          {
            question: "Upload resume",
            helpText: null,
            fieldType: "FILE_UPLOAD",
            unsupportedReason: null,
            required: true,
            autocomplete: null,
            constraints,
            choices: []
          },
          {
            question: "Upload cover letter",
            helpText: null,
            fieldType: "FILE_UPLOAD",
            unsupportedReason: null,
            required: true,
            autocomplete: null,
            constraints,
            choices: []
          }
        ]
      }]
    }]
  };
}

test("production packet source/document FOR SHARE queries execute on PostgreSQL 16", { timeout: LOCK_TEST_TIMEOUT_MS }, async () => {
  const actor = await createPostgresTestActor("f3a-packet-locks");
  const user = await createSyntheticTestUser(actor, "f3a-packet-locks");
  const captured: CapturedRawQuery[] = [];

  try {
    const job = await actor.client.jobPosting.create({
      data: {
        userId: user.id,
        title: "F3a Lock Test",
        normalizedTitle: `f3a-lock-test-${randomUUID()}`,
        company: "Example",
        normalizedCompany: `example-${randomUUID()}`,
        normalizedLocation: "remote",
        sourceUrl: APPLY_URL,
        applyUrl: APPLY_URL,
        normalizedApplyUrl: APPLY_URL,
        description: "Disposable F3a PostgreSQL lock execution fixture.",
        requirements: [],
        preferredQualifications: [],
        benefits: [],
        detectedTechStack: [],
        missingKeywords: [],
        supportedKeywords: [],
        concerns: [],
        sourceType: "MANUAL"
      }
    });
    const application = await actor.client.application.create({
      data: { userId: user.id, jobPostingId: job.id }
    });
    const resumeText = "F3a PostgreSQL resume lock text";
    const coverText = "F3a PostgreSQL cover-letter lock text";
    const resume = await actor.client.resumeVersion.create({
      data: {
        userId: user.id,
        jobPostingId: job.id,
        title: "F3a Resume",
        skills: [],
        fullText: resumeText
      }
    });
    const cover = await actor.client.generatedDocument.create({
      data: {
        userId: user.id,
        jobPostingId: job.id,
        type: "COVER_LETTER",
        title: "F3a Cover Letter",
        content: coverText
      }
    });
    const run = await actor.client.applicationRun.create({
      data: {
        userId: user.id,
        jobPostingId: job.id,
        applicationId: application.id,
        state: "READY",
        stateVersion: 4,
        idempotencyKey: `f3a-lock-${randomUUID()}`,
        applyUrlSnapshot: APPLY_URL,
        applyHost: APPLY_HOST,
        resumeVersionId: resume.id,
        resumeContentHash: sha256(resumeText),
        coverLetterVersionId: cover.id,
        coverLetterContentHash: sha256(coverText)
      }
    });
    await actor.client.applicationAutomationPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        allowedHosts: [APPLY_HOST],
        sensitiveAnswerPolicy: "EXCLUDE",
        finalReviewRequired: true
      }
    });
    const vaultIds = ["f3a-vault-z", "f3a-vault-a"];
    await actor.client.applicationAnswer.createMany({
      data: [
        {
          id: vaultIds[0],
          userId: user.id,
          category: "LINKS",
          question: "LinkedIn profile URL",
          normalizedQuestion: `linkedin-z-${randomUUID()}`,
          answer: "https://www.linkedin.com/in/z"
        },
        {
          id: vaultIds[1],
          userId: user.id,
          category: "LINKS",
          question: "LinkedIn profile URL",
          normalizedQuestion: `linkedin-a-${randomUUID()}`,
          answer: "https://www.linkedin.com/in/a"
        }
      ]
    });

    const instrumentedClient = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        actor.client.$transaction(async (tx) => {
          const instrumentedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
              return async (...args: unknown[]) => {
                const sql = sqlText(args[0]).replace(/\s+/g, " ").trim();
                const rows = await (target.$queryRaw as (...rawArgs: unknown[]) => Promise<unknown[]>)(...args);
                for (const table of ["ApplicationAnswer", "ResumeVersion", "GeneratedDocument"] as const) {
                  if (sql.includes(`FROM "${table}"`)) {
                    captured.push({ table, sql, rows: rows as Array<Record<string, unknown>> });
                  }
                }
                return rows;
              };
            }
          });
          return callback(instrumentedTx);
        }, options as Parameters<typeof actor.client.$transaction>[1])
    };
    const packetService = createApplicationRunAnswerPacketService({
      prismaClient: instrumentedClient as NonNullable<ApplicationRunAnswerPacketServiceDependencies["prismaClient"]>,
      env: { APPLICATION_AUTOMATION_ENABLED: "true" },
      clock: () => new Date("2026-08-26T20:00:00.000Z")
    });

    const result = await packetService.publishFormInspectionAndAnswerPacket({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: 4,
      expectedFormInspectionVersion: 0,
      expectedAnswerPacketVersion: 0,
      observedUrl: `${APPLY_URL}#ignored-fragment`,
      inspectionReport: formReport()
    });

    assert.equal(result.packetVersion, 1);
    assert.deepEqual(captured.map(({ table }) => table), [
      "ApplicationAnswer",
      "ResumeVersion",
      "GeneratedDocument"
    ]);
    const answerLock = captured[0];
    assert.match(answerLock.sql, /ORDER BY "id" ASC LIMIT 257 FOR SHARE/);
    assert.deepEqual(answerLock.rows.map((row) => row.id), ["f3a-vault-a", "f3a-vault-z"]);
    assert.equal(typeof answerLock.rows[0].question, "string");
    assert.equal(typeof answerLock.rows[0].answer, "string");
    assert.ok(answerLock.rows[0].updatedAt instanceof Date);

    const resumeLock = captured[1];
    assert.match(resumeLock.sql, /FROM "ResumeVersion"/);
    assert.match(resumeLock.sql, /FOR SHARE/);
    assert.equal(resumeLock.rows[0].fullText, resumeText);
    assert.ok(resumeLock.rows[0].createdAt instanceof Date);

    const coverLock = captured[2];
    assert.match(coverLock.sql, /FROM "GeneratedDocument"/);
    assert.match(coverLock.sql, /FOR SHARE/);
    assert.equal(coverLock.rows[0].content, coverText);
    assert.ok(coverLock.rows[0].createdAt instanceof Date);
  } finally {
    await deleteSyntheticTestUsers(actor, [user.id]);
    await disconnectPostgresTestActors([actor]);
  }
});
