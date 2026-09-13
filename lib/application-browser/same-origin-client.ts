import type { ApplicationRunState } from "@prisma/client";

import { parseApplyPilotOrigin, parseImmutableRunId } from "@/lib/application-browser/types";
import {
  parseFillStatusResponse as parseSharedFillStatusResponse,
  type BrowserFillAttemptStatus,
  type BrowserFillStepResult
} from "@/lib/application-browser/fill-status-presentation";
export type {
  BrowserFillAttemptStatus,
  BrowserFillStepResult
} from "@/lib/application-browser/fill-status-presentation";
import {
  parseApplicationAnswerProposal,
  type ApplicationAnswerProposal
} from "@/lib/application-runs/answer-packet-domain";
import {
  FILL_ELIGIBLE_FIELD_TYPES,
  FILL_ERROR_CODES,
  FILL_STEP_RESULTS,
  reconcileFillFinalization,
  type FillEligibleFieldType,
  type FillErrorCode,
  type FillStepResult,
  type StoppedEarlyFillError
} from "@/lib/application-runs/fill-attempt-domain";
import {
  MAX_FUTURE_RAW_HTTP_BODY_BYTES,
  MAX_FIELDS_TOTAL,
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

type PatchOptions = PostOptions;

export type ContextRequestLike = {
  get(url: string, options: GetOptions): Promise<ResponseLike>;
  post(url: string, options: PostOptions): Promise<ResponseLike>;
  patch(url: string, options: PatchOptions): Promise<ResponseLike>;
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

export type FillMutationDispatchState = "NOT_DISPATCHED" | "MAY_HAVE_DISPATCHED";

export type BrowserFillProposal =
  | Readonly<{ kind: "SCALAR"; value: string }>
  | Readonly<{ kind: "OPTIONS"; optionKeys: readonly [string] }>;

export type BrowserAcquiredFillField = Readonly<{
  stepKey: string;
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: FillEligibleFieldType;
  proposal: BrowserFillProposal;
}>;

export type BrowserFillAcquisition = Readonly<{
  attemptId: string;
  runStateVersion: number;
  leaseExpiresAt: string;
  formInspectionVersion: number;
  answerPacketVersion: number;
  packetHash: string;
  formFingerprint: string;
  eligibleFields: readonly BrowserAcquiredFillField[];
}>;

export type BrowserFillAcquireInput = Readonly<{
  runId: string;
  expectedStateVersion: number;
}>;

export type BrowserFillFinalizeInput = Readonly<{
  runId: string;
  fillAttemptId: string;
  expectedStateVersion: number;
  outcome: "COMPLETED" | "STOPPED_EARLY";
  errorCode: StoppedEarlyFillError | null;
  steps: readonly BrowserFillStepResult[];
}>;

export type BrowserFillRecoverInput = Readonly<{
  runId: string;
  fillAttemptId: string;
  expectedStateVersion: number;
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

export type SameOriginFillClient = Readonly<{
  acquireFillAttempt(
    input: BrowserFillAcquireInput,
    assertReadyToDispatch: () => void
  ): Promise<BrowserFillAcquisition>;
  getFillAttemptStatus(runId: string): Promise<BrowserFillAttemptStatus>;
  finalizeFillAttempt(
    input: BrowserFillFinalizeInput,
    assertReadyToDispatch: () => void
  ): Promise<BrowserFillAttemptStatus>;
  recoverExpiredFillAttempt(
    input: BrowserFillRecoverInput,
    assertReadyToDispatch: () => void
  ): Promise<BrowserFillAttemptStatus>;
}>;

export type SameOriginClientWithFill = SameOriginClient & SameOriginFillClient;

export class SameOriginClientError extends Error {
  readonly code: string;
  readonly dispatchState: FillMutationDispatchState | null;
  readonly responseReceived: boolean;

  constructor(
    message: string,
    code: string,
    dispatchState: FillMutationDispatchState | null = null,
    responseReceived = false
  ) {
    super(message);
    this.name = "SameOriginClientError";
    this.code = code;
    this.dispatchState = dispatchState;
    this.responseReceived = responseReceived;
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
const FILL_ERROR_RESPONSE_CODES = new Set([
  "RUN_NOT_FOUND",
  "FILL_POLICY_DENIED",
  "FILL_REVIEW_REQUIRED",
  "FILL_ALREADY_IN_PROGRESS",
  "FILL_NO_ELIGIBLE_FIELDS",
  "FILL_STALE"
]);

const GET_OPTIONS = { failOnStatusCode: false, maxRedirects: 0 } as const;
const SUCCESS_200 = new Set([200]);
const SUCCESS_201 = new Set([201]);
const SUCCESS_PUBLICATION = new Set([200, 201]);
const NO_ERROR_CODES = new Set<string>();
const TEXT_ENCODER = new TextEncoder();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fillEligibleTypes = new Set<string>(FILL_ELIGIBLE_FIELD_TYPES);
const fillStepResults = new Set<string>(FILL_STEP_RESULTS);
const fillErrorCodes = new Set<string>(FILL_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isFillErrorCode(value: unknown): value is FillErrorCode {
  return typeof value === "string" && fillErrorCodes.has(value);
}

function isFillStepResult(value: unknown): value is FillStepResult {
  return typeof value === "string" && fillStepResults.has(value);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SameOriginClientError) return error.code;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  return "SAME_ORIGIN_REQUEST_FAILED";
}

function mutationFailure(
  error: unknown,
  dispatchState: FillMutationDispatchState,
  responseReceived: boolean
): SameOriginClientError {
  return new SameOriginClientError(
    "The Fill mutation failed safely.",
    safeErrorCode(error),
    dispatchState,
    responseReceived
  );
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

function mutationOptions(body: string): PostOptions {
  return {
    data: body,
    headers: { "Content-Type": "application/json" },
    failOnStatusCode: false,
    maxRedirects: 0,
    maxRetries: 0
  };
}

async function performFillMutation<T>(input: Readonly<{
  expectedUrl: string;
  buildBody(): string;
  assertReadyToDispatch(): void;
  dispatch(options: PostOptions): Promise<ResponseLike>;
  successStatuses: ReadonlySet<number>;
  parse(value: unknown): T;
}>): Promise<T> {
  let dispatchState: FillMutationDispatchState = "NOT_DISPATCHED";
  let responseReceived = false;
  try {
    const body = input.buildBody();
    input.assertReadyToDispatch();
    dispatchState = "MAY_HAVE_DISPATCHED";
    const response = await input.dispatch(mutationOptions(body));
    responseReceived = true;
    await assertExactResponse(
      response,
      input.expectedUrl,
      input.successStatuses,
      FILL_ERROR_RESPONSE_CODES
    );
    const value = await parseJsonOrThrow(
      response,
      "Invalid Fill response.",
      "INVALID_FILL_RESPONSE"
    );
    return input.parse(value);
  } catch (error) {
    throw mutationFailure(error, dispatchState, responseReceived);
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

function invalidFillAcquisitionResponse(): SameOriginClientError {
  return new SameOriginClientError(
    "Invalid Fill acquisition response.",
    "INVALID_FILL_ACQUISITION_RESPONSE"
  );
}

function parseBrowserFillProposal(
  value: unknown,
  fieldType: FillEligibleFieldType
): BrowserFillProposal {
  let proposal: ApplicationAnswerProposal;
  try {
    proposal = parseApplicationAnswerProposal(value);
  } catch {
    throw invalidFillAcquisitionResponse();
  }
  if (fieldType === "SELECT_ONE") {
    if (
      proposal.kind !== "OPTIONS" ||
      proposal.optionKeys.length !== 1 ||
      !isSha256(proposal.optionKeys[0])
    ) {
      throw invalidFillAcquisitionResponse();
    }
    return Object.freeze({
      kind: "OPTIONS" as const,
      optionKeys: Object.freeze([proposal.optionKeys[0]]) as readonly [string]
    });
  }
  if (proposal.kind !== "SCALAR") throw invalidFillAcquisitionResponse();
  return Object.freeze({ kind: "SCALAR" as const, value: proposal.value });
}

function parseFillAcquisitionResponse(value: unknown): BrowserFillAcquisition {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "attemptId",
      "runStateVersion",
      "leaseExpiresAt",
      "formInspectionVersion",
      "answerPacketVersion",
      "packetHash",
      "formFingerprint",
      "eligibleFields"
    ]) ||
    !isUuid(value.attemptId) ||
    !isSafeNonnegativeInteger(value.runStateVersion) ||
    !isCanonicalIsoDate(value.leaseExpiresAt) ||
    !isSafePositiveInteger(value.formInspectionVersion) ||
    !isSafePositiveInteger(value.answerPacketVersion) ||
    !isSha256(value.packetHash) ||
    !isSha256(value.formFingerprint) ||
    !Array.isArray(value.eligibleFields) ||
    value.eligibleFields.length < 1 ||
    value.eligibleFields.length > MAX_FIELDS_TOTAL
  ) {
    throw invalidFillAcquisitionResponse();
  }

  const fieldKeys = new Set<string>();
  const stepKeys = new Set<string>();
  const eligibleFields = value.eligibleFields.map((candidate): BrowserAcquiredFillField => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "stepKey",
        "normalizedFieldKey",
        "fieldFingerprint",
        "fieldType",
        "proposal"
      ]) ||
      typeof candidate.stepKey !== "string" ||
      !isSha256(candidate.normalizedFieldKey) ||
      !isSha256(candidate.fieldFingerprint) ||
      typeof candidate.fieldType !== "string" ||
      !fillEligibleTypes.has(candidate.fieldType) ||
      candidate.stepKey !== `fill:${value.attemptId}:${candidate.normalizedFieldKey}` ||
      fieldKeys.has(candidate.normalizedFieldKey) ||
      stepKeys.has(candidate.stepKey)
    ) {
      throw invalidFillAcquisitionResponse();
    }
    fieldKeys.add(candidate.normalizedFieldKey);
    stepKeys.add(candidate.stepKey);
    const fieldType = candidate.fieldType as FillEligibleFieldType;
    return Object.freeze({
      stepKey: candidate.stepKey,
      normalizedFieldKey: candidate.normalizedFieldKey,
      fieldFingerprint: candidate.fieldFingerprint,
      fieldType,
      proposal: parseBrowserFillProposal(candidate.proposal, fieldType)
    });
  });

  return Object.freeze({
    attemptId: value.attemptId,
    runStateVersion: value.runStateVersion,
    leaseExpiresAt: value.leaseExpiresAt,
    formInspectionVersion: value.formInspectionVersion,
    answerPacketVersion: value.answerPacketVersion,
    packetHash: value.packetHash,
    formFingerprint: value.formFingerprint,
    eligibleFields: Object.freeze(eligibleFields)
  });
}

function invalidFillStatusResponse(): SameOriginClientError {
  return new SameOriginClientError(
    "Invalid Fill status response.",
    "INVALID_FILL_STATUS_RESPONSE"
  );
}

function parseFillStatusResponse(value: unknown): BrowserFillAttemptStatus {
  try {
    return parseSharedFillStatusResponse(value);
  } catch {
    throw invalidFillStatusResponse();
  }
}

function assertExactInputKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function serializeFillAcquire(input: BrowserFillAcquireInput): string {
  if (
    !assertExactInputKeys(input, ["runId", "expectedStateVersion"]) ||
    !isSafeNonnegativeInteger(input.expectedStateVersion)
  ) {
    throw new SameOriginClientError(
      "Invalid Fill acquisition request.",
      "INVALID_FILL_ACQUISITION_REQUEST"
    );
  }
  return JSON.stringify({ expectedStateVersion: input.expectedStateVersion });
}

function parseFinalizationStep(value: unknown): BrowserFillStepResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["stepKey", "result", "errorCode"]) ||
    typeof value.stepKey !== "string" ||
    !isFillStepResult(value.result) ||
    !(value.errorCode === null || isFillErrorCode(value.errorCode))
  ) {
    throw new SameOriginClientError(
      "Invalid Fill finalization request.",
      "INVALID_FILL_FINALIZATION_REQUEST"
    );
  }
  return {
    stepKey: value.stepKey,
    result: value.result,
    errorCode: value.errorCode
  };
}

