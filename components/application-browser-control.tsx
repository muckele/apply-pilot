"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import {
  applyAuthoritativeBrowserStatus,
  apparentAutomatableFieldCount,
  bindingRejectionPlan,
  browserCommandAvailability,
  buildAnswerReviewRequest,
  buildResolveReviewRequest,
  derivePacketFreshness,
  deriveManualFieldPresentations,
  dispositionMessage,
  isAnswerReviewEligible,
  isAnswerReviewPostconditionCurrent,
  isAnswerReviewMutationEligible,
  isFillActivationEligible,
  isResolveReviewEligible,
  isResolveReviewPostconditionCurrent,
  parseApplicationRunReviewResponse,
  parseAnswerPacketResponse,
  parseAnswerReviewResponse,
  presentProposal,
  REVIEW_REASON_LABELS,
  readinessMessage,
  shouldOfferRetryConnection,
  type AnswerReviewMutationSnapshot,
  type AnswerPacket,
  type CommandNotice,
  type ControlConnection,
  type PacketFreshness,
  type PendingReviewMutation,
  type PendingBrowserCommand,
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
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status,
  type B2InspectionCommandStatus
} from "@/lib/application-browser/types";

type ControlWindow = Window & {
  [APPLICATION_BROWSER_BINDING_NAME]?: (command: B1Command) => Promise<B1Status>;
};

