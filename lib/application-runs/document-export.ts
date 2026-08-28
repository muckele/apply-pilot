import { createHash } from "node:crypto";

import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  computeApplicationAnswerProposalHash,
  parseCompatibleApplicationAnswerProposal,
  type ApplicationDocumentArtifactType
} from "@/lib/application-runs/answer-packet-domain";
import {
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction,
  type ApplicationRunAnswerPacketTransaction,
  type LockedAnswerPacketRun
} from "@/lib/application-runs/answer-packet-service";
import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
  renderCanonicalApplicationDocumentV1
} from "@/lib/documents/export-renderer";
import { prisma } from "@/lib/prisma";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const serviceInputSchema = z
  .object({
    userId: z.string().trim().min(1).max(128),
    runId: z.string().cuid(),
    answerId: z.string().cuid(),
    expectedStateVersion: z.number().int().safe().nonnegative(),
    answerPacketVersion: z.number().int().safe().positive(),
    packetHash: z.string().regex(/^[a-f0-9]{64}$/),
    format: z.unknown()
  })
  .strict();

type ApplicationRunDocumentExportPrismaClient = Pick<typeof prisma, "$transaction">;

export type ApplicationRunDocumentExportServiceDependencies = {
  prismaClient?: ApplicationRunDocumentExportPrismaClient;
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction?:
    typeof loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;
  renderCanonicalApplicationDocumentV1?: typeof renderCanonicalApplicationDocumentV1;
};

type LockedResumeSource = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  fullText: string;
};

type LockedCoverLetterSource = {
  id: string;
  userId: string;
  jobPostingId: string | null;
  type: "COVER_LETTER";
  content: string;
};

type CanonicalApplicationDocumentSnapshot = Readonly<{
  artifactType: ApplicationDocumentArtifactType;
  content: string;
  format: "docx";
  profileVersion: 1;
  contentType: typeof DOCX_CONTENT_TYPE;
  filename: "apply-pilot-resume.docx" | "apply-pilot-cover-letter.docx";
}>;

function publicError(message: string, status: number, code: string): PublicApiError {
  return new PublicApiError(message, status, { code });
}

function runNotFound(): PublicApiError {
  return publicError("This application run was not found.", 404, "RUN_NOT_FOUND");
}

function invalidState(): PublicApiError {
  return publicError("Documents cannot be exported in this application run state.", 409, "RUN_INVALID_STATE");
}

function staleLifecycle(): PublicApiError {
  return publicError(
    "This application run changed before the request could be completed.",
    409,
    "RUN_LIFECYCLE_STALE"
  );
}

function packetStale(): PublicApiError {
  return publicError("The requested answer packet is no longer current.", 409, "RUN_PACKET_STALE");
}

function packetInvalid(): PublicApiError {
  return publicError("The current answer packet is invalid.", 409, "RUN_PACKET_INVALID");
}

function packetReviewIncomplete(): PublicApiError {
  return publicError(
    "The current answer packet review is incomplete.",
    409,
    "RUN_PACKET_REVIEW_INCOMPLETE"
  );
}

function answerNotFound(): PublicApiError {
  return publicError("This application run answer was not found.", 404, "RUN_ANSWER_NOT_FOUND");
}

function answerNotApproved(): PublicApiError {
  return publicError(
    "This application document answer has not been approved.",
    409,
    "RUN_DOCUMENT_ANSWER_NOT_APPROVED"
  );
}

function formatUnsupported(): PublicApiError {
  return publicError(
    "The approved application document format is not supported for this field.",
    422,
    "RUN_DOCUMENT_FORMAT_UNSUPPORTED"
  );
}

function documentStale(): PublicApiError {
  return publicError("A selected application document has changed.", 409, "RUN_DOCUMENT_STALE");
}

