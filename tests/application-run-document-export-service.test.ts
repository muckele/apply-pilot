import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { computeApplicationAnswerProposalHash } from "@/lib/application-runs/answer-packet-domain";
import type { VerifiedCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import {
  createApplicationRunDocumentExportService,
  type ApplicationRunDocumentExportServiceDependencies
} from "@/lib/application-runs/document-export";

const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const ANSWER_ID = "clz8w7m9a0005qwer1234tyui";
const HISTORICAL_ANSWER_ID = "clz8w7m9a0006qwer1234tyui";
const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const JOB_ID = "clz8w7m9a0002qwer1234tyui";
const RESUME_ID = "resume-version-current";
const COVER_ID = "cover-letter-current";
const PACKET_ID = "packet-current";
const PACKET_HASH = "d".repeat(64);
const FIELD_KEY = "b".repeat(64);
const FIELD_FINGERPRINT = "c".repeat(64);
const REVIEWED_AT = new Date("2026-08-26T20:00:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCode(error: unknown, code: string): true {
  assert.equal(error instanceof PublicApiError ? error.details?.code : undefined, code);
  return true;
}

type ArtifactType = "RESUME" | "COVER_LETTER";

class FakeDocumentExportDatabase {
  inTransaction = false;
  transactionOptions: unknown[] = [];
  queryLog: string[] = [];
  queryValues: unknown[][] = [];
  renderInputs: Array<{ artifactType: ArtifactType; content: string }> = [];
  renderFailure: Error | null = null;
  verifiedFailure: Error | null = null;

  run = {
    id: RUN_ID,
    userId: USER_ID,
    applicationId: APPLICATION_ID,
    jobPostingId: JOB_ID,
    state: "READY",
    stateVersion: 7,
    currentFormInspectionVersion: 3,
    currentAnswerPacketVersion: 4,
    applyUrlSnapshot: "https://jobs.example.com/apply",
    applyHost: "jobs.example.com",
    resumeVersionId: RESUME_ID as string | null,
    resumeContentHash: sha256("Approved résumé content") as string | null,
    coverLetterVersionId: null as string | null,
    coverLetterContentHash: null as string | null,
    application: { id: APPLICATION_ID, userId: USER_ID, jobPostingId: JOB_ID },
    jobPosting: { id: JOB_ID, userId: USER_ID }
  };

  field = {
    normalizedFieldKey: FIELD_KEY,
    semanticFieldKey: "document.resume",
    question: "Upload your resume",
    normalizedQuestion: "upload your resume",
    helpText: null,
    fieldType: "FILE_UPLOAD",
    classification: "DOCUMENT",
    permittedDisposition: "PROPOSABLE",
    dispositionReason: null,
    unsupportedReason: null,
    required: true,
    autocomplete: null,
    constraints: {
      minLength: null,
      maxLength: null,
      min: null,
      max: null,
      step: null,
      acceptedFileTypes: ["DOCX"] as string[],
      multiple: false
    },
    choices: [],
    fieldFingerprint: FIELD_FINGERPRINT
  };

  proposal = {
    kind: "DOCUMENT_REFERENCE" as const,
    artifactType: "RESUME" as ArtifactType,
    documentId: RESUME_ID,
    contentHash: this.run.resumeContentHash!
  };

  answer = {
    id: ANSWER_ID,
    runId: RUN_ID,
    userId: USER_ID,
    answerPacketId: PACKET_ID,
    normalizedFieldKey: FIELD_KEY,
    originalQuestion: "Upload your resume",
    normalizedQuestion: "upload your resume",
    fieldFingerprint: FIELD_FINGERPRINT,
    semanticFieldKey: "document.resume",
    fieldType: "FILE_UPLOAD",
    classification: "DOCUMENT",
    disposition: "PROPOSABLE",
    dispositionReason: null,
    proposedValue: null,
    proposal: this.proposal as unknown,
    valueRedacted: false,
    sourceType: "TAILORED_RESUME",
    sourceIds: [RESUME_ID],
    evidenceIds: [],
    sourceFingerprint: "e".repeat(64),
    confidence: 100,
    sensitive: false,
    required: true,
    requiresReview: true,
    status: "APPROVED",
    reviewedByUser: true,
    reviewedAt: REVIEWED_AT as Date | null,
    finalValueHash: computeApplicationAnswerProposalHash(this.proposal) as string | null,
    reviewHashVersion: "CANONICAL_PROPOSAL_V1",
    createdAt: REVIEWED_AT,
    updatedAt: REVIEWED_AT
  };

  resumeRows = [{
    id: RESUME_ID,
    userId: USER_ID,
    jobPostingId: JOB_ID,
    fullText: "Approved résumé content",
    title: "Mutable title",
    template: "MODERN",
    pageSize: "A4",
    fontFamily: "GEORGIA",
    accentColor: "#FFFFFF",
    fontSize: 14,
    lineSpacing: 150
  }];

  coverRows: Array<{
    id: string;
    userId: string;
    jobPostingId: string;
    type: string;
    content: string;
    title: string;
  }> = [];

  verified(): VerifiedCurrentAnswerPacket {
    return {
      inspection: {} as never,
      snapshot: {} as never,
      fieldsByKey: new Map([[FIELD_KEY, this.field as never]]),
      packetRecord: {
        id: PACKET_ID,
        runId: RUN_ID,
        userId: USER_ID,
        version: this.run.currentAnswerPacketVersion,
        formInspectionId: "inspection-current",
        schemaVersion: 1,
        builderVersion: 1,
        policyHash: "a".repeat(64),
        inputHash: "f".repeat(64),
        packetHash: PACKET_HASH,
        reviewedAt: REVIEWED_AT,
        createdAt: REVIEWED_AT
      },
      answerRows: [this.answer] as never,
      packet: {} as never,
      validationContext: { fields: [] },
      summary: {} as never,
      ownerSafe: {} as never
    };
  }

  private sqlText(query: unknown): string {
    if (Array.isArray(query)) return query.join("?");
    if (query && typeof query === "object" && "strings" in query) {
      return Array.from((query as { strings: readonly string[] }).strings).join("?");
    }
    return String(query);
  }

  private transactionClient() {
    return {
      $queryRaw: async <T>(query: unknown, ...values: unknown[]): Promise<T> => {
        const sql = this.sqlText(query).replace(/\s+/g, " ").trim();
        this.queryLog.push(sql);
        this.queryValues.push(values);
        if (sql.includes('FROM "ApplicationRun"')) {
          const [runId, userId] = values;
          return (this.run.id === runId && this.run.userId === userId ? [{ id: this.run.id }] : []) as T;
        }
        if (sql.includes('FROM "ResumeVersion"')) {
          const [id, userId, jobPostingId] = values;
          return this.resumeRows.filter((row) =>
            row.id === id && row.userId === userId && row.jobPostingId === jobPostingId
          ) as T;
        }
        if (sql.includes('FROM "GeneratedDocument"')) {
          const [id, userId, jobPostingId] = values;
          return this.coverRows.filter((row) =>
            row.id === id && row.userId === userId && row.jobPostingId === jobPostingId && row.type === "COVER_LETTER"
          ) as T;
        }
        throw new Error(`Unexpected raw query: ${sql}`);
      },
      applicationRun: {
        findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
          this.run.id === where.id && this.run.userId === where.userId ? this.run : null
      }
    };
  }

  client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>, options?: unknown): Promise<T> => {
      this.transactionOptions.push(options);
      this.inTransaction = true;
      try {
        return await callback(this.transactionClient());
      } finally {
        this.inTransaction = false;
      }
    }
  };

  service() {
    return createApplicationRunDocumentExportService({
      prismaClient: this.client as unknown as NonNullable<
        ApplicationRunDocumentExportServiceDependencies["prismaClient"]
      >,
      loadVerifiedCurrentAnswerPacketForLockedRunInTransaction: async () => {
        assert.equal(this.inTransaction, true);
        if (this.verifiedFailure) throw this.verifiedFailure;
        return this.verified();
      },
      renderCanonicalApplicationDocumentV1: async (input) => {
        assert.equal(this.inTransaction, false, "DOCX rendering must occur after transaction commit");
        this.renderInputs.push({ ...input });
        if (this.renderFailure) throw this.renderFailure;
        return Buffer.from(`docx:${input.artifactType}:${input.content}`, "utf8");
      }
    });
  }
}

function exportInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    expectedStateVersion: 7,
    answerPacketVersion: 4,
    packetHash: PACKET_HASH,
    format: "docx",
    ...overrides
  };
}

function configureCoverLetter(database: FakeDocumentExportDatabase): void {
  const content = "Approved cover letter content";
  const contentHash = sha256(content);
  database.run.resumeVersionId = null;
  database.run.resumeContentHash = null;
  database.run.coverLetterVersionId = COVER_ID;
  database.run.coverLetterContentHash = contentHash;
  database.field.semanticFieldKey = "document.cover_letter";
  database.field.question = "Upload your cover letter";
  database.field.normalizedQuestion = "upload your cover letter";
  database.proposal.artifactType = "COVER_LETTER";
  database.proposal.documentId = COVER_ID;
  database.proposal.contentHash = contentHash;
  database.answer.originalQuestion = "Upload your cover letter";
  database.answer.normalizedQuestion = "upload your cover letter";
  database.answer.semanticFieldKey = "document.cover_letter";
  database.answer.proposal = database.proposal;
  database.answer.sourceType = "COVER_LETTER";
  database.answer.sourceIds = [COVER_ID];
  database.answer.finalValueHash = computeApplicationAnswerProposalHash(database.proposal);
  database.resumeRows = [];
  database.coverRows = [{
    id: COVER_ID,
    userId: USER_ID,
    jobPostingId: JOB_ID,
    type: "COVER_LETTER",
    content,
    title: "Mutable cover title"
  }];
}

