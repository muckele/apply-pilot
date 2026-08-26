import { createHash } from "node:crypto";

import { Prisma, type ApplicationRunState } from "@prisma/client";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  ANSWER_PACKET_BUILDER_VERSION,
  ANSWER_PACKET_CANONICALIZER_VERSION,
  ANSWER_PACKET_SCHEMA_VERSION,
  assertApplicationAnswerDispositionWithinPermitted,
  canonicalizeApplicationAnswerPacketInputProjection,
  canonicalizeApplicationAnswerPacketProjection,
  computeApplicationAnswerPacketHash,
  computeApplicationAnswerPacketInputHash,
  computeApplicationAnswerPacketPolicyHash,
  computeApplicationAnswerSourceFingerprint,
  parseCompatibleApplicationAnswerProposal,
  summarizeApplicationAnswerPacket,
  type ApplicationAnswerPacketProjection,
  type ApplicationAnswerPacketSummary,
  type ApplicationAnswerProposal,
  type ApplicationAnswerPacketValidationContext
} from "@/lib/application-runs/answer-packet-domain";
import { revokeUsableExecutionTokensForRunInTransaction } from "@/lib/application-runs/execution-token";
import {
  FIELD_FINGERPRINT_VERSION,
  FORM_INSPECTION_SCHEMA_VERSION,
  FORM_NORMALIZER_VERSION,
  MAX_FUTURE_OBSERVED_URL_CODE_POINTS,
  buildNormalizedApplicationFormInspection,
  canonicalizeFormComparisonText,
  sanitizeFormDisplayText,
  verifyNormalizedApplicationFormSnapshot,
  type NormalizedApplicationFormField,
  type NormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";
import {
  assertExecutionHostAllowed,
  parseExecutionTargetUrl,
  type ExecutionTarget
} from "@/lib/application-runs/host-policy";
import { assertAutomationCapability, type AutomationEnv } from "@/lib/application-runs/policy";
import { CLASSIFIER_VERSION, classifyApplicationQuestion } from "@/lib/application-runs/question-classification";
import { prisma } from "@/lib/prisma";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const serviceUserIdSchema = z.string().trim().min(1).max(128);
const serviceRunIdSchema = z.string().cuid();
const nonnegativeVersionSchema = z.number().int().safe().nonnegative();

const publicationInputSchema = z
  .object({
    userId: serviceUserIdSchema,
    runId: serviceRunIdSchema,
    expectedStateVersion: nonnegativeVersionSchema,
    expectedFormInspectionVersion: nonnegativeVersionSchema,
    expectedAnswerPacketVersion: nonnegativeVersionSchema,
    observedUrl: z.string().max(MAX_FUTURE_OBSERVED_URL_CODE_POINTS),
    inspectionReport: z.unknown()
  })
  .strict();

const rebuildInputSchema = z
  .object({
    userId: serviceUserIdSchema,
    runId: serviceRunIdSchema,
    expectedStateVersion: nonnegativeVersionSchema,
    expectedFormInspectionVersion: nonnegativeVersionSchema,
    expectedAnswerPacketVersion: nonnegativeVersionSchema
  })
  .strict();

const currentReadInputSchema = z
  .object({ userId: serviceUserIdSchema, runId: serviceRunIdSchema })
  .strict();

type LockedPolicy = {
  id: string;
  userId: string;
  enabled: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
  sensitiveAnswerPolicy: "EXCLUDE";
  finalReviewRequired: boolean;
};

export type LockedAnswerPacketRun = {
  id: string;
  userId: string;
  applicationId: string;
  jobPostingId: string;
  state: ApplicationRunState;
  stateVersion: number;
  currentFormInspectionVersion: number;
  currentAnswerPacketVersion: number;
  applyUrlSnapshot: string;
  applyHost: string;
  resumeVersionId: string | null;
  resumeContentHash: string | null;
  coverLetterVersionId: string | null;
  coverLetterContentHash: string | null;
  application: { id: string; userId: string; jobPostingId: string };
  jobPosting: { id: string; userId: string };
};

type StoredInspection = {
  id: string;
  runId: string;
  userId: string;
  version: number;
  schemaVersion: number;
  normalizerVersion: number;
  classifierVersion: number;
  fingerprintVersion: number;
  formFingerprint: string;
  normalizedSnapshot: unknown;
  createdAt: Date;
};

type StoredPacket = {
  id: string;
  runId: string;
  userId: string;
  version: number;
  formInspectionId: string;
  schemaVersion: number;
  builderVersion: number;
  policyHash: string;
  inputHash: string;
  packetHash: string;
  reviewedAt: Date | null;
  createdAt: Date;
};

type StoredPacketAnswer = {
  id: string;
  runId: string;
  userId: string;
  answerPacketId: string | null;
  normalizedFieldKey: string;
  originalQuestion: string;
  normalizedQuestion: string | null;
  fieldFingerprint: string | null;
  semanticFieldKey: string | null;
  fieldType: NormalizedApplicationFormField["fieldType"] | null;
  classification: NormalizedApplicationFormField["classification"] | null;
  disposition: NormalizedApplicationFormField["permittedDisposition"] | null;
  dispositionReason: NormalizedApplicationFormField["dispositionReason"];
  proposedValue: string | null;
  proposal: unknown;
  valueRedacted: boolean;
  sourceType: "ANSWER_VAULT" | "TAILORED_RESUME" | "COVER_LETTER" | null;
  sourceIds: string[];
  evidenceIds: string[];
  sourceFingerprint: string | null;
  confidence: number;
  sensitive: boolean;
  required: boolean;
  requiresReview: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByUser: boolean;
  reviewedAt: Date | null;
  finalValueHash: string | null;
  reviewHashVersion: "LEGACY_SCALAR_SHA256" | "CANONICAL_PROPOSAL_V1" | null;
  createdAt: Date;
  updatedAt: Date;
};

type AnswerVaultRow = {
  id: string;
  category: string;
  question: string;
  answer: string;
  updatedAt: Date;
};

type LockedResume = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  fullText: string;
  createdAt: Date;
};

type LockedCoverLetter = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  type: "COVER_LETTER";
  content: string;
  createdAt: Date;
};

export type ApplicationRunAnswerPacketTransaction = Prisma.TransactionClient;

