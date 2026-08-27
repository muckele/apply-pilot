import { PublicApiError } from "@/lib/api-errors";
import type { VerifiedCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import type { NormalizedApplicationFormField } from "@/lib/application-runs/form-inspection";
import { MAX_FUTURE_RAW_HTTP_BODY_BYTES } from "@/lib/application-runs/form-inspection";
import type {
  ApplicationAnswerDisposition,
  ApplicationAnswerDispositionReason,
  ApplicationQuestionClassification
} from "@/lib/application-runs/question-classification";

type OwnerSafePacket = VerifiedCurrentAnswerPacket["ownerSafe"];

export type PublicApplicationAnswerProposal =
  | { kind: "SCALAR"; value: string }
  | { kind: "BOOLEAN"; value: boolean }
  | { kind: "OPTIONS"; optionKeys: string[] }
  | {
      kind: "DOCUMENT_REFERENCE";
      artifactType: "RESUME" | "COVER_LETTER";
      documentId: string;
    };

export type PublicApplicationRunAnswerPacketSummary = {
  fieldCount: number;
  proposableCount: number;
  pendingReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
  manualOnlyCount: number;
  excludedCount: number;
  unsupportedCount: number;
  manualRequiredCount: number;
  readyForRunResolution: boolean;
};

export type PublicApplicationRunAnswerPacketAnswer = {
  id: string;
  normalizedFieldKey: string;
  question: string;
  fieldType: NormalizedApplicationFormField["fieldType"];
  classification: ApplicationQuestionClassification;
  disposition: ApplicationAnswerDisposition;
  dispositionReason: ApplicationAnswerDispositionReason | null;
  choices: Array<{ key: string; label: string; disabled: boolean }>;
  proposal: PublicApplicationAnswerProposal | null;
  required: boolean;
  requiresReview: boolean;
  sensitive: boolean;
  valueRedacted: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByUser: boolean;
  reviewedAt: string | null;
};

export type PublicApplicationRunAnswerPacket = {
  inspectionVersion: number;
  answerPacketVersion: number;
  packetHash: string;
  reviewedAt: string | null;
  createdAt: string;
  summary: PublicApplicationRunAnswerPacketSummary;
  answers: PublicApplicationRunAnswerPacketAnswer[];
};

function boundaryError(message: string, status: number, code: string): PublicApiError {
  return new PublicApiError(message, status, { code });
}

function requestBodyTooLarge(): PublicApiError {
  return boundaryError("The request body is too large.", 413, "REQUEST_BODY_TOO_LARGE");
}

function invalidContentLength(): PublicApiError {
  return boundaryError("Content-Length must be a nonnegative decimal integer.", 400, "INVALID_CONTENT_LENGTH");
}

function invalidJson(): PublicApiError {
  return boundaryError("The request body must contain valid JSON.", 400, "INVALID_JSON");
}

function invalidRequestBody(): PublicApiError {
  return boundaryError("The request body could not be read.", 400, "INVALID_REQUEST_BODY");
}

export function assertApplicationJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw boundaryError("Content-Type must be application/json.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
}

function assertDeclaredBodySize(request: Request): void {
  const declared = request.headers.get("content-length");
  if (declared === null) return;
  const trimmed = declared.trim();
  if (!/^\d+$/.test(trimmed)) throw invalidContentLength();
  if (BigInt(trimmed) > BigInt(MAX_FUTURE_RAW_HTTP_BODY_BYTES)) throw requestBodyTooLarge();
}

export async function readBoundedApplicationRunPacketJson(request: Request): Promise<unknown> {
  assertDeclaredBodySize(request);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_FUTURE_RAW_HTTP_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Cancellation is best effort; the authoritative result remains 413.
          }
          throw requestBodyTooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw invalidRequestBody();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A consumed or cancelled reader may already have released its lock.
      }
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(decoded) as unknown;
  } catch {
    throw invalidJson();
  }
}

function toPublicProposal(
  proposal: OwnerSafePacket["answers"][number]["proposal"]
): PublicApplicationAnswerProposal | null {
  if (proposal === null) return null;
  if (proposal.kind === "SCALAR") return { kind: "SCALAR", value: proposal.value };
  if (proposal.kind === "BOOLEAN") return { kind: "BOOLEAN", value: proposal.value };
  if (proposal.kind === "OPTIONS") return { kind: "OPTIONS", optionKeys: [...proposal.optionKeys] };
  return {
    kind: "DOCUMENT_REFERENCE",
    artifactType: proposal.artifactType,
    documentId: proposal.documentId
  };
}

export function toPublicApplicationRunAnswerPacket(
  packet: OwnerSafePacket
): PublicApplicationRunAnswerPacket {
  return {
    inspectionVersion: packet.inspectionVersion,
    answerPacketVersion: packet.packetVersion,
    packetHash: packet.packetHash,
    reviewedAt: packet.reviewedAt?.toISOString() ?? null,
    createdAt: packet.createdAt.toISOString(),
    summary: {
      fieldCount: packet.summary.fieldCount,
      proposableCount: packet.summary.proposableCount,
      pendingReviewCount: packet.summary.pendingReviewCount,
      approvedCount: packet.summary.approvedCount,
      rejectedCount: packet.summary.rejectedCount,
      manualOnlyCount: packet.summary.manualOnlyCount,
      excludedCount: packet.summary.excludedCount,
      unsupportedCount: packet.summary.unsupportedCount,
      manualRequiredCount: packet.summary.manualRequiredCount,
      readyForRunResolution: packet.summary.readyForRunResolution
    },
    answers: packet.answers.map((answer) => ({
      id: answer.id,
      normalizedFieldKey: answer.normalizedFieldKey,
      question: answer.originalQuestion,
      fieldType: answer.fieldType,
      classification: answer.classification,
      disposition: answer.disposition,
      dispositionReason: answer.dispositionReason,
      choices: answer.choices.map((choice) => ({
        key: choice.key,
        label: choice.label,
        disabled: choice.disabled
      })),
      proposal: toPublicProposal(answer.proposal),
      required: answer.required,
      requiresReview: answer.requiresReview,
      sensitive: answer.sensitive,
      valueRedacted: answer.valueRedacted,
      status: answer.status,
      reviewedByUser: answer.reviewedByUser,
      reviewedAt: answer.reviewedAt?.toISOString() ?? null
    }))
  };
}
