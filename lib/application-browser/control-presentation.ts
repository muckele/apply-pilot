import { z } from "zod";

import type {
  PublicApplicationAnswerProposal,
  PublicApplicationRunAnswerPacket,
  PublicApplicationRunAnswerPacketAnswer
} from "@/lib/application-runs/answer-packet-api";
import type { ApplicationFormFieldType } from "@/lib/application-runs/form-inspection";
import type {
  ApplicationAnswerDisposition,
  ApplicationAnswerDispositionReason,
  ApplicationQuestionClassification
} from "@/lib/application-runs/question-classification";
import type {
  B1Status,
  B1WorkflowState,
  B2InspectionCommandStatus,
  BrowserInspectionRecoverableCode
} from "@/lib/application-browser/types";

export type ControlConnection = "UNKNOWN" | "CONNECTED" | "UNAVAILABLE";
export type PendingBrowserCommand =
  | "GET_STATUS"
  | "OPEN_TARGET"
  | "INSPECT_FORM"
  | "CLOSE_WORKFLOW"
  | null;
export type PacketFreshness = "absent" | "current" | "stale" | "unverified";
export type AnswerPacket = PublicApplicationRunAnswerPacket;
export type AnswerPacketAnswer = PublicApplicationRunAnswerPacketAnswer;

type CommandAvailability = Record<Exclude<PendingBrowserCommand, null>, boolean>;

const WORKFLOW_STATES = [
  "STARTING",
  "APPLY_PILOT_AUTH_REQUIRED",
  "CONTROL_READY",
  "OPENING_TARGET",
  "TARGET_OPEN",
  "ERROR",
  "CLOSED"
] as const satisfies readonly B1WorkflowState[];

const RECOVERABLE_CODES = [
  "FORM_INSPECTION_IN_PROGRESS",
  "FORM_STABILITY_TIMEOUT",
  "FORM_GENERATION_INVALIDATED",
  "FORM_CORRELATION_INVALID",
  "AMBIGUOUS_DUPLICATE_FIELD",
  "FORM_INSPECTION_CANCELLED",
  "FORM_INSPECTION_REQUEST_TOO_LARGE",
  "RUN_LIFECYCLE_STALE",
  "RUN_DOCUMENT_STALE",
  "SAME_ORIGIN_RATE_LIMITED",
  "SAME_ORIGIN_REQUEST_FAILED"
] as const satisfies readonly BrowserInspectionRecoverableCode[];

const FIELD_TYPES = [
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA",
  "SELECT_ONE",
  "SELECT_MANY",
  "RADIO_GROUP",
  "CHECKBOX_BOOLEAN",
  "CHECKBOX_GROUP",
  "NUMBER",
  "DATE",
  "FILE_UPLOAD",
  "UNSUPPORTED"
] as const satisfies readonly ApplicationFormFieldType[];

const CLASSIFICATIONS = [
  "CONTACT",
  "PROFESSIONAL_LINK",
  "EXPERIENCE",
  "EDUCATION",
  "SKILL",
  "CITIZENSHIP_IMMIGRATION",
  "WORK_AUTHORIZATION",
  "SPONSORSHIP",
  "AVAILABILITY",
  "RELOCATION",
  "COMPENSATION",
  "DEMOGRAPHIC",
  "DISABILITY",
  "VETERAN",
  "CRIMINAL_HISTORY",
  "LEGAL_ATTESTATION",
  "DOCUMENT",
  "UNKNOWN"
] as const satisfies readonly ApplicationQuestionClassification[];

const DISPOSITIONS = [
  "PROPOSABLE",
  "MANUAL_ONLY",
  "EXCLUDED",
  "UNSUPPORTED"
] as const satisfies readonly ApplicationAnswerDisposition[];

const DISPOSITION_REASONS = [
  "NO_ELIGIBLE_SOURCE",
  "INVALID_SOURCE_VALUE",
  "AMBIGUOUS_SOURCE",
  "UNCONFIRMED_APPLICANT_CONTACT",
  "POLICY_EXCLUDED",
  "LEGAL_ATTESTATION",
  "V1_MANUAL_POLICY",
  "UNSUPPORTED_CONTROL",
  "AMBIGUOUS_FIELD",
  "AMBIGUOUS_CHOICES",
  "MULTIPLE_FILE_UPLOAD",
  "NO_SELECTED_DOCUMENT",
  "UNKNOWN_QUESTION"
] as const satisfies readonly ApplicationAnswerDispositionReason[];

const boundedText = z.string().min(1).max(2_048);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const positiveSafeInteger = z.number().int().positive().safe();
const isoDateTime = z.string().datetime({ offset: true });

const inspectionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("IN_PROGRESS") }).strict(),
  z
    .object({
      outcome: z.literal("SUCCEEDED"),
      replayed: z.boolean(),
      inspectionVersion: positiveSafeInteger,
      answerPacketVersion: positiveSafeInteger,
      reinspectionRequired: z.boolean()
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REINSPECTION_REQUIRED"),
      errorCode: z.literal("FORM_GENERATION_INVALIDATED"),
      retryAllowed: z.literal(true)
    })
    .strict(),
  z
    .object({
      outcome: z.literal("FAILED"),
      errorCode: z.enum(RECOVERABLE_CODES),
      retryAllowed: z.literal(true)
    })
    .strict()
]);

const statusSchema = z
  .object({
    state: z.enum(WORKFLOW_STATES),
    runId: boundedText,
    targetHost: boundedText.optional(),
    errorCode: boundedText.optional(),
    inspection: inspectionSchema.optional()
  })
  .strict();

const choiceSchema = z
  .object({
    key: boundedText,
    label: z.string().max(2_048),
    disabled: z.boolean()
  })
  .strict();

const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SCALAR"), value: z.string().max(16_384) }).strict(),
  z.object({ kind: z.literal("BOOLEAN"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("OPTIONS"), optionKeys: z.array(boundedText).max(256) }).strict(),
  z
    .object({
      kind: z.literal("DOCUMENT_REFERENCE"),
      artifactType: z.enum(["RESUME", "COVER_LETTER"]),
      documentId: boundedText
    })
    .strict()
]);

const summarySchema = z
  .object({
    fieldCount: nonnegativeSafeInteger,
    proposableCount: nonnegativeSafeInteger,
    pendingReviewCount: nonnegativeSafeInteger,
    approvedCount: nonnegativeSafeInteger,
    rejectedCount: nonnegativeSafeInteger,
    manualOnlyCount: nonnegativeSafeInteger,
    excludedCount: nonnegativeSafeInteger,
    unsupportedCount: nonnegativeSafeInteger,
    manualRequiredCount: nonnegativeSafeInteger,
    readyForRunResolution: z.boolean()
  })
  .strict();

const answerSchema = z
  .object({
    id: boundedText,
    normalizedFieldKey: boundedText,
    question: z.string().max(2_048),
    fieldType: z.enum(FIELD_TYPES),
    classification: z.enum(CLASSIFICATIONS),
    disposition: z.enum(DISPOSITIONS),
    dispositionReason: z.enum(DISPOSITION_REASONS).nullable(),
    choices: z.array(choiceSchema).max(256),
    proposal: proposalSchema.nullable(),
    required: z.boolean(),
    requiresReview: z.boolean(),
    sensitive: z.boolean(),
    valueRedacted: z.boolean(),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    reviewedByUser: z.boolean(),
    reviewedAt: isoDateTime.nullable()
  })
  .strict()
  .superRefine((answer, context) => {
    const hasProposal = answer.proposal !== null;
    if ((answer.disposition === "PROPOSABLE") !== hasProposal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "Proposal authority is inconsistent with the answer disposition."
      });
    }
    if (hasProposal && (answer.sensitive || answer.valueRedacted)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "Sensitive or redacted answers cannot contain proposal authority."
      });
    }
  });

const packetSchema = z
  .object({
    inspectionVersion: positiveSafeInteger,
    answerPacketVersion: positiveSafeInteger,
    packetHash: sha256Hex,
    reviewedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    summary: summarySchema,
    answers: z.array(answerSchema).max(200)
  })
  .strict();

const packetResponseSchema = z
  .object({
    runId: boundedText,
    current: packetSchema.nullable()
  })
  .strict();

const RECOVERABLE_MESSAGES: Record<BrowserInspectionRecoverableCode, string> = {
  FORM_INSPECTION_IN_PROGRESS:
    "An inspection is already running. Wait for it to finish, then refresh status.",
  FORM_STABILITY_TIMEOUT:
    "The form did not settle in time. Wait for the page to finish changing, then inspect again.",
  FORM_GENERATION_INVALIDATED: "The employer form changed during inspection. Inspect it again.",
  FORM_CORRELATION_INVALID:
    "The form could not be matched safely. Check that the intended form is visible, then inspect again.",
  AMBIGUOUS_DUPLICATE_FIELD:
    "Similar duplicate fields could not be distinguished safely. Review the employer form, then retry; handle those fields manually if it persists.",
  FORM_INSPECTION_CANCELLED:
    "Inspection stopped before publication. Check that the target is still open, then retry.",
  FORM_INSPECTION_REQUEST_TOO_LARGE:
    "The visible form is too large to inspect safely in one pass. Navigate to a smaller form step if available and retry; otherwise complete it manually.",
  RUN_LIFECYCLE_STALE: "The application run changed. Refresh browser status, then inspect again.",
  RUN_DOCUMENT_STALE: "The application documents changed. Refresh browser status, then inspect again.",
  SAME_ORIGIN_RATE_LIMITED: "Too many inspection requests were made. Wait a moment, then retry.",
  SAME_ORIGIN_REQUEST_FAILED:
    "Apply Pilot could not publish the inspection. Check the control workflow and connection, then retry."
};

