import type { ApplicationRunState } from "@prisma/client";

import { parseApplyPilotOrigin, parseImmutableRunId } from "@/lib/application-browser/types";
import {
  MAX_FUTURE_RAW_HTTP_BODY_BYTES,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";

type ResponseLike = {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
};

type GetOptions = {
  failOnStatusCode: false;
  maxRedirects: 0;
};

type PostOptions = {
  data: string;
  headers: { "Content-Type": "application/json" };
  failOnStatusCode: false;
  maxRedirects: 0;
  maxRetries: 0;
};

export type ContextRequestLike = {
  get(url: string, options: GetOptions): Promise<ResponseLike>;
  post(url: string, options: PostOptions): Promise<ResponseLike>;
};

export type BrowserApplicationRun = Readonly<{
  id: string;
  state: ApplicationRunState;
  stateVersion: number;
  applyHost: string;
  applyUrlSnapshot: string;
}>;

export type BrowserAutomationPolicy = Readonly<{
  effectiveEnabled: boolean;
  allowedHosts: readonly string[];
  blockedHosts: readonly string[];
}>;

export type BrowserAnswerPacketMetadata = Readonly<{
  inspectionVersion: number;
  answerPacketVersion: number;
}>;

export type BrowserCurrentAnswerPacket = Readonly<{
  runId: string;
  current: BrowserAnswerPacketMetadata | null;
}>;

export type BrowserOperationalRunState = "READY" | "REVIEW_REQUIRED";

export type BrowserFormInspectionPublicationInput = Readonly<{
  runId: string;
  freshRunState: BrowserOperationalRunState;
  expectedStateVersion: number;
  expectedFormInspectionVersion: number;
  expectedAnswerPacketVersion: number;
  observedUrl: string;
  inspectionReport: ApplicationFormInspectionReport;
}>;

type BrowserFormInspectionPublicationSnapshot = Readonly<{
  runId: string;
  freshRunState: BrowserOperationalRunState;
  expectedStateVersion: number;
  expectedFormInspectionVersion: number;
  expectedAnswerPacketVersion: number;
  observedUrl: string;
  inspectionReport: ApplicationFormInspectionReport;
}>;

type BrowserFormInspectionResponseAuthority = Readonly<{
  freshRunState: BrowserOperationalRunState;
  expectedStateVersion: number;
  expectedFormInspectionVersion: number;
  expectedAnswerPacketVersion: number;
}>;

export type BrowserFormInspectionPublicationResult = Readonly<{
  replayed: boolean;
  run: Readonly<{
    id: string;
    state: ApplicationRunState;
    stateVersion: number;
  }>;
  current: BrowserAnswerPacketMetadata;
}>;

export type SameOriginClient = Readonly<{
  getApplicationRun(runId: string): Promise<BrowserApplicationRun>;
  getAutomationPolicy(): Promise<BrowserAutomationPolicy>;
  getCurrentAnswerPacket(runId: string): Promise<BrowserCurrentAnswerPacket>;
  publishFormInspection(
    publication: BrowserFormInspectionPublicationInput,
    assertReadyToDispatch: () => void
  ): Promise<BrowserFormInspectionPublicationResult>;
}>;

export class SameOriginClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SameOriginClientError";
    this.code = code;
  }
}

const APPLICATION_RUN_STATES = new Set<string>([
  "DRAFT",
  "PREPARING",
  "READY",
  "FILLING",
  "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION",
  "COMPLETED_BY_USER",
  "BLOCKED",
  "FAILED",
  "CANCELLED"
]);

const RUN_ERROR_CODES = new Set(["RUN_NOT_FOUND"]);
const PACKET_ERROR_CODES = new Set([
  "RUN_NOT_FOUND",
  "RUN_INSPECTION_STALE",
  "RUN_INSPECTION_INVALID",
  "RUN_PACKET_INVALID"
]);
const PUBLICATION_ERROR_CODES = new Set([
  "AUTOMATION_DISABLED",
  "RUN_NOT_FOUND",
  "RUN_INVALID_STATE",
  "RUN_LIFECYCLE_STALE",
  "RUN_TARGET_INVALID",
  "RUN_TARGET_STALE",
  "RUN_HOST_NOT_ALLOWED",
  "RUN_DOCUMENT_STALE",
  "RUN_INSPECTION_STALE",
  "RUN_INSPECTION_INVALID",
  "RUN_PACKET_INVALID",
  "RUN_ANSWER_SOURCE_SET_TOO_LARGE",
  "REQUEST_BODY_TOO_LARGE",
  "INVALID_CONTENT_LENGTH",
  "INVALID_JSON",
  "INVALID_REQUEST_BODY",
  "UNSUPPORTED_MEDIA_TYPE"
]);