export type ApplicationRunAnswerPacketServiceDependencies = {
  prismaClient?: Pick<typeof prisma, "$transaction">;
  env?: AutomationEnv;
  clock?: () => Date;
};

type OwnerSafeAnswer = {
  id: string;
  normalizedFieldKey: string;
  originalQuestion: string;
  normalizedQuestion: string;
  semanticFieldKey: string | null;
  fieldType: NormalizedApplicationFormField["fieldType"];
  classification: NormalizedApplicationFormField["classification"];
  disposition: NormalizedApplicationFormField["permittedDisposition"];
  dispositionReason: NormalizedApplicationFormField["dispositionReason"];
  proposal: ApplicationAnswerProposal | null;
  required: boolean;
  requiresReview: boolean;
  sensitive: boolean;
  valueRedacted: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByUser: boolean;
  reviewedAt: Date | null;
};

type OwnerSafePacket = {
  inspectionVersion: number;
  packetVersion: number;
  packetHash: string;
  reviewedAt: Date | null;
  createdAt: Date;
  summary: ApplicationAnswerPacketSummary;
  answers: OwnerSafeAnswer[];
};

export type VerifiedCurrentAnswerPacket = {
  inspection: StoredInspection;
  snapshot: NormalizedApplicationFormSnapshot;
  fieldsByKey: ReadonlyMap<string, NormalizedApplicationFormField>;
  packetRecord: StoredPacket;
  answerRows: readonly StoredPacketAnswer[];
  packet: ApplicationAnswerPacketProjection;
  validationContext: ApplicationAnswerPacketValidationContext;
  summary: ApplicationAnswerPacketSummary;
  ownerSafe: OwnerSafePacket;
};

type MaterialResult = {
  replayed: boolean;
  runId: string;
  state: ApplicationRunState;
  stateVersion: number;
  inspectionVersion: number;
  packetVersion: number;
  packetHash: string;
  packet: OwnerSafePacket;
};

type PointerRows = {
  inspection: StoredInspection;
  packet: StoredPacket;
} | null;

type CandidateAnswer = ApplicationAnswerPacketProjection["answers"][number];

type CandidatePacket = {
  inspectionVersion: number;
  policyHash: string;
  inputHash: string;
  packetHash: string;
  packet: ApplicationAnswerPacketProjection;
  validationContext: ApplicationAnswerPacketValidationContext;
  summary: ApplicationAnswerPacketSummary;
  answers: CandidateAnswer[];
};

function publicError(message: string, code: string): PublicApiError {
  return new PublicApiError(message, 409, { code });
}

function runNotFound(): PublicApiError {
  return new PublicApiError("This application run was not found.", 404, { code: "RUN_NOT_FOUND" });
}

function invalidState(): PublicApiError {
  return publicError("Answers cannot be prepared in this application run state.", "RUN_INVALID_STATE");
}

function staleLifecycle(): PublicApiError {
  return publicError("This application run changed before the request could be completed.", "RUN_LIFECYCLE_STALE");
}

function inspectionStale(): PublicApiError {
  return publicError("The current form inspection must be refreshed.", "RUN_INSPECTION_STALE");
}

function inspectionInvalid(): PublicApiError {
  return publicError("The current form inspection is invalid.", "RUN_INSPECTION_INVALID");
}

function packetInvalid(): PublicApiError {
  return publicError("The current answer packet is invalid.", "RUN_PACKET_INVALID");
}

function documentStale(): PublicApiError {
  return publicError("A selected application document has changed.", "RUN_DOCUMENT_STALE");
}

function sourceSetTooLarge(): PublicApiError {
  return publicError("The eligible answer source set is too large.", "RUN_ANSWER_SOURCE_SET_TOO_LARGE");
}

function isSupportedInspection(inspection: StoredInspection): boolean {
  return (
    inspection.schemaVersion === FORM_INSPECTION_SCHEMA_VERSION &&
    inspection.normalizerVersion === FORM_NORMALIZER_VERSION &&
    inspection.classifierVersion === CLASSIFIER_VERSION &&
    inspection.fingerprintVersion === FIELD_FINGERPRINT_VERSION
  );
}

function isSupportedPacket(packet: StoredPacket): boolean {
  return (
    packet.schemaVersion === ANSWER_PACKET_SCHEMA_VERSION &&
    packet.builderVersion === ANSWER_PACKET_BUILDER_VERSION
  );
}

function flattenFields(snapshot: NormalizedApplicationFormSnapshot): NormalizedApplicationFormField[] {
  return snapshot.forms.flatMap((form) => form.sections.flatMap((section) => section.fields));
}

function frozenField(field: NormalizedApplicationFormField) {
  return {
    normalizedFieldKey: field.normalizedFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType,
    semanticFieldKey: field.semanticFieldKey,
    choices: field.choices.map((choice) => ({ key: choice.key, disabled: choice.disabled }))
  };
}

function validationContextFor(answers: readonly CandidateAnswer[], fields: readonly NormalizedApplicationFormField[]) {
  const byKey = new Map(fields.map((field) => [field.normalizedFieldKey, field] as const));
  return {
    fields: answers
      .filter((answer) => answer.proposal?.kind === "OPTIONS")
      .map((answer) => frozenField(byKey.get(answer.normalizedFieldKey)!))
  } satisfies ApplicationAnswerPacketValidationContext;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveNow(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PublicApiError("The request could not be completed.", 500);
  }
  return now;
}

function canonicalTargetWithoutFragment(target: ExecutionTarget): string {
  const url = new URL(target.url.toString());
  url.hash = "";
  return url.toString();
}

function parseObservedTarget(value: string): ExecutionTarget {
  const target = parseExecutionTargetUrl(value);
  if (!target) {
    throw new PublicApiError("The observed application target is invalid.", 422, {
      code: "RUN_TARGET_INVALID"
    });
  }
  return target;
}

function assertRunRelationships(run: LockedAnswerPacketRun, userId: string): void {
  if (
    run.userId !== userId ||
    run.application.id !== run.applicationId ||
    run.application.userId !== userId ||
    run.application.jobPostingId !== run.jobPostingId ||
    run.jobPosting.id !== run.jobPostingId ||
    run.jobPosting.userId !== userId
  ) {
    throw runNotFound();
  }
}

