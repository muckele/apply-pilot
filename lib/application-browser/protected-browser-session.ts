import { randomBytes } from "node:crypto";
import type { CDPSession, Page } from "playwright";

import {
  PROTECTED_BROWSER_CAPABILITY_METHODS,
  PROTECTED_WRITABLE_FIELD_TYPES,
  protectedBrowserCapabilityExpression,
  protectedBrowserWorldBootstrapSource
} from "@/lib/application-browser/protected-browser-world";
import {
  applicationFormInspectionReportSchema,
  MAX_CHOICES_PER_FIELD,
  MAX_CHOICES_TOTAL,
  MAX_FIELDS_TOTAL,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";
import { parseApplicationAnswerProposal } from "@/lib/application-runs/answer-packet-domain";

export {
  PROTECTED_BROWSER_CAPABILITY_METHODS,
  PROTECTED_WRITABLE_FIELD_TYPES
} from "@/lib/application-browser/protected-browser-world";

export const PROTECTED_BROWSER_SESSION_ERROR_CODES = [
  "PROTECTED_SESSION_SETUP_FAILED",
  "PROTECTED_SESSION_READINESS_TIMEOUT",
  "PROTECTED_SESSION_NOT_READY",
  "PROTECTED_SESSION_CLOSED",
  "PROTECTED_SESSION_BUSY",
  "PROTECTED_SESSION_STALE_RESPONSE",
  "PROTECTED_SESSION_INVALID_RESPONSE",
  "PROTECTED_CANDIDATE_INVALID"
] as const;

export type ProtectedBrowserSessionErrorCode =
  (typeof PROTECTED_BROWSER_SESSION_ERROR_CODES)[number];

export class ProtectedBrowserSessionError extends Error {
  readonly code: ProtectedBrowserSessionErrorCode;

  constructor(code: ProtectedBrowserSessionErrorCode) {
    super(`Protected browser session failed: ${code}`);
    this.name = "ProtectedBrowserSessionError";
    this.code = code;
  }
}

export const PROTECTED_SESSION_LIFECYCLE_CODES = [
  "DOCUMENT_CHANGED",
  "EXECUTION_CONTEXT_DESTROYED",
  "SESSION_DISCONNECTED",
  "PAGE_CLOSED",
  "CLOSED"
] as const;

export type ProtectedSessionLifecycleCode =
  (typeof PROTECTED_SESSION_LIFECYCLE_CODES)[number];

/**
 * An advisory notification snapshot for one exact protected document epoch.
 * `semanticRevision` reports only known relevant observer/style signals, and
 * `applicantStateEpoch` reports captured applicant-state events. Equality does
 * not prove canonical report equality, candidate currentness, CSSOM equality,
 * visibility equality, shadow inventory equality, or the absence of
 * programmatic browser-state changes.
 */
export type BrowserDocumentFence = Readonly<{
  documentEpoch: number;
  semanticRevision: number;
  applicantStateEpoch: number;
}>;

declare const opaqueCandidateBrand: unique symbol;
declare const opaqueFieldBrand: unique symbol;
declare const opaqueChoiceBrand: unique symbol;

export type OpaqueExtractionCandidate = Readonly<{ [opaqueCandidateBrand]: true }>;
export type OpaqueProtectedFieldReference = Readonly<{ [opaqueFieldBrand]: true }>;
export type OpaqueProtectedChoiceReference = Readonly<{ [opaqueChoiceBrand]: true }>;

export type ProtectedSourceFieldOrdinal = Readonly<{
  form: number;
  section: number;
  field: number;
}>;

export type ProtectedSourceChoiceOrdinal = Readonly<{
  form: number;
  section: number;
  field: number;
  choice: number;
}>;

export type ProtectedWritableFieldType = (typeof PROTECTED_WRITABLE_FIELD_TYPES)[number];

export type ProtectedWriterChoiceBinding = Readonly<{
  choiceKey: string;
  sourceOrdinal: ProtectedSourceChoiceOrdinal;
}>;

export type ProtectedWriterTargetBinding = Readonly<{
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: ProtectedWritableFieldType;
  sourceOrdinal: ProtectedSourceFieldOrdinal;
  choices: readonly ProtectedWriterChoiceBinding[];
}>;

export type ProtectedCandidateFieldWriteRequest = Readonly<{
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: ProtectedWritableFieldType;
  proposal:
    | Readonly<{ kind: "SCALAR"; value: string }>
      | Readonly<{ kind: "OPTIONS"; optionKeys: readonly [string] }>;
}>;

/**
 * `MANUAL / UNWRITABLE` applies only to a supported target that was present
 * in the protected candidate and sealed for writing. Initially effectively
 * disabled controls remain outside the inspection candidate and have no
 * writer request or result until a fresh inspection discovers them enabled.
 */
export type ProtectedCandidateFieldWriteResult =
  | Readonly<{ status: "FILLED" }>
  | Readonly<{ status: "PRESERVED_EXISTING" }>
  | Readonly<{ status: "MANUAL"; reason: "UNWRITABLE" }>
  | Readonly<{
      status: "FAILED";
      reason: "CANDIDATE_INVALID" | "TARGET_INVALID" | "UNEXPECTED_ACTIVITY" | "WRITE_FAILED";
    }>;

export type ProtectedChoiceSlot = Readonly<{
  sourceOrdinal: ProtectedSourceChoiceOrdinal;
  reference: OpaqueProtectedChoiceReference;
}>;

export type ProtectedFieldSlot = Readonly<{
  sourceOrdinal: ProtectedSourceFieldOrdinal;
  reference: OpaqueProtectedFieldReference;
  choices: readonly ProtectedChoiceSlot[];
}>;

export type ProtectedApplicationFormExtraction = Readonly<{
  candidate: OpaqueExtractionCandidate;
  report: ApplicationFormInspectionReport;
  fields: readonly ProtectedFieldSlot[];
  sealWriterTargets(bindings: readonly ProtectedWriterTargetBinding[]): Promise<void>;
  dispose(): Promise<void>;
}>;

export type ProtectedCandidateVerification =
  | Readonly<{ status: "CURRENT"; report: ApplicationFormInspectionReport; fence: BrowserDocumentFence }>
  | Readonly<{ status: "INVALID" }>;

export const PROTECTED_APPLICATION_FORM_EXTRACTION_ERROR_CODES = [
  "FORM_STRUCTURE_UNSUPPORTED",
  "FORM_INSPECTION_OVERSIZE",
  "FORM_INSPECTION_INVALID",
  "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
] as const;

export type ProtectedApplicationFormExtractionErrorCode =
  (typeof PROTECTED_APPLICATION_FORM_EXTRACTION_ERROR_CODES)[number];

export class ProtectedApplicationFormExtractionError extends Error {
  readonly code: ProtectedApplicationFormExtractionErrorCode;

  constructor(code: ProtectedApplicationFormExtractionErrorCode) {
    super(`Protected form inspection failed: ${code}`);
    this.name = "ProtectedApplicationFormExtractionError";
    this.code = code;
  }
}

export type ProtectedApplicationBrowserSession = Readonly<{
  waitUntilReady(): Promise<void>;
  extractApplicationForm(): Promise<ProtectedApplicationFormExtraction>;
  /**
   * Performs a fresh exact protected extraction and identity comparison.
   * `CURRENT` is an authoritative point-in-time proof only for the
   * protected invocation that produced it; it is not a durable lease.
   */
  verifyCandidate(candidate: OpaqueExtractionCandidate): Promise<ProtectedCandidateVerification>;
  /**
   * Performs fresh exact candidate/target verification and at most one bounded
   * supported mutation inside one synchronous protected-world invocation.
   */
  writeCandidateField(
    candidate: OpaqueExtractionCandidate,
    request: ProtectedCandidateFieldWriteRequest
  ): Promise<ProtectedCandidateFieldWriteResult>;
  /**
   * Drains the currently retained bounded observer graph and returns an
   * advisory notification fence. The result is not a currentness proof.
   */
  snapshot(): Promise<BrowserDocumentFence>;
  /**
   * Provides an advisory wakeup. A changed fence means a known relevant signal
   * was observed; an unchanged timeout means only that no known signal was
   * observed during that bounded wait. Neither result proves currentness.
   */
  waitForChange(since: BrowserDocumentFence, timeoutMs: number): Promise<BrowserDocumentFence>;
  subscribe(listener: (code: ProtectedSessionLifecycleCode) => void | Promise<void>): () => void;
  /** Retires every protected browser capability with acknowledged CDP cleanup, retaining only the page. */
  retireForHuman(): Promise<void>;
  close(): Promise<void>;
}>;

type ProtocolRecord = Record<string, unknown>;

type ExecutionContext = Readonly<{
  id: number;
  name: string;
  frameId: string;
  uniqueId: string | null;
}>;

type Authority = Readonly<{
  context: ExecutionContext;
  capabilityObjectId: string;
  documentEpoch: number;
}>;

type ReadinessAttempt = Readonly<{ promise: Promise<void> }>;

type CandidateState = {
  readonly browserCandidateId: number;
  readonly candidate: OpaqueExtractionCandidate;
  readonly authority: Authority;
  readonly documentEpoch: number;
  readonly reportCanonical: string;
  readonly fieldReferences: readonly OpaqueProtectedFieldReference[];
  readonly choiceReferences: readonly OpaqueProtectedChoiceReference[];
  sealAttempted: boolean;
  writerTargetsSealed: boolean;
  live: boolean;
  disposePromise: Promise<void> | null;
};

function sessionError(code: ProtectedBrowserSessionErrorCode): ProtectedBrowserSessionError {
  return new ProtectedBrowserSessionError(code);
}

// A whole ordinary public operation (including validation cleanup) gets this
// Node-host budget. waitForChange adds its requested browser wait, so a valid
// 10-second wait has 15 seconds to settle its complete CDP transport.
const HOST_OPERATION_TIMEOUT_MS = 5_000;

function settleInBackground(operation: () => Promise<unknown>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Best-effort cleanup must also contain synchronous transport failures.
  }
}