function serializeFillFinalization(input: BrowserFillFinalizeInput): string {
  const invalid = () => new SameOriginClientError(
    "Invalid Fill finalization request.",
    "INVALID_FILL_FINALIZATION_REQUEST"
  );
  if (
    !assertExactInputKeys(input, [
      "runId",
      "fillAttemptId",
      "expectedStateVersion",
      "outcome",
      "errorCode",
      "steps"
    ]) ||
    !isUuid(input.fillAttemptId) ||
    !isSafeNonnegativeInteger(input.expectedStateVersion) ||
    (input.outcome !== "COMPLETED" && input.outcome !== "STOPPED_EARLY") ||
    !(input.errorCode === null || isFillErrorCode(input.errorCode)) ||
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > MAX_FIELDS_TOTAL
  ) {
    throw invalid();
  }
  const steps = input.steps.map(parseFinalizationStep);
  try {
    reconcileFillFinalization({
      fillAttemptId: input.fillAttemptId,
      persistedSteps: steps.map((step) => ({
        fillAttemptId: input.fillAttemptId,
        stepKey: step.stepKey
      })),
      assertion: {
        fillAttemptId: input.fillAttemptId,
        outcome: input.outcome,
        errorCode: input.errorCode,
        steps
      }
    });
  } catch {
    throw invalid();
  }
  return JSON.stringify({
    action: "FINALIZE",
    fillAttemptId: input.fillAttemptId,
    expectedStateVersion: input.expectedStateVersion,
    outcome: input.outcome,
    errorCode: input.errorCode,
    steps
  });
}