test("valid current approved resume authorizes under FOR SHARE locks and renders after commit", async () => {
  const database = new FakeDocumentExportDatabase();

  const result = await database.service().exportApprovedApplicationRunDocument(exportInput());

  assert.deepEqual(result, {
    bytes: Buffer.from("docx:RESUME:Approved résumé content", "utf8"),
    artifactType: "RESUME",
    format: "docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "apply-pilot-resume.docx"
  });
  assert.deepEqual(database.renderInputs, [{ artifactType: "RESUME", content: "Approved résumé content" }]);
  assert.equal(database.transactionOptions[0], undefined);
  assert.match(database.queryLog[0], /ApplicationRun.*FOR SHARE/);
  assert.match(database.queryLog[1], /ResumeVersion.*FOR SHARE/);
});

test("valid current approved cover letter uses fixed metadata without mutable title authority", async () => {
  const database = new FakeDocumentExportDatabase();
  configureCoverLetter(database);

  const result = await database.service().exportApprovedApplicationRunDocument(exportInput());

  assert.equal(result.artifactType, "COVER_LETTER");
  assert.equal(result.filename, "apply-pilot-cover-letter.docx");
  assert.deepEqual(database.renderInputs, [{
    artifactType: "COVER_LETTER",
    content: "Approved cover letter content"
  }]);
  assert.match(database.queryLog[1], /GeneratedDocument.*FOR SHARE/);
});

test("PENDING and REJECTED current document answers are not approved export authority", async (t) => {
  for (const status of ["PENDING", "REJECTED"] as const) {
    await t.test(status, async () => {
      const database = new FakeDocumentExportDatabase();
      database.answer.status = status;
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput()),
        (error) => assertCode(error, "RUN_DOCUMENT_ANSWER_NOT_APPROVED")
      );
      assert.deepEqual(database.renderInputs, []);
    });
  }
});

test("wrong, missing, and historical answer IDs cannot escape the verified current packet", async (t) => {
  for (const answerId of ["clz8w7m9a0007qwer1234tyui", HISTORICAL_ANSWER_ID]) {
    await t.test(answerId, async () => {
      const database = new FakeDocumentExportDatabase();
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput({ answerId })),
        (error) => assertCode(error, "RUN_ANSWER_NOT_FOUND")
      );
    });
  }
});

test("wrong owner is hidden behind RUN_NOT_FOUND", async () => {
  const database = new FakeDocumentExportDatabase();
  await assert.rejects(
    database.service().exportApprovedApplicationRunDocument(exportInput({ userId: OTHER_USER_ID })),
    (error) => assertCode(error, "RUN_NOT_FOUND")
  );
});