function beforeHostDeadline<T>(
  deadline: number,
  operation: () => Promise<T>,
  code: ProtectedBrowserSessionErrorCode,
  options: Readonly<{
    onTimeout?: () => void;
    onLateSuccess?: (value: T) => void;
    dispatchCleanupAfterDeadline?: boolean;
  }> = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const expire = () => {
      if (settled) return;
      settled = true;
      options.onTimeout?.();
      reject(sessionError(code));
    };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      expire();
      // Expiry ends permission to wait, not the duty to attempt reachable
      // authority-reducing cleanup. Ordinary expired operations never dispatch.
      if (options.dispatchCleanupAfterDeadline) settleInBackground(operation);
      return;
    }
    const timer = setTimeout(expire, remainingMs);
    try {
      // Both handlers stay attached after timeout. Late success can only perform
      // explicitly supplied resource cleanup; no authority continuation runs.
      operation().then((value) => {
        if (settled) {
          options.onLateSuccess?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }).catch(() => undefined);
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function isRecord(value: unknown): value is ProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: ProtocolRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const protectedWritableFieldTypes = new Set<string>(PROTECTED_WRITABLE_FIELD_TYPES);

function parseSourceFieldOrdinal(value: unknown): ProtectedSourceFieldOrdinal | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["form", "section", "field"]) ||
    !Number.isSafeInteger(value.form) ||
    !Number.isSafeInteger(value.section) ||
    !Number.isSafeInteger(value.field) ||
    (value.form as number) < 0 ||
    (value.section as number) < 0 ||
    (value.field as number) < 0
  ) return null;
  return Object.freeze({
    form: value.form as number,
    section: value.section as number,
    field: value.field as number
  });
}

function parseSourceChoiceOrdinal(value: unknown): ProtectedSourceChoiceOrdinal | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["form", "section", "field", "choice"]) ||
    !Number.isSafeInteger(value.form) ||
    !Number.isSafeInteger(value.section) ||
    !Number.isSafeInteger(value.field) ||
    !Number.isSafeInteger(value.choice) ||
    (value.form as number) < 0 ||
    (value.section as number) < 0 ||
    (value.field as number) < 0 ||
    (value.choice as number) < 0
  ) return null;
  return Object.freeze({
    form: value.form as number,
    section: value.section as number,
    field: value.field as number,
    choice: value.choice as number
  });
}