async function lockPolicy(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  env: AutomationEnv
): Promise<LockedPolicy> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ApplicationAutomationPolicy"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new PublicApiError("Application automation is disabled.", 403, { code: "AUTOMATION_DISABLED" });
  }
  const policy = await tx.applicationAutomationPolicy.findUnique({ where: { userId } });
  if (!policy) {
    throw new PublicApiError("Application automation is disabled.", 403, { code: "AUTOMATION_DISABLED" });
  }
  assertAutomationCapability(policy, env);
  if (policy.sensitiveAnswerPolicy !== "EXCLUDE" || policy.finalReviewRequired !== true) {
    throw new PublicApiError("Application automation is disabled.", 403, { code: "AUTOMATION_DISABLED" });
  }
  return policy as LockedPolicy;
}

async function lockOwnedRun(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  runId: string
): Promise<LockedAnswerPacketRun> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ApplicationRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw runNotFound();
  const run = await tx.applicationRun.findFirst({
    where: { id: runId, userId },
    include: {
      application: { select: { id: true, userId: true, jobPostingId: true } },
      jobPosting: { select: { id: true, userId: true } }
    }
  });
  if (!run) throw runNotFound();
  assertRunRelationships(run as LockedAnswerPacketRun, userId);
  return run as LockedAnswerPacketRun;
}

async function readOwnedRun(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  runId: string
): Promise<LockedAnswerPacketRun> {
  const run = await tx.applicationRun.findFirst({
    where: { id: runId, userId },
    include: {
      application: { select: { id: true, userId: true, jobPostingId: true } },
      jobPosting: { select: { id: true, userId: true } }
    }
  });
  if (!run) throw runNotFound();
  assertRunRelationships(run as LockedAnswerPacketRun, userId);
  return run as LockedAnswerPacketRun;
}

function assertOperationalRun(run: LockedAnswerPacketRun, expectedStateVersion: number): void {
  if (run.state !== "READY" && run.state !== "REVIEW_REQUIRED") throw invalidState();
  if (run.stateVersion !== expectedStateVersion) throw staleLifecycle();
}

function assertAuthoritativeTarget(
  run: LockedAnswerPacketRun,
  policy: LockedPolicy,
  observedTarget?: ExecutionTarget
): ExecutionTarget {
  const authoritative = parseExecutionTargetUrl(run.applyUrlSnapshot);
  if (!authoritative || authoritative.host !== run.applyHost) {
    assertExecutionHostAllowed("", policy);
    throw new Error("unreachable");
  }
  if (observedTarget) {
    if (
      observedTarget.host !== authoritative.host ||
      canonicalTargetWithoutFragment(observedTarget) !== canonicalTargetWithoutFragment(authoritative)
    ) {
      throw publicError("The observed application target is no longer current.", "RUN_TARGET_STALE");
    }
  }
  assertExecutionHostAllowed(authoritative.host, policy);
  return authoritative;
}

async function loadPointerRows(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  run: LockedAnswerPacketRun
): Promise<PointerRows> {
  const inspectionVersion = run.currentFormInspectionVersion;
  const packetVersion = run.currentAnswerPacketVersion;
  if (inspectionVersion === 0 && packetVersion === 0) return null;
  if (inspectionVersion <= 0 || packetVersion <= 0) throw packetInvalid();

  const inspection = await tx.applicationRunFormInspection.findUnique({
    where: { runId_version: { runId: run.id, version: inspectionVersion } }
  }) as StoredInspection | null;
  if (
    !inspection ||
    inspection.runId !== run.id ||
    inspection.userId !== userId ||
    inspection.version !== inspectionVersion
  ) {
    throw inspectionInvalid();
  }

  const packet = await tx.applicationRunAnswerPacket.findUnique({
    where: { runId_version: { runId: run.id, version: packetVersion } }
  }) as StoredPacket | null;
  if (
    !packet ||
    packet.runId !== run.id ||
    packet.userId !== userId ||
    packet.version !== packetVersion ||
    packet.formInspectionId !== inspection.id
  ) {
    throw packetInvalid();
  }
  return { inspection, packet };
}

function packetProjectionFromRows(
  inspection: StoredInspection,
  packet: StoredPacket,
  rows: readonly StoredPacketAnswer[],
  snapshot: NormalizedApplicationFormSnapshot
): {
  packet: ApplicationAnswerPacketProjection;
  validationContext: ApplicationAnswerPacketValidationContext;
  fieldsByKey: Map<string, NormalizedApplicationFormField>;
} {
  const fields = flattenFields(snapshot);
  const fieldsByKey = new Map(fields.map((field) => [field.normalizedFieldKey, field] as const));
  if (rows.length !== fields.length) throw packetInvalid();
  const answerKeys = new Set<string>();
  const answers: CandidateAnswer[] = rows.map((row) => {
    const field = fieldsByKey.get(row.normalizedFieldKey);
    if (
      !field ||
      answerKeys.has(row.normalizedFieldKey) ||
      row.runId !== packet.runId ||
      row.userId !== packet.userId ||
      row.answerPacketId !== packet.id ||
      row.originalQuestion !== (field.question ?? "") ||
      row.normalizedQuestion !== field.normalizedQuestion ||
      row.fieldFingerprint !== field.fieldFingerprint ||
      row.semanticFieldKey !== field.semanticFieldKey ||
      row.fieldType !== field.fieldType ||
      row.classification !== field.classification ||
      row.proposedValue !== null
    ) {
      throw packetInvalid();
    }
    answerKeys.add(row.normalizedFieldKey);
    return {
      normalizedFieldKey: row.normalizedFieldKey,
      normalizedQuestion: row.normalizedQuestion,
      semanticFieldKey: row.semanticFieldKey,
      fieldFingerprint: row.fieldFingerprint,
      fieldType: row.fieldType,
      classification: row.classification,
      disposition: row.disposition!,
      dispositionReason: row.dispositionReason,
      proposal: row.proposal,
      sourceType: row.sourceType,
      sourceIds: row.sourceIds,
      evidenceIds: row.evidenceIds,
      sourceFingerprint: row.sourceFingerprint,
      confidence: row.confidence,
      required: row.required,
      requiresReview: row.requiresReview,
      sensitive: row.sensitive,
      valueRedacted: row.valueRedacted
    } as CandidateAnswer;
  });
  const validationContext = validationContextFor(answers, fields);
  const canonical = canonicalizeApplicationAnswerPacketProjection({
    schemaVersion: packet.schemaVersion,
    inspectionVersion: inspection.version,
    formFingerprint: inspection.formFingerprint,
    builderVersion: packet.builderVersion,
    policyHash: packet.policyHash,
    answers
  }, validationContext);
  return { packet: canonical, validationContext, fieldsByKey };
}