test("non-READY state and stale lifecycle version fail before packet/source authorization", async (t) => {
  await t.test("state", async () => {
    const database = new FakeDocumentExportDatabase();
    database.run.state = "REVIEW_REQUIRED";
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_INVALID_STATE")
    );
  });
  await t.test("version", async () => {
    const database = new FakeDocumentExportDatabase();
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput({ expectedStateVersion: 6 })),
      (error) => assertCode(error, "RUN_LIFECYCLE_STALE")
    );
  });
});

test("stale packet version and hash return RUN_PACKET_STALE without current values", async (t) => {
  for (const input of [{ answerPacketVersion: 3 }, { packetHash: "a".repeat(64) }]) {
    await t.test(JSON.stringify(input), async () => {
      const database = new FakeDocumentExportDatabase();
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput(input)),
        (error: unknown) => {
          assertCode(error, "RUN_PACKET_STALE");
          assert.deepEqual(error instanceof PublicApiError ? error.details : null, { code: "RUN_PACKET_STALE" });
          return true;
        }
      );
    });
  }
});

test("unreviewed packet and corrupt packet verification fail closed", async (t) => {
  await t.test("review incomplete", async () => {
    const database = new FakeDocumentExportDatabase();
    const originalVerified = database.verified.bind(database);
    database.verified = () => {
      const verified = originalVerified();
      verified.packetRecord.reviewedAt = null;
      return verified;
    };
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_PACKET_REVIEW_INCOMPLETE")
    );
  });
  await t.test("verified helper integrity error", async () => {
    const database = new FakeDocumentExportDatabase();
    database.verifiedFailure = new PublicApiError("Inspection invalid.", 409, { code: "RUN_INSPECTION_INVALID" });
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_PACKET_INVALID")
    );
  });
  await t.test("approval hash", async () => {
    const database = new FakeDocumentExportDatabase();
    database.answer.finalValueHash = "0".repeat(64);
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_PACKET_INVALID")
    );
  });
});

test("corrupt approved answer invariants fail as RUN_PACKET_INVALID", async (t) => {
  const mutations: Array<[string, (database: FakeDocumentExportDatabase) => void]> = [
    ["field type", (database) => { database.answer.fieldType = "TEXT"; }],
    ["classification", (database) => { database.answer.classification = "CONTACT"; }],
    ["disposition", (database) => { database.answer.disposition = "MANUAL_ONLY"; }],
    ["requires review", (database) => { database.answer.requiresReview = false; }],
    ["sensitive", (database) => { database.answer.sensitive = true; }],
    ["redacted", (database) => { database.answer.valueRedacted = true; }],
    ["reviewed by user", (database) => { database.answer.reviewedByUser = false; }],
    ["reviewed at", (database) => { database.answer.reviewedAt = null; }],
    ["review hash version", (database) => { database.answer.reviewHashVersion = "LEGACY_SCALAR_SHA256"; }],
    ["missing final hash", (database) => { database.answer.finalValueHash = null; }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const database = new FakeDocumentExportDatabase();
      mutate(database);
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput()),
        (error) => assertCode(error, "RUN_PACKET_INVALID")
      );
    });
  }
});

test("semantic artifact and provenance mismatches invalidate current approval", async (t) => {
  const mutations: Array<[string, (database: FakeDocumentExportDatabase) => void]> = [
    ["semantic", (database) => { database.field.semanticFieldKey = "document.cover_letter"; }],
    ["artifact", (database) => { database.proposal.artifactType = "COVER_LETTER"; }],
    ["source type", (database) => { database.answer.sourceType = "COVER_LETTER"; }],
    ["source id", (database) => { database.answer.sourceIds = [COVER_ID]; }],
    ["proposal document", (database) => { database.proposal.documentId = COVER_ID; }],
    ["proposal content", (database) => { database.proposal.contentHash = "1".repeat(64); }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const database = new FakeDocumentExportDatabase();
      mutate(database);
      database.answer.finalValueHash = computeApplicationAnswerProposalHash(database.proposal);
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput()),
        (error) => assertCode(error, "RUN_PACKET_INVALID")
      );
    });
  }
});