function parseWriterTargetBindings(value: unknown): readonly ProtectedWriterTargetBinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_FIELDS_TOTAL) return null;
  const fieldKeys = new Set<string>();
  const fingerprints = new Set<string>();
  const fieldOrdinals = new Set<string>();
  let totalChoices = 0;
  const parsed: ProtectedWriterTargetBinding[] = [];
  for (const binding of value) {
    if (
      !isRecord(binding) ||
      !exactKeys(binding, [
        "normalizedFieldKey",
        "fieldFingerprint",
        "fieldType",
        "sourceOrdinal",
        "choices"
      ]) ||
      typeof binding.normalizedFieldKey !== "string" ||
      !SHA256_HEX_PATTERN.test(binding.normalizedFieldKey) ||
      typeof binding.fieldFingerprint !== "string" ||
      !SHA256_HEX_PATTERN.test(binding.fieldFingerprint) ||
      typeof binding.fieldType !== "string" ||
      !protectedWritableFieldTypes.has(binding.fieldType) ||
      !Array.isArray(binding.choices) ||
      binding.choices.length > MAX_CHOICES_PER_FIELD
    ) return null;
    const sourceOrdinal = parseSourceFieldOrdinal(binding.sourceOrdinal);
    if (!sourceOrdinal) return null;
    const ordinalKey = `${sourceOrdinal.form}/${sourceOrdinal.section}/${sourceOrdinal.field}`;
    if (
      fieldKeys.has(binding.normalizedFieldKey) ||
      fingerprints.has(binding.fieldFingerprint) ||
      fieldOrdinals.has(ordinalKey)
    ) return null;
    fieldKeys.add(binding.normalizedFieldKey);
    fingerprints.add(binding.fieldFingerprint);
    fieldOrdinals.add(ordinalKey);

    const choiceKeys = new Set<string>();
    const choiceOrdinals = new Set<number>();
    const choices: ProtectedWriterChoiceBinding[] = [];
    for (const choice of binding.choices) {
      if (
        !isRecord(choice) ||
        !exactKeys(choice, ["choiceKey", "sourceOrdinal"]) ||
        typeof choice.choiceKey !== "string" ||
        !SHA256_HEX_PATTERN.test(choice.choiceKey)
      ) return null;
      const choiceOrdinal = parseSourceChoiceOrdinal(choice.sourceOrdinal);
      if (
        !choiceOrdinal ||
        choiceOrdinal.form !== sourceOrdinal.form ||
        choiceOrdinal.section !== sourceOrdinal.section ||
        choiceOrdinal.field !== sourceOrdinal.field ||
        choiceKeys.has(choice.choiceKey) ||
        choiceOrdinals.has(choiceOrdinal.choice)
      ) return null;
      choiceKeys.add(choice.choiceKey);
      choiceOrdinals.add(choiceOrdinal.choice);
      choices.push(Object.freeze({ choiceKey: choice.choiceKey, sourceOrdinal: choiceOrdinal }));
    }
    totalChoices += choices.length;
    if (
      totalChoices > MAX_CHOICES_TOTAL ||
      (binding.fieldType === "SELECT_ONE" ? choices.length === 0 : choices.length !== 0)
    ) return null;
    parsed.push(Object.freeze({
      normalizedFieldKey: binding.normalizedFieldKey,
      fieldFingerprint: binding.fieldFingerprint,
      fieldType: binding.fieldType as ProtectedWritableFieldType,
      sourceOrdinal,
      choices: Object.freeze(choices)
    }));
  }
  return Object.freeze(parsed);
}

function parseCandidateFieldWriteRequest(value: unknown): ProtectedCandidateFieldWriteRequest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["normalizedFieldKey", "fieldFingerprint", "fieldType", "proposal"]) ||
    typeof value.normalizedFieldKey !== "string" ||
    !SHA256_HEX_PATTERN.test(value.normalizedFieldKey) ||
    typeof value.fieldFingerprint !== "string" ||
    !SHA256_HEX_PATTERN.test(value.fieldFingerprint) ||
    typeof value.fieldType !== "string" ||
    !protectedWritableFieldTypes.has(value.fieldType)
  ) return null;
  let proposal;
  try {
    proposal = parseApplicationAnswerProposal(value.proposal);
  } catch {
    return null;
  }
  if (value.fieldType === "SELECT_ONE") {
    if (proposal.kind !== "OPTIONS" || proposal.optionKeys.length !== 1) return null;
    return Object.freeze({
      normalizedFieldKey: value.normalizedFieldKey,
      fieldFingerprint: value.fieldFingerprint,
      fieldType: "SELECT_ONE",
      proposal: Object.freeze({
        kind: "OPTIONS" as const,
        optionKeys: Object.freeze([proposal.optionKeys[0]]) as readonly [string]
      })
    });
  }
  if (proposal.kind !== "SCALAR") return null;
  return Object.freeze({
    normalizedFieldKey: value.normalizedFieldKey,
    fieldFingerprint: value.fieldFingerprint,
    fieldType: value.fieldType as Exclude<ProtectedWritableFieldType, "SELECT_ONE">,
    proposal: Object.freeze({ kind: "SCALAR" as const, value: proposal.value })
  });
}

function parseCandidateFieldWriteResult(value: unknown): ProtectedCandidateFieldWriteResult | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (
    (value.status === "FILLED" || value.status === "PRESERVED_EXISTING") &&
    exactKeys(value, ["status"])
  ) return Object.freeze({ status: value.status });
  if (
    value.status === "MANUAL" &&
    exactKeys(value, ["status", "reason"]) &&
    value.reason === "UNWRITABLE"
  ) return Object.freeze({ status: "MANUAL", reason: "UNWRITABLE" });
  if (
    value.status === "FAILED" &&
    exactKeys(value, ["status", "reason"]) &&
    (
      value.reason === "CANDIDATE_INVALID" ||
      value.reason === "TARGET_INVALID" ||
      value.reason === "UNEXPECTED_ACTIVITY" ||
      value.reason === "WRITE_FAILED"
    )
  ) return Object.freeze({ status: "FAILED", reason: value.reason });
  return null;
}

function parseFrameId(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["frameTree"]) || !isRecord(value.frameTree)) return null;
  const frame = value.frameTree.frame;
  return isRecord(frame) && typeof frame.id === "string" && frame.id.length > 0 ? frame.id : null;
}

function parseScriptIdentifier(value: unknown): string | null {
  return isRecord(value) && exactKeys(value, ["identifier"]) &&
    typeof value.identifier === "string" && value.identifier.length > 0
    ? value.identifier
    : null;
}

function parseRemoteObjectId(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["result"]) || !isRecord(value.result)) return null;
  const result = value.result;
  return result.type === "object" && typeof result.objectId === "string" && result.objectId.length > 0
    ? result.objectId
    : null;
}

function parseHandshake(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["result"]) || !isRecord(value.result)) return false;
  const result = value.result;
  if (!exactKeys(result, ["type", "value"]) || result.type !== "object" || !isRecord(result.value)) return false;
  const handshake = result.value;
  return exactKeys(handshake, ["version", "state", "methods"]) &&
    handshake.version === 2 && handshake.state === "READY" &&
    Array.isArray(handshake.methods) &&
    handshake.methods.length === PROTECTED_BROWSER_CAPABILITY_METHODS.length &&
    handshake.methods.every((method, index) => method === PROTECTED_BROWSER_CAPABILITY_METHODS[index]);
}

const INVALID_PROTOCOL_VALUE = Symbol("INVALID_PROTOCOL_VALUE");