function ownerSafePacket(
  inspection: StoredInspection,
  packet: StoredPacket,
  rows: readonly StoredPacketAnswer[],
  canonicalPacket: ApplicationAnswerPacketProjection,
  summary: ApplicationAnswerPacketSummary
): OwnerSafePacket {
  const byKey = new Map(canonicalPacket.answers.map((answer) => [answer.normalizedFieldKey, answer] as const));
  return {
    inspectionVersion: inspection.version,
    packetVersion: packet.version,
    packetHash: packet.packetHash,
    reviewedAt: packet.reviewedAt,
    createdAt: packet.createdAt,
    summary,
    answers: rows
      .map((row): OwnerSafeAnswer => {
        const answer = byKey.get(row.normalizedFieldKey)!;
        return {
          id: row.id,
          normalizedFieldKey: row.normalizedFieldKey,
          originalQuestion: row.originalQuestion,
          normalizedQuestion: row.normalizedQuestion!,
          semanticFieldKey: row.semanticFieldKey,
          fieldType: row.fieldType!,
          classification: row.classification!,
          disposition: answer.disposition,
          dispositionReason: answer.dispositionReason,
          proposal: answer.proposal,
          required: row.required,
          requiresReview: row.requiresReview,
          sensitive: row.sensitive,
          valueRedacted: row.valueRedacted,
          status: row.status,
          reviewedByUser: row.reviewedByUser,
          reviewedAt: row.reviewedAt
        };
      })
      .sort((left, right) => left.normalizedFieldKey.localeCompare(right.normalizedFieldKey))
  };
}

export async function loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(
  tx: ApplicationRunAnswerPacketTransaction,
  input: { userId: string; run: LockedAnswerPacketRun }
): Promise<VerifiedCurrentAnswerPacket | null> {
  const pointers = await loadPointerRows(tx, input.userId, input.run);
  if (!pointers) return null;
  const { inspection, packet } = pointers;
  if (!isSupportedInspection(inspection)) throw inspectionStale();
  if (!isSupportedPacket(packet)) throw packetInvalid();
  if (!SHA256_PATTERN.test(packet.inputHash)) throw packetInvalid();

  let snapshot: NormalizedApplicationFormSnapshot;
  try {
    snapshot = verifyNormalizedApplicationFormSnapshot({
      authoritativeApplyHost: input.run.applyHost,
      expectedFormFingerprint: inspection.formFingerprint,
      snapshot: inspection.normalizedSnapshot
    });
  } catch {
    throw inspectionInvalid();
  }

  const rows = await tx.applicationRunAnswer.findMany({
    where: { answerPacketId: packet.id },
    orderBy: { normalizedFieldKey: "asc" }
  }) as StoredPacketAnswer[];
  let projected: ReturnType<typeof packetProjectionFromRows>;
  try {
    projected = packetProjectionFromRows(inspection, packet, rows, snapshot);
    if (computeApplicationAnswerPacketHash(projected.packet, projected.validationContext) !== packet.packetHash) {
      throw packetInvalid();
    }
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    throw packetInvalid();
  }

  let summary: ApplicationAnswerPacketSummary;
  try {
    summary = summarizeApplicationAnswerPacket({
      currentPacketVersion: input.run.currentAnswerPacketVersion,
      packetVersion: packet.version,
      packet: projected.packet,
      validationContext: projected.validationContext,
      rows: rows.map((row) => ({
        packetVersion: packet.version,
        packetHash: packet.packetHash,
        normalizedFieldKey: row.normalizedFieldKey,
        status: row.status,
        finalValueHash: row.finalValueHash,
        reviewHashVersion: row.reviewHashVersion
      }))
    });
  } catch {
    throw packetInvalid();
  }

  return {
    inspection,
    snapshot,
    fieldsByKey: projected.fieldsByKey,
    packetRecord: packet,
    answerRows: rows,
    packet: projected.packet,
    validationContext: projected.validationContext,
    summary,
    ownerSafe: ownerSafePacket(inspection, packet, rows, projected.packet, summary)
  };
}

async function lockAnswerVaultRows(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  fields: readonly NormalizedApplicationFormField[]
): Promise<AnswerVaultRow[]> {
  const includeLinks = fields.some(
    (field) => field.permittedDisposition === "PROPOSABLE" && field.classification === "PROFESSIONAL_LINK"
  );
  const includeAvailability = fields.some(
    (field) => field.permittedDisposition === "PROPOSABLE" && field.classification === "AVAILABILITY"
  );
  if (!includeLinks && !includeAvailability) return [];
  const rows = await tx.$queryRaw<AnswerVaultRow[]>`
    SELECT "id", "category", "question", "answer", "updatedAt"
    FROM "ApplicationAnswer"
    WHERE "userId" = ${userId}
      AND "isActive" = TRUE
      AND "sensitive" = FALSE
      AND (
        (${includeLinks} = TRUE AND "category" = 'LINKS')
        OR (${includeAvailability} = TRUE AND "category" = 'AVAILABILITY')
      )
    ORDER BY "id" ASC
    LIMIT 257
    FOR SHARE
  `;
  if (rows.length === 257) throw sourceSetTooLarge();
  return rows;
}

async function lockResume(
  tx: ApplicationRunAnswerPacketTransaction,
  run: LockedAnswerPacketRun
): Promise<LockedResume | null> {
  if (!run.resumeVersionId || !run.resumeContentHash) return null;
  const rows = await tx.$queryRaw<LockedResume[]>`
    SELECT "id", "userId", "jobPostingId", "fullText", "createdAt"
    FROM "ResumeVersion"
    WHERE "id" = ${run.resumeVersionId}
      AND "userId" = ${run.userId}
      AND "jobPostingId" = ${run.jobPostingId}
    FOR SHARE
  `;
  if (rows.length !== 1 || hashText(rows[0].fullText) !== run.resumeContentHash) throw documentStale();
  return rows[0];
}