test("resume and cover content changes return RUN_DOCUMENT_STALE", async (t) => {
  await t.test("resume", async () => {
    const database = new FakeDocumentExportDatabase();
    database.resumeRows[0].fullText = "Edited résumé content";
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_DOCUMENT_STALE")
    );
  });
  await t.test("cover", async () => {
    const database = new FakeDocumentExportDatabase();
    configureCoverLetter(database);
    database.coverRows[0].content = "Edited cover letter content";
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_DOCUMENT_STALE")
    );
  });
});

test("resume format/title-only and cover title-only changes do not stale canonical authority", async (t) => {
  await t.test("resume", async () => {
    const database = new FakeDocumentExportDatabase();
    Object.assign(database.resumeRows[0], {
      title: "Entirely new title",
      template: "COMPACT",
      pageSize: "LETTER",
      fontFamily: "CALIBRI",
      accentColor: "#000000",
      fontSize: 8,
      lineSpacing: 100
    });
    const result = await database.service().exportApprovedApplicationRunDocument(exportInput());
    assert.equal(result.artifactType, "RESUME");
  });
  await t.test("cover", async () => {
    const database = new FakeDocumentExportDatabase();
    configureCoverLetter(database);
    database.coverRows[0].title = "Entirely new cover title";
    const result = await database.service().exportApprovedApplicationRunDocument(exportInput());
    assert.equal(result.artifactType, "COVER_LETTER");
  });
});

test("unsupported requested format and frozen file constraints return the approved format error", async (t) => {
  await t.test("request", async () => {
    const database = new FakeDocumentExportDatabase();
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput({ format: "pdf" })),
      (error) => assertCode(error, "RUN_DOCUMENT_FORMAT_UNSUPPORTED")
    );
  });
  await t.test("frozen PDF only", async () => {
    const database = new FakeDocumentExportDatabase();
    database.field.constraints.acceptedFileTypes = ["PDF"];
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_DOCUMENT_FORMAT_UNSUPPORTED")
    );
  });
  await t.test("frozen DOC does not imply DOCX", async () => {
    const database = new FakeDocumentExportDatabase();
    database.field.constraints.acceptedFileTypes = ["DOC"];
    await assert.rejects(
      database.service().exportApprovedApplicationRunDocument(exportInput()),
      (error) => assertCode(error, "RUN_DOCUMENT_FORMAT_UNSUPPORTED")
    );
  });
  await t.test("empty accepted types allows DOCX", async () => {
    const database = new FakeDocumentExportDatabase();
    database.field.constraints.acceptedFileTypes = [];
    const result = await database.service().exportApprovedApplicationRunDocument(exportInput());
    assert.equal(result.format, "docx");
  });
});

test("missing or wrong owner/job/type selected sources collapse to RUN_DOCUMENT_STALE", async (t) => {
  const cases: Array<[string, (database: FakeDocumentExportDatabase) => void]> = [
    ["missing", (database) => { database.resumeRows = []; }],
    ["wrong owner", (database) => { database.resumeRows[0].userId = OTHER_USER_ID; }],
    ["wrong job", (database) => { database.resumeRows[0].jobPostingId = "other-job"; }],
    ["wrong cover type", (database) => {
      configureCoverLetter(database);
      database.coverRows[0].type = "INTERVIEW_PREP";
    }]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const database = new FakeDocumentExportDatabase();
      mutate(database);
      await assert.rejects(
        database.service().exportApprovedApplicationRunDocument(exportInput()),
        (error) => assertCode(error, "RUN_DOCUMENT_STALE")
      );
    });
  }
});

test("canonical renderer failure is content-free RUN_DOCUMENT_RENDER_FAILED", async () => {
  const database = new FakeDocumentExportDatabase();
  database.renderFailure = new Error("renderer leaked Approved résumé content and internal hash");

  await assert.rejects(
    database.service().exportApprovedApplicationRunDocument(exportInput()),
    (error: unknown) => {
      assertCode(error, "RUN_DOCUMENT_RENDER_FAILED");
      assert.deepEqual(error instanceof PublicApiError ? error.details : null, {
        code: "RUN_DOCUMENT_RENDER_FAILED"
      });
      assert.doesNotMatch(error instanceof Error ? error.message : "", /résumé|hash|renderer leaked/i);
      return true;
    }
  );
});
