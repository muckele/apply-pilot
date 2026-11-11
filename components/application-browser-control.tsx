"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CheckAnswersStepBody,
  FillStatusBlock,
  FillStepBody,
  FinishStepBody,
  MoreActions,
  Notice,
  noticeClass,
  OpenFormStepBody,
  RecordStepBody,
  StepActionButton,
  StepSection,
  stepSummary,
  StoppedCard,
  type MoreAction
} from "@/components/application-browser-steps";
import { SecondaryButton } from "@/components/ui";
import {
  applyAuthoritativeBrowserStatus,
  apparentAutomatableFieldCount,
  bindingRejectionPlan,
  browserCommandAvailability,
  buildAnswerReviewRequest,
  buildCompleteApplicationRunByUserRequest,
  buildResolveReviewRequest,
  derivePacketFreshness,
  deriveManualFieldPresentations,
  isAnswerReviewEligible,
  isAnswerReviewPostconditionCurrent,
  isAnswerReviewMutationEligible,
  fillRejectionNotice,
  isFillActivationEligible,
  isPersonalSubmissionCompletionEligible,
  isResolveReviewEligible,
  isResolveReviewPostconditionCurrent,
  parseApplicationRunReviewResponse,
  parseAnswerPacketResponse,
  parseAnswerReviewResponse,
  parseCompleteApplicationRunByUserResponse,
  shouldOfferRetryConnection,
  type AnswerReviewMutationSnapshot,
  type AnswerPacket,
  type CommandNotice,
  type ControlConnection,
  type PersonalSubmissionCompletionAuthority,
  type PendingReviewMutation,
  type PendingBrowserCommand,
  type ReviewRunAuthority,
  type ResolveReviewMutationSnapshot
} from "@/lib/application-browser/control-presentation";
import {
  fillStatusPresentation,
  parseFillStatusResponse,
  reconcileFillStatusSnapshot,
  stoppedFillErrorDescription,
  type BrowserFillAttemptStatus
} from "@/lib/application-browser/fill-status-presentation";
import {
  controlPageTitle,
  deriveControlSteps,
  shouldWarnBeforeLeaving
} from "@/lib/assisted-apply/control-steps";
import {
  companionStateLabel,
  companionStatusSentence,
  runStateLabel
} from "@/lib/assisted-apply/plain-language";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status,
  type B1WorkflowState,
  type B2InspectionCommandStatus
} from "@/lib/application-browser/types";

type ControlWindow = Window & {
  [APPLICATION_BROWSER_BINDING_NAME]?: (command: B1Command) => Promise<B1Status>;
};

type ReviewLoad = {
  phase: "idle" | "loading" | "loaded" | "error";
  run: ReviewRunAuthority | null;
  runVerified: boolean;
  packet: AnswerPacket | null;
  latestResponseWasNull: boolean;
  unverified: boolean;
  notice: CommandNotice | null;
};

type ReviewAuthorityRefreshResult =
  | Readonly<{ outcome: "COMMITTED" }>
  | Readonly<{ outcome: "FAILED" }>
  | Readonly<{ outcome: "SUPERSEDED" }>
  | Readonly<{ outcome: "INACTIVE" }>;

type FillStatusLoad = {
  phase: "idle" | "loading" | "loaded" | "error";
  status: BrowserFillAttemptStatus | null;
  verified: boolean;
  notice: CommandNotice | null;
};

type FillStatusRefreshResult =
  | Readonly<{ outcome: "COMMITTED"; verified: boolean }>
  | Readonly<{ outcome: "FAILED" }>
  | Readonly<{ outcome: "SUPERSEDED" }>
  | Readonly<{ outcome: "INACTIVE" }>;

type PersonalSubmissionCompletion = {
  phase: "idle" | "confirming" | "pending" | "confirmed" | "uncertain";
  notice: CommandNotice | null;
};

type PersonalSubmissionConfirmationIntent = Readonly<{
  componentGeneration: number;
  reviewRequestId: number;
  runId: string;
  runState: "READY" | "READY_FOR_USER_SUBMISSION";
  runStateVersion: number;
}>;

type ReviewRunReconciliation = Readonly<{
  run: ReviewRunAuthority;
  verified: boolean;
  decision: "ACCEPTED_INITIAL" | "ACCEPTED_NEWER" | "UNCHANGED" | "IGNORED_OLDER" | "CONTRADICTION";
}>;

const initialReviewLoad: ReviewLoad = {
  phase: "idle",
  run: null,
  runVerified: false,
  packet: null,
  latestResponseWasNull: false,
  unverified: false,
  notice: null
};

const initialFillStatusLoad: FillStatusLoad = {
  phase: "idle",
  status: null,
  verified: false,
  notice: null
};

const initialPersonalSubmissionCompletion: PersonalSubmissionCompletion = {
  phase: "idle",
  notice: null
};

function sameReviewRunAuthority(
  left: ReviewRunAuthority,
  right: ReviewRunAuthority
): boolean {
  return left.id === right.id &&
    left.state === right.state &&
    left.stateVersion === right.stateVersion &&
    left.completedAt === right.completedAt &&
    left.reviewReasons.length === right.reviewReasons.length &&
    left.reviewReasons.every((reason, index) => reason === right.reviewReasons[index]);
}

function reconcileReviewRunAuthority(input: Readonly<{
  current: ReviewRunAuthority | null;
  incoming: ReviewRunAuthority;
}>): ReviewRunReconciliation {
  if (input.current === null) {
    return { run: input.incoming, verified: true, decision: "ACCEPTED_INITIAL" };
  }
  if (input.incoming.stateVersion < input.current.stateVersion) {
    return {
      run: input.current,
      verified: false,
      decision: "IGNORED_OLDER"
    };
  }
  if (input.incoming.stateVersion === input.current.stateVersion) {
    if (sameReviewRunAuthority(input.current, input.incoming)) {
      return { run: input.current, verified: true, decision: "UNCHANGED" };
    }
    return { run: input.current, verified: false, decision: "CONTRADICTION" };
  }
  return { run: input.incoming, verified: true, decision: "ACCEPTED_NEWER" };
}

function reviewRunReconciliationNotice(
  decision: ReviewRunReconciliation["decision"]
): CommandNotice | null {
  if (decision === "IGNORED_OLDER") {
    return {
      tone: "WARNING",
      text: "An older run response was ignored; the newer accepted lifecycle state is preserved."
    };
  }
  if (decision === "CONTRADICTION") {
    return {
      tone: "ERROR",
      text: "A contradictory same-version run response was rejected. Run authority is unverified."
    };
  }
  return null;
}

// What one bridge command came back with. "ACCEPTED" means the binding answered and its status
// was accepted for this run; anything else (a thrown binding, a refused status, an inactive page,
// a command already in flight) is "NOT_ACCEPTED".
type InvokeResult =
  | Readonly<{ outcome: "ACCEPTED"; state: B1WorkflowState }>
  | Readonly<{ outcome: "NOT_ACCEPTED" }>;

const NOT_ACCEPTED: InvokeResult = { outcome: "NOT_ACCEPTED" };

// Whether a review mutation's own postcondition check confirmed the change it asked for.
type ReviewStepOutcome = "CONFIRMED" | "NOT_CONFIRMED";
const CONFIRMED: ReviewStepOutcome = "CONFIRMED";
const NOT_CONFIRMED: ReviewStepOutcome = "NOT_CONFIRMED";

type PlannedApproval = Readonly<{ answerId: string; fingerprint: string; status: "APPROVED" | "REJECTED" }>;

// What the user saw for one proposed answer: everything except its review status.
function proposedAnswerFingerprint(answer: AnswerPacket["answers"][number]): string {
  return JSON.stringify([
    answer.id,
    answer.normalizedFieldKey,
    answer.question,
    answer.fieldType,
    answer.classification,
    answer.disposition,
    answer.proposal,
    answer.choices,
    answer.required,
    answer.sensitive,
    answer.valueRedacted
  ]);
}

// One review per pending proposed answer, in screen order: ticked → APPROVED, unticked → REJECTED.
function planAnswerApprovals(packet: AnswerPacket, ticked: ReadonlySet<string>): readonly PlannedApproval[] {
  return packet.answers
    .filter((answer) => isAnswerReviewEligible(answer))
    .map((answer) => ({
      answerId: answer.id,
      fingerprint: proposedAnswerFingerprint(answer),
      status: ticked.has(answer.id) ? "APPROVED" as const : "REJECTED" as const
    }));
}

// Before resolving: the same proposed answers, unchanged, each decided as the screen said.
function proposedAnswersAsPlanned(
  displayed: AnswerPacket,
  latest: AnswerPacket,
  plan: readonly PlannedApproval[]
): boolean {
  const proposedIn = (packet: AnswerPacket) => packet.answers.filter((answer) => answer.disposition === "PROPOSABLE");
  const shown = proposedIn(displayed);
  const now = proposedIn(latest);
  if (shown.length !== now.length) return false;
  return shown.every((answer) => {
    const current = now.find((entry) => entry.id === answer.id);
    if (current === undefined || proposedAnswerFingerprint(current) !== proposedAnswerFingerprint(answer)) return false;
    const planned = plan.find((step) => step.answerId === answer.id);
    return current.status === (planned ? planned.status : answer.status);
  });
}

type CompanionWindow = "checking" | "present" | "absent";

// The companion's connection arrives a moment after its signed-in page loads, so the
// page waits this long before saying it is in the wrong window.
export const COMPANION_WINDOW_WAIT_MS = 8_000;
const COMPANION_WINDOW_POLL_MS = 250;

function hasCompanionBinding(): boolean {
  return typeof (window as ControlWindow)[APPLICATION_BROWSER_BINDING_NAME] === "function";
}