function parseByValueResult(value: unknown): unknown | typeof INVALID_PROTOCOL_VALUE {
  if (!isRecord(value) || !exactKeys(value, ["result"]) || !isRecord(value.result)) {
    return INVALID_PROTOCOL_VALUE;
  }
  const result = value.result;
  if (!exactKeys(result, ["type", "value"]) || typeof result.type !== "string") {
    return INVALID_PROTOCOL_VALUE;
  }
  if (result.type === "object" || result.type === "string") return result.value;
  return INVALID_PROTOCOL_VALUE;
}

function parseBrowserFence(value: unknown): Readonly<{
  semanticRevision: number;
  applicantStateEpoch: number;
}> | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["semanticRevision", "applicantStateEpoch"]) ||
    !Number.isSafeInteger(value.semanticRevision) ||
    !Number.isSafeInteger(value.applicantStateEpoch) ||
    (value.semanticRevision as number) < 0 ||
    (value.applicantStateEpoch as number) < 0
  ) return null;
  return {
    semanticRevision: value.semanticRevision as number,
    applicantStateEpoch: value.applicantStateEpoch as number
  };
}

function extractionErrorCode(value: unknown): ProtectedApplicationFormExtractionErrorCode | null {
  return typeof value === "string" &&
    (PROTECTED_APPLICATION_FORM_EXTRACTION_ERROR_CODES as readonly string[]).includes(value)
    ? value as ProtectedApplicationFormExtractionErrorCode
    : null;
}

function contextFromEvent(value: unknown): ExecutionContext | null {
  if (!isRecord(value) || !isRecord(value.context)) return null;
  const context = value.context;
  const auxData = context.auxData;
  if (
    !Number.isSafeInteger(context.id) ||
    typeof context.name !== "string" ||
    !isRecord(auxData) ||
    typeof auxData.frameId !== "string" ||
    auxData.isDefault === true ||
    (auxData.type !== undefined && auxData.type !== "isolated")
  ) return null;
  return {
    id: context.id as number,
    name: context.name,
    frameId: auxData.frameId,
    uniqueId: typeof context.uniqueId === "string" ? context.uniqueId : null
  };
}