function renderFailed(): PublicApiError {
  return publicError("The approved application document could not be rendered.", 500, "RUN_DOCUMENT_RENDER_FAILED");
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

async function lockOwnedRunForShare(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  runId: string
): Promise<LockedAnswerPacketRun> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ApplicationRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
    FOR SHARE
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

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSnapshot(artifactType: ApplicationDocumentArtifactType, content: string) {
  return Object.freeze({
    artifactType,
    content,
    format: "docx",
    profileVersion: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.profileVersion,
    contentType: DOCX_CONTENT_TYPE,
    filename: artifactType === "RESUME"
      ? "apply-pilot-resume.docx"
      : "apply-pilot-cover-letter.docx"
  }) satisfies CanonicalApplicationDocumentSnapshot;
}

function mapPacketVerificationError(error: unknown): never {
  if (
    error instanceof PublicApiError &&
    error.details?.code === "RUN_PACKET_INVALID"
  ) {
    throw error;
  }
  throw packetInvalid();
}

export function createApplicationRunDocumentExportService(
  dependencies: ApplicationRunDocumentExportServiceDependencies = {}
) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const loadVerifiedCurrentPacket =
    dependencies.loadVerifiedCurrentAnswerPacketForLockedRunInTransaction ??
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;
  const renderCanonical =
    dependencies.renderCanonicalApplicationDocumentV1 ?? renderCanonicalApplicationDocumentV1;

  async function exportApprovedApplicationRunDocument(input: unknown) {
    const parsed = serviceInputSchema.parse(input);
    if (parsed.format !== "docx") throw formatUnsupported();

    const snapshot = await prismaClient.$transaction(async (untypedTx) => {
      const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
      const run = await lockOwnedRunForShare(tx, parsed.userId, parsed.runId);

      if (
        run.currentAnswerPacketVersion <= 0 ||
        parsed.answerPacketVersion !== run.currentAnswerPacketVersion
      ) {
        throw packetStale();
      }
      if (run.state !== "READY") throw invalidState();
      if (parsed.expectedStateVersion !== run.stateVersion) throw staleLifecycle();

      let verified;
      try {
        verified = await loadVerifiedCurrentPacket(tx, { userId: parsed.userId, run });
      } catch (error) {
        mapPacketVerificationError(error);
      }
      if (
        !verified ||
        verified.packetRecord.runId !== run.id ||
        verified.packetRecord.userId !== parsed.userId ||
        verified.packetRecord.version !== run.currentAnswerPacketVersion
      ) {
        throw packetInvalid();
      }
      if (parsed.packetHash !== verified.packetRecord.packetHash) throw packetStale();
      if (verified.packetRecord.reviewedAt === null) throw packetReviewIncomplete();

      const answer = verified.answerRows.find((candidate) => candidate.id === parsed.answerId);
      if (!answer) throw answerNotFound();
      if (answer.status !== "APPROVED") throw answerNotApproved();
      const frozenField = verified.fieldsByKey.get(answer.normalizedFieldKey);
      if (
        !frozenField ||
        answer.runId !== run.id ||
        answer.userId !== parsed.userId ||
        answer.answerPacketId !== verified.packetRecord.id ||
        answer.fieldType !== "FILE_UPLOAD" ||
        answer.classification !== "DOCUMENT" ||
        answer.disposition !== "PROPOSABLE" ||
        answer.requiresReview !== true ||
        answer.sensitive !== false ||
        answer.valueRedacted !== false ||
        answer.reviewedByUser !== true ||
        answer.reviewedAt === null ||
        answer.reviewHashVersion !== "CANONICAL_PROPOSAL_V1" ||
        answer.finalValueHash === null ||
        answer.fieldFingerprint === null ||
        answer.proposal === null
      ) {
        throw packetInvalid();
      }

      let proposal;
      try {
        proposal = parseCompatibleApplicationAnswerProposal(answer.proposal, {
          expectedField: {
            normalizedFieldKey: answer.normalizedFieldKey,
            fieldFingerprint: answer.fieldFingerprint,
            fieldType: answer.fieldType,
            semanticFieldKey: answer.semanticFieldKey
          },
          frozenField: {
            normalizedFieldKey: frozenField.normalizedFieldKey,
            fieldFingerprint: frozenField.fieldFingerprint,
            fieldType: frozenField.fieldType,
            semanticFieldKey: frozenField.semanticFieldKey,
            choices: frozenField.choices.map((choice) => ({
              key: choice.key,
              disabled: choice.disabled
            }))
          }
        });
      } catch {
        throw packetInvalid();
      }
      if (
        proposal.kind !== "DOCUMENT_REFERENCE" ||
        computeApplicationAnswerProposalHash(proposal) !== answer.finalValueHash
      ) {
        throw packetInvalid();
      }

      const expectedArtifactType = frozenField.semanticFieldKey === "document.resume"
        ? "RESUME"
        : frozenField.semanticFieldKey === "document.cover_letter"
          ? "COVER_LETTER"
          : null;
      const expectedSourceType = expectedArtifactType === "RESUME" ? "TAILORED_RESUME" : "COVER_LETTER";
      if (
        expectedArtifactType === null ||
        proposal.artifactType !== expectedArtifactType ||
        answer.sourceType !== expectedSourceType ||
        answer.sourceIds.length !== 1 ||
        answer.sourceIds[0] !== proposal.documentId
      ) {
        throw packetInvalid();
      }

      const expectedDocumentId = expectedArtifactType === "RESUME"
        ? run.resumeVersionId
        : run.coverLetterVersionId;
      const expectedContentHash = expectedArtifactType === "RESUME"
        ? run.resumeContentHash
        : run.coverLetterContentHash;
      if (
        expectedDocumentId === null ||
        expectedContentHash === null ||
        proposal.documentId !== expectedDocumentId ||
        proposal.contentHash !== expectedContentHash
      ) {
        throw packetInvalid();
      }

      const acceptedFileTypes = frozenField.constraints.acceptedFileTypes;
      if (acceptedFileTypes.length > 0 && !acceptedFileTypes.includes("DOCX")) {
        throw formatUnsupported();
      }

      if (expectedArtifactType === "RESUME") {
        const rows = await tx.$queryRaw<LockedResumeSource[]>`
          SELECT "id", "userId", "jobPostingId", "fullText"
          FROM "ResumeVersion"
          WHERE "id" = ${expectedDocumentId}
            AND "userId" = ${parsed.userId}
            AND "jobPostingId" = ${run.jobPostingId}
          FOR SHARE
        `;
        if (rows.length !== 1) throw documentStale();
        const contentHash = hashText(rows[0].fullText);
        if (contentHash !== expectedContentHash || contentHash !== proposal.contentHash) {
          throw documentStale();
        }
        return canonicalSnapshot("RESUME", rows[0].fullText);
      }

      const rows = await tx.$queryRaw<LockedCoverLetterSource[]>`
        SELECT "id", "userId", "jobPostingId", "type", "content"
        FROM "GeneratedDocument"
        WHERE "id" = ${expectedDocumentId}
          AND "userId" = ${parsed.userId}
          AND "jobPostingId" = ${run.jobPostingId}
          AND "type" = 'COVER_LETTER'
        FOR SHARE
      `;
      if (rows.length !== 1) throw documentStale();
      const contentHash = hashText(rows[0].content);
      if (contentHash !== expectedContentHash || contentHash !== proposal.contentHash) {
        throw documentStale();
      }
      return canonicalSnapshot("COVER_LETTER", rows[0].content);
    });

    let bytes: Buffer;
    try {
      bytes = await renderCanonical({
        artifactType: snapshot.artifactType,
        content: snapshot.content
      });
    } catch {
      throw renderFailed();
    }

    return {
      bytes,
      artifactType: snapshot.artifactType,
      format: snapshot.format,
      contentType: snapshot.contentType,
      filename: snapshot.filename
    } as const;
  }

  return { exportApprovedApplicationRunDocument };
}

const defaultApplicationRunDocumentExportService = createApplicationRunDocumentExportService();

export const exportApprovedApplicationRunDocument =
  defaultApplicationRunDocumentExportService.exportApprovedApplicationRunDocument;