export function browserCommandAvailability(input: {
  status: B1Status;
  connection: ControlConnection;
  pendingCommand: PendingBrowserCommand;
}): CommandAvailability {
  if (
    input.status.state === "CLOSED" ||
    input.connection === "UNAVAILABLE" ||
    input.pendingCommand !== null
  ) {
    return { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false };
  }
  if (input.connection === "UNKNOWN") {
    return { GET_STATUS: true, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false };
  }
  return {
    GET_STATUS: true,
    OPEN_TARGET: input.status.state === "CONTROL_READY",
    INSPECT_FORM:
      input.status.state === "TARGET_OPEN" && input.status.inspection?.outcome !== "IN_PROGRESS",
    CLOSE_WORKFLOW: true
  };
}

export function shouldOfferRetryConnection(
  connection: ControlConnection,
  status: B1Status,
  pendingCommand: PendingBrowserCommand
): boolean {
  return connection === "UNAVAILABLE" && status.state !== "CLOSED" && pendingCommand === null;
}

export function bindingRejectionPlan(
  command: Exclude<PendingBrowserCommand, null>,
  status: B1Status,
  packetFreshness: PacketFreshness
) {
  return {
    connection: "UNAVAILABLE" as const,
    preservedStatus: status,
    recoverWithGetStatus:
      command !== "GET_STATUS" && !(command === "CLOSE_WORKFLOW" && status.state === "CLOSED"),
    packetTrust:
      command === "INSPECT_FORM"
        ? packetFreshness === "stale"
          ? ("STALE" as const)
          : ("UNVERIFIED" as const)
        : ("UNCHANGED" as const)
  };
}

export type InspectionPresentation = {
  tone: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  text: string;
  retryAllowed: boolean;
  invalidatesPacket: boolean;
  automaticPacketRefreshKey: string | null;
};

export function inspectionPresentation(inspection: B2InspectionCommandStatus): InspectionPresentation {
  if (inspection.outcome === "IN_PROGRESS") {
    return {
      tone: "INFO",
      text: "Inspection is in progress. No employer fields are being filled or submitted.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: null
    };
  }
  if (inspection.outcome === "SUCCEEDED") {
    if (inspection.reinspectionRequired) {
      return {
        tone: "WARNING",
        text: "The employer form changed after publication. Inspect it again before relying on the packet.",
        retryAllowed: true,
        invalidatesPacket: true,
        automaticPacketRefreshKey: null
      };
    }
    return {
      tone: "SUCCESS",
      text: inspection.replayed
        ? "Existing current packet matched the verified inspection; no new packet version was created."
        : "Inspection was published and the current answer packet was updated. Review the proposed answers below. No employer fields were filled or submitted.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: `${inspection.inspectionVersion}:${inspection.answerPacketVersion}`
    };
  }
  return {
    tone: inspection.outcome === "REINSPECTION_REQUIRED" ? "WARNING" : "ERROR",
    text: RECOVERABLE_MESSAGES[inspection.errorCode],
    retryAllowed: inspection.retryAllowed,
    invalidatesPacket: inspection.errorCode === "FORM_GENERATION_INVALIDATED",
    automaticPacketRefreshKey: null
  };
}

export type CommandNotice = Pick<InspectionPresentation, "tone" | "text">;

export function applyAuthoritativeBrowserStatus(input: {
  value: unknown;
  expectedRunId: string;
  formInvalidatedSinceVerifiedSuccess: boolean;
}):
  | { accepted: false; connection: "UNAVAILABLE" }
  | {
      accepted: true;
      status: B1Status;
      connection: "CONNECTED";
      lastAcceptedInspection: B2InspectionCommandStatus | null;
      formInvalidatedSinceVerifiedSuccess: boolean;
      notice: CommandNotice | null;
      automaticPacketRefreshKey: string | null;
    } {
  const parsed = statusSchema.safeParse(input.value);
  if (!parsed.success || parsed.data.runId !== input.expectedRunId) {
    return { accepted: false, connection: "UNAVAILABLE" };
  }
  const status = parsed.data as B1Status;
  const inspection = status.inspection ?? null;
  if (inspection === null) {
    return {
      accepted: true,
      status,
      connection: "CONNECTED",
      lastAcceptedInspection: null,
      formInvalidatedSinceVerifiedSuccess: input.formInvalidatedSinceVerifiedSuccess,
      notice: null,
      automaticPacketRefreshKey: null
    };
  }
  const presentation = inspectionPresentation(inspection);
  const cleanSuccess = inspection.outcome === "SUCCEEDED" && !inspection.reinspectionRequired;
  return {
    accepted: true,
    status,
    connection: "CONNECTED",
    lastAcceptedInspection: inspection,
    formInvalidatedSinceVerifiedSuccess: cleanSuccess
      ? false
      : input.formInvalidatedSinceVerifiedSuccess || presentation.invalidatesPacket,
    notice: { tone: presentation.tone, text: presentation.text },
    automaticPacketRefreshKey: presentation.automaticPacketRefreshKey
  };
}