export async function createProtectedApplicationBrowserSession(input: Readonly<{
  page: Page;
  readinessTimeoutMs?: number;
}>): Promise<ProtectedApplicationBrowserSession> {
  const page = input.page;
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 0 ||
    readinessTimeoutMs > 10_000
  ) throw sessionError("PROTECTED_SESSION_SETUP_FAILED");
  const worldName = `apply-pilot-protected-${randomBytes(32).toString("hex")}`;
  const objectGroup = `${worldName}-objects`;
  let cdp: CDPSession | null = null;
  let scriptIdentifier: string | null = null;
  let mainFrameId: string | null = null;
  let documentEpoch = 0;
  let authority: Authority | null = null;
  let readinessAttempt: ReadinessAttempt | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const contexts = new Map<number, ExecutionContext>();
  const lifecycleListeners = new Set<(code: ProtectedSessionLifecycleCode) => void | Promise<void>>();
  const contextWaiters = new Set<() => void>();
  const candidateStates = new WeakMap<object, CandidateState>();
  const fieldReferenceStates = new WeakMap<object, CandidateState>();
  const choiceReferenceStates = new WeakMap<object, CandidateState>();
  const liveCandidates = new Set<CandidateState>();

  const invalidateCandidate = (candidate: CandidateState) => {
    if (!candidate.live) return;
    candidate.live = false;
    liveCandidates.delete(candidate);
    for (const reference of candidate.fieldReferences) fieldReferenceStates.delete(reference);
    for (const reference of candidate.choiceReferences) choiceReferenceStates.delete(reference);
  };
  const invalidateAllCandidates = () => {
    for (const candidate of [...liveCandidates]) invalidateCandidate(candidate);
  };

  const notifyContexts = () => {
    for (const waiter of contextWaiters) waiter();
    contextWaiters.clear();
  };
  const emitLifecycle = (code: ProtectedSessionLifecycleCode) => {
    for (const listener of lifecycleListeners) {
      try {
        // Subscribers are advisory: assimilate returned thenables and observe
        // rejection without awaiting them or delaying authority invalidation.
        void Promise.resolve(listener(code)).catch(() => undefined);
      } catch {
        // Lifecycle observers cannot interrupt invalidation.
      }
    }
  };
  const invalidateAuthority = (code: ProtectedSessionLifecycleCode) => {
    readinessAttempt = null;
    if (authority) documentEpoch += 1;
    invalidateAllCandidates();
    authority = null;
    emitLifecycle(code);
    notifyContexts();
  };
  const onContextCreated = (event: unknown) => {
    if (!isRecord(event) || !isRecord(event.context) || !Number.isSafeInteger(event.context.id)) return;
    // Numeric IDs can be reused by a default or unrelated world too. Retire
    // the old protected identity before deciding whether its replacement is eligible.
    const id = event.context.id as number;
    const previous = contexts.get(id);
    if (previous) contexts.delete(id);
    if (previous && (mainFrameId === null || previous.frameId === mainFrameId)) {
      readinessAttempt = null;
      if (authority?.context === previous) invalidateAuthority("EXECUTION_CONTEXT_DESTROYED");
      else notifyContexts();
    }
    const context = contextFromEvent(event);
    if (!context || context.name !== worldName) return;
    contexts.set(context.id, context);
    notifyContexts();
  };
  const onContextDestroyed = (event: unknown) => {
    if (!isRecord(event) || !Number.isSafeInteger(event.executionContextId)) return;
    const id = event.executionContextId as number;
    const context = contexts.get(id);
    contexts.delete(id);
    if (context && (mainFrameId === null || context.frameId === mainFrameId)) {
      readinessAttempt = null;
      notifyContexts();
    }
    if (authority?.context.id === id) invalidateAuthority("EXECUTION_CONTEXT_DESTROYED");
  };
  const onContextsCleared = () => {
    readinessAttempt = null;
    contexts.clear();
    if (authority) invalidateAuthority("EXECUTION_CONTEXT_DESTROYED");
    else notifyContexts();
  };
  const onFrameNavigated = (event: unknown) => {
    if (!isRecord(event) || !isRecord(event.frame) || typeof event.frame.id !== "string") return;
    if (typeof event.frame.parentId === "string") return;
    readinessAttempt = null;
    if (mainFrameId !== null || authority !== null) documentEpoch += 1;
    invalidateAllCandidates();
    for (const [contextId, context] of contexts) {
      if (context.frameId === event.frame.id) contexts.delete(contextId);
    }
    mainFrameId = event.frame.id;
    authority = null;
    emitLifecycle("DOCUMENT_CHANGED");
    notifyContexts();
  };
  const onDisconnected = () => {
    closed = true;
    invalidateAuthority("SESSION_DISCONNECTED");
  };
  const onPageClosed = () => {
    closed = true;
    invalidateAuthority("PAGE_CLOSED");
  };

  const cleanupSetup = async () => {
    if (!cdp) return;
    const setupCdp = cdp;
    // Setup shares one transport budget; rollback receives one final cleanup
    // budget. Even a stalled setup followed by stalled detach settles in 10s.
    await beforeHostDeadline(
      Date.now() + HOST_OPERATION_TIMEOUT_MS,
      () => setupCdp.detach(),
      "PROTECTED_SESSION_SETUP_FAILED"
    ).catch(() => undefined);
  };

  try {
    const setupDeadline = Date.now() + HOST_OPERATION_TIMEOUT_MS;
    cdp = await beforeHostDeadline(
      setupDeadline,
      () => page.context().newCDPSession(page),
      "PROTECTED_SESSION_SETUP_FAILED",
      { onLateSuccess: (attached) => settleInBackground(() => attached.detach()) }
    );
    const setupCdp = cdp;
    await beforeHostDeadline(setupDeadline, () => setupCdp.send("Page.enable"), "PROTECTED_SESSION_SETUP_FAILED");
    await beforeHostDeadline(setupDeadline, () => setupCdp.send("Runtime.enable"), "PROTECTED_SESSION_SETUP_FAILED");
    cdp.on("Runtime.executionContextCreated", onContextCreated);
    cdp.on("Runtime.executionContextDestroyed", onContextDestroyed);
    cdp.on("Runtime.executionContextsCleared", onContextsCleared);
    cdp.on("Page.frameNavigated", onFrameNavigated);
    cdp.on("close", onDisconnected);
    page.on("close", onPageClosed);
    const registered = await beforeHostDeadline(setupDeadline,
      () => setupCdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: protectedBrowserWorldBootstrapSource(),
        worldName
      }),
      "PROTECTED_SESSION_SETUP_FAILED",
      { onLateSuccess: (value) => {
        const identifier = parseScriptIdentifier(value);
        if (identifier) settleInBackground(() => setupCdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }));
      } }
    );
    scriptIdentifier = parseScriptIdentifier(registered);
    if (!scriptIdentifier) throw sessionError("PROTECTED_SESSION_SETUP_FAILED");
  } catch {
    closed = true;
    contexts.clear();
    cdp?.off("Runtime.executionContextCreated", onContextCreated);
    cdp?.off("Runtime.executionContextDestroyed", onContextDestroyed);
    cdp?.off("Runtime.executionContextsCleared", onContextsCleared);
    cdp?.off("Page.frameNavigated", onFrameNavigated);
    cdp?.off("close", onDisconnected);
    page.off("close", onPageClosed);
    await cleanupSetup();
    throw sessionError("PROTECTED_SESSION_SETUP_FAILED");
  }

  const exactCdp = cdp;
  if (!exactCdp) throw sessionError("PROTECTED_SESSION_SETUP_FAILED");
  const inFlightProtocol = new Set<Promise<unknown>>();
  const sendTracked = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const pending = exactCdp.send(method as Parameters<CDPSession["send"]>[0], params as never);
    inFlightProtocol.add(pending);
    void pending.finally(() => inFlightProtocol.delete(pending)).catch(() => undefined);
    return pending;
  };

  const requireOpen = () => {
    if (closed) throw sessionError("PROTECTED_SESSION_CLOSED");
  };

  const waitForContextSignal = (remainingMs: number): Promise<void> => new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      contextWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, remainingMs));
    contextWaiters.add(finish);
  });

  const readinessCall = async <T>(
    deadline: number,
    operation: () => Promise<T>
  ): Promise<T | null> => {
    try {
      return await beforeHostDeadline(deadline, operation, "PROTECTED_SESSION_READINESS_TIMEOUT");
    } catch (error) {
      if (
        error instanceof ProtectedBrowserSessionError &&
        error.code === "PROTECTED_SESSION_READINESS_TIMEOUT"
      ) throw error;
      return null;
    }
  };

  const acquireReadiness = async (attempt: ReadinessAttempt, deadline: number): Promise<void> => {
    const requireCurrentAttempt = () => {
      requireOpen();
      if (readinessAttempt !== attempt) throw sessionError("PROTECTED_SESSION_STALE_RESPONSE");
    };
    requireCurrentAttempt();
    const frameTree = await readinessCall(
      deadline,
      () => sendTracked("Page.getFrameTree")
    );
    // Bind the entire attempt, including frame selection, to its identity.
    // Replacement can happen before authority exists or documentEpoch advances.
    requireCurrentAttempt();
    const selectedFrameId = parseFrameId(frameTree);
    if (!selectedFrameId) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    if (mainFrameId !== null && mainFrameId !== selectedFrameId) {
      documentEpoch += 1;
      authority = null;
    }
    mainFrameId = selectedFrameId;

    while (!authority) {
      requireCurrentAttempt();
      const context = [...contexts.values()].find((candidate) =>
        candidate.name === worldName && candidate.frameId === selectedFrameId
      );
      if (context) {
        const epoch = documentEpoch;
        const evaluated = await readinessCall(deadline, () => sendTracked("Runtime.evaluate", {
          expression: protectedBrowserCapabilityExpression(),
          contextId: context.id,
          objectGroup,
          returnByValue: false,
          silent: true
        }));
        requireCurrentAttempt();
        const contextIsCurrent = () => contexts.get(context.id) === context &&
          mainFrameId === selectedFrameId && documentEpoch === epoch;
        if (!contextIsCurrent()) throw sessionError("PROTECTED_SESSION_STALE_RESPONSE");
        const objectId = parseRemoteObjectId(evaluated);
        if (!objectId) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
        const handshake = await readinessCall(deadline, () => sendTracked("Runtime.callFunctionOn", {
          functionDeclaration: "function () { return this.handshake(); }",
          objectId,
          objectGroup,
          returnByValue: true,
          awaitPromise: true,
          silent: true
        }));
        requireCurrentAttempt();
        if (!contextIsCurrent()) throw sessionError("PROTECTED_SESSION_STALE_RESPONSE");
        if (!parseHandshake(handshake)) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
        authority = { context, capabilityObjectId: objectId, documentEpoch: epoch };
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw sessionError("PROTECTED_SESSION_READINESS_TIMEOUT");
      await waitForContextSignal(remaining);
      requireCurrentAttempt();
    }
  };

  const waitUntilReady = (): Promise<void> => {
    if (closed) return Promise.reject(sessionError("PROTECTED_SESSION_CLOSED"));
    if (authority) return Promise.resolve();
    if (readinessAttempt) return readinessAttempt.promise;
    const deadline = Date.now() + readinessTimeoutMs;
    // Install before dispatch: all same-document callers receive this exact
    // promise. The record itself is the generation token, independent of epoch.
    const attempt: ReadinessAttempt = {
      promise: Promise.resolve().then(() => acquireReadiness(attempt, deadline)).finally(() => {
        if (readinessAttempt === attempt) readinessAttempt = null;
      })
    };
    readinessAttempt = attempt;
    return attempt.promise;
  };

  let exclusiveOperation = false;
  let activeOperation: Promise<unknown> | null = null;

  const authorityIsCurrent = (captured: Authority): boolean =>
    !closed &&
    authority === captured &&
    documentEpoch === captured.documentEpoch &&
    mainFrameId === captured.context.frameId &&
    contexts.get(captured.context.id) === captured.context;

  const rawCapabilityCall = async (
    captured: Authority,
    functionDeclaration: string,
    argument?: unknown,
    deadline = Date.now() + HOST_OPERATION_TIMEOUT_MS,
    dispatchCleanupAfterDeadline = false
  ): Promise<unknown> => beforeHostDeadline(deadline, () => sendTracked("Runtime.callFunctionOn", {
    functionDeclaration,
    objectId: captured.capabilityObjectId,
    objectGroup,
    returnByValue: true,
    awaitPromise: true,
    silent: true,
    ...(argument === undefined ? {} : { arguments: [{ value: argument }] })
  }), "PROTECTED_SESSION_STALE_RESPONSE", { dispatchCleanupAfterDeadline, onTimeout: () => {
    // A timeout revokes only its captured authority. A new document/attempt may
    // already own this session when an old transport's timer expires.
    if (!authorityIsCurrent(captured)) return;
    invalidateAllCandidates();
    authority = null;
    documentEpoch += 1;
    notifyContexts();
  } });

  const protectedCapabilityCall = async (
    captured: Authority,
    functionDeclaration: string,
    argument?: unknown,
    deadline = Date.now() + HOST_OPERATION_TIMEOUT_MS
  ): Promise<unknown> => {
    let response: unknown;
    try {
      response = await rawCapabilityCall(captured, functionDeclaration, argument, deadline);
    } catch {
      if (!authorityIsCurrent(captured)) throw sessionError("PROTECTED_SESSION_STALE_RESPONSE");
      throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    }
    if (!authorityIsCurrent(captured)) throw sessionError("PROTECTED_SESSION_STALE_RESPONSE");
    const value = parseByValueResult(response);
    if (value === INVALID_PROTOCOL_VALUE) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    return value;
  };

  const runExclusive = async <T>(
    operation: (captured: Authority, deadline: number) => Promise<T>,
    browserWaitMs = 0
  ): Promise<T> => {
    requireOpen();
    const captured = authority;
    if (!captured) throw sessionError("PROTECTED_SESSION_NOT_READY");
    if (exclusiveOperation) throw sessionError("PROTECTED_SESSION_BUSY");
    exclusiveOperation = true;
    const pending = operation(captured, Date.now() + HOST_OPERATION_TIMEOUT_MS + browserWaitMs);
    activeOperation = pending;
    try {
      return await pending;
    } finally {
      if (activeOperation === pending) activeOperation = null;
      exclusiveOperation = false;
    }
  };

  const browserFence = (
    captured: Authority,
    value: unknown
  ): BrowserDocumentFence => {
    const parsed = parseBrowserFence(value);
    if (!parsed) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    return Object.freeze({
      documentEpoch: captured.documentEpoch,
      semanticRevision: parsed.semanticRevision,
      applicantStateEpoch: parsed.applicantStateEpoch
    });
  };

  const cleanupBrowserCandidate = async (
    candidate: CandidateState,
    deadline = Date.now() + HOST_OPERATION_TIMEOUT_MS
  ): Promise<void> => {
    if (
      closed ||
      authority !== candidate.authority ||
      documentEpoch !== candidate.documentEpoch
    ) return;
    let response: unknown;
    try {
      response = await rawCapabilityCall(
        candidate.authority,
        "function (input) { return this.disposeCandidate(input); }",
        { candidateId: candidate.browserCandidateId },
        deadline,
        true
      );
    } catch {
      return;
    }
    if (!authorityIsCurrent(candidate.authority)) return;
    const result = parseByValueResult(response);
    if (result !== "DISPOSED" && result !== "MISSING") {
      throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    }
  };

  const disposeCandidateState = (candidate: CandidateState): Promise<void> => {
    if (candidate.disposePromise) return candidate.disposePromise;
    invalidateCandidate(candidate);
    // Node references are already revoked, so renderer cleanup can safely be
    // dispatched while an earlier read is pending. It must not queue behind a
    // longer waitForChange or depend on that read's cooperation.
    candidate.disposePromise = cleanupBrowserCandidate(candidate);
    return candidate.disposePromise;
  };

  const emptyOpaqueReference = <T extends object>(): T =>
    Object.freeze(Object.create(null)) as T;

  const extractApplicationForm = (): Promise<ProtectedApplicationFormExtraction> => runExclusive(async (captured, deadline) => {
    const value = await protectedCapabilityCall(
      captured,
      "function () { return this.extract(); }",
      undefined,
      deadline
    );
    if (!isRecord(value)) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    if (value.kind === "ERROR") {
      if (!exactKeys(value, ["kind", "code"])) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      const code = extractionErrorCode(value.code);
      if (!code) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      throw new ProtectedApplicationFormExtractionError(code);
    }
    if (
      value.kind !== "OK" ||
      !exactKeys(value, ["kind", "candidateId", "report"]) ||
      !Number.isSafeInteger(value.candidateId) ||
      (value.candidateId as number) <= 0
    ) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    const parsed = applicationFormInspectionReportSchema.safeParse(value.report);
    if (!parsed.success) {
      await rawCapabilityCall(
        captured,
        "function (input) { return this.disposeCandidate(input); }",
        { candidateId: value.candidateId },
        deadline,
        true
      ).catch(() => undefined);
      throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    }

    const candidateReference = emptyOpaqueReference<OpaqueExtractionCandidate>();
    const fieldReferences: OpaqueProtectedFieldReference[] = [];
    const choiceReferences: OpaqueProtectedChoiceReference[] = [];
    const fields: ProtectedFieldSlot[] = [];
    for (const [formIndex, form] of parsed.data.forms.entries()) {
      for (const [sectionIndex, section] of form.sections.entries()) {
        for (const [fieldIndex, field] of section.fields.entries()) {
          const reference = emptyOpaqueReference<OpaqueProtectedFieldReference>();
          fieldReferences.push(reference);
          const choices = field.choices.map((_, choiceIndex): ProtectedChoiceSlot => {
            const choiceReference = emptyOpaqueReference<OpaqueProtectedChoiceReference>();
            choiceReferences.push(choiceReference);
            return Object.freeze({
              sourceOrdinal: Object.freeze({
                form: formIndex,
                section: sectionIndex,
                field: fieldIndex,
                choice: choiceIndex
              }),
              reference: choiceReference
            });
          });
          fields.push(Object.freeze({
            sourceOrdinal: Object.freeze({
              form: formIndex,
              section: sectionIndex,
              field: fieldIndex
            }),
            reference,
            choices: Object.freeze(choices)
          }));
        }
      }
    }

    const state: CandidateState = {
      browserCandidateId: value.candidateId as number,
      candidate: candidateReference,
      authority: captured,
      documentEpoch: captured.documentEpoch,
      reportCanonical: JSON.stringify(parsed.data),
      fieldReferences: Object.freeze(fieldReferences),
      choiceReferences: Object.freeze(choiceReferences),
      sealAttempted: false,
      writerTargetsSealed: false,
      live: true,
      disposePromise: null
    };
    candidateStates.set(candidateReference, state);
    for (const reference of fieldReferences) fieldReferenceStates.set(reference, state);
    for (const reference of choiceReferences) choiceReferenceStates.set(reference, state);
    liveCandidates.add(state);

    const sealWriterTargets = async (
      bindings: readonly ProtectedWriterTargetBinding[]
    ): Promise<void> => {
      if (state.sealAttempted || !state.live) {
        invalidateCandidate(state);
        await cleanupBrowserCandidate(state).catch(() => undefined);
        throw sessionError("PROTECTED_CANDIDATE_INVALID");
      }
      state.sealAttempted = true;
      const parsedBindings = parseWriterTargetBindings(bindings);
      if (!parsedBindings) {
        invalidateCandidate(state);
        await cleanupBrowserCandidate(state).catch(() => undefined);
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
      try {
        await runExclusive(async (sealAuthority, sealDeadline) => {
          if (sealAuthority !== state.authority || !state.live) {
            throw sessionError("PROTECTED_CANDIDATE_INVALID");
          }
          const result = await protectedCapabilityCall(
            sealAuthority,
            "function (input) { return this.sealCandidateWriterTargets(input); }",
            { candidateId: state.browserCandidateId, bindings: parsedBindings },
            sealDeadline
          );
          if (result !== "SEALED" || !state.live) {
            throw sessionError("PROTECTED_CANDIDATE_INVALID");
          }
          state.writerTargetsSealed = true;
        });
      } catch (error) {
        invalidateCandidate(state);
        await cleanupBrowserCandidate(state).catch(() => undefined);
        if (error instanceof ProtectedBrowserSessionError) throw error;
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
    };

    return Object.freeze({
      candidate: candidateReference,
      report: parsed.data,
      fields: Object.freeze(fields),
      sealWriterTargets,
      dispose: () => disposeCandidateState(state)
    });
  });

  const verifyCandidate = async (
    candidateReference: OpaqueExtractionCandidate
  ): Promise<ProtectedCandidateVerification> => {
    if (typeof candidateReference !== "object" || candidateReference === null) {
      throw sessionError("PROTECTED_CANDIDATE_INVALID");
    }
    const candidate = candidateStates.get(candidateReference);
    if (!candidate) throw sessionError("PROTECTED_CANDIDATE_INVALID");
    if (
      !candidate.live ||
      candidate.documentEpoch !== documentEpoch ||
      candidate.authority !== authority ||
      candidate.fieldReferences.some((reference) => fieldReferenceStates.get(reference) !== candidate) ||
      candidate.choiceReferences.some((reference) => choiceReferenceStates.get(reference) !== candidate)
    ) {
      invalidateCandidate(candidate);
      return Object.freeze({ status: "INVALID" });
    }
    return runExclusive(async (captured, deadline) => {
      if (captured !== candidate.authority) {
        invalidateCandidate(candidate);
        return Object.freeze({ status: "INVALID" });
      }
      const value = await protectedCapabilityCall(
        captured,
        "function (input) { return this.verifyCandidate(input); }",
        { candidateId: candidate.browserCandidateId },
        deadline
      );
      if (
        !candidate.live ||
        candidate.documentEpoch !== documentEpoch ||
        candidate.authority !== authority ||
        candidate.fieldReferences.some((reference) => fieldReferenceStates.get(reference) !== candidate) ||
        candidate.choiceReferences.some((reference) => choiceReferenceStates.get(reference) !== candidate)
      ) return Object.freeze({ status: "INVALID" });
      if (!isRecord(value) || typeof value.status !== "string") {
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
      if (value.status === "INVALID" && exactKeys(value, ["status"])) {
        invalidateCandidate(candidate);
        return Object.freeze({ status: "INVALID" });
      }
      if (value.status !== "CURRENT" || !exactKeys(value, ["status", "report", "fence"])) {
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
      const report = applicationFormInspectionReportSchema.safeParse(value.report);
      if (!report.success || JSON.stringify(report.data) !== candidate.reportCanonical) {
        invalidateCandidate(candidate);
        await cleanupBrowserCandidate(candidate, deadline);
        return Object.freeze({ status: "INVALID" });
      }
      return Object.freeze({
        status: "CURRENT" as const,
        report: report.data,
        fence: browserFence(captured, value.fence)
      });
    });
  };

  const writeCandidateField = async (
    candidateReference: OpaqueExtractionCandidate,
    request: ProtectedCandidateFieldWriteRequest
  ): Promise<ProtectedCandidateFieldWriteResult> => {
    if (typeof candidateReference !== "object" || candidateReference === null) {
      throw sessionError("PROTECTED_CANDIDATE_INVALID");
    }
    const candidate = candidateStates.get(candidateReference);
    if (!candidate) {
      throw sessionError("PROTECTED_CANDIDATE_INVALID");
    }
    if (
      !candidate.live ||
      candidate.documentEpoch !== documentEpoch ||
      candidate.authority !== authority ||
      candidate.fieldReferences.some((reference) => fieldReferenceStates.get(reference) !== candidate) ||
      candidate.choiceReferences.some((reference) => choiceReferenceStates.get(reference) !== candidate)
    ) {
      invalidateCandidate(candidate);
      return Object.freeze({ status: "FAILED", reason: "CANDIDATE_INVALID" });
    }
    if (!candidate.writerTargetsSealed) {
      invalidateCandidate(candidate);
      await cleanupBrowserCandidate(candidate).catch(() => undefined);
      throw sessionError("PROTECTED_CANDIDATE_INVALID");
    }
    const parsedRequest = parseCandidateFieldWriteRequest(request);
    if (!parsedRequest) {
      invalidateCandidate(candidate);
      await cleanupBrowserCandidate(candidate).catch(() => undefined);
      throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    }
    return runExclusive(async (captured, deadline) => {
      if (captured !== candidate.authority || !candidate.live) {
        invalidateCandidate(candidate);
        return Object.freeze({ status: "FAILED", reason: "CANDIDATE_INVALID" });
      }
      let value: unknown;
      try {
        value = await protectedCapabilityCall(
          captured,
          "function (input) { return this.writeCandidateField(input); }",
          { candidateId: candidate.browserCandidateId, request: parsedRequest },
          deadline
        );
      } catch (error) {
        invalidateCandidate(candidate);
        await cleanupBrowserCandidate(candidate, deadline).catch(() => undefined);
        if (error instanceof ProtectedBrowserSessionError) throw error;
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
      if (!candidate.live || candidate.authority !== authority || candidate.documentEpoch !== documentEpoch) {
        invalidateCandidate(candidate);
        return Object.freeze({ status: "FAILED", reason: "CANDIDATE_INVALID" });
      }
      const result = parseCandidateFieldWriteResult(value);
      if (!result) {
        invalidateCandidate(candidate);
        await cleanupBrowserCandidate(candidate, deadline).catch(() => undefined);
        throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
      }
      if (result.status === "FAILED") invalidateCandidate(candidate);
      return result;
    });
  };

  const snapshot = (): Promise<BrowserDocumentFence> => runExclusive(async (captured, deadline) =>
    browserFence(
      captured,
      await protectedCapabilityCall(captured, "function () { return this.snapshot(); }", undefined, deadline)
    )
  );

  const waitForChange = (
    since: BrowserDocumentFence,
    timeoutMs: number
  ): Promise<BrowserDocumentFence> => runExclusive(async (captured, deadline) => {
    if (
      !isRecord(since) ||
      !exactKeys(since, ["documentEpoch", "semanticRevision", "applicantStateEpoch"]) ||
      !Number.isSafeInteger(since.documentEpoch) ||
      !Number.isSafeInteger(since.semanticRevision) ||
      !Number.isSafeInteger(since.applicantStateEpoch) ||
      since.documentEpoch !== captured.documentEpoch ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 10_000
    ) throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
    return browserFence(
      captured,
      await protectedCapabilityCall(
        captured,
        "function (input) { return this.waitForChange(input); }",
        {
          semanticRevision: since.semanticRevision,
          applicantStateEpoch: since.applicantStateEpoch,
          timeoutMs
        },
        deadline
      )
    );
  }, Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 10_000 ? timeoutMs : 0);

  const retireForHuman = (): Promise<void> => {
    requireOpen();
    const retiringAuthority = authority;
    closed = true; // closes admission before inspecting pending transport
    invalidateAllCandidates();
    authority = null;
    const busy = exclusiveOperation || activeOperation || readinessAttempt !== null || inFlightProtocol.size > 0;
    const deadline = Date.now() + HOST_OPERATION_TIMEOUT_MS;
    const retirement = Promise.resolve().then(async () => {
      if (busy) throw sessionError("PROTECTED_SESSION_BUSY");
      if (retiringAuthority) {
        const disposed = await beforeHostDeadline(deadline, () => sendTracked("Runtime.callFunctionOn", {
          functionDeclaration: "function () { return this.dispose(); }",
          objectId: retiringAuthority.capabilityObjectId,
          objectGroup,
          returnByValue: true,
          awaitPromise: true,
          silent: true
        }), "PROTECTED_SESSION_STALE_RESPONSE");
        if (parseByValueResult(disposed) !== "DISPOSED") {
          throw sessionError("PROTECTED_SESSION_INVALID_RESPONSE");
        }
      }
      if (scriptIdentifier) {
        await beforeHostDeadline(deadline, () => sendTracked("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: scriptIdentifier
        }), "PROTECTED_SESSION_STALE_RESPONSE");
      }
      await beforeHostDeadline(deadline, () => sendTracked("Runtime.releaseObjectGroup", { objectGroup }),
        "PROTECTED_SESSION_STALE_RESPONSE");
      await beforeHostDeadline(deadline, () => exactCdp.detach(), "PROTECTED_SESSION_STALE_RESPONSE");
      page.off("close", onPageClosed);
      exactCdp.off("Runtime.executionContextCreated", onContextCreated);
      exactCdp.off("Runtime.executionContextDestroyed", onContextDestroyed);
      exactCdp.off("Runtime.executionContextsCleared", onContextsCleared);
      exactCdp.off("Page.frameNavigated", onFrameNavigated);
      exactCdp.off("close", onDisconnected);
      lifecycleListeners.clear();
      contexts.clear();
    });
    closePromise = retirement;
    emitLifecycle("CLOSED");
    notifyContexts();
    return retirement;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    // Install the exact shared operation before lifecycle listeners or cleanup
    // dispatch can reenter close. Authority still invalidates synchronously.
    let settleClose!: (result: void | PromiseLike<void>) => void;
    closePromise = new Promise<void>((resolve) => { settleClose = resolve; });
    const closingAuthority = authority;
    closed = true;
    invalidateAllCandidates();
    authority = null;
    emitLifecycle("CLOSED");
    notifyContexts();
    settleClose((async () => {
      page.off("close", onPageClosed);
      exactCdp.off("Runtime.executionContextCreated", onContextCreated);
      exactCdp.off("Runtime.executionContextDestroyed", onContextDestroyed);
      exactCdp.off("Runtime.executionContextsCleared", onContextsCleared);
      exactCdp.off("Page.frameNavigated", onFrameNavigated);
      exactCdp.off("close", onDisconnected);

      // Renderer-cooperative cleanup is best effort. Dispatch every owned cleanup
      // command before detaching, but do not let a hostile renderer keep the
      // page-owning controller from reaching its required employer-page close.
      if (closingAuthority) {
        settleInBackground(() => rawCapabilityCall(
          closingAuthority,
          "function () { return this.dispose(); }"
        ));
      }
      const closingOperation = activeOperation;
      if (closingOperation) settleInBackground(() => closingOperation);
      if (scriptIdentifier) {
        const identifier = scriptIdentifier;
        settleInBackground(() => exactCdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier
        }));
      }
      settleInBackground(() => exactCdp.send("Runtime.releaseObjectGroup", { objectGroup }));
      settleInBackground(() => exactCdp.detach());
      lifecycleListeners.clear();
      contexts.clear();
    })());
    return closePromise;
  };

  return Object.freeze({
    waitUntilReady,
    extractApplicationForm,
    verifyCandidate,
    writeCandidateField,
    snapshot,
    waitForChange,
    subscribe(listener: (code: ProtectedSessionLifecycleCode) => void | Promise<void>) {
      requireOpen();
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    retireForHuman,
    close
  }) as ProtectedApplicationBrowserSession;
}