type ReviewLoad = {
  phase: "idle" | "loading" | "loaded" | "error";
  run: import("@/lib/application-browser/control-presentation").ReviewRunAuthority | null;
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

const initialReviewLoad: ReviewLoad = {
  phase: "idle",
  run: null,
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

function noticeClass(tone: CommandNotice["tone"]): string {
  if (tone === "SUCCESS") return "bg-emerald-50 text-emerald-800";
  if (tone === "WARNING") return "bg-amber-50 text-amber-900";
  if (tone === "ERROR") return "bg-rose-50 text-rose-800";
  return "bg-sky-50 text-sky-800";
}

function freshnessCopy(freshness: PacketFreshness): { className: string; text: string } {
  if (freshness === "current") {
    return {
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      text: "Current packet — versions match the latest verified employer-form inspection in this session."
    };
  }
  if (freshness === "stale") {
    return {
      className: "border-amber-300 bg-amber-50 text-amber-950",
      text: "Stale packet — the employer form changed. Inspect the form again before relying on these answers."
    };
  }
  if (freshness === "unverified") {
    return {
      className: "border-slate-300 bg-slate-100 text-slate-800",
      text: "Unverified packet — these answers have not been matched to a current successful inspection in this control-page session."
    };
  }
  return {
    className: "border-slate-200 bg-slate-50 text-slate-700",
    text: "No current answer packet is available for this application run."
  };
}

function displayDate(value: string | null): string {
  return value === null ? "Not acknowledged" : new Date(value).toLocaleString();
}

export function ApplicationBrowserControl({
  runId,
  authenticatedOwnerPage
}: {
  runId: string;
  authenticatedOwnerPage: boolean;
}) {
  const [status, setStatus] = useState<B1Status>({ state: "STARTING", runId });
  const [controlConnection, setControlConnection] = useState<ControlConnection>("UNKNOWN");
  const [hasAcceptedAuthoritativeStatus, setHasAcceptedAuthoritativeStatus] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingBrowserCommand>(null);
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>({
    tone: "INFO",
    text: "Start the local companion, then refresh status."
  });
  const [reviewLoad, setReviewLoad] = useState<ReviewLoad>(initialReviewLoad);
  const [fillStatusLoad, setFillStatusLoad] = useState<FillStatusLoad>(initialFillStatusLoad);
  const [pendingReviewMutation, setPendingReviewMutation] = useState<PendingReviewMutation>(null);
  const [pendingFillActivation, setPendingFillActivation] = useState(false);
  const [fillMayHaveDispatched, setFillMayHaveDispatched] = useState(false);
  const [lastAcceptedInspection, setLastAcceptedInspection] = useState<B2InspectionCommandStatus | null>(null);
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
  const pendingFillActivationRef = useRef(false);
  const fillMayHaveDispatchedRef = useRef(false);
  const mutationAbortControllerRef = useRef<AbortController | null>(null);
  const lastAutoRefreshAttemptKeyRef = useRef<string | null>(null);
  const componentGenerationRef = useRef(0);
  const activeComponentGenerationRef = useRef<number | null>(null);

  const updateReviewLoad = useCallback((update: (current: ReviewLoad) => ReviewLoad) => {
    const next = update(reviewLoadRef.current);
    reviewLoadRef.current = next;
    setReviewLoad(next);
  }, []);

  const updateFillStatusLoad = useCallback((update: (current: FillStatusLoad) => FillStatusLoad) => {
    const next = update(fillStatusLoadRef.current);
    fillStatusLoadRef.current = next;
    setFillStatusLoad(next);
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

    updateReviewLoad((current) => ({ ...current, phase: "loading", unverified: true, notice: null }));
    const fail = (notice: CommandNotice, clear = false): ReviewAuthorityRefreshResult => {
      const result = resultForInactiveOrSuperseded();
      if (result !== null) return result;
      updateReviewLoad((current) => clear
        ? { phase: "error", run: null, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...current, phase: "error", unverified: true, notice }
      );
      return { outcome: "FAILED" };
    };
    try {
      const [runResult, packetResult] = await Promise.allSettled([
        fetch(`/api/application-runs/${encodeURIComponent(runId)}`, { cache: "no-store", signal: controller.signal }),
        fetch(`/api/application-runs/${encodeURIComponent(runId)}/answer-packet`, { cache: "no-store", signal: controller.signal })
      ]);
      const afterResponses = resultForInactiveOrSuperseded();
      if (afterResponses !== null) return afterResponses;
      const runResponse = runResult.status === "fulfilled" ? runResult.value : null;
      const packetResponse = packetResult.status === "fulfilled" ? packetResult.value : null;
      const fulfilledResponses = [runResponse, packetResponse].filter((response): response is Response => response !== null);
      const authFailure = fulfilledResponses.find((response) =>
        !response.ok && (response.status === 401 || response.status === 403 || response.status === 404)
      );
      if (authFailure !== undefined) {
        if (authFailure.status === 401) return fail({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to read review data." }, true);
        if (authFailure.status === 403) return fail({ tone: "ERROR", text: "You are not authorized to read review data for this application run." }, true);
        return fail({ tone: "ERROR", text: "This application run or answer packet is unavailable." }, true);
      }
      if (runResponse === null || packetResponse === null) {
        return fail({ tone: "ERROR", text: "Apply Pilot could not reach the review authority service. Refresh review data before another action." });
      }
      const failedResponses = [runResponse, packetResponse].filter((response) => !response.ok);
      const failedResponse = failedResponses[0] ?? null;
      if (failedResponse !== null) {
        const status = failedResponse.status;
        if (status === 401) return fail({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to read review data." }, true);
        if (status === 403) return fail({ tone: "ERROR", text: "You are not authorized to read review data for this application run." }, true);
        if (status === 404) return fail({ tone: "ERROR", text: "This application run or answer packet is unavailable." }, true);
        if (status === 429) return fail({ tone: "WARNING", text: "Review data reads are temporarily limited. Wait a moment, then refresh review data." });
        return fail({ tone: "ERROR", text: "Review data is temporarily unavailable. Refresh review data before another action." });
      }
      let runValue: unknown;
      let packetValue: unknown;
      try {
        [runValue, packetValue] = await Promise.all([runResponse.json(), packetResponse.json()]);
      } catch {
        return fail({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
      const afterJson = resultForInactiveOrSuperseded();
      if (afterJson !== null) return afterJson;
      try {
        const run = parseApplicationRunReviewResponse(runValue, runId);
        const packet = parseAnswerPacketResponse(packetValue, runId).current;
        const afterParse = resultForInactiveOrSuperseded();
        if (afterParse !== null) return afterParse;
        updateReviewLoad(() => ({
          phase: "loaded",
          run,
          packet,
          latestResponseWasNull: packet === null,
          unverified: false,
          notice: packet === null ? { tone: "INFO", text: "No current answer packet has been published yet." } : null
        }));
        return { outcome: "COMMITTED" };
      } catch {
        return fail({ tone: "ERROR", text: "Apply Pilot could not safely read the review authority response." });
      }
    } catch {
      return fail({ tone: "ERROR", text: "Apply Pilot could not reach the review authority service. Refresh review data before another action." });
    }
  }, [runId, updateReviewLoad]);

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
  }, [fetchFillStatus, fetchReviewAuthority, runId]);

  const invoke = useCallback(async (
    command: Exclude<B1Command, { type: "FILL_APPROVED_FIELDS" }>
  ) => {
    if (pendingCommandRef.current !== null || pendingFillActivationRef.current) return;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return;
    pendingCommandRef.current = command.type;
    setPendingCommand(command.type);
    setCommandNotice(null);
    try {
      const binding = (window as ControlWindow)[APPLICATION_BROWSER_BINDING_NAME];
      if (typeof binding !== "function") {
        if (activeComponentGenerationRef.current !== expectedGeneration) return;
        setControlConnection("UNAVAILABLE");
        setCommandNotice({ tone: "WARNING", text: "Local browser companion is not connected to this control page." });
        return;
      }

      try {
        const nextStatus = await binding(command);
        if (activeComponentGenerationRef.current !== expectedGeneration) return;
        const accepted = acceptAuthoritativeStatus(nextStatus, expectedGeneration);
        if (!accepted.active) return;
        if (!accepted.accepted) {
          setCommandNotice({
            tone: "WARNING",
            text: "The local browser companion returned a status that could not be accepted for this run."
          });
          return;
        }
        if (!accepted.suppliedNotice) {
          const text = command.type === "OPEN_TARGET"
            ? "Frozen employer target opened."
            : command.type === "CLOSE_WORKFLOW"
              ? "Browser workflow status updated."
              : command.type === "INSPECT_FORM"
                ? "Inspection status updated."
                : "Browser status updated.";
          setCommandNotice({ tone: "INFO", text });
        }
      } catch {
        if (activeComponentGenerationRef.current !== expectedGeneration) return;
        const freshness = derivePacketFreshness({
          packet: reviewLoadRef.current.packet,
          latestPacketResponseWasNull: reviewLoadRef.current.latestResponseWasNull,
          packetLoadUnverified: reviewLoadRef.current.unverified,
          connection: controlConnection,
          workflowState: statusRef.current.state,
          lastAcceptedInspection,
          formInvalidatedSinceVerifiedSuccess: formInvalidatedRef.current
        });
        const plan = bindingRejectionPlan(command.type, statusRef.current, freshness);
        const text = command.type === "GET_STATUS"
          ? "The local browser connection could not be refreshed. Retry the connection."
          : command.type === "OPEN_TARGET"
            ? "The target-open command stopped safely. Browser status was checked once."
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
          return;
        }
        try {
          const recoveredStatus = await binding({ type: "GET_STATUS" });
          if (activeComponentGenerationRef.current !== expectedGeneration) return;
          const recovered = acceptAuthoritativeStatus(recoveredStatus, expectedGeneration);
          if (!recovered.active) return;
          if (!recovered.accepted) setControlConnection("UNAVAILABLE");
        } catch {
          if (activeComponentGenerationRef.current !== expectedGeneration) return;
          setControlConnection("UNAVAILABLE");
        }
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
  }, [acceptAuthoritativeStatus, controlConnection, invalidateReviewAuthority, lastAcceptedInspection, updateReviewLoad]);

  const activateFill = useCallback(async () => {
    if (
      pendingCommandRef.current !== null ||
      pendingFillActivationRef.current ||
      fillMayHaveDispatchedRef.current
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
        setCommandNotice(commandStatus.errorCode === "FILL_NO_ELIGIBLE_FIELDS"
          ? {
              tone: "WARNING",
              text: "No approved automatable fields remained when Fill authority was checked. Complete the employer form manually. Fill was not retried."
            }
          : {
              tone: "WARNING",
              text: "Fill was not started because current trusted authority rejected the request. Review the current run and complete the employer form manually if needed."
            });
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
    updateReviewLoad
  ]);

  const reviewAnswer = useCallback(async (
    answer: AnswerPacket["answers"][number],
    status: "APPROVED" | "REJECTED"
  ) => {
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
    ) return;
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return;

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
        ? { phase: "error", run: null, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...loaded, phase: "error", unverified: true, notice }
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
      if (!active()) return;
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
        return;
      }
      if (!response.ok) {
        if (response.status === 401) markUnverified({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to review answers." }, true);
        else if (response.status === 403) markUnverified({ tone: "ERROR", text: "You are not authorized to review this answer." }, true);
        else if (response.status === 404) markUnverified({ tone: "ERROR", text: "This application run or answer is unavailable." }, true);
        else if (response.status === 429) markUnverified({ tone: "WARNING", text: "Review actions are temporarily limited. Wait before refreshing review data." });
        else markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
        return;
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return;
      }
      if (!active()) return;
      try {
        parseAnswerReviewResponse(value, { runId, answerId: snapshot.answerId, status: snapshot.requestedStatus });
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return;
      }
      const refreshResult = await fetchReviewAuthority(expectedGeneration);
      if (!active() || refreshResult.outcome !== "COMMITTED") return;
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
  }, [fetchReviewAuthority, invalidateReviewAuthority, runId, updateReviewLoad]);

  const resolveReview = useCallback(async () => {
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
    ) return;

    const mutation: Exclude<PendingReviewMutation, null> = { type: "RESOLVE" };
    const snapshot: ResolveReviewMutationSnapshot = {
      stateVersion: current.run.stateVersion,
      answerPacketVersion: current.packet.answerPacketVersion,
      packetHash: current.packet.packetHash,
      acknowledgedReviewReasons: [...current.run.reviewReasons]
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
        ? { phase: "error", run: null, packet: null, latestResponseWasNull: false, unverified: true, notice }
        : { ...loaded, phase: "error", unverified: true, notice }
      );
    };
    try {
      const request = buildResolveReviewRequest({ runId, run: current.run, packet: current.packet });
      const response = await fetch(request.url, { ...request.init, signal: controller.signal });
      if (!active()) return;
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
        return;
      }
      if (!response.ok) {
        if (response.status === 401) markUnverified({ tone: "ERROR", text: "Your session is no longer authenticated. Sign in again to resolve review." }, true);
        else if (response.status === 403) markUnverified({ tone: "ERROR", text: "You are not authorized to resolve review for this application run." }, true);
        else if (response.status === 404) markUnverified({ tone: "ERROR", text: "This application run is unavailable for review resolution." }, true);
        else if (response.status === 429) markUnverified({ tone: "WARNING", text: "Review actions are temporarily limited. Wait before refreshing review data." });
        else markUnverified({ tone: "ERROR", text: "The review action outcome is unverified. Refresh review data before another action." });
        return;
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return;
      }
      if (!active()) return;
      try {
        parseApplicationRunReviewResponse(value, runId);
      } catch {
        markUnverified({ tone: "ERROR", text: "Apply Pilot could not safely read the review action response." });
        return;
      }
      const refreshResult = await fetchReviewAuthority(expectedGeneration);
      if (!active() || refreshResult.outcome !== "COMMITTED") return;
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
  }, [fetchFillStatus, fetchReviewAuthority, invalidateReviewAuthority, runId, updateReviewLoad]);

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
      mutationAbortControllerRef.current?.abort();
      mutationAbortControllerRef.current = null;
      reviewRequestSequenceRef.current += 1;
      reviewAbortControllerRef.current?.abort();
      fillStatusRequestSequenceRef.current += 1;
      fillStatusAbortControllerRef.current?.abort();
    };
  }, [fetchFillStatus, fetchReviewAuthority]);

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
  const freshnessStatus = freshnessCopy(freshness);
  const resolveReviewEligible = isResolveReviewEligible({
    run: reviewLoad.run,
    packet: reviewLoad.packet,
    trusted: reviewLoad.phase === "loaded" && !reviewLoad.unverified
  });
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
  const fillUiLocked = pendingFillActivation;

  return (
    <div className="space-y-5 p-5">
      <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Workflow state</dt><dd className="mt-1 font-medium text-slate-950">{hasAcceptedAuthoritativeStatus ? status.state : "Awaiting companion status"}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Local connection</dt><dd className="mt-1 font-medium text-slate-950">{controlConnection}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Run ID</dt><dd className="mt-1 break-all font-mono text-xs text-slate-800">{runId}</dd></div>
        {status.targetHost ? <div><dt className="text-xs font-semibold uppercase text-slate-500">Target host</dt><dd className="mt-1 text-slate-800">{status.targetHost}</dd></div> : null}
        {status.errorCode ? <div><dt className="text-xs font-semibold uppercase text-slate-500">Safe stop code</dt><dd className="mt-1 font-mono text-xs text-rose-700">{status.errorCode}</dd></div> : null}
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <SecondaryButton type="button" disabled={fillUiLocked || !availability.GET_STATUS} onClick={() => void invoke({ type: "GET_STATUS" })}>Refresh status</SecondaryButton>
        <PrimaryButton type="button" disabled={fillUiLocked || !availability.OPEN_TARGET} onClick={() => void invoke({ type: "OPEN_TARGET" })}>Open frozen target</PrimaryButton>
        <PrimaryButton type="button" disabled={fillUiLocked || !availability.INSPECT_FORM} onClick={() => void invoke({ type: "INSPECT_FORM" })}>{pendingCommand === "INSPECT_FORM" ? "Inspecting…" : "Inspect form"}</PrimaryButton>
        <SecondaryButton type="button" disabled={fillUiLocked || !availability.CLOSE_WORKFLOW} onClick={() => void invoke({ type: "CLOSE_WORKFLOW" })}>Close workflow</SecondaryButton>
        {!fillUiLocked && shouldOfferRetryConnection(controlConnection, status, pendingCommand) ? <SecondaryButton type="button" onClick={() => void invoke({ type: "GET_STATUS" })}>Retry connection</SecondaryButton> : null}
      </div>

      {controlConnection === "UNAVAILABLE" ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{hasAcceptedAuthoritativeStatus ? "The local companion connection is unavailable. The last accepted browser status is preserved." : "The local companion connection is unavailable. No companion status received."}</p> : null}
      {commandNotice ? <p className={`rounded-lg px-3 py-2 text-sm ${noticeClass(commandNotice.tone)}`}>{commandNotice.text}</p> : null}

      <section className="space-y-4 border-t border-slate-200 pt-5" aria-labelledby="fill-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="fill-heading" className="font-semibold text-slate-950">Fill approved fields</h2>
            <p className="mt-1 text-sm text-slate-600">One explicit Fill attempt may process reviewed supported fields. You remain responsible for reviewing and submitting the employer form.</p>
          </div>
          <SecondaryButton
            type="button"
            disabled={fillUiLocked || pendingCommand !== null || pendingReviewMutation !== null || fillStatusLoad.phase === "loading"}
            onClick={() => {
              if (!pendingFillActivationRef.current) void fetchFillStatus();
            }}
          >
            {fillStatusLoad.phase === "loading" ? "Refreshing Fill status…" : "Refresh Fill status"}
          </SecondaryButton>
        </div>

        {fillStatusLoad.notice ? <p aria-live="polite" role={fillStatusLoad.notice.tone === "ERROR" ? "alert" : undefined} className={`rounded-lg px-3 py-2 text-sm ${noticeClass(fillStatusLoad.notice.tone)}`}>{fillStatusLoad.notice.text}</p> : null}
        {fillPresentation ? <div className={`rounded-lg px-4 py-3 text-sm ${noticeClass(fillPresentation.tone)}`}>
          <h3 className="font-semibold">{fillPresentation.title}</h3>
          <p className="mt-2 leading-6">{fillPresentation.text}</p>
          {stoppedErrorCopy ? <p className="mt-2">{stoppedErrorCopy}</p> : null}
          {fillStatusLoad.status && fillStatusLoad.status.steps.length > 0 ? <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ["Filled", fillPresentation.counts.filled],
              ["Preserved existing", fillPresentation.counts.preservedExisting],
              ["Runtime manual", fillPresentation.counts.runtimeManual],
              ["Failed", fillPresentation.counts.failed],
              ["Not attempted", fillPresentation.counts.notAttempted]
            ].map(([label, count]) => <div key={label}><dt className="text-xs font-medium">{label}</dt><dd className="mt-1 font-semibold">{count}</dd></div>)}
          </dl> : null}
        </div> : <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{fillStatusPendingCopy}</p>}

        {apparentEligibleCount > 0 ? <PrimaryButton
          type="button"
          disabled={!fillActivationEligible}
          onClick={() => void activateFill()}
        >
          {pendingFillActivation ? "Filling…" : "Fill approved fields"}
        </PrimaryButton> : <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">No approved automatable fields are apparent in the current packet. Complete the employer form manually; no Fill attempt will be consumed from this page.</p>}

        {manualFields.length > 0 ? <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="font-medium text-slate-950">Manual fields</h3>
          <p className="mt-1 text-sm text-slate-600">These packet fields remain for you to complete or confirm manually.</p>
          <ul className="mt-3 space-y-2 text-sm text-slate-800">
            {manualFields.map((field, index) => <li key={`${field.question}:${field.fieldType}:${index}`}>
              <span className="font-medium">{field.question || "Unlabeled field"}</span>
              {` — ${field.fieldType} — ${field.required ? "Required" : "Optional"} — ${field.category}`}
            </li>)}
          </ul>
        </div> : null}
      </section>

      <section className="space-y-4 border-t border-slate-200 pt-5" aria-labelledby="answer-packet-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 id="answer-packet-heading" className="font-semibold text-slate-950">Current answer packet</h2><p className="mt-1 text-sm text-slate-600">Read-only proposed answers from the authenticated ApplicationRun packet API.</p></div>
          <SecondaryButton type="button" disabled={fillUiLocked || reviewLoad.phase === "loading" || pendingReviewMutation !== null} onClick={() => {
            if (!pendingFillActivationRef.current) void fetchReviewAuthority();
          }}>{reviewLoad.phase === "loading" ? "Refreshing…" : "Refresh review data"}</SecondaryButton>
        </div>
        {reviewLoad.notice ? <p aria-live="polite" role={reviewLoad.notice.tone === "ERROR" ? "alert" : undefined} className={`rounded-lg px-3 py-2 text-sm ${noticeClass(reviewLoad.notice.tone)}`}>{reviewLoad.notice.text}</p> : null}
        <p className={`rounded-lg border px-3 py-2 text-sm ${freshnessStatus.className}`}>{freshnessStatus.text}</p>

        {reviewLoad.packet ? <div className="space-y-5">
          <dl className="grid gap-3 rounded-lg border border-slate-200 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Inspection version</dt><dd className="mt-1 text-slate-900">{reviewLoad.packet.inspectionVersion}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Packet version</dt><dd className="mt-1 text-slate-900">{reviewLoad.packet.answerPacketVersion}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Created</dt><dd className="mt-1 text-slate-900">{displayDate(reviewLoad.packet.createdAt)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Review time</dt><dd className="mt-1 text-slate-900">{displayDate(reviewLoad.packet.reviewedAt)}</dd></div>
            <div className="sm:col-span-2 lg:col-span-4"><dt className="text-xs font-semibold uppercase text-slate-500">Packet hash</dt><dd className="mt-1 break-all font-mono text-xs text-slate-700">{reviewLoad.packet.packetHash}</dd></div>
          </dl>

          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-950">Packet summary</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
              {[
                ["Fields", reviewLoad.packet.summary.fieldCount], ["Proposable", reviewLoad.packet.summary.proposableCount],
                ["Pending review", reviewLoad.packet.summary.pendingReviewCount], ["Approved", reviewLoad.packet.summary.approvedCount],
                ["Rejected", reviewLoad.packet.summary.rejectedCount], ["Manual only", reviewLoad.packet.summary.manualOnlyCount],
                ["Excluded", reviewLoad.packet.summary.excludedCount], ["Unsupported", reviewLoad.packet.summary.unsupportedCount],
                ["Manual required", reviewLoad.packet.summary.manualRequiredCount]
              ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-medium text-slate-900">{value}</dd></div>)}
            </dl>
            <p id="review-readiness" className="mt-4 text-sm text-slate-700">{readinessMessage(reviewLoad.packet.summary.readyForRunResolution)}</p>
            {reviewLoad.run ? <div id="review-reasons" className="mt-4 border-t border-slate-200 pt-4">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-slate-500">Run state</dt><dd className="mt-1 font-medium text-slate-900">{reviewLoad.run.state}</dd></div>
                <div><dt className="text-xs text-slate-500">State version</dt><dd className="mt-1 font-medium text-slate-900">{reviewLoad.run.stateVersion}</dd></div>
              </dl>
              <h4 className="mt-4 text-xs font-semibold uppercase text-slate-500">Review reasons</h4>
              {reviewLoad.run.reviewReasons.length === 0
                ? <p className="mt-2 text-sm text-slate-700">No planner review reasons require acknowledgment.</p>
                : <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">{reviewLoad.run.reviewReasons.map((reason) => <li key={reason}>{REVIEW_REASON_LABELS[reason]}</li>)}</ol>}
            </div> : null}
            <div className="mt-4">
              <PrimaryButton
                type="button"
                aria-describedby="review-readiness review-reasons"
                disabled={fillUiLocked || !resolveReviewEligible || pendingReviewMutation !== null}
                onClick={() => void resolveReview()}
              >
                {pendingReviewMutation?.type === "RESOLVE" ? "Resolving…" : "Resolve review"}
              </PrimaryButton>
            </div>
          </div>

          <div className="space-y-4">
            {reviewLoad.packet.answers.map((answer) => {
              const proposal = answer.proposal ? presentProposal(answer.proposal, answer.choices, answer) : null;
              return <article key={answer.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="font-medium text-slate-950">{answer.question}</h3><p className="mt-1 text-xs text-slate-500">{answer.fieldType} · {answer.classification}</p></div><span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{answer.status}</span></div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div><dt className="text-xs text-slate-500">Required</dt><dd className="mt-1 text-slate-900">{answer.required ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-xs text-slate-500">Requires review</dt><dd className="mt-1 text-slate-900">{answer.requiresReview ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-xs text-slate-500">Reviewed by user</dt><dd className="mt-1 text-slate-900">{answer.reviewedByUser ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-xs text-slate-500">Reviewed at</dt><dd className="mt-1 text-slate-900">{displayDate(answer.reviewedAt)}</dd></div>
                  <div><dt className="text-xs text-slate-500">Sensitive</dt><dd className="mt-1 text-slate-900">{answer.sensitive ? "Yes" : "No"}</dd></div>
                  <div><dt className="text-xs text-slate-500">Value redacted</dt><dd className="mt-1 text-slate-900">{answer.valueRedacted ? "Yes" : "No"}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Disposition</dt><dd className="mt-1 text-slate-900">{answer.disposition}</dd></div>
                </dl>
                <p className="mt-3 text-sm text-slate-700">{dispositionMessage(answer.disposition)}</p>
                {answer.dispositionReason ? <p className="mt-2 text-sm text-slate-700">Disposition reason: <span className="font-mono text-xs">{answer.dispositionReason}</span></p> : null}
                {answer.choices.length > 0 ? <div className="mt-4"><h4 className="text-xs font-semibold uppercase text-slate-500">Public choices</h4><ul className="mt-2 space-y-1 text-sm text-slate-700">{answer.choices.map((choice, index) => <li key={`${choice.key}:${index}`}>{choice.label}{choice.disabled ? " — Disabled option" : ""}</li>)}</ul></div> : null}
                {proposal ? <div className="mt-4 rounded-lg bg-slate-50 p-3"><h4 className="text-sm font-medium text-slate-900">{proposal.label}</h4><ul className="mt-2 space-y-1 text-sm text-slate-800">{proposal.values.map((value, index) => <li key={`${value.text}:${index}`} className="break-words">{value.text}{value.annotation ? ` — ${value.annotation}` : ""}</li>)}</ul></div> : null}
                {isAnswerReviewEligible(answer) ? <div className="mt-4 flex gap-2">
                  <PrimaryButton type="button" aria-label={`Approve proposed answer for ${answer.question}`} disabled={fillUiLocked || pendingReviewMutation !== null || reviewLoad.phase !== "loaded" || reviewLoad.unverified || reviewLoad.packet?.answers.find((entry) => entry.id === answer.id) !== answer || !isAnswerReviewMutationEligible({ answer, run: reviewLoad.run, trusted: true })} onClick={() => void reviewAnswer(answer, "APPROVED")}>{pendingReviewMutation?.type === "ANSWER" && pendingReviewMutation.answerId === answer.id && pendingReviewMutation.status === "APPROVED" ? "Approving…" : "Approve"}</PrimaryButton>
                  <SecondaryButton type="button" aria-label={`Reject proposed answer for ${answer.question}`} disabled={fillUiLocked || pendingReviewMutation !== null || reviewLoad.phase !== "loaded" || reviewLoad.unverified || reviewLoad.packet?.answers.find((entry) => entry.id === answer.id) !== answer || !isAnswerReviewMutationEligible({ answer, run: reviewLoad.run, trusted: true })} onClick={() => void reviewAnswer(answer, "REJECTED")}>{pendingReviewMutation?.type === "ANSWER" && pendingReviewMutation.answerId === answer.id && pendingReviewMutation.status === "REJECTED" ? "Rejecting…" : "Reject"}</SecondaryButton>
                </div> : null}
              </article>;
            })}
          </div>
        </div> : null}
      </section>

      <p className="text-xs leading-5 text-slate-500">Apply Pilot may fill reviewed supported fields only after your explicit action. It does not upload documents, click employer controls, or submit the application. Review every employer field, complete all remaining manual work, and personally click the employer&apos;s Submit button.</p>
    </div>
  );
}