const GET_OPTIONS = { failOnStatusCode: false, maxRedirects: 0 } as const;
const SUCCESS_200 = new Set([200]);
const SUCCESS_PUBLICATION = new Set([200, 201]);
const NO_ERROR_CODES = new Set<string>();
const TEXT_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownRunState(value: unknown): value is ApplicationRunState {
  return typeof value === "string" && APPLICATION_RUN_STATES.has(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonnegativeInteger(value) && value > 0;
}

function identityMismatch(): SameOriginClientError {
  return new SameOriginClientError(
    "The requested run does not match the immutable run.",
    "RUN_IDENTITY_MISMATCH"
  );
}

function requestFailed(): SameOriginClientError {
  return new SameOriginClientError("The same-origin request failed.", "SAME_ORIGIN_REQUEST_FAILED");
}

async function performGet(
  requestContext: ContextRequestLike,
  url: string
): Promise<ResponseLike> {
  try {
    return await requestContext.get(url, GET_OPTIONS);
  } catch {
    throw requestFailed();
  }
}

async function performPost(
  requestContext: ContextRequestLike,
  url: string,
  body: string
): Promise<ResponseLike> {
  try {
    return await requestContext.post(url, {
      data: body,
      headers: { "Content-Type": "application/json" },
      failOnStatusCode: false,
      maxRedirects: 0,
      maxRetries: 0
    });
  } catch {
    throw requestFailed();
  }
}

async function assertExactResponse(
  response: ResponseLike,
  expectedUrl: string,
  successStatuses: ReadonlySet<number>,
  allowedClientErrorCodes: ReadonlySet<string>
): Promise<number> {
  const status = response.status();
  if (status >= 300 && status < 400) {
    throw new SameOriginClientError(
      "The same-origin request redirect was rejected.",
      "SAME_ORIGIN_REDIRECT_REJECTED"
    );
  }
  if (response.url() !== expectedUrl) {
    throw new SameOriginClientError(
      "The same-origin response did not match the fixed route.",
      "SAME_ORIGIN_RESPONSE_MISMATCH"
    );
  }
  if (successStatuses.has(status)) return status;
  if (status >= 200 && status < 300) {
    throw new SameOriginClientError(
      "The same-origin response used an unexpected success status.",
      "SAME_ORIGIN_RESPONSE_MISMATCH"
    );
  }
  if (status === 401) {
    throw new SameOriginClientError(
      "Apply Pilot authentication is required.",
      "APPLY_PILOT_AUTH_REQUIRED"
    );
  }
  if (status === 429) {
    throw new SameOriginClientError(
      "The same-origin request was rate limited.",
      "SAME_ORIGIN_RATE_LIMITED"
    );
  }
  if (status >= 500 || status < 400) throw requestFailed();

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SameOriginClientError(
      "The same-origin endpoint returned an unexpected client error.",
      "SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR"
    );
  }
  const code = isRecord(value) && typeof value.code === "string" ? value.code : null;
  if (code && allowedClientErrorCodes.has(code)) {
    throw new SameOriginClientError("The same-origin endpoint rejected the request.", code);
  }
  throw new SameOriginClientError(
    "The same-origin endpoint returned an unexpected client error.",
    "SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR"
  );
}

async function parseJsonOrThrow(
  response: ResponseLike,
  message: string,
  code: string
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SameOriginClientError(message, code);
  }
}