export function ApplicationBrowserControl({
  runId,
  authenticatedOwnerPage,
  detectCompanionWindow = false,
  companionWindowWaitMs = COMPANION_WINDOW_WAIT_MS,
  applicationHref
}: {
  runId: string;
  authenticatedOwnerPage: boolean;
  // When true, the page first checks that it is inside the Apply Pilot browser (the only
  // tab the companion connects to). Elsewhere it says so instead of showing controls
  // that can never work. Presentation only: the companion and server keep every check.
  detectCompanionWindow?: boolean;
  companionWindowWaitMs?: number;
  applicationHref?: string;
}) {
  const [companionWindow, setCompanionWindow] = useState<CompanionWindow>(
    detectCompanionWindow ? "checking" : "present"
  );
  const [status, setStatus] = useState<B1Status>({ state: "STARTING", runId });
  const [controlConnection, setControlConnectionState] = useState<ControlConnection>("UNKNOWN");
  const [hasAcceptedAuthoritativeStatus, setHasAcceptedAuthoritativeStatus] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingBrowserCommand>(null);
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>({
    tone: "INFO",
    text: "Start the local companion, then refresh status."
  });
  const [reviewLoad, setReviewLoad] = useState<ReviewLoad>(initialReviewLoad);
  const [fillStatusLoad, setFillStatusLoad] = useState<FillStatusLoad>(initialFillStatusLoad);
  const [pendingReviewMutation, setPendingReviewMutation] = useState<PendingReviewMutation>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState<CommandNotice | null>(null);
  const [pendingFillActivation, setPendingFillActivation] = useState(false);
  const [fillMayHaveDispatched, setFillMayHaveDispatched] = useState(false);
  const [transmissionAcknowledged, setTransmissionAcknowledged] = useState(false);
  const [handoffConfirming, setHandoffConfirming] = useState(false);
  const [humanClockMs, setHumanClockMs] = useState(() => Date.now());
  const [personalSubmissionCompletion, setPersonalSubmissionCompletion] =
    useState<PersonalSubmissionCompletion>(initialPersonalSubmissionCompletion);
  const [lastAcceptedInspection, setLastAcceptedInspectionState] = useState<B2InspectionCommandStatus | null>(null);
  const [formInvalidatedSinceVerifiedSuccess, setFormInvalidatedSinceVerifiedSuccess] = useState(false);

  const statusRef = useRef(status);
  const reviewLoadRef = useRef(reviewLoad);
  const fillStatusLoadRef = useRef(fillStatusLoad);
  const formInvalidatedRef = useRef(formInvalidatedSinceVerifiedSuccess);
  const reviewRequestSequenceRef = useRef(0);
  const reviewAbortControllerRef = useRef<AbortController | null>(null);
  const fillStatusRequestSequenceRef = useRef(0);
  const fillStatusAbortControllerRef = useRef<AbortController | null>(null);
  const pendingCommandRef = useRef<PendingBrowserCommand>(null);
  const pendingReviewMutationRef = useRef<PendingReviewMutation>(null);
  const approvalPendingRef = useRef(false);
  const pendingFillActivationRef = useRef(false);
  const fillMayHaveDispatchedRef = useRef(false);
  const transmissionAcknowledgedRef = useRef(false);
  const personalSubmissionCompletionPendingRef = useRef(false);
  const personalSubmissionConfirmationIntentRef = useRef<PersonalSubmissionConfirmationIntent | null>(null);
  const mutationAbortControllerRef = useRef<AbortController | null>(null);
  const lastAutoRefreshAttemptKeyRef = useRef<string | null>(null);
  const componentGenerationRef = useRef(0);
  const activeComponentGenerationRef = useRef<number | null>(null);

  const updateReviewLoad = useCallback((update: (current: ReviewLoad) => ReviewLoad) => {
    const next = update(reviewLoadRef.current);
    reviewLoadRef.current = next;
    setReviewLoad(next);
  }, []);

  // The latest connection and accepted inspection, for code that runs after an await (for example
  // the read that follows "Open and read the form"): a render's values may be older by then.
  const controlConnectionRef = useRef<ControlConnection>("UNKNOWN");
  const lastAcceptedInspectionRef = useRef<B2InspectionCommandStatus | null>(null);
  const setControlConnection = useCallback((next: ControlConnection) => {
    controlConnectionRef.current = next;
    setControlConnectionState(next);
  }, []);
  const setLastAcceptedInspection = useCallback((next: B2InspectionCommandStatus | null) => {
    lastAcceptedInspectionRef.current = next;
    setLastAcceptedInspectionState(next);
  }, []);

  const updateFillStatusLoad = useCallback((update: (current: FillStatusLoad) => FillStatusLoad) => {
    const next = update(fillStatusLoadRef.current);
    fillStatusLoadRef.current = next;
    setFillStatusLoad(next);
  }, []);

  useEffect(() => {
    if (status.state !== "HUMAN_ONLY") return;
    const timer = window.setInterval(() => setHumanClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  const invalidatePersonalSubmissionConfirmationIntent = useCallback(() => {
    if (personalSubmissionConfirmationIntentRef.current === null) return;
    personalSubmissionConfirmationIntentRef.current = null;
    setPersonalSubmissionCompletion((current) => current.phase === "confirming"
      ? { phase: "idle", notice: current.notice }
      : current
    );
  }, []);

  const cancelPersonalSubmissionConfirmation = useCallback((
    confirmationIntent: PersonalSubmissionConfirmationIntent
  ) => {
    if (
      personalSubmissionCompletionPendingRef.current ||
      personalSubmissionConfirmationIntentRef.current !== confirmationIntent
    ) return;
    personalSubmissionConfirmationIntentRef.current = null;
    setPersonalSubmissionCompletion((current) => current.phase === "confirming"
      ? initialPersonalSubmissionCompletion
      : current
    );
  }, []);

  const invalidateFillStatusAuthority = useCallback(() => {
    fillStatusRequestSequenceRef.current += 1;
    fillStatusAbortControllerRef.current?.abort();
    fillStatusAbortControllerRef.current = null;
    updateFillStatusLoad((current) => ({ ...current, verified: false }));
  }, [updateFillStatusLoad]);

  const invalidateReviewAuthority = useCallback(() => {
    reviewRequestSequenceRef.current += 1;
    reviewAbortControllerRef.current?.abort();
    reviewAbortControllerRef.current = null;
  }, []);

  const fetchReviewAuthority = useCallback(async (
    expectedGeneration = activeComponentGenerationRef.current
  ): Promise<ReviewAuthorityRefreshResult> => {
    if (expectedGeneration === null || activeComponentGenerationRef.current !== expectedGeneration) {
      return { outcome: "INACTIVE" };
    }
    if (personalSubmissionCompletionPendingRef.current) {
      return { outcome: "SUPERSEDED" };
    }
    reviewAbortControllerRef.current?.abort();
    const requestId = reviewRequestSequenceRef.current + 1;
    reviewRequestSequenceRef.current = requestId;
    const controller = new AbortController();
    reviewAbortControllerRef.current = controller;
    const resultForInactiveOrSuperseded = (): ReviewAuthorityRefreshResult | null => {
      if (activeComponentGenerationRef.current !== expectedGeneration) return { outcome: "INACTIVE" };
      if (reviewRequestSequenceRef.current !== requestId || controller.signal.aborted) return { outcome: "SUPERSEDED" };
      return null;
    };
    const currentResult = resultForInactiveOrSuperseded();
    if (currentResult !== null) return currentResult;

    invalidatePersonalSubmissionConfirmationIntent();
    updateReviewLoad((current) => ({
      ...current,
      phase: "loading",
      runVerified: false,
      unverified: true,
      notice: null
    }));
    const failRun = (notice: CommandNotice, clear = false): ReviewAuthorityRefreshResult => {
      const result = resultForInactiveOrSuperseded();
      if (result !== null) return result;
      updateReviewLoad((current) => clear
        ? { phase: "error", run: null, runVerified: false, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...current, phase: "error", runVerified: false, unverified: true, notice }
      );
      return { outcome: "FAILED" };
    };
    const failPacket = (notice: CommandNotice, clear = false): ReviewAuthorityRefreshResult => {
      const result = resultForInactiveOrSuperseded();
      if (result !== null) return result;
      updateReviewLoad((current) => clear
        ? { ...current, phase: "error", packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...current, phase: "error", unverified: true, notice }
      );
      return { outcome: "FAILED" };
    };
    try {
      const runResponsePromise = fetch(`/api/application-runs/${encodeURIComponent(runId)}`, {
        cache: "no-store",
        signal: controller.signal
      }).then((response) => response, () => null);
      const packetResponsePromise = fetch(`/api/application-runs/${encodeURIComponent(runId)}/answer-packet`, {
        cache: "no-store",
        signal: controller.signal
      }).then((response) => response, () => null);

      const runResponse = await runResponsePromise;
      const afterRunResponse = resultForInactiveOrSuperseded();
      if (afterRunResponse !== null) return afterRunResponse;
      if (runResponse === null || !runResponse.ok) {
        const packetResponse = await packetResponsePromise;
        const afterPacketSibling = resultForInactiveOrSuperseded();
        if (afterPacketSibling !== null) return afterPacketSibling;
        const authFailure = [runResponse, packetResponse].find((response): response is Response =>
          response !== null && !response.ok &&
          (response.status === 401 || response.status === 403 || response.status === 404)
        );
        if (authFailure?.status === 401) return failRun({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to read review data." }, true);
        if (authFailure?.status === 403) return failRun({ tone: "ERROR", text: "You are not authorized to read review data for this application run." }, true);
        if (authFailure?.status === 404) return failRun({ tone: "ERROR", text: "This application run or answer packet is unavailable." }, true);
        if (runResponse === null) {
          return failRun({ tone: "ERROR", text: "Apply Pilot could not reach the review authority service. Refresh review data before another action." });
        }
        if (runResponse.status === 429) return failRun({ tone: "WARNING", text: "Review data reads are temporarily limited. Wait a moment, then refresh review data." });
        return failRun({ tone: "ERROR", text: "Review data is temporarily unavailable. Refresh review data before another action." });
      }

      let runValue: unknown;
      try {
        runValue = await runResponse.json();
      } catch {
        return failRun({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
      const afterRunJson = resultForInactiveOrSuperseded();
      if (afterRunJson !== null) return afterRunJson;

      let run: ReviewRunAuthority;
      try {
        run = parseApplicationRunReviewResponse(runValue, runId);
      } catch {
        return failRun({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
      const afterRunParse = resultForInactiveOrSuperseded();
      if (afterRunParse !== null) return afterRunParse;
      const runReconciliation = reconcileReviewRunAuthority({
        current: reviewLoadRef.current.run,
        incoming: run
      });
      const runReconciliationNotice = reviewRunReconciliationNotice(runReconciliation.decision);
      updateReviewLoad((current) => runReconciliationNotice === null
        ? { ...current, run: runReconciliation.run, runVerified: runReconciliation.verified }
        : {
            ...current,
            phase: "error",
            run: runReconciliation.run,
            runVerified: runReconciliation.verified,
            unverified: true,
            notice: runReconciliationNotice
          }
      );
      if (runReconciliationNotice !== null) {
        controller.abort();
        if (reviewAbortControllerRef.current === controller) reviewAbortControllerRef.current = null;
        return { outcome: "FAILED" };
      }

      const packetResponse = await packetResponsePromise;
      const afterPacketResponse = resultForInactiveOrSuperseded();
      if (afterPacketResponse !== null) return afterPacketResponse;
      if (packetResponse === null) {
        return failPacket({ tone: "ERROR", text: "Apply Pilot could not reach the review authority service. Refresh review data before another action." });
      }
      if (!packetResponse.ok) {
        if (packetResponse.status === 401) return failPacket({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to read review data." }, true);
        if (packetResponse.status === 403) return failPacket({ tone: "ERROR", text: "You are not authorized to read review data for this application run." }, true);
        if (packetResponse.status === 404) return failPacket({ tone: "ERROR", text: "This application run or answer packet is unavailable." }, true);
        if (packetResponse.status === 429) return failPacket({ tone: "WARNING", text: "Review data reads are temporarily limited. Wait a moment, then refresh review data." });
        return failPacket({ tone: "ERROR", text: "Review data is temporarily unavailable. Refresh review data before another action." });
      }

      let packetValue: unknown;
      try {
        packetValue = await packetResponse.json();
      } catch {
        return failPacket({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
      const afterPacketJson = resultForInactiveOrSuperseded();
      if (afterPacketJson !== null) return afterPacketJson;
      try {
        const packet = parseAnswerPacketResponse(packetValue, runId).current;
        const afterPacketParse = resultForInactiveOrSuperseded();
        if (afterPacketParse !== null) return afterPacketParse;
        const finalRunReconciliation = reconcileReviewRunAuthority({
          current: reviewLoadRef.current.run,
          incoming: run
        });
        const finalRunNotice = reviewRunReconciliationNotice(finalRunReconciliation.decision);
        if (finalRunNotice !== null) {
          updateReviewLoad((current) => ({
            ...current,
            phase: "error",
            run: finalRunReconciliation.run,
            runVerified: finalRunReconciliation.verified,
            unverified: true,
            notice: finalRunNotice
          }));
          return { outcome: "FAILED" };
        }
        updateReviewLoad(() => ({
          phase: "loaded",
          run: finalRunReconciliation.run,
          runVerified: finalRunReconciliation.verified,
          packet,
          latestResponseWasNull: packet === null,
          unverified: false,
          notice: packet === null ? { tone: "INFO", text: "No current answer packet has been published yet." } : null
        }));
        return { outcome: "COMMITTED" };
      } catch {
        return failPacket({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
    } catch {
      return failRun({ tone: "ERROR", text: "Apply Pilot could not reach the review authority service. Refresh review data before another action." });
    }
  }, [invalidatePersonalSubmissionConfirmationIntent, runId, updateReviewLoad]);

  const fetchFillStatus = useCallback(async (
    expectedGeneration = activeComponentGenerationRef.current
  ): Promise<FillStatusRefreshResult> => {
    if (expectedGeneration === null || activeComponentGenerationRef.current !== expectedGeneration) {
      return { outcome: "INACTIVE" };
    }
    fillStatusAbortControllerRef.current?.abort();
    const requestId = fillStatusRequestSequenceRef.current + 1;
    fillStatusRequestSequenceRef.current = requestId;
    const controller = new AbortController();
    fillStatusAbortControllerRef.current = controller;
    const inactiveOrSuperseded = (): FillStatusRefreshResult | null => {
      if (activeComponentGenerationRef.current !== expectedGeneration) return { outcome: "INACTIVE" };
      if (fillStatusRequestSequenceRef.current !== requestId || controller.signal.aborted) {
        return { outcome: "SUPERSEDED" };
      }
      return null;
    };
    const currentResult = inactiveOrSuperseded();
    if (currentResult !== null) return currentResult;

    updateFillStatusLoad((current) => ({ ...current, phase: "loading", notice: null }));
    const fail = (notice: CommandNotice, clear = false): FillStatusRefreshResult => {
      const result = inactiveOrSuperseded();
      if (result !== null) return result;
      updateFillStatusLoad((current) => clear
        ? { phase: "error", status: null, verified: false, notice }
        : { ...current, phase: "error", verified: false, notice }
      );
      return { outcome: "FAILED" };
    };

    try {
      const response = await fetch(
        `/api/application-runs/${encodeURIComponent(runId)}/fill-attempt`,
        { cache: "no-store", signal: controller.signal }
      );
      const afterResponse = inactiveOrSuperseded();
      if (afterResponse !== null) return afterResponse;
      if (!response.ok) {
        if (response.status === 401) {
          return fail({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to read Fill status." }, true);
        }
        if (response.status === 403) {
          return fail({ tone: "ERROR", text: "You are not authorized to read Fill status for this application run." }, true);
        }
        if (response.status === 404) {
          return fail({ tone: "ERROR", text: "This application run is unavailable for Fill status." }, true);
        }
        if (response.status === 429) {
          return fail({ tone: "WARNING", text: "Fill-status reads are temporarily limited. Wait before refreshing." });
        }
        return fail({ tone: "ERROR", text: "Fill status is temporarily unavailable. Use Refresh Fill status for a read-only retry." });
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return fail({ tone: "ERROR", text: "Apply Pilot could not safely read the Fill-status response." });
      }
      const afterJson = inactiveOrSuperseded();
      if (afterJson !== null) return afterJson;

      try {
        const incoming = parseFillStatusResponse(value);
        const current = fillStatusLoadRef.current;
        const reconciled = reconcileFillStatusSnapshot({
          current: current.status,
          currentVerified: current.verified,
          incoming
        });
        const notice: CommandNotice | null = reconciled.decision === "CONTRADICTION"
          ? { tone: "ERROR", text: "A contradictory same-version Fill status was rejected. Fill authority is unverified." }
          : reconciled.decision === "IGNORED_OLDER"
            ? { tone: "WARNING", text: "An older Fill status was ignored; the newer accepted status is preserved." }
            : reconciled.decision === "ACCEPTED_UNAVAILABLE"
              ? { tone: "ERROR", text: "The Fill-status combination could not be verified safely." }
              : null;
        updateFillStatusLoad(() => ({
          phase: "loaded",
          status: reconciled.status,
          verified: reconciled.verified,
          notice
        }));
        return { outcome: "COMMITTED", verified: reconciled.verified };
      } catch {
        return fail({ tone: "ERROR", text: "Apply Pilot could not safely read the Fill-status response." });
      }
    } catch {
      return fail({ tone: "ERROR", text: "Apply Pilot could not reach the Fill-status service. Use Refresh Fill status for a read-only retry." });
    }
  }, [runId, updateFillStatusLoad]);

  const acceptAuthoritativeStatus = useCallback((
    value: unknown,
    expectedGeneration: number,
    refreshFillStatus = true,
    requireFillDisposition = false
  ) => {
    if (activeComponentGenerationRef.current !== expectedGeneration) {
      return { active: false, accepted: false, suppliedNotice: false };
    }
    const result = applyAuthoritativeBrowserStatus({
      value,
      expectedRunId: runId,
      formInvalidatedSinceVerifiedSuccess: formInvalidatedRef.current
    });
    if (
      !result.accepted ||
      (requireFillDisposition &&
        (result.status.state !== "TARGET_OPEN" || result.status.fillCommand === undefined))
    ) {
      setControlConnection("UNAVAILABLE");
      return { active: true, accepted: false, suppliedNotice: false };
    }

    statusRef.current = result.status;
    setStatus(result.status);
    setControlConnection(result.connection);
    setHasAcceptedAuthoritativeStatus(true);
    setLastAcceptedInspection(result.lastAcceptedInspection);
    formInvalidatedRef.current = result.formInvalidatedSinceVerifiedSuccess;
    setFormInvalidatedSinceVerifiedSuccess(result.formInvalidatedSinceVerifiedSuccess);
    if (result.notice) setCommandNotice(result.notice);
    if (refreshFillStatus) void fetchFillStatus(expectedGeneration);

    const refreshKey = result.automaticPacketRefreshKey;
    if (refreshKey !== null) {
      const authority = reviewLoadRef.current;
      const displayed = authority.packet;
      const matches = displayed !== null && `${displayed.inspectionVersion}:${displayed.answerPacketVersion}` === refreshKey;
      const trustedMatch = matches && authority.phase === "loaded" && !authority.unverified;
      const needsTrustRestoration = authority.unverified || authority.phase === "error";
      if (
        !trustedMatch &&
        (lastAutoRefreshAttemptKeyRef.current !== refreshKey ||
          (needsTrustRestoration && authority.phase !== "loading"))
      ) {
        lastAutoRefreshAttemptKeyRef.current = refreshKey;
        void fetchReviewAuthority(expectedGeneration);
      }
    }
    return { active: true, accepted: true, suppliedNotice: result.notice !== null };
  }, [fetchFillStatus, fetchReviewAuthority, runId, setControlConnection, setLastAcceptedInspection]);

  const invoke = useCallback(async (
    command: Exclude<B1Command, { type: "FILL_APPROVED_FIELDS" }>
  ): Promise<InvokeResult> => {
    if (pendingCommandRef.current !== null || pendingFillActivationRef.current) return NOT_ACCEPTED;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return NOT_ACCEPTED;
    pendingCommandRef.current = command.type;
    setPendingCommand(command.type);
    setCommandNotice(null);
    try {
      const binding = (window as ControlWindow)[APPLICATION_BROWSER_BINDING_NAME];
      if (typeof binding !== "function") {
        if (activeComponentGenerationRef.current !== expectedGeneration) return NOT_ACCEPTED;
        setControlConnection("UNAVAILABLE");
        setCommandNotice({ tone: "WARNING", text: "Local browser companion is not connected to this control page." });
        return NOT_ACCEPTED;
      }

      try {
        const nextStatus = await binding(command);
        if (activeComponentGenerationRef.current !== expectedGeneration) return NOT_ACCEPTED;
        const accepted = acceptAuthoritativeStatus(nextStatus, expectedGeneration);
        if (!accepted.active) return NOT_ACCEPTED;
        if (!accepted.accepted) {
          setCommandNotice({
            tone: "WARNING",
            text: "The local browser companion returned a status that could not be accepted for this run."
          });
          return NOT_ACCEPTED;
        }
        if (!accepted.suppliedNotice) {
          const text = command.type === "OPEN_TARGET"
            ? "The employer's form is open."
            : command.type === "HANDOFF_TO_HUMAN"
              ? "The form is unlocked. Finish it in the employer's window and press Submit yourself."
              : command.type === "END_HUMAN_SESSION"
                ? "Human browser session ended."
            : command.type === "CLOSE_WORKFLOW"
              ? "Browser workflow status updated."
              : command.type === "INSPECT_FORM"
                ? "Inspection status updated."
                : "Browser status updated.";
          setCommandNotice({ tone: "INFO", text });
        }
        return { outcome: "ACCEPTED", state: statusRef.current.state };
      } catch {
        if (activeComponentGenerationRef.current !== expectedGeneration) return NOT_ACCEPTED;
        const freshness = derivePacketFreshness({
          packet: reviewLoadRef.current.packet,
          latestPacketResponseWasNull: reviewLoadRef.current.latestResponseWasNull,
          packetLoadUnverified: reviewLoadRef.current.unverified,
          connection: controlConnectionRef.current,
          workflowState: statusRef.current.state,
          lastAcceptedInspection: lastAcceptedInspectionRef.current,
          formInvalidatedSinceVerifiedSuccess: formInvalidatedRef.current
        });
        const plan = bindingRejectionPlan(command.type, statusRef.current, freshness);
        const text = command.type === "GET_STATUS"
          ? "The local browser connection could not be refreshed. Retry the connection."
          : command.type === "HANDOFF_TO_HUMAN"
            ? "Handoff outcome is uncertain. Refresh browser status; never repeat Fill. If the browser was closed, complete manually in your ordinary browser."
            : command.type === "END_HUMAN_SESSION"
              ? "End-session cleanup outcome is uncertain. Do not assume the employer page or submitted application has closed."
          : command.type === "OPEN_TARGET"
            ? "Apply Pilot couldn't open the employer's form, so it stopped safely and didn't try again. Browser status was checked once."
            : command.type === "INSPECT_FORM"
              ? "The inspection command stopped safely. The displayed packet is unverified until browser status is recovered."
              : "The close command stopped safely. Browser status was checked once.";
        setCommandNotice({ tone: "WARNING", text });
        if (plan.packetTrust === "UNVERIFIED") {
          invalidateReviewAuthority();
          updateReviewLoad((current) => ({
            ...current,
            phase: current.phase === "loading" ? "error" : current.phase,
            unverified: true
          }));
        }
        if (!plan.recoverWithGetStatus) {
          setControlConnection(plan.connection);
          return NOT_ACCEPTED;
        }
        try {
          const recoveredStatus = await binding({ type: "GET_STATUS" });
          if (activeComponentGenerationRef.current !== expectedGeneration) return NOT_ACCEPTED;
          const recovered = acceptAuthoritativeStatus(recoveredStatus, expectedGeneration);
          if (!recovered.active) return NOT_ACCEPTED;
          if (!recovered.accepted) setControlConnection("UNAVAILABLE");
        } catch {
          if (activeComponentGenerationRef.current !== expectedGeneration) return NOT_ACCEPTED;
          setControlConnection("UNAVAILABLE");
        }
        return NOT_ACCEPTED;
      }
    } finally {
      if (
        activeComponentGenerationRef.current === expectedGeneration &&
        pendingCommandRef.current === command.type
      ) {
        pendingCommandRef.current = null;
        setPendingCommand(null);
      }
    }
  }, [acceptAuthoritativeStatus, invalidateReviewAuthority, setControlConnection, updateReviewLoad]);

  // Step 4 (D-C): one explicit click sends the existing OPEN_TARGET and, only when that command
  // itself came back as an accepted TARGET_OPEN status, the existing INSPECT_FORM. Both only open
  // and read. A failed open stops here with its notice; nothing is retried automatically.
  const openAndReadForm = useCallback(async () => {
    if (pendingCommandRef.current !== null || pendingFillActivationRef.current) return;
    const opened = await invoke({ type: "OPEN_TARGET" });
    if (opened.outcome !== "ACCEPTED") return;
    if (opened.state !== "TARGET_OPEN") {
      setCommandNotice({
        tone: "WARNING",
        text: `Apply Pilot couldn't open the employer's form (${companionStateLabel(opened.state).toLowerCase()}), so it stopped and didn't read it.`
      });
      return;
    }
    await invoke({ type: "INSPECT_FORM" });
  }, [invoke]);

  const activateFill = useCallback(async () => {
    if (
      pendingCommandRef.current !== null ||
      pendingFillActivationRef.current ||
      fillMayHaveDispatchedRef.current ||
      !transmissionAcknowledgedRef.current
    ) return;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return;
    const currentStatus = statusRef.current;
    const currentReview = reviewLoadRef.current;
    const currentFillStatus = fillStatusLoadRef.current;
    const freshness = derivePacketFreshness({
      packet: currentReview.packet,
      latestPacketResponseWasNull: currentReview.latestResponseWasNull,
      packetLoadUnverified: currentReview.unverified,
      connection: controlConnection,
      workflowState: currentStatus.state,
      lastAcceptedInspection,
      formInvalidatedSinceVerifiedSuccess: formInvalidatedRef.current
    });
    if (!isFillActivationEligible({
      authenticatedOwnerPage,
      componentActive: true,
      connection: controlConnection,
      hasAcceptedAuthoritativeStatus,
      browserStatus: currentStatus,
      packetFreshness: freshness,
      reviewLoad: {
        phase: currentReview.phase,
        verified: !currentReview.unverified,
        run: currentReview.run,
        packet: currentReview.packet
      },
      fillStatusLoad: currentFillStatus,
      pendingBrowserCommand: pendingCommandRef.current,
      pendingReviewMutation: pendingReviewMutationRef.current,
      pendingFillActivation: false,
      fillMayHaveDispatched: false
    })) return;

    const binding = (window as ControlWindow)[APPLICATION_BROWSER_BINDING_NAME];
    if (typeof binding !== "function") {
      setControlConnection("UNAVAILABLE");
      setCommandNotice({
        tone: "WARNING",
        text: "Local browser companion is not connected to this control page. Fill definitely did not dispatch."
      });
      return;
    }

    pendingFillActivationRef.current = true;
    setPendingFillActivation(true);
    setCommandNotice(null);
    const markMutationUncertainAndReconcile = async () => {
      if (activeComponentGenerationRef.current !== expectedGeneration) return;
      invalidateReviewAuthority();
      updateReviewLoad((current) => ({
        ...current,
        phase: current.phase === "loading" ? "error" : current.phase,
        unverified: true
      }));
      invalidateFillStatusAuthority();
      setControlConnection("UNAVAILABLE");
      await Promise.all([
        fetchFillStatus(expectedGeneration),
        fetchReviewAuthority(expectedGeneration)
      ]);
      if (activeComponentGenerationRef.current === expectedGeneration) {
        setCommandNotice({
          tone: "WARNING",
          text: "Fill mutation outcome is uncertain because the binding result was unavailable. Apply Pilot did not replay Fill. Review every employer field manually and use Refresh Fill status only for read-only updates."
        });
      }
    };

    try {
      fillMayHaveDispatchedRef.current = true;
      setFillMayHaveDispatched(true);
      invalidateFillStatusAuthority();
      const nextStatus = await binding({ type: "FILL_APPROVED_FIELDS" });
      if (activeComponentGenerationRef.current !== expectedGeneration) return;
      const accepted = acceptAuthoritativeStatus(nextStatus, expectedGeneration, false, true);
      if (!accepted.active) return;
      if (!accepted.accepted) {
        await markMutationUncertainAndReconcile();
        return;
      }

      const [fillStatusRefresh] = await Promise.all([
        fetchFillStatus(expectedGeneration),
        fetchReviewAuthority(expectedGeneration)
      ]);
      if (activeComponentGenerationRef.current !== expectedGeneration) return;
      const commandStatus = statusRef.current.fillCommand;
      if (fillStatusRefresh.outcome !== "COMMITTED" || !fillStatusRefresh.verified) {
        setCommandNotice({
          tone: "WARNING",
          text: `The bridge reported a bounded ${commandStatus?.outcome ?? "Fill-command"} disposition, but the authenticated durable Fill status is unverified. Review every employer field manually and use Refresh Fill status only for read-only updates.`
        });
      } else if (commandStatus?.outcome === "REJECTED") {
        setCommandNotice(fillRejectionNotice(commandStatus.errorCode));
      } else if (commandStatus?.outcome === "RECOVERY_PENDING") {
        setCommandNotice({
          tone: "WARNING",
          text: "Fill recovery is pending. Do not start Fill again; use read-only Fill-status refreshes."
        });
      } else if (commandStatus?.outcome === "CANCELLED") {
        setCommandNotice({
          tone: "WARNING",
          text: "The application run was cancelled. Fill cannot be started again."
        });
      } else {
        setCommandNotice({
          tone: "INFO",
          text: "Fill command settled. The authenticated durable Fill status was refreshed."
        });
      }
    } catch {
      await markMutationUncertainAndReconcile();
    } finally {
      pendingFillActivationRef.current = false;
      if (activeComponentGenerationRef.current === expectedGeneration) {
        setPendingFillActivation(false);
      }
    }
  }, [
    acceptAuthoritativeStatus,
    authenticatedOwnerPage,
    controlConnection,
    fetchFillStatus,
    fetchReviewAuthority,
    hasAcceptedAuthoritativeStatus,
    invalidateFillStatusAuthority,
    invalidateReviewAuthority,
    lastAcceptedInspection,
    setControlConnection,
    updateReviewLoad
  ]);

  const reviewAnswer = useCallback(async (
    answer: AnswerPacket["answers"][number],
    status: "APPROVED" | "REJECTED"
  ): Promise<ReviewStepOutcome> => {
    const current = reviewLoadRef.current;
    const currentAnswer = current.packet?.answers.find((entry) => entry.id === answer.id);
    if (
      pendingFillActivationRef.current ||
      pendingReviewMutationRef.current !== null ||
      current.phase !== "loaded" ||
      current.unverified ||
      current.packet === null ||
      currentAnswer !== answer ||
      !isAnswerReviewMutationEligible({
        answer: currentAnswer,
        run: current.run,
        trusted: true
      })
    ) return NOT_CONFIRMED;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return NOT_CONFIRMED;

    const mutation: Exclude<PendingReviewMutation, null> = { type: "ANSWER", answerId: currentAnswer.id, status };
    const snapshot: AnswerReviewMutationSnapshot = {
      answerId: currentAnswer.id,
      requestedStatus: status,
      answerPacketVersion: current.packet.answerPacketVersion
    };
    pendingReviewMutationRef.current = mutation;
    setPendingReviewMutation(mutation);
    const controller = new AbortController();
    mutationAbortControllerRef.current = controller;
    const active = () => activeComponentGenerationRef.current === expectedGeneration;
    const markUnverified = (notice: CommandNotice, clear = false) => {
      if (!active()) return;
      invalidateReviewAuthority();
      updateReviewLoad((loaded) => clear
        ? { phase: "error", run: null, runVerified: false, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...loaded, phase: "error", runVerified: false, unverified: true, notice }
      );
    };
    try {
      const request = buildAnswerReviewRequest({
        runId,
        answerId: snapshot.answerId,
        answerPacketVersion: snapshot.answerPacketVersion,
        status: snapshot.requestedStatus
      });
      const response = await fetch(request.url, { ...request.init, signal: controller.signal });
      if (!active()) return NOT_CONFIRMED;
      if (response.status === 409) {
        const conflictNotice: CommandNotice = {
          tone: "WARNING",
          text: "Review authority changed. Refreshing current review data."
        };
        markUnverified(conflictNotice);
        const recovery = await fetchReviewAuthority(expectedGeneration);
        if (active() && recovery.outcome === "COMMITTED") {
          updateReviewLoad((loaded) => ({ ...loaded, notice: conflictNotice }));
        }
        return NOT_CONFIRMED;
      }
      if (!response.ok) {
        if (response.status === 401) markUnverified({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to review answers." }, true);
        else if (response.status === 403) markUnverified({ tone: "ERROR", text: "You are not authorized to review this answer." }, true);
        else if (response.status === 404) markUnverified({ tone: "ERROR", text: "This application run or answer is unavailable." }, true);
        else if (response.status === 429) markUnverified({ tone: "WARNING", text: "Review actions are temporarily limited. Wait before refreshing review data." });
        else markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
        return NOT_CONFIRMED;
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return NOT_CONFIRMED;
      }
      if (!active()) return NOT_CONFIRMED;
      try {
        parseAnswerReviewResponse(value, { runId, answerId: snapshot.answerId, status: snapshot.requestedStatus });
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return NOT_CONFIRMED;
      }
      const refreshResult = await fetchReviewAuthority(expectedGeneration);
      if (!active() || refreshResult.outcome !== "COMMITTED") return NOT_CONFIRMED;
      const refreshed = reviewLoadRef.current;
      if (isAnswerReviewPostconditionCurrent({
        phase: refreshed.phase,
        unverified: refreshed.unverified,
        packet: refreshed.packet,
        snapshot
      })) {
        updateReviewLoad((loaded) => ({
          ...loaded,
          notice: { tone: "SUCCESS", text: status === "APPROVED" ? "Answer approved." : "Answer rejected." }
        }));
        return CONFIRMED;
      } else {
        updateReviewLoad((loaded) => ({
          ...loaded,
          notice: { tone: "WARNING", text: "Review data changed after the action. Review the current packet before continuing." }
        }));
      }
    } catch {
      if (active()) markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
    } finally {
      if (activeComponentGenerationRef.current === expectedGeneration && pendingReviewMutationRef.current === mutation) {
        pendingReviewMutationRef.current = null;
        setPendingReviewMutation(null);
      }
      if (mutationAbortControllerRef.current === controller) mutationAbortControllerRef.current = null;
    }
    return NOT_CONFIRMED;
  }, [fetchReviewAuthority, invalidateReviewAuthority, runId, updateReviewLoad]);

  const resolveReview = useCallback(async (): Promise<ReviewStepOutcome> => {
    const current = reviewLoadRef.current;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (
      pendingFillActivationRef.current ||
      pendingReviewMutationRef.current !== null ||
      expectedGeneration === null ||
      current.phase !== "loaded" ||
      current.unverified ||
      current.run === null ||
      current.packet === null ||
      !isResolveReviewEligible({ run: current.run, packet: current.packet, trusted: true })
    ) return NOT_CONFIRMED;

    const mutation: Exclude<PendingReviewMutation, null> = { type: "RESOLVE" };
    const snapshot: ResolveReviewMutationSnapshot = {
      stateVersion: current.run.stateVersion,
      answerPacketVersion: current.packet.answerPacketVersion,
      packetHash: current.packet.packetHash,
      acknowledgedReviewReasons: [...current.run.reviewReasons],
      acknowledgedAmbiguousQuestionCount: current.packet.summary.ambiguousQuestionCount
    };
    pendingReviewMutationRef.current = mutation;
    setPendingReviewMutation(mutation);
    const controller = new AbortController();
    mutationAbortControllerRef.current = controller;
    const active = () => activeComponentGenerationRef.current === expectedGeneration;
    const markUnverified = (notice: CommandNotice, clear = false) => {
      if (!active()) return;
      invalidateReviewAuthority();
      updateReviewLoad((loaded) => clear
        ? { phase: "error", run: null, runVerified: false, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...loaded, phase: "error", runVerified: false, unverified: true, notice }
      );
    };
    try {
      const request = buildResolveReviewRequest({ runId, run: current.run, packet: current.packet });
      const response = await fetch(request.url, { ...request.init, signal: controller.signal });
      if (!active()) return NOT_CONFIRMED;
      if (response.status === 409) {
        const conflictNotice: CommandNotice = {
          tone: "WARNING",
          text: "Review authority changed. Refreshing current review data."
        };
        markUnverified(conflictNotice);
        const recovery = await fetchReviewAuthority(expectedGeneration);
        if (active() && recovery.outcome === "COMMITTED") {
          updateReviewLoad((loaded) => ({ ...loaded, notice: conflictNotice }));
        }
        return NOT_CONFIRMED;
      }
      if (!response.ok) {
        if (response.status === 401) markUnverified({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to resolve review." }, true);
        else if (response.status === 403) markUnverified({ tone: "ERROR", text: "You are not authorized to resolve review for this application run." }, true);
        else if (response.status === 404) markUnverified({ tone: "ERROR", text: "This application run is unavailable for review resolution." }, true);
        else if (response.status === 429) markUnverified({ tone: "WARNING", text: "Review actions are temporarily limited. Wait before refreshing review data." });
        else markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
        return NOT_CONFIRMED;
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return NOT_CONFIRMED;
      }
      if (!active()) return NOT_CONFIRMED;
      try {
        parseApplicationRunReviewResponse(value, runId);
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return NOT_CONFIRMED;
      }
      const refreshResult = await fetchReviewAuthority(expectedGeneration);
      if (!active() || refreshResult.outcome !== "COMMITTED") return NOT_CONFIRMED;
      const refreshed = reviewLoadRef.current;
      if (isResolveReviewPostconditionCurrent({
        phase: refreshed.phase,
        unverified: refreshed.unverified,
        run: refreshed.run,
        packet: refreshed.packet,
        snapshot
      })) {
        updateReviewLoad((loaded) => ({ ...loaded, notice: { tone: "SUCCESS", text: "Review resolved." } }));
        await fetchFillStatus(expectedGeneration);
        return CONFIRMED;
      } else {
        updateReviewLoad((loaded) => ({
          ...loaded,
          notice: {
            tone: "WARNING",
            text: "Review authority changed after the action. Review the current run and packet before continuing."
          }
        }));
      }
    } catch {
      if (active()) markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
    } finally {
      if (activeComponentGenerationRef.current === expectedGeneration && pendingReviewMutationRef.current === mutation) {
        pendingReviewMutationRef.current = null;
        setPendingReviewMutation(null);
      }
      if (mutationAbortControllerRef.current === controller) mutationAbortControllerRef.current = null;
    }
    return NOT_CONFIRMED;
  }, [fetchFillStatus, fetchReviewAuthority, invalidateReviewAuthority, runId, updateReviewLoad]);


  // Step 5 (D-H): one click sends today's per-answer review for every pending proposed answer
  // (ticked → APPROVED, unticked → REJECTED) in screen order, then today's resolve-review. Each
  // request keeps its own shape, postcondition check and authority refresh. Before each one the
  // latest answer is re-read; if anything failed or changed, nothing more is sent.
  const approveAndContinue = useCallback(async (
    displayed: AnswerPacket,
    ticked: ReadonlySet<string>
  ) => {
    if (
      approvalPendingRef.current ||
      pendingReviewMutationRef.current !== null ||
      pendingFillActivationRef.current ||
      personalSubmissionCompletionPendingRef.current
    ) return;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return;
    const active = () => activeComponentGenerationRef.current === expectedGeneration;
    approvalPendingRef.current = true;
    setApprovalPending(true);
    setApprovalNotice(null);

    const stop = async () => {
      if (!active()) return;
      const latest = reviewLoadRef.current;
      // A refused session or a missing run already cleared the answers; reading again won't help.
      const cleared = latest.phase === "error" && latest.run === null && latest.packet === null;
      if (!cleared && (latest.phase !== "loaded" || latest.unverified)) {
        await fetchReviewAuthority(expectedGeneration);
        if (!active()) return;
      }
      setApprovalNotice({
        tone: "WARNING",
        text: cleared ? "Nothing more was approved." : "The answers changed, so nothing more was approved. Check them again."
      });
    };

    try {
      const start = reviewLoadRef.current;
      if (
        start.phase !== "loaded" ||
        start.unverified ||
        start.packet !== displayed ||
        start.run?.state !== "REVIEW_REQUIRED"
      ) {
        await stop();
        return;
      }
      const plan = planAnswerApprovals(displayed, ticked);
      for (const step of plan) {
        if (!active()) return;
        const latest = reviewLoadRef.current;
        const answer = latest.packet?.answers.find((entry) => entry.id === step.answerId);
        if (
          latest.phase !== "loaded" ||
          latest.unverified ||
          latest.packet === null ||
          latest.packet.answerPacketVersion !== displayed.answerPacketVersion ||
          answer === undefined ||
          answer.status !== "PENDING" ||
          proposedAnswerFingerprint(answer) !== step.fingerprint
        ) {
          await stop();
          return;
        }
        const outcome = await reviewAnswer(answer, step.status);
        if (outcome !== CONFIRMED) {
          await stop();
          return;
        }
      }
      if (!active()) return;
      const latest = reviewLoadRef.current;
      if (
        latest.phase !== "loaded" ||
        latest.unverified ||
        latest.packet === null ||
        latest.packet.answerPacketVersion !== displayed.answerPacketVersion ||
        !proposedAnswersAsPlanned(displayed, latest.packet, plan) ||
        !isResolveReviewEligible({ run: latest.run, packet: latest.packet, trusted: true })
      ) {
        await stop();
        return;
      }
      const resolved = await resolveReview();
      if (resolved !== CONFIRMED) await stop();
    } finally {
      approvalPendingRef.current = false;
      if (active()) setApprovalPending(false);
    }
  }, [fetchReviewAuthority, resolveReview, reviewAnswer]);

  const reconcilePersonalSubmissionCompletion = useCallback(async (
    expectedGeneration: number
  ): Promise<void> => {
    const active = () => activeComponentGenerationRef.current === expectedGeneration;
    if (!active()) return;

    const markUncertain = (notice: CommandNotice, clearRun = false) => {
      if (!active()) return;
      updateReviewLoad((current) => clearRun
        ? {
            phase: "error",
            run: null,
            runVerified: false,
            packet: current.packet,
            latestResponseWasNull: current.latestResponseWasNull,
            unverified: true,
            notice: current.notice
          }
        : { ...current, runVerified: false, unverified: true }
      );
      setPersonalSubmissionCompletion({ phase: "uncertain", notice });
    };

    try {
      const response = await fetch(`/api/application-runs/${encodeURIComponent(runId)}`, {
        cache: "no-store"
      });
      if (!active()) return;
      if (!response.ok) {
        if (response.status === 401) {
          markUncertain({
            tone: "ERROR",
            text: "Your session is no longer authenticated. Sign in again before checking personal-submission status."
          }, true);
        } else if (response.status === 403) {
          markUncertain({
            tone: "ERROR",
            text: "You are not authorized to check personal-submission status for this application run."
          }, true);
        } else if (response.status === 404) {
          markUncertain({
            tone: "ERROR",
            text: "This application run is unavailable for personal-submission status."
          }, true);
        } else if (response.status === 429) {
          markUncertain({
            tone: "WARNING",
            text: "Personal-submission status checks are temporarily limited. Wait before refreshing status."
          });
        } else {
          markUncertain({
            tone: "WARNING",
            text: "Apply Pilot could not verify whether the attestation was recorded. Refresh personal-submission status before deciding whether to act again."
          });
        }
        return;
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        markUncertain({
          tone: "WARNING",
          text: "Apply Pilot could not safely read personal-submission status. Refresh status before deciding whether to act again."
        });
        return;
      }
      if (!active()) return;

      let run: ReviewRunAuthority;
      try {
        run = parseApplicationRunReviewResponse(value, runId);
      } catch {
        markUncertain({
          tone: "WARNING",
          text: "Apply Pilot could not safely verify personal-submission status. Refresh status before deciding whether to act again."
        });
        return;
      }
      if (!active()) return;

      const runReconciliation = reconcileReviewRunAuthority({
        current: reviewLoadRef.current.run,
        incoming: run
      });
      const runNotice = reviewRunReconciliationNotice(runReconciliation.decision);
      updateReviewLoad((current) => ({
        ...current,
        phase: runNotice === null ? current.phase : "error",
        run: runReconciliation.run,
        runVerified: runReconciliation.verified,
        unverified: true,
        notice: runNotice ?? current.notice
      }));
      if (!runReconciliation.verified) {
        setPersonalSubmissionCompletion({
          phase: "uncertain",
          notice: {
            tone: "WARNING",
            text: "Apply Pilot received contradictory run authority while checking personal-submission status. No completion request was repeated."
          }
        });
      } else if (runReconciliation.run.state === "COMPLETED_BY_USER") {
        setPersonalSubmissionCompletion({
          phase: "confirmed",
          notice: {
            tone: "SUCCESS",
            text: "Personal submission is recorded from your explicit attestation."
          }
        });
      } else if (
        runReconciliation.run.state === "READY" ||
        runReconciliation.run.state === "READY_FOR_USER_SUBMISSION"
      ) {
        setPersonalSubmissionCompletion({
          phase: "uncertain",
          notice: {
            tone: "WARNING",
            text: "Apply Pilot could not verify whether the attestation was recorded. The latest run is still eligible; any future completion attempt must be another explicit user action."
          }
        });
      } else {
        setPersonalSubmissionCompletion({
          phase: "uncertain",
          notice: {
            tone: "WARNING",
            text: "The application run changed state while personal-submission status was being reconciled. No completion request was repeated."
          }
        });
      }
    } catch {
      markUncertain({
        tone: "WARNING",
        text: "Apply Pilot could not verify whether the attestation was recorded. Refresh personal-submission status before deciding whether to act again."
      });
    }
  }, [runId, updateReviewLoad]);

  const openPersonalSubmissionConfirmation = useCallback(() => {
    const expectedGeneration = activeComponentGenerationRef.current;
    const current = reviewLoadRef.current;
    const currentRun = current.run;
    if (
      expectedGeneration === null ||
      personalSubmissionCompletionPendingRef.current ||
      !isPersonalSubmissionCompletionEligible({
        authenticatedOwnerPage,
        componentActive: true,
        run: currentRun,
        runVerified: current.runVerified,
        completionPending: false
      }) ||
      currentRun === null ||
      (currentRun.state !== "READY" && currentRun.state !== "READY_FOR_USER_SUBMISSION")
    ) return;

    personalSubmissionConfirmationIntentRef.current = {
      componentGeneration: expectedGeneration,
      reviewRequestId: reviewRequestSequenceRef.current,
      runId: currentRun.id,
      runState: currentRun.state,
      runStateVersion: currentRun.stateVersion
    };
    setPersonalSubmissionCompletion((currentCompletion) => ({
      phase: "confirming",
      notice: currentCompletion.notice
    }));
  }, [authenticatedOwnerPage]);

  const completeApplicationRunByUserFromControl = useCallback(async (
    confirmationIntent: PersonalSubmissionConfirmationIntent
  ) => {
    const expectedGeneration = activeComponentGenerationRef.current;
    const current = reviewLoadRef.current;
    const currentRun = current.run;
    if (
      expectedGeneration === null ||
      personalSubmissionConfirmationIntentRef.current !== confirmationIntent ||
      confirmationIntent.componentGeneration !== expectedGeneration ||
      confirmationIntent.reviewRequestId !== reviewRequestSequenceRef.current ||
      currentRun === null ||
      currentRun.id !== confirmationIntent.runId ||
      currentRun.state !== confirmationIntent.runState ||
      currentRun.stateVersion !== confirmationIntent.runStateVersion ||
      personalSubmissionCompletionPendingRef.current ||
      !isPersonalSubmissionCompletionEligible({
        authenticatedOwnerPage,
        componentActive: true,
        run: currentRun,
        runVerified: current.runVerified,
        completionPending: false
      })
    ) return;

    personalSubmissionCompletionPendingRef.current = true;
    personalSubmissionConfirmationIntentRef.current = null;
    invalidateReviewAuthority();
    updateReviewLoad((loaded) => ({
      ...loaded,
      phase: loaded.phase === "loading" ? "error" : loaded.phase,
      unverified: true
    }));
    setPersonalSubmissionCompletion({ phase: "pending", notice: null });
    const active = () => activeComponentGenerationRef.current === expectedGeneration;

    try {
      const request = buildCompleteApplicationRunByUserRequest({ runId });
      const response = await fetch(request.url, request.init);
      if (!active()) return;
      if (!response.ok) {
        await reconcilePersonalSubmissionCompletion(expectedGeneration);
        return;
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        await reconcilePersonalSubmissionCompletion(expectedGeneration);
        return;
      }
      if (!active()) return;

      let completion: PersonalSubmissionCompletionAuthority;
      try {
        completion = parseCompleteApplicationRunByUserResponse(value, runId);
      } catch {
        await reconcilePersonalSubmissionCompletion(expectedGeneration);
        return;
      }
      if (!active()) return;

      const completionRun: ReviewRunAuthority = {
        id: completion.id,
        state: completion.state,
        stateVersion: completion.stateVersion,
        completedAt: completion.completedAt,
        reviewReasons: reviewLoadRef.current.run?.id === completion.id
          ? reviewLoadRef.current.run.reviewReasons
          : []
      };
      const runReconciliation = reconcileReviewRunAuthority({
        current: reviewLoadRef.current.run,
        incoming: completionRun
      });
      const runNotice = reviewRunReconciliationNotice(runReconciliation.decision);
      updateReviewLoad((loaded) => ({
        ...loaded,
        phase: runNotice === null ? loaded.phase : "error",
        run: runReconciliation.run,
        runVerified: runReconciliation.verified,
        unverified: true,
        notice: runNotice ?? loaded.notice
      }));
      if (!runReconciliation.verified || runReconciliation.run.state !== "COMPLETED_BY_USER") {
        await reconcilePersonalSubmissionCompletion(expectedGeneration);
        return;
      }
      setPersonalSubmissionCompletion({
        phase: "confirmed",
        notice: {
          tone: "SUCCESS",
          text: "Personal submission is recorded from your explicit attestation."
        }
      });
    } catch {
      if (active()) await reconcilePersonalSubmissionCompletion(expectedGeneration);
    } finally {
      personalSubmissionCompletionPendingRef.current = false;
      if (active()) {
        setPersonalSubmissionCompletion((currentCompletion) =>
          currentCompletion.phase === "pending"
            ? {
                phase: "uncertain",
                notice: {
                  tone: "WARNING",
                  text: "Apply Pilot could not verify whether the attestation was recorded. Refresh personal-submission status before deciding whether to act again."
                }
              }
            : currentCompletion
        );
      }
    }
  }, [authenticatedOwnerPage, invalidateReviewAuthority, reconcilePersonalSubmissionCompletion, runId, updateReviewLoad]);

  useEffect(() => {
    const generation = componentGenerationRef.current + 1;
    componentGenerationRef.current = generation;
    activeComponentGenerationRef.current = generation;
    void fetchReviewAuthority(generation);
    void fetchFillStatus(generation);
    return () => {
      if (activeComponentGenerationRef.current === generation) {
        activeComponentGenerationRef.current = null;
      }
      componentGenerationRef.current += 1;
      pendingCommandRef.current = null;
      pendingReviewMutationRef.current = null;
      personalSubmissionConfirmationIntentRef.current = null;
      mutationAbortControllerRef.current?.abort();
      mutationAbortControllerRef.current = null;
      reviewRequestSequenceRef.current += 1;
      reviewAbortControllerRef.current?.abort();
      fillStatusRequestSequenceRef.current += 1;
      fillStatusAbortControllerRef.current?.abort();
    };
  }, [fetchFillStatus, fetchReviewAuthority]);

  // Wrong-window guard (redesign UX-1). Reads a window property only; sends nothing.
  useEffect(() => {
    if (!detectCompanionWindow || companionWindow !== "checking") return;
    const startedAt = Date.now();
    const settled = () => {
      if (hasCompanionBinding()) {
        setCompanionWindow("present");
        return true;
      }
      if (Date.now() - startedAt >= companionWindowWaitMs) {
        setCompanionWindow("absent");
        return true;
      }
      return false;
    };
    let interval: number | undefined;
    const first = window.setTimeout(() => {
      if (settled()) return;
      interval = window.setInterval(() => {
        if (settled()) window.clearInterval(interval);
      }, Math.max(10, Math.min(COMPANION_WINDOW_POLL_MS, companionWindowWaitMs)));
    }, 0);
    return () => {
      window.clearTimeout(first);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [companionWindow, companionWindowWaitMs, detectCompanionWindow]);

  // Inside the Apply Pilot browser, read its status once instead of asking for a click.
  // GET_STATUS is read-only and payload-free.
  const invokeRef = useRef(invoke);
  useEffect(() => {
    invokeRef.current = invoke;
  }, [invoke]);
  const automaticStatusReadRef = useRef(false);
  useEffect(() => {
    if (!detectCompanionWindow || companionWindow !== "present" || automaticStatusReadRef.current) return;
    automaticStatusReadRef.current = true;
    void invokeRef.current({ type: "GET_STATUS" });
    return () => {
      automaticStatusReadRef.current = false;
    };
  }, [companionWindow, detectCompanionWindow]);

  // Remembers that the form was handed over on this page, so a later safe stop or ended session
  // still leads to step 8 (Record it). Presentation only.
  const [formHandedOver, setFormHandedOver] = useState(false);
  const formHandedOverNow = hasAcceptedAuthoritativeStatus &&
    (status.state === "HANDOFF_PENDING" || status.state === "HUMAN_ONLY");
  if (formHandedOverNow && !formHandedOver) setFormHandedOver(true);

  const availability = browserCommandAvailability({ status, connection: controlConnection, pendingCommand });
  const freshness = useMemo(() => derivePacketFreshness({
    packet: reviewLoad.packet,
    latestPacketResponseWasNull: reviewLoad.latestResponseWasNull,
    packetLoadUnverified: reviewLoad.unverified,
    connection: controlConnection,
    workflowState: status.state,
    lastAcceptedInspection,
    formInvalidatedSinceVerifiedSuccess
  }), [controlConnection, formInvalidatedSinceVerifiedSuccess, lastAcceptedInspection, reviewLoad, status.state]);
  const resolveReviewEligible = isResolveReviewEligible({
    run: reviewLoad.run,
    packet: reviewLoad.packet,
    trusted: reviewLoad.phase === "loaded" && !reviewLoad.unverified
  });
  // The one approval click (D-H): trusted answers still waiting for review. Every request it sends
  // is still checked by isAnswerReviewMutationEligible and isResolveReviewEligible.
  const approveAndContinueEligible = reviewLoad.phase === "loaded" &&
    !reviewLoad.unverified &&
    reviewLoad.run?.state === "REVIEW_REQUIRED" &&
    reviewLoad.packet !== null &&
    (resolveReviewEligible || reviewLoad.packet.answers.some((answer) => isAnswerReviewEligible(answer)));
  const personalSubmissionCompletionPending = personalSubmissionCompletion.phase === "pending";
  const personalSubmissionRunVerified = reviewLoad.runVerified;
  const personalSubmissionCompletionEligible = isPersonalSubmissionCompletionEligible({
    authenticatedOwnerPage,
    componentActive: true,
    run: reviewLoad.run,
    runVerified: personalSubmissionRunVerified,
    completionPending: personalSubmissionCompletionPending
  });
  const personalSubmissionConfirmationIntent = personalSubmissionConfirmationIntentRef.current;
  const personalSubmissionRecorded =
    reviewLoad.run?.state === "COMPLETED_BY_USER" && reviewLoad.run.completedAt !== null;
  const showPersonalSubmissionSection =
    personalSubmissionRecorded ||
    personalSubmissionCompletionEligible ||
    personalSubmissionCompletion.phase !== "idle";
  const apparentEligibleCount = apparentAutomatableFieldCount(reviewLoad.packet);
  const manualFields = deriveManualFieldPresentations(reviewLoad.packet);
  const storedFillPresentation = fillStatusLoad.status === null
    ? null
    : fillStatusPresentation(fillStatusLoad.status);
  const fillPresentation = storedFillPresentation?.category === "NO_ATTEMPT" &&
      fillMayHaveDispatched &&
      !fillStatusLoad.verified
    ? null
    : storedFillPresentation;
  const fillStatusPendingCopy = pendingFillActivation
    ? "Fill command is pending. Durable Fill status will be checked after the command settles."
    : fillMayHaveDispatched && !fillStatusLoad.verified
      ? "Durable Fill status is unverified. Do not start Fill again; use Refresh Fill status only for a read-only update."
      : "Fill status has not been verified yet.";
  const stoppedErrorCopy = fillStatusLoad.status === null
    ? null
    : stoppedFillErrorDescription(fillStatusLoad.status.errorCode);
  const fillActivationEligible = isFillActivationEligible({
    authenticatedOwnerPage,
    componentActive: true,
    connection: controlConnection,
    hasAcceptedAuthoritativeStatus,
    browserStatus: status,
    packetFreshness: freshness,
    reviewLoad: {
      phase: reviewLoad.phase,
      verified: !reviewLoad.unverified,
      run: reviewLoad.run,
      packet: reviewLoad.packet
    },
    fillStatusLoad,
    pendingBrowserCommand: pendingCommand,
    pendingReviewMutation,
    pendingFillActivation,
    fillMayHaveDispatched
  });
  const fillUiLocked = pendingFillActivation || personalSubmissionCompletionPending;
  const handoffEligible = status.state === "TARGET_OPEN" &&
    fillStatusLoad.verified && fillStatusLoad.status !== null &&
    !fillStatusLoad.status.leaseLive && !fillStatusLoad.status.expiredRecoveryRequired &&
    status.fillCommand?.outcome !== "IN_PROGRESS" && status.fillCommand?.outcome !== "RECOVERY_PENDING" &&
    !pendingFillActivation && pendingCommand === null && pendingReviewMutation === null;
  const humanMinutesRemaining = status.humanSession
    ? Math.max(0, Math.ceil((status.humanSession.expiresAtMs - humanClockMs) / 60_000))
    : null;

  // Which step is "now", its one primary action and why anything is disabled. It only reads the
  // gates above; it never widens them.
  const view = deriveControlSteps({
    companion: {
      hasStatus: hasAcceptedAuthoritativeStatus,
      connection: controlConnection,
      state: status.state,
      errorCode: status.errorCode ?? null,
      inspection: status.inspection ?? null,
      formInvalidated: formInvalidatedSinceVerifiedSuccess,
      fillCommand: status.fillCommand ?? null,
      handedOverEarlier: formHandedOver || formHandedOverNow,
      humanMinutesRemaining,
      canOpenTarget: availability.OPEN_TARGET,
      canInspectForm: availability.INSPECT_FORM,
      canHandOff: availability.HANDOFF_TO_HUMAN,
      pendingCommand
    },
    review: {
      phase: reviewLoad.phase,
      verified: !reviewLoad.unverified,
      runState: reviewLoad.run?.state ?? null,
      packet: reviewLoad.packet === null ? null : {
        inspectionVersion: reviewLoad.packet.inspectionVersion,
        answerPacketVersion: reviewLoad.packet.answerPacketVersion,
        reviewedAt: reviewLoad.packet.reviewedAt,
        fieldCount: reviewLoad.packet.summary.fieldCount,
        proposableCount: reviewLoad.packet.summary.proposableCount,
        pendingReviewCount: reviewLoad.packet.summary.pendingReviewCount,
        readyForRunResolution: reviewLoad.packet.summary.readyForRunResolution
      },
      pendingMutation: pendingReviewMutation !== null || approvalPending,
      approving: approvalPending,
      approveEligible: approveAndContinueEligible
    },
    fill: {
      phase: fillStatusLoad.phase,
      verified: fillStatusLoad.verified,
      category: storedFillPresentation?.category ?? null,
      fillableCount: apparentEligibleCount,
      activationEligible: fillActivationEligible,
      acknowledged: transmissionAcknowledged,
      pendingActivation: pendingFillActivation,
      mayHaveDispatched: fillMayHaveDispatched,
      packetCurrent: freshness === "current"
    },
    handoff: { eligible: handoffEligible, confirming: handoffConfirming },
    record: {
      eligible: personalSubmissionCompletionEligible,
      recorded: personalSubmissionRecorded,
      phase: personalSubmissionCompletion.phase,
      runVerified: personalSubmissionRunVerified
    },
    uiLocked: fillUiLocked
  });

  const pageTitle = controlPageTitle(view, hasAcceptedAuthoritativeStatus);
  useEffect(() => {
    if (!detectCompanionWindow || companionWindow !== "present") return;
    const previousTitle = document.title;
    document.title = pageTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [companionWindow, detectCompanionWindow, pageTitle]);

  // While the employer's form is opening, open or handed over, leaving or reloading this page
  // closes it, so the browser asks first.
  const warnBeforeLeaving = shouldWarnBeforeLeaving({
    hasStatus: hasAcceptedAuthoritativeStatus,
    state: status.state
  });
  useEffect(() => {
    if (!warnBeforeLeaving) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [warnBeforeLeaving]);

  const recordPhase = personalSubmissionCompletion.phase;
  const recordEntryIsPrimary = view.primary?.action === "RECORD";
  const recordEntryAvailable = !personalSubmissionRecorded &&
    personalSubmissionCompletionEligible &&
    recordPhase !== "confirming";
  const recordBody = (inStepper: boolean) => <RecordStepBody
    show={showPersonalSubmissionSection || (inStepper && recordEntryIsPrimary && view.recordEntryStep === 8)}
    recorded={personalSubmissionRecorded}
    recordedAt={reviewLoad.run?.completedAt ?? null}
    phase={recordPhase}
    notice={personalSubmissionCompletion.notice}
    showEntry={inStepper
      ? view.recordEntryStep === 8 && (recordEntryAvailable || recordEntryIsPrimary)
      : recordEntryAvailable}
    entryPrimary={inStepper && recordEntryIsPrimary && view.recordEntryStep === 8}
    entryState={view.actions.RECORD}
    confirmPrimary={inStepper && view.primary?.action === "CONFIRM_RECORD"}
    confirmState={view.actions.CONFIRM_RECORD}
    showCheck={!personalSubmissionRecorded && recordPhase === "uncertain" && !personalSubmissionRunVerified}
    checkPrimary={inStepper && view.primary?.action === "CHECK_RECORD"}
    checkState={view.actions.CHECK_RECORD}
    onEntry={openPersonalSubmissionConfirmation}
    onConfirm={() => {
      if (personalSubmissionConfirmationIntent !== null) {
        void completeApplicationRunByUserFromControl(personalSubmissionConfirmationIntent);
      }
    }}
    onCancel={() => {
      if (personalSubmissionConfirmationIntent !== null) {
        cancelPersonalSubmissionConfirmation(personalSubmissionConfirmationIntent);
      }
    }}
    onCheck={() => {
      const generation = activeComponentGenerationRef.current;
      if (generation !== null) void reconcilePersonalSubmissionCompletion(generation);
    }}
  />;

  if (detectCompanionWindow && companionWindow !== "present") {
    return (
      <div className="space-y-5 p-5">
        {companionWindow === "checking" ? (
          <p role="status" className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">Connecting to the Apply Pilot browser…</p>
        ) : (
          <section data-testid="wrong-window" aria-labelledby="wrong-window-heading" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <h2 id="wrong-window-heading" className="text-base font-semibold">This page only works inside the Apply Pilot browser</h2>
            <p>You&apos;re in your usual browser. Opening, checking and filling the employer&apos;s form happen in the separate window titled &ldquo;Apply Pilot browser&rdquo;.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Can&apos;t find it? Look for &ldquo;Google Chrome for Testing&rdquo; in the Dock, or on your other desktops.</li>
              <li>Not started yet? Start the Apply Pilot browser from Terminal, then sign it in with a one-time code from this job&apos;s application page.</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              {applicationHref ? <a href={applicationHref} className="inline-flex items-center rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white">Back to the application</a> : null}
              <SecondaryButton type="button" onClick={() => setCompanionWindow("checking")}>Check again</SecondaryButton>
            </div>
          </section>
        )}
        {companionWindow === "absent" && showPersonalSubmissionSection ? (
          <section aria-labelledby="record-heading" className="space-y-3 rounded-lg border border-slate-200 p-4">
            <h2 id="record-heading" className="font-semibold text-slate-950">Record it</h2>
            {recordBody(false)}
          </section>
        ) : null}
      </div>
    );
  }

  const moreActions: MoreAction[] = [
    {
      key: "refresh-status",
      label: "Refresh status",
      disabled: fillUiLocked || !availability.GET_STATUS,
      onClick: () => void invoke({ type: "GET_STATUS" })
    },
    ...(!fillUiLocked && shouldOfferRetryConnection(controlConnection, status, pendingCommand) ? [{
      key: "retry-connection",
      label: "Retry connection",
      disabled: false,
      onClick: () => void invoke({ type: "GET_STATUS" })
    }] : []),
    ...(hasAcceptedAuthoritativeStatus && status.state === "TARGET_OPEN" && view.primary?.action !== "READ_FORM" ? [{
      key: "read-again",
      label: "Read the form again",
      disabled: !view.actions.READ_FORM.enabled,
      onClick: () => void invoke({ type: "INSPECT_FORM" })
    }] : []),
    {
      key: "refresh-review",
      label: reviewLoad.phase === "loading" ? "Refreshing…" : "Refresh review data",
      disabled: fillUiLocked || reviewLoad.phase === "loading" || pendingReviewMutation !== null || approvalPending,
      onClick: () => {
        if (
          !pendingFillActivationRef.current &&
          !personalSubmissionCompletionPendingRef.current &&
          !approvalPendingRef.current
        ) void fetchReviewAuthority();
      }
    },
    {
      key: "refresh-fill",
      label: fillStatusLoad.phase === "loading" ? "Refreshing Fill status…" : "Refresh Fill status",
      disabled: fillUiLocked || pendingCommand !== null || pendingReviewMutation !== null || approvalPending || fillStatusLoad.phase === "loading",
      onClick: () => {
        if (!pendingFillActivationRef.current) void fetchFillStatus();
      }
    },
    {
      key: "close-workflow",
      label: "Close workflow",
      disabled: fillUiLocked || !availability.CLOSE_WORKFLOW,
      onClick: () => void invoke({ type: "CLOSE_WORKFLOW" })
    }
  ];

  const ambiguousQuestionCount = reviewLoad.packet?.summary.ambiguousQuestionCount ?? 0;

  return (
    <div className="space-y-5 p-5">
      {detectCompanionWindow ? (
        <p data-testid="apply-pilot-browser-banner" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white">
          Apply Pilot browser <span className="font-normal">· this window opens, checks and fills the employer&apos;s form</span>
        </p>
      ) : null}
      <p data-testid="companion-status" className="text-sm font-medium text-slate-950">
        {companionStatusSentence(status, controlConnection, hasAcceptedAuthoritativeStatus)}
      </p>

      <div className="space-y-2">
        {controlConnection === "UNAVAILABLE" ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{hasAcceptedAuthoritativeStatus ? "The local companion connection is unavailable. The last accepted browser status is preserved." : "The local companion connection is unavailable. No companion status received."}</p> : null}
        {commandNotice ? <p className={`rounded-lg px-3 py-2 text-sm ${noticeClass(commandNotice.tone)}`}>{commandNotice.text}</p> : null}
        <Notice notice={reviewLoad.notice} />
        <Notice notice={approvalNotice} />
        <Notice notice={fillStatusLoad.notice} />
      </div>

      {view.finished === "STOPPED" && view.current === null ? <StoppedCard view={view} /> : null}

      <div data-testid="control-steps" className="space-y-3">
        <StepSection step={4} view={view} summary={stepSummary(4, view.progress[4])}>
          <OpenFormStepBody
            view={view}
            formRead={view.progress[4] === "done"}
            onOpenAndRead={() => void openAndReadForm()}
            onReadForm={() => void invoke({ type: "INSPECT_FORM" })}
          />
        </StepSection>

        <StepSection step={5} view={view} summary={stepSummary(5, view.progress[5])}>
          <CheckAnswersStepBody
            view={view}
            packet={reviewLoad.packet}
            run={reviewLoad.run}
            freshness={freshness}
            approving={approvalPending}
            isTickLocked={(answer) => fillUiLocked ||
              approvalPending ||
              pendingReviewMutation !== null ||
              reviewLoad.phase !== "loaded" ||
              reviewLoad.unverified ||
              reviewLoad.packet?.answers.find((entry) => entry.id === answer.id) !== answer ||
              !isAnswerReviewMutationEligible({ answer, run: reviewLoad.run, trusted: true })}
            onApproveAndContinue={(displayed, ticked) => void approveAndContinue(displayed, ticked)}
          />
        </StepSection>

        <StepSection step={6} view={view} summary={stepSummary(6, view.progress[6])}>
          <FillStepBody
            view={view}
            manualFields={manualFields}
            fillableCount={apparentEligibleCount}
            ambiguousQuestionCount={ambiguousQuestionCount}
            acknowledged={transmissionAcknowledged}
            onAcknowledge={(checked) => {
              transmissionAcknowledgedRef.current = checked;
              setTransmissionAcknowledged(checked);
            }}
            onFill={() => void activateFill()}
            fillStatusBlock={<FillStatusBlock
              presentation={fillPresentation}
              pendingCopy={fillStatusPendingCopy}
              stoppedErrorCopy={stoppedErrorCopy}
              hasSteps={fillStatusLoad.status !== null && fillStatusLoad.status.steps.length > 0}
              ambiguousQuestionCount={ambiguousQuestionCount}
              packetAvailable={reviewLoad.packet !== null}
            />}
          />
        </StepSection>

        <StepSection step={7} view={view} summary={stepSummary(7, view.progress[7])}>
          <FinishStepBody
            view={view}
            workflowState={status.state === "TARGET_OPEN" ? "TARGET_OPEN" : status.state === "HUMAN_ONLY" ? "HANDED_OVER" : "OTHER"}
            handoffConfirming={handoffConfirming}
            fillResultTitle={fillPresentation && fillPresentation.category !== "NO_ATTEMPT" ? fillPresentation.title : null}
            humanMinutesRemaining={humanMinutesRemaining}
            manualFields={manualFields}
            canEndSession={availability.END_HUMAN_SESSION && !fillUiLocked}
            onUnlock={() => setHandoffConfirming(true)}
            onConfirmUnlock={() => {
              setHandoffConfirming(false);
              void invoke({ type: "HANDOFF_TO_HUMAN" });
            }}
            onCancelUnlock={() => setHandoffConfirming(false)}
            onEndSession={() => void invoke({ type: "END_HUMAN_SESSION" })}
            recordEntry={view.recordEntryStep === 7
              ? <StepActionButton action="RECORD" state={view.actions.RECORD} primary={recordEntryIsPrimary} onClick={openPersonalSubmissionConfirmation} />
              : null}
          />
        </StepSection>

        <StepSection step={8} view={view} summary={stepSummary(8, view.progress[8])}>
          {recordBody(true)}
        </StepSection>
      </div>

      <MoreActions actions={moreActions} />

      <details data-technical className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-slate-600">Details (for troubleshooting)</summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs font-semibold uppercase text-slate-500">Workflow state</dt><dd className="mt-1 font-medium text-slate-950">{hasAcceptedAuthoritativeStatus ? status.state : "Awaiting companion status"}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">Local connection</dt><dd className="mt-1 font-medium text-slate-950">{controlConnection}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">Application</dt><dd className="mt-1 text-slate-800">{reviewLoad.run ? `${runStateLabel(reviewLoad.run.state)} (${reviewLoad.run.state})` : "Not loaded"}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">Run ID</dt><dd className="mt-1 break-all font-mono text-xs text-slate-800">{runId}</dd></div>
          {status.targetHost ? <div><dt className="text-xs font-semibold uppercase text-slate-500">Target host</dt><dd className="mt-1 text-slate-800">{status.targetHost}</dd></div> : null}
          {status.errorCode ? <div><dt className="text-xs font-semibold uppercase text-slate-500">Safe stop code</dt><dd className="mt-1 font-mono text-xs text-rose-700">{status.errorCode}</dd></div> : null}
        </dl>
      </details>

      <p className="text-xs leading-5 text-slate-500">Apply Pilot only types answers you approved, only when you press Fill, and only once. It doesn&apos;t upload documents, click the employer&apos;s buttons or press Submit. Check every field on the employer&apos;s form, finish what&apos;s left, and press the employer&apos;s Submit button yourself.</p>
    </div>
  );
}