export function parseAnswerPacketResponse(value: unknown, expectedRunId: string): {
  runId: string;
  current: AnswerPacket | null;
} {
  const parsed = packetResponseSchema.parse(value);
  if (parsed.runId !== expectedRunId) throw new Error("Answer packet run mismatch.");
  return parsed as { runId: string; current: AnswerPacket | null };
}

export function derivePacketFreshness(input: {
  packet: AnswerPacket | null;
  latestPacketResponseWasNull: boolean;
  packetLoadUnverified: boolean;
  connection: ControlConnection;
  workflowState: B1WorkflowState;
  lastAcceptedInspection: B2InspectionCommandStatus | null;
  formInvalidatedSinceVerifiedSuccess: boolean;
}): PacketFreshness {
  if (input.packet === null) {
    return input.latestPacketResponseWasNull ? "absent" : "unverified";
  }
  if (
    input.formInvalidatedSinceVerifiedSuccess ||
    input.lastAcceptedInspection?.outcome === "REINSPECTION_REQUIRED" ||
    (input.lastAcceptedInspection?.outcome === "SUCCEEDED" &&
      input.lastAcceptedInspection.reinspectionRequired)
  ) {
    return "stale";
  }
  if (
    input.packetLoadUnverified ||
    input.connection !== "CONNECTED" ||
    input.workflowState !== "TARGET_OPEN" ||
    input.lastAcceptedInspection?.outcome !== "SUCCEEDED" ||
    input.lastAcceptedInspection.reinspectionRequired ||
    input.packet.inspectionVersion !== input.lastAcceptedInspection.inspectionVersion ||
    input.packet.answerPacketVersion !== input.lastAcceptedInspection.answerPacketVersion
  ) {
    return "unverified";
  }
  return "current";
}

export type ProposalPresentation = {
  label: string;
  values: Array<{ text: string; annotation: string | null }>;
};

export function presentProposal(
  proposal: PublicApplicationAnswerProposal,
  choices: AnswerPacketAnswer["choices"],
  answer: Pick<AnswerPacketAnswer, "disposition" | "sensitive" | "valueRedacted">
): ProposalPresentation | null {
  if (answer.disposition !== "PROPOSABLE" || answer.sensitive || answer.valueRedacted) {
    return null;
  }
  if (proposal.kind === "SCALAR") {
    return {
      label: "Proposed answer — review before use",
      values: [{ text: proposal.value, annotation: null }]
    };
  }
  if (proposal.kind === "BOOLEAN") {
    return {
      label: "Proposed answer — review before use",
      values: [{ text: proposal.value ? "Yes" : "No", annotation: null }]
    };
  }
  if (proposal.kind === "DOCUMENT_REFERENCE") {
    return {
      label:
        proposal.artifactType === "RESUME"
          ? "Proposed résumé document reference"
          : "Proposed cover-letter document reference",
      values: [{ text: proposal.documentId, annotation: null }]
    };
  }
  return {
    label: "Proposed answer — review before use",
    values: proposal.optionKeys.map((key) => {
      const matches = choices.filter((choice) => choice.key === key);
      if (matches.length !== 1) {
        return { text: "Option unavailable in packet choices", annotation: null };
      }
      return {
        text: matches[0].label,
        annotation: matches[0].disabled ? "Disabled option" : null
      };
    })
  };
}

const DISPOSITION_MESSAGES: Record<ApplicationAnswerDisposition, string> = {
  PROPOSABLE: "Apply Pilot produced a proposed answer. Review it before using it.",
  MANUAL_ONLY: "You must answer this field manually.",
  EXCLUDED: "Apply Pilot intentionally did not propose an answer.",
  UNSUPPORTED: "This field or control is unsupported and must be handled manually."
};

export function dispositionMessage(disposition: ApplicationAnswerDisposition): string {
  return DISPOSITION_MESSAGES[disposition];
}

export function readinessMessage(ready: boolean): string {
  return ready
    ? "Packet review requirements are satisfied for Apply Pilot's internal run-review workflow."
    : "Packet review requirements are not yet satisfied for Apply Pilot's internal run-review workflow.";
}