function serializeFillRecovery(input: BrowserFillRecoverInput): string {
  if (
    !assertExactInputKeys(input, ["runId", "fillAttemptId", "expectedStateVersion"]) ||
    !isUuid(input.fillAttemptId) ||
    !isSafeNonnegativeInteger(input.expectedStateVersion)
  ) {
    throw new SameOriginClientError(
      "Invalid Fill recovery request.",
      "INVALID_FILL_RECOVERY_REQUEST"
    );
  }
  return JSON.stringify({
    action: "RECOVER_EXPIRED",
    fillAttemptId: input.fillAttemptId,
    expectedStateVersion: input.expectedStateVersion
  });
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
}): SameOriginClientWithFill {
  const origin = parseApplyPilotOrigin(input.configuredApplyPilotOrigin);
  const immutableRunId = parseImmutableRunId(input.immutableRunId);
  const runUrl = `${origin}/api/application-runs/${immutableRunId}`;
  const policyUrl = `${origin}/api/application-automation-policy`;
  const packetUrl = `${runUrl}/answer-packet`;
  const publicationUrl = `${runUrl}/form-inspection`;
  const fillAttemptUrl = `${runUrl}/fill-attempt`;

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
    async acquireFillAttempt(
      acquireInput: BrowserFillAcquireInput,
      assertReadyToDispatch: () => void
    ) {
      return performFillMutation({
        expectedUrl: fillAttemptUrl,
        buildBody: () => {
          if (acquireInput.runId !== immutableRunId) throw identityMismatch();
          return serializeFillAcquire(acquireInput);
        },
        assertReadyToDispatch,
        dispatch: (options) => input.requestContext.post(fillAttemptUrl, options),
        successStatuses: SUCCESS_201,
        parse: parseFillAcquisitionResponse
      });
    },
    async getFillAttemptStatus(runId: string) {
      if (runId !== immutableRunId) throw identityMismatch();
      const response = await performGet(input.requestContext, fillAttemptUrl);
      await assertExactResponse(
        response,
        fillAttemptUrl,
        SUCCESS_200,
        FILL_ERROR_RESPONSE_CODES
      );
      const value = await parseJsonOrThrow(
        response,
        "Invalid Fill status response.",
        "INVALID_FILL_STATUS_RESPONSE"
      );
      return parseFillStatusResponse(value);
    },
    async finalizeFillAttempt(
      finalizeInput: BrowserFillFinalizeInput,
      assertReadyToDispatch: () => void
    ) {
      return performFillMutation({
        expectedUrl: fillAttemptUrl,
        buildBody: () => {
          if (finalizeInput.runId !== immutableRunId) throw identityMismatch();
          return serializeFillFinalization(finalizeInput);
        },
        assertReadyToDispatch,
        dispatch: (options) => input.requestContext.patch(fillAttemptUrl, options),
        successStatuses: SUCCESS_200,
        parse: parseFillStatusResponse
      });
    },
    async recoverExpiredFillAttempt(
      recoverInput: BrowserFillRecoverInput,
      assertReadyToDispatch: () => void
    ) {
      return performFillMutation({
        expectedUrl: fillAttemptUrl,
        buildBody: () => {
          if (recoverInput.runId !== immutableRunId) throw identityMismatch();
          return serializeFillRecovery(recoverInput);
        },
        assertReadyToDispatch,
        dispatch: (options) => input.requestContext.patch(fillAttemptUrl, options),
        successStatuses: SUCCESS_200,
        parse: parseFillStatusResponse
      });
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