async function lockCoverLetter(
  tx: ApplicationRunAnswerPacketTransaction,
  run: LockedAnswerPacketRun
): Promise<LockedCoverLetter | null> {
  if (!run.coverLetterVersionId || !run.coverLetterContentHash) return null;
  const rows = await tx.$queryRaw<LockedCoverLetter[]>`
    SELECT "id", "userId", "jobPostingId", "type", "content", "createdAt"
    FROM "GeneratedDocument"
    WHERE "id" = ${run.coverLetterVersionId}
      AND "userId" = ${run.userId}
      AND "jobPostingId" = ${run.jobPostingId}
      AND "type" = 'COVER_LETTER'
    FOR SHARE
  `;
  if (rows.length !== 1 || hashText(rows[0].content) !== run.coverLetterContentHash) throw documentStale();
  return rows[0];
}

function baseNonproposableAnswer(field: NormalizedApplicationFormField): CandidateAnswer {
  const sensitive = field.permittedDisposition === "EXCLUDED";
  return {
    normalizedFieldKey: field.normalizedFieldKey,
    normalizedQuestion: field.normalizedQuestion,
    semanticFieldKey: field.semanticFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType,
    classification: field.classification,
    disposition: field.permittedDisposition,
    dispositionReason: field.dispositionReason,
    proposal: null,
    sourceType: null,
    sourceIds: [],
    evidenceIds: [],
    sourceFingerprint: null,
    confidence: 0,
    required: field.required,
    requiresReview: false,
    sensitive,
    valueRedacted: sensitive
  };
}

function downgradedAnswer(
  field: NormalizedApplicationFormField,
  dispositionReason: "NO_ELIGIBLE_SOURCE" | "AMBIGUOUS_SOURCE" | "INVALID_SOURCE_VALUE" | "NO_SELECTED_DOCUMENT"
): CandidateAnswer {
  return {
    ...baseNonproposableAnswer(field),
    disposition: "MANUAL_ONLY",
    dispositionReason,
    sensitive: false,
    valueRedacted: false
  };
}

function assertDisposition(field: NormalizedApplicationFormField, answer: CandidateAnswer): CandidateAnswer {
  assertApplicationAnswerDispositionWithinPermitted({
    permittedDisposition: field.permittedDisposition,
    permittedDispositionReason: field.dispositionReason,
    disposition: answer.disposition,
    dispositionReason: answer.dispositionReason
  });
  return answer;
}

function sourceMatchesField(
  candidate: AnswerVaultRow,
  field: NormalizedApplicationFormField,
  expectedCategory: "LINKS" | "AVAILABILITY"
): boolean {
  if (candidate.category !== expectedCategory || field.semanticFieldKey === null) return false;
  try {
    const question = canonicalizeFormComparisonText(sanitizeFormDisplayText(candidate.question));
    const classification = classifyApplicationQuestion({
      question,
      sectionHeading: null,
      helpText: null,
      autocomplete: null,
      fieldType: field.fieldType
    });
    return (
      classification.classification === field.classification &&
      classification.permittedDisposition === "PROPOSABLE" &&
      classification.semanticFieldKey !== null &&
      classification.semanticFieldKey === field.semanticFieldKey
    );
  } catch {
    return false;
  }
}

function answerVaultResolution(
  field: NormalizedApplicationFormField,
  candidates: readonly AnswerVaultRow[],
  sourceLookups: Array<{ normalizedFieldKey: string; candidateSourceFingerprints: string[] }>
): CandidateAnswer {
  const expectedCategory = field.classification === "PROFESSIONAL_LINK"
    ? "LINKS"
    : field.classification === "AVAILABILITY"
      ? "AVAILABILITY"
      : null;
  if (!expectedCategory) return assertDisposition(field, downgradedAnswer(field, "NO_ELIGIBLE_SOURCE"));
  const matching = candidates.filter((candidate) => sourceMatchesField(candidate, field, expectedCategory));
  const fingerprinted = matching.flatMap((candidate) => {
    try {
      return [computeApplicationAnswerSourceFingerprint({
        sourceType: "ANSWER_VAULT",
        sourceId: candidate.id,
        sourceRevision: candidate.updatedAt.toISOString(),
        sourceCategory: expectedCategory,
        exactValue: candidate.answer
      }).sourceFingerprint];
    } catch {
      return [];
    }
  });
  sourceLookups.push({
    normalizedFieldKey: field.normalizedFieldKey,
    candidateSourceFingerprints: fingerprinted
  });
  if (matching.length === 0) return assertDisposition(field, downgradedAnswer(field, "NO_ELIGIBLE_SOURCE"));
  if (matching.length > 1) return assertDisposition(field, downgradedAnswer(field, "AMBIGUOUS_SOURCE"));

  const candidate = matching[0];
  let proposal: ApplicationAnswerProposal;
  let sourceFingerprint: string;
  try {
    proposal = parseCompatibleApplicationAnswerProposal({ kind: "SCALAR", value: candidate.answer }, {
      expectedField: {
        normalizedFieldKey: field.normalizedFieldKey,
        fieldFingerprint: field.fieldFingerprint,
        fieldType: field.fieldType,
        semanticFieldKey: field.semanticFieldKey
      },
      frozenField: frozenField(field)
    });
    sourceFingerprint = computeApplicationAnswerSourceFingerprint({
      sourceType: "ANSWER_VAULT",
      sourceId: candidate.id,
      sourceRevision: candidate.updatedAt.toISOString(),
      sourceCategory: expectedCategory,
      exactValue: candidate.answer
    }).sourceFingerprint;
  } catch {
    return assertDisposition(field, downgradedAnswer(field, "INVALID_SOURCE_VALUE"));
  }

  return assertDisposition(field, {
    normalizedFieldKey: field.normalizedFieldKey,
    normalizedQuestion: field.normalizedQuestion,
    semanticFieldKey: field.semanticFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType,
    classification: field.classification,
    disposition: "PROPOSABLE",
    dispositionReason: null,
    proposal,
    sourceType: "ANSWER_VAULT",
    sourceIds: [candidate.id],
    evidenceIds: [],
    sourceFingerprint,
    confidence: 100,
    required: field.required,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false
  });
}