function parseRunResponse(value: unknown, immutableRunId: string): BrowserApplicationRun {
  if (!isRecord(value) || !isRecord(value.run)) {
    throw new SameOriginClientError("Invalid run response.", "INVALID_RUN_RESPONSE");
  }
  const run = value.run;
  if (
    run.id !== immutableRunId ||
    !isKnownRunState(run.state) ||
    !isSafeNonnegativeInteger(run.stateVersion) ||
    typeof run.applyHost !== "string" ||
    !run.applyHost ||
    typeof run.applyUrlSnapshot !== "string" ||
    !run.applyUrlSnapshot
  ) {
    throw new SameOriginClientError("Invalid run response.", "INVALID_RUN_RESPONSE");
  }
  return {
    id: run.id,
    state: run.state,
    stateVersion: run.stateVersion,
    applyHost: run.applyHost,
    applyUrlSnapshot: run.applyUrlSnapshot
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parsePolicyResponse(value: unknown): BrowserAutomationPolicy {
  if (
    !isRecord(value) ||
    typeof value.effectiveEnabled !== "boolean" ||
    !stringArray(value.allowedHosts) ||
    !stringArray(value.blockedHosts)
  ) {
    throw new SameOriginClientError("Invalid policy response.", "INVALID_POLICY_RESPONSE");
  }
  return {
    effectiveEnabled: value.effectiveEnabled,
    allowedHosts: [...value.allowedHosts],
    blockedHosts: [...value.blockedHosts]
  };
}

function parseCurrentAnswerPacketResponse(
  value: unknown,
  immutableRunId: string
): BrowserCurrentAnswerPacket {
  if (
    !isRecord(value) ||
    value.runId !== immutableRunId ||
    !Object.prototype.hasOwnProperty.call(value, "current")
  ) {
    throw new SameOriginClientError(
      "Invalid answer-packet response.",
      "INVALID_ANSWER_PACKET_RESPONSE"
    );
  }
  if (value.current === null) return { runId: immutableRunId, current: null };
  if (
    !isRecord(value.current) ||
    !isSafePositiveInteger(value.current.inspectionVersion) ||
    !isSafePositiveInteger(value.current.answerPacketVersion)
  ) {
    throw new SameOriginClientError(
      "Invalid answer-packet response.",
      "INVALID_ANSWER_PACKET_RESPONSE"
    );
  }
  return {
    runId: immutableRunId,
    current: {
      inspectionVersion: value.current.inspectionVersion,
      answerPacketVersion: value.current.answerPacketVersion
    }
  };
}

function invalidPublicationResponse(): SameOriginClientError {
  return new SameOriginClientError(
    "Invalid form-inspection publication response.",
    "INVALID_FORM_INSPECTION_RESPONSE"
  );
}

function parsePublicationResponse(
  value: unknown,
  status: number,
  authority: BrowserFormInspectionResponseAuthority,
  immutableRunId: string
): BrowserFormInspectionPublicationResult {
  if (
    !isRecord(value) ||
    typeof value.replayed !== "boolean" ||
    !isRecord(value.run) ||
    !isRecord(value.current) ||
    value.run.id !== immutableRunId ||
    !isKnownRunState(value.run.state) ||
    !isSafeNonnegativeInteger(value.run.stateVersion) ||
    !isSafePositiveInteger(value.current.inspectionVersion) ||
    !isSafePositiveInteger(value.current.answerPacketVersion)
  ) {
    throw invalidPublicationResponse();
  }

  if (status === 200) {
    if (
      !value.replayed ||
      value.run.state !== authority.freshRunState ||
      value.run.stateVersion !== authority.expectedStateVersion ||
      value.current.inspectionVersion < authority.expectedFormInspectionVersion ||
      value.current.answerPacketVersion < authority.expectedAnswerPacketVersion
    ) {
      throw invalidPublicationResponse();
    }
  } else {
    let expectedStateVersion: number;
    if (authority.freshRunState === "READY") {
      expectedStateVersion = authority.expectedStateVersion + 1;
    } else if (authority.freshRunState === "REVIEW_REQUIRED") {
      expectedStateVersion = authority.expectedStateVersion;
    } else {
      throw invalidPublicationResponse();
    }
    const expectedAnswerPacketVersion = authority.expectedAnswerPacketVersion + 1;
    const minimumInspectionVersion = authority.expectedFormInspectionVersion;
    const maximumInspectionVersion = authority.expectedFormInspectionVersion + 1;
    if (
      value.replayed ||
      value.run.state !== "REVIEW_REQUIRED" ||
      value.run.stateVersion !== expectedStateVersion ||
      value.current.answerPacketVersion !== expectedAnswerPacketVersion ||
      value.current.inspectionVersion < minimumInspectionVersion ||
      value.current.inspectionVersion > maximumInspectionVersion ||
      (authority.expectedFormInspectionVersion === 0 && value.current.inspectionVersion !== 1) ||
      (authority.expectedAnswerPacketVersion === 0 && value.current.answerPacketVersion !== 1)
    ) {
      throw invalidPublicationResponse();
    }
  }

  return {
    replayed: value.replayed,
    run: {
      id: immutableRunId,
      state: value.run.state,
      stateVersion: value.run.stateVersion
    },
    current: {
      inspectionVersion: value.current.inspectionVersion,
      answerPacketVersion: value.current.answerPacketVersion
    }
  };
}

function snapshotPublication(
  publication: BrowserFormInspectionPublicationInput
): BrowserFormInspectionPublicationSnapshot {
  return {
    runId: publication.runId,
    freshRunState: publication.freshRunState,
    expectedStateVersion: publication.expectedStateVersion,
    expectedFormInspectionVersion: publication.expectedFormInspectionVersion,
    expectedAnswerPacketVersion: publication.expectedAnswerPacketVersion,
    observedUrl: publication.observedUrl,
    inspectionReport: publication.inspectionReport
  };
}

function serializePublication(snapshot: BrowserFormInspectionPublicationSnapshot): string {
  const freshRunState = snapshot.freshRunState;
  if (
    (freshRunState !== "READY" && freshRunState !== "REVIEW_REQUIRED") ||
    !isSafeNonnegativeInteger(snapshot.expectedStateVersion) ||
    !isSafeNonnegativeInteger(snapshot.expectedFormInspectionVersion) ||
    !isSafeNonnegativeInteger(snapshot.expectedAnswerPacketVersion) ||
    typeof snapshot.observedUrl !== "string" ||
    !snapshot.observedUrl ||
    !isRecord(snapshot.inspectionReport)
  ) {
    throw new SameOriginClientError(
      "Invalid form-inspection publication request.",
      "INVALID_FORM_INSPECTION_REQUEST"
    );
  }

  let body: string;
  try {
    body = JSON.stringify({
      expectedStateVersion: snapshot.expectedStateVersion,
      expectedFormInspectionVersion: snapshot.expectedFormInspectionVersion,
      expectedAnswerPacketVersion: snapshot.expectedAnswerPacketVersion,
      observedUrl: snapshot.observedUrl,
      inspectionReport: snapshot.inspectionReport
    });
  } catch {
    throw new SameOriginClientError(
      "Invalid form-inspection publication request.",
      "INVALID_FORM_INSPECTION_REQUEST"
    );
  }
  if (TEXT_ENCODER.encode(body).byteLength > MAX_FUTURE_RAW_HTTP_BODY_BYTES) {
    throw new SameOriginClientError(
      "The form-inspection publication request is too large.",
      "FORM_INSPECTION_REQUEST_TOO_LARGE"
    );
  }
  return body;
}

export function createSameOriginClient(input: {
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  requestContext: ContextRequestLike;
}): SameOriginClient {
  const origin = parseApplyPilotOrigin(input.configuredApplyPilotOrigin);
  const immutableRunId = parseImmutableRunId(input.immutableRunId);
  const runUrl = `${origin}/api/application-runs/${immutableRunId}`;
  const policyUrl = `${origin}/api/application-automation-policy`;
  const packetUrl = `${runUrl}/answer-packet`;
  const publicationUrl = `${runUrl}/form-inspection`;

  return Object.freeze({
    async getApplicationRun(runId: string) {
      if (runId !== immutableRunId) throw identityMismatch();
      const response = await performGet(input.requestContext, runUrl);
      await assertExactResponse(response, runUrl, SUCCESS_200, RUN_ERROR_CODES);
      const value = await parseJsonOrThrow(response, "Invalid run response.", "INVALID_RUN_RESPONSE");
      return parseRunResponse(value, immutableRunId);
    },
    async getAutomationPolicy() {
      const response = await performGet(input.requestContext, policyUrl);
      await assertExactResponse(response, policyUrl, SUCCESS_200, NO_ERROR_CODES);
      const value = await parseJsonOrThrow(
        response,
        "Invalid policy response.",
        "INVALID_POLICY_RESPONSE"
      );
      return parsePolicyResponse(value);
    },
    async getCurrentAnswerPacket(runId: string) {
      if (runId !== immutableRunId) throw identityMismatch();
      const response = await performGet(input.requestContext, packetUrl);
      await assertExactResponse(response, packetUrl, SUCCESS_200, PACKET_ERROR_CODES);
      const value = await parseJsonOrThrow(
        response,
        "Invalid answer-packet response.",
        "INVALID_ANSWER_PACKET_RESPONSE"
      );
      return parseCurrentAnswerPacketResponse(value, immutableRunId);
    },
    async publishFormInspection(
      publication: BrowserFormInspectionPublicationInput,
      assertReadyToDispatch: () => void
    ) {
      const snapshot = snapshotPublication(publication);
      if (snapshot.runId !== immutableRunId) throw identityMismatch();
      const body = serializePublication(snapshot);
      const responseAuthority: BrowserFormInspectionResponseAuthority = {
        freshRunState: snapshot.freshRunState,
        expectedStateVersion: snapshot.expectedStateVersion,
        expectedFormInspectionVersion: snapshot.expectedFormInspectionVersion,
        expectedAnswerPacketVersion: snapshot.expectedAnswerPacketVersion
      };
      assertReadyToDispatch();
      const response = await performPost(input.requestContext, publicationUrl, body);
      const status = await assertExactResponse(
        response,
        publicationUrl,
        SUCCESS_PUBLICATION,
        PUBLICATION_ERROR_CODES
      );
      const value = await parseJsonOrThrow(
        response,
        "Invalid form-inspection publication response.",
        "INVALID_FORM_INSPECTION_RESPONSE"
      );
      return parsePublicationResponse(value, status, responseAuthority, immutableRunId);
    }
  });
}