function documentResolution(
  field: NormalizedApplicationFormField,
  run: LockedAnswerPacketRun,
  resume: LockedResume | null,
  coverLetter: LockedCoverLetter | null
): CandidateAnswer {
  const isResume = field.semanticFieldKey === "document.resume";
  const document = isResume ? resume : field.semanticFieldKey === "document.cover_letter" ? coverLetter : null;
  const contentHash = isResume ? run.resumeContentHash : run.coverLetterContentHash;
  if (!document || !contentHash) {
    return assertDisposition(field, downgradedAnswer(field, "NO_SELECTED_DOCUMENT"));
  }
  const artifactType = isResume ? "RESUME" : "COVER_LETTER";
  const sourceType = isResume ? "TAILORED_RESUME" : "COVER_LETTER";
  const sourceCategory = isResume ? "TAILORED_RESUME" : "COVER_LETTER";
  const proposal = parseCompatibleApplicationAnswerProposal({
    kind: "DOCUMENT_REFERENCE",
    artifactType,
    documentId: document.id,
    contentHash
  }, {
    expectedField: {
      normalizedFieldKey: field.normalizedFieldKey,
      fieldFingerprint: field.fieldFingerprint,
      fieldType: field.fieldType,
      semanticFieldKey: field.semanticFieldKey
    },
    frozenField: frozenField(field)
  });
  const sourceFingerprint = computeApplicationAnswerSourceFingerprint({
    sourceType,
    sourceId: document.id,
    sourceRevision: document.createdAt.toISOString(),
    sourceCategory,
    exactValue: contentHash
  }).sourceFingerprint;
  return assertDisposition(field, {
    normalizedFieldKey: field.normalizedFieldKey,
    normalizedQuestion: field.normalizedQuestion,
    semanticFieldKey: field.semanticFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType,
    classification: field.classification,
    disposition: "PROPOSABLE",
    dispositionReason: null,
    proposal,
    sourceType,
    sourceIds: [document.id],
    evidenceIds: [],
    sourceFingerprint,
    confidence: 100,
    required: field.required,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false
  });
}

async function buildCandidatePacket(
  tx: ApplicationRunAnswerPacketTransaction,
  input: {
    userId: string;
    run: LockedAnswerPacketRun;
    policy: LockedPolicy;
    inspectionVersion: number;
    formFingerprint: string;
    snapshot: NormalizedApplicationFormSnapshot;
    candidatePacketVersion: number;
  }
): Promise<CandidatePacket> {
  const fields = flattenFields(input.snapshot);
  const vaultRows = await lockAnswerVaultRows(tx, input.userId, fields);
  const needsResume = fields.some(
    (field) => field.permittedDisposition === "PROPOSABLE" && field.semanticFieldKey === "document.resume"
  );
  const needsCoverLetter = fields.some(
    (field) => field.permittedDisposition === "PROPOSABLE" && field.semanticFieldKey === "document.cover_letter"
  );
  const resume = needsResume ? await lockResume(tx, input.run) : null;
  const coverLetter = needsCoverLetter ? await lockCoverLetter(tx, input.run) : null;
  const sourceLookups: Array<{ normalizedFieldKey: string; candidateSourceFingerprints: string[] }> = [];
  const documentReferences: Array<{ artifactType: "RESUME" | "COVER_LETTER"; documentId: string; contentHash: string }> = [];
  if (resume && input.run.resumeContentHash) {
    documentReferences.push({ artifactType: "RESUME", documentId: resume.id, contentHash: input.run.resumeContentHash });
  }
  if (coverLetter && input.run.coverLetterContentHash) {
    documentReferences.push({
      artifactType: "COVER_LETTER",
      documentId: coverLetter.id,
      contentHash: input.run.coverLetterContentHash
    });
  }

  const answers = fields.map((field) => {
    if (field.permittedDisposition !== "PROPOSABLE") {
      return assertDisposition(field, baseNonproposableAnswer(field));
    }
    if (field.classification === "DOCUMENT") {
      return documentResolution(field, input.run, resume, coverLetter);
    }
    return answerVaultResolution(field, vaultRows, sourceLookups);
  });

  const policyProjection = {
    schemaVersion: 1 as const,
    sensitiveAnswerPolicy: input.policy.sensitiveAnswerPolicy,
    finalReviewRequired: input.policy.finalReviewRequired
  };
  const policyHash = computeApplicationAnswerPacketPolicyHash(policyProjection);
  const inputProjection = canonicalizeApplicationAnswerPacketInputProjection({
    schemaVersion: 1,
    inspectionVersion: input.inspectionVersion,
    formFingerprint: input.formFingerprint,
    builderVersion: ANSWER_PACKET_BUILDER_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    canonicalizerVersion: ANSWER_PACKET_CANONICALIZER_VERSION,
    reviewHashVersion: "CANONICAL_PROPOSAL_V1",
    policyHash,
    documentReferences,
    sourceLookups
  });
  const inputHash = computeApplicationAnswerPacketInputHash(inputProjection);
  const validationContext = validationContextFor(answers, fields);
  const packet = canonicalizeApplicationAnswerPacketProjection({
    schemaVersion: ANSWER_PACKET_SCHEMA_VERSION,
    inspectionVersion: input.inspectionVersion,
    formFingerprint: input.formFingerprint,
    builderVersion: ANSWER_PACKET_BUILDER_VERSION,
    policyHash,
    answers
  }, validationContext);
  const packetHash = computeApplicationAnswerPacketHash(packet, validationContext);
  const summary = summarizeApplicationAnswerPacket({
    currentPacketVersion: input.candidatePacketVersion,
    packetVersion: input.candidatePacketVersion,
    packet,
    validationContext,
    rows: answers.map((answer) => ({
      packetVersion: input.candidatePacketVersion,
      packetHash,
      normalizedFieldKey: answer.normalizedFieldKey,
      status: "PENDING",
      finalValueHash: null,
      reviewHashVersion: null
    }))
  });
  return {
    inspectionVersion: input.inspectionVersion,
    policyHash,
    inputHash,
    packetHash,
    packet,
    validationContext,
    summary,
    answers
  };
}

function isExactReplay(
  current: VerifiedCurrentAnswerPacket | null,
  candidate: CandidatePacket,
  formFingerprint: string
): current is VerifiedCurrentAnswerPacket {
  return Boolean(
    current &&
    current.inspection.version === candidate.inspectionVersion &&
    current.inspection.formFingerprint === formFingerprint &&
    current.packetRecord.policyHash === candidate.policyHash &&
    current.packetRecord.inputHash === candidate.inputHash &&
    current.packetRecord.packetHash === candidate.packetHash
  );
}

function materialAnswerData(
  answer: CandidateAnswer,
  field: NormalizedApplicationFormField,
  input: { runId: string; userId: string; answerPacketId: string }
) {
  return {
    runId: input.runId,
    userId: input.userId,
    answerPacketId: input.answerPacketId,
    normalizedFieldKey: answer.normalizedFieldKey,
    originalQuestion: field.question ?? "",
    normalizedQuestion: answer.normalizedQuestion,
    fieldFingerprint: answer.fieldFingerprint,
    semanticFieldKey: answer.semanticFieldKey,
    fieldType: answer.fieldType,
    classification: answer.classification,
    disposition: answer.disposition,
    dispositionReason: answer.dispositionReason,
    proposedValue: null,
    proposal: answer.proposal === null
      ? Prisma.DbNull
      : answer.proposal as Prisma.InputJsonValue,
    valueRedacted: answer.valueRedacted,
    sourceType: answer.sourceType,
    sourceIds: [...answer.sourceIds],
    evidenceIds: [],
    sourceFingerprint: answer.sourceFingerprint,
    confidence: answer.confidence,
    sensitive: answer.sensitive,
    required: answer.required,
    requiresReview: answer.requiresReview,
    status: "PENDING" as const,
    reviewedByUser: false,
    reviewedAt: null,
    finalValueHash: null,
    reviewHashVersion: null
  };
}

async function persistMaterialPacket(
  tx: ApplicationRunAnswerPacketTransaction,
  input: {
    userId: string;
    run: LockedAnswerPacketRun;
    candidate: CandidatePacket;
    snapshot: NormalizedApplicationFormSnapshot;
    formFingerprint: string;
    existingInspection: StoredInspection | null;
    mode: "initial" | "rebuild";
    clock: () => Date;
  }
): Promise<MaterialResult> {
  const inspection = input.existingInspection ?? await tx.applicationRunFormInspection.create({
    data: {
      runId: input.run.id,
      userId: input.userId,
      version: input.candidate.inspectionVersion,
      schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
      normalizerVersion: FORM_NORMALIZER_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      fingerprintVersion: FIELD_FINGERPRINT_VERSION,
      formFingerprint: input.formFingerprint,
      normalizedSnapshot: input.snapshot as unknown as Prisma.InputJsonValue
    }
  }) as StoredInspection;
  const packetVersion = input.run.currentAnswerPacketVersion + 1;
  const packet = await tx.applicationRunAnswerPacket.create({
    data: {
      runId: input.run.id,
      userId: input.userId,
      version: packetVersion,
      formInspectionId: inspection.id,
      schemaVersion: ANSWER_PACKET_SCHEMA_VERSION,
      builderVersion: ANSWER_PACKET_BUILDER_VERSION,
      policyHash: input.candidate.policyHash,
      inputHash: input.candidate.inputHash,
      packetHash: input.candidate.packetHash,
      reviewedAt: null
    }
  }) as StoredPacket;
  const fieldsByKey = new Map(flattenFields(input.snapshot).map((field) => [field.normalizedFieldKey, field] as const));
  const answerData = input.candidate.answers.map((answer) => materialAnswerData(
    answer,
    fieldsByKey.get(answer.normalizedFieldKey)!,
    { runId: input.run.id, userId: input.userId, answerPacketId: packet.id }
  ));
  const inserted = await tx.applicationRunAnswer.createMany({ data: answerData });
  if (inserted.count !== answerData.length) throw packetInvalid();

  const resultState = "REVIEW_REQUIRED" as const;
  const resultStateVersion = input.run.state === "READY" ? input.run.stateVersion + 1 : input.run.stateVersion;
  const runUpdate = await tx.applicationRun.updateMany({
    where: {
      id: input.run.id,
      userId: input.userId,
      state: input.run.state,
      stateVersion: input.run.stateVersion,
      currentFormInspectionVersion: input.run.currentFormInspectionVersion,
      currentAnswerPacketVersion: input.run.currentAnswerPacketVersion
    },
    data: {
      currentFormInspectionVersion: inspection.version,
      currentAnswerPacketVersion: packetVersion,
      ...(input.run.state === "READY"
        ? { state: "REVIEW_REQUIRED" as const, stateVersion: { increment: 1 } }
        : {})
    }
  });
  if (runUpdate.count !== 1) throw staleLifecycle();

  const now = resolveNow(input.clock);
  const revokedTokenCount = await revokeUsableExecutionTokensForRunInTransaction(tx, {
    userId: input.userId,
    runId: input.run.id,
    now,
    reason: "answer_packet_changed"
  });
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: "application-run-answer-packet.publish",
      resource: "ApplicationRunAnswerPacket",
      resourceId: packet.id,
      metadata: {
        runId: input.run.id,
        inspectionVersion: inspection.version,
        packetVersion,
        mode: input.mode,
        formChanged: input.existingInspection === null,
        previousState: input.run.state,
        resultState,
        previousStateVersion: input.run.stateVersion,
        resultStateVersion,
        aggregateCounts: input.candidate.summary,
        revokedTokenCount
      } as Prisma.InputJsonValue
    }
  });
  await tx.applicationEvent.create({
    data: {
      userId: input.userId,
      applicationId: input.run.applicationId,
      type: "APPLICATION_RUN_EVENT",
      title: input.run.currentAnswerPacketVersion === 0
        ? "Application answer packet prepared"
        : "Application answer packet updated",
      metadata: {
        runId: input.run.id,
        inspectionVersion: inspection.version,
        packetVersion,
        state: resultState,
        aggregateCounts: input.candidate.summary
      } as Prisma.InputJsonValue
    }
  });

  const resultRun = {
    ...input.run,
    state: resultState,
    stateVersion: resultStateVersion,
    currentFormInspectionVersion: inspection.version,
    currentAnswerPacketVersion: packetVersion
  };
  const verified = await loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(tx, {
    userId: input.userId,
    run: resultRun
  });
  if (!verified) throw packetInvalid();
  return {
    replayed: false,
    runId: input.run.id,
    state: resultState,
    stateVersion: resultStateVersion,
    inspectionVersion: inspection.version,
    packetVersion,
    packetHash: packet.packetHash,
    packet: verified.ownerSafe
  };
}

function replayResult(run: LockedAnswerPacketRun, current: VerifiedCurrentAnswerPacket): MaterialResult {
  return {
    replayed: true,
    runId: run.id,
    state: run.state,
    stateVersion: run.stateVersion,
    inspectionVersion: current.inspection.version,
    packetVersion: current.packetRecord.version,
    packetHash: current.packetRecord.packetHash,
    packet: current.ownerSafe
  };
}

export function createApplicationRunAnswerPacketService(
  dependencies: ApplicationRunAnswerPacketServiceDependencies = {}
) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const env = dependencies.env ?? process.env;
  const clock = dependencies.clock ?? (() => new Date());

  async function publishFormInspectionAndAnswerPacket(input: unknown): Promise<MaterialResult> {
    const parsed = publicationInputSchema.parse(input);
    const observedTarget = parseObservedTarget(parsed.observedUrl);
    const freshInspection = buildNormalizedApplicationFormInspection({
      authoritativeApplyHost: observedTarget.host,
      report: parsed.inspectionReport
    });

    return prismaClient.$transaction(async (untypedTx) => {
      const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
      const policy = await lockPolicy(tx, parsed.userId, env);
      const run = await lockOwnedRun(tx, parsed.userId, parsed.runId);
      assertOperationalRun(run, parsed.expectedStateVersion);
      assertAuthoritativeTarget(run, policy, observedTarget);
      const pointers = await loadPointerRows(tx, parsed.userId, run);

      let reusedInspection: StoredInspection | null = null;
      let current: VerifiedCurrentAnswerPacket | null = null;
      if (
        pointers &&
        isSupportedInspection(pointers.inspection) &&
        pointers.inspection.formFingerprint === freshInspection.formFingerprint
      ) {
        try {
          verifyNormalizedApplicationFormSnapshot({
            authoritativeApplyHost: run.applyHost,
            expectedFormFingerprint: pointers.inspection.formFingerprint,
            snapshot: pointers.inspection.normalizedSnapshot
          });
        } catch {
          throw inspectionInvalid();
        }
        reusedInspection = pointers.inspection;
        if (isSupportedPacket(pointers.packet)) {
          current = await loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(tx, {
            userId: parsed.userId,
            run
          });
        }
      }

      const inspectionVersion = reusedInspection?.version ?? run.currentFormInspectionVersion + 1;
      const candidate = await buildCandidatePacket(tx, {
        userId: parsed.userId,
        run,
        policy,
        inspectionVersion,
        formFingerprint: freshInspection.formFingerprint,
        snapshot: freshInspection.snapshot,
        candidatePacketVersion: run.currentAnswerPacketVersion + 1
      });
      if (isExactReplay(current, candidate, freshInspection.formFingerprint)) {
        return replayResult(run, current);
      }
      if (
        parsed.expectedFormInspectionVersion !== run.currentFormInspectionVersion ||
        parsed.expectedAnswerPacketVersion !== run.currentAnswerPacketVersion
      ) {
        throw staleLifecycle();
      }
      return persistMaterialPacket(tx, {
        userId: parsed.userId,
        run,
        candidate,
        snapshot: freshInspection.snapshot,
        formFingerprint: freshInspection.formFingerprint,
        existingInspection: reusedInspection,
        mode: "initial",
        clock
      });
    });
  }

  async function getCurrentAnswerPacket(input: unknown): Promise<{ runId: string; current: OwnerSafePacket | null }> {
    const parsed = currentReadInputSchema.parse(input);
    return prismaClient.$transaction(async (untypedTx) => {
      const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
      const run = await readOwnedRun(tx, parsed.userId, parsed.runId);
      const current = await loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(tx, {
        userId: parsed.userId,
        run
      });
      return { runId: run.id, current: current?.ownerSafe ?? null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async function rebuildCurrentAnswerPacket(input: unknown): Promise<MaterialResult> {
    const parsed = rebuildInputSchema.parse(input);
    return prismaClient.$transaction(async (untypedTx) => {
      const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
      const policy = await lockPolicy(tx, parsed.userId, env);
      const run = await lockOwnedRun(tx, parsed.userId, parsed.runId);
      assertOperationalRun(run, parsed.expectedStateVersion);
      assertAuthoritativeTarget(run, policy);
      const pointers = await loadPointerRows(tx, parsed.userId, run);
      if (!pointers) throw inspectionInvalid();
      if (!isSupportedInspection(pointers.inspection)) throw inspectionStale();
      let snapshot: NormalizedApplicationFormSnapshot;
      try {
        snapshot = verifyNormalizedApplicationFormSnapshot({
          authoritativeApplyHost: run.applyHost,
          expectedFormFingerprint: pointers.inspection.formFingerprint,
          snapshot: pointers.inspection.normalizedSnapshot
        });
      } catch {
        throw inspectionInvalid();
      }
      const current = isSupportedPacket(pointers.packet)
        ? await loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(tx, { userId: parsed.userId, run })
        : null;
      const candidate = await buildCandidatePacket(tx, {
        userId: parsed.userId,
        run,
        policy,
        inspectionVersion: pointers.inspection.version,
        formFingerprint: pointers.inspection.formFingerprint,
        snapshot,
        candidatePacketVersion: run.currentAnswerPacketVersion + 1
      });
      if (isExactReplay(current, candidate, pointers.inspection.formFingerprint)) {
        return replayResult(run, current);
      }
      if (
        parsed.expectedFormInspectionVersion !== run.currentFormInspectionVersion ||
        parsed.expectedAnswerPacketVersion !== run.currentAnswerPacketVersion
      ) {
        throw staleLifecycle();
      }
      return persistMaterialPacket(tx, {
        userId: parsed.userId,
        run,
        candidate,
        snapshot,
        formFingerprint: pointers.inspection.formFingerprint,
        existingInspection: pointers.inspection,
        mode: "rebuild",
        clock
      });
    });
  }

  return {
    publishFormInspectionAndAnswerPacket,
    getCurrentAnswerPacket,
    rebuildCurrentAnswerPacket
  };
}

const defaultService = createApplicationRunAnswerPacketService();

export const publishFormInspectionAndAnswerPacket = defaultService.publishFormInspectionAndAnswerPacket;
export const getCurrentAnswerPacket = defaultService.getCurrentAnswerPacket;
export const rebuildCurrentAnswerPacket = defaultService.rebuildCurrentAnswerPacket;
