"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import {
  applyAuthoritativeBrowserStatus,
  bindingRejectionPlan,
  browserCommandAvailability,
  derivePacketFreshness,
  dispositionMessage,
  parseAnswerPacketResponse,
  presentProposal,
  readinessMessage,
  shouldOfferRetryConnection,
  type AnswerPacket,
  type CommandNotice,
  type ControlConnection,
  type PacketFreshness,
  type PendingBrowserCommand
} from "@/lib/application-browser/control-presentation";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status,
  type B2InspectionCommandStatus
} from "@/lib/application-browser/types";

type ControlWindow = Window & {
  [APPLICATION_BROWSER_BINDING_NAME]?: (command: B1Command) => Promise<B1Status>;
};

type PacketLoad = {
  phase: "idle" | "loading" | "loaded" | "error";
  packet: AnswerPacket | null;
  latestResponseWasNull: boolean;
  unverified: boolean;
  notice: string | null;
};

const initialPacketLoad: PacketLoad = {
  phase: "idle",
  packet: null,
  latestResponseWasNull: false,
  unverified: false,
  notice: null
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function ApplicationBrowserControl({ runId }: { runId: string }) {
  const [status, setStatus] = useState<B1Status>({ state: "STARTING", runId });
  const [controlConnection, setControlConnection] = useState<ControlConnection>("UNKNOWN");
  const [hasAcceptedAuthoritativeStatus, setHasAcceptedAuthoritativeStatus] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingBrowserCommand>(null);
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>({
    tone: "INFO",
    text: "Start the local companion, then refresh status."
  });
  const [packetLoad, setPacketLoad] = useState<PacketLoad>(initialPacketLoad);
  const [lastAcceptedInspection, setLastAcceptedInspection] = useState<B2InspectionCommandStatus | null>(null);
  const [formInvalidatedSinceVerifiedSuccess, setFormInvalidatedSinceVerifiedSuccess] = useState(false);

  const statusRef = useRef(status);
  const packetLoadRef = useRef(packetLoad);
  const formInvalidatedRef = useRef(formInvalidatedSinceVerifiedSuccess);
  const packetRequestSequenceRef = useRef(0);
  const packetAbortControllerRef = useRef<AbortController | null>(null);
  const lastAutoRefreshAttemptKeyRef = useRef<string | null>(null);
  const componentGenerationRef = useRef(0);
  const activeComponentGenerationRef = useRef<number | null>(null);

  const updatePacketLoad = useCallback((update: (current: PacketLoad) => PacketLoad) => {
    setPacketLoad((current) => {
      const next = update(current);
      packetLoadRef.current = next;
      return next;
    });
  }, []);

  const fetchPacket = useCallback(async (expectedGeneration = activeComponentGenerationRef.current) => {
    if (
      expectedGeneration === null ||
      activeComponentGenerationRef.current !== expectedGeneration
    ) {
      return;
    }
    packetAbortControllerRef.current?.abort();
    const requestId = packetRequestSequenceRef.current + 1;
    packetRequestSequenceRef.current = requestId;
    const controller = new AbortController();
    packetAbortControllerRef.current = controller;
    const isCurrent = () =>
      activeComponentGenerationRef.current === expectedGeneration &&
      packetRequestSequenceRef.current === requestId &&
      !controller.signal.aborted;

    updatePacketLoad((current) => ({ ...current, phase: "loading", notice: null }));
    try {
      const response = await fetch(`/api/application-runs/${encodeURIComponent(runId)}/answer-packet`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!isCurrent()) return;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          const notice = response.status === 401
            ? "Your session is no longer authenticated. Sign in again to read this answer packet."
            : response.status === 403
              ? "You are not authorized to read this answer packet."
              : "This application run or answer packet is unavailable.";
          updatePacketLoad(() => ({
            phase: "error",
            packet: null,
            latestResponseWasNull: false,
            unverified: true,
            notice
          }));
          return;
        }
        const notice = response.status === 429
          ? "Answer packet reads are temporarily limited. Wait a moment, then refresh the packet."
          : response.status >= 500
            ? "The answer packet is temporarily unavailable. Try refreshing it again."
            : "The answer packet could not be refreshed safely. The displayed packet is unverified.";
        updatePacketLoad((current) => ({ ...current, phase: "error", unverified: true, notice }));
        return;
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (!isCurrent()) return;
        updatePacketLoad((current) => ({
          ...current,
          phase: "error",
          unverified: true,
          notice: "Apply Pilot could not safely read the answer packet response."
        }));
        return;
      }
      if (!isCurrent()) return;

      if (isRecord(value) && typeof value.runId === "string" && value.runId !== runId) {
        updatePacketLoad((current) => ({
          ...current,
          phase: "error",
          unverified: true,
          notice: "The answer packet response did not match this application run."
        }));
        return;
      }

      try {
        const parsed = parseAnswerPacketResponse(value, runId);
        if (!isCurrent()) return;
        updatePacketLoad(() => ({
          phase: "loaded",
          packet: parsed.current,
          latestResponseWasNull: parsed.current === null,
          unverified: false,
          notice: parsed.current === null ? "No current answer packet has been published yet." : null
        }));
      } catch {
        if (!isCurrent()) return;
        updatePacketLoad((current) => ({
          ...current,
          phase: "error",
          unverified: true,
          notice: "Apply Pilot could not safely read the answer packet response."
        }));
      }
    } catch {
      if (!isCurrent()) return;
      updatePacketLoad((current) => ({
        ...current,
        phase: "error",
        unverified: true,
        notice: "Apply Pilot could not reach the answer packet service. Check the connection and try again."
      }));
    }
  }, [runId, updatePacketLoad]);

  const acceptAuthoritativeStatus = useCallback((value: unknown, expectedGeneration: number) => {
    if (activeComponentGenerationRef.current !== expectedGeneration) {
      return { active: false, accepted: false, suppliedNotice: false };
    }
    const result = applyAuthoritativeBrowserStatus({
      value,
      expectedRunId: runId,
      formInvalidatedSinceVerifiedSuccess: formInvalidatedRef.current
    });
    if (!result.accepted) {
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

    const refreshKey = result.automaticPacketRefreshKey;
    if (refreshKey !== null) {
      const displayed = packetLoadRef.current.packet;
      const matches = displayed !== null && `${displayed.inspectionVersion}:${displayed.answerPacketVersion}` === refreshKey;
      if (
        matches &&
        packetLoadRef.current.phase === "loaded" &&
        packetLoadRef.current.notice === null
      ) {
        updatePacketLoad((current) => ({ ...current, unverified: false }));
      } else if (lastAutoRefreshAttemptKeyRef.current !== refreshKey) {
        lastAutoRefreshAttemptKeyRef.current = refreshKey;
        void fetchPacket(expectedGeneration);
      }
    }
    return { active: true, accepted: true, suppliedNotice: result.notice !== null };
  }, [fetchPacket, runId, updatePacketLoad]);

  const invoke = useCallback(async (command: B1Command) => {
    const expectedGeneration = activeComponentGenerationRef.current;
    if (expectedGeneration === null) return;
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
          packet: packetLoadRef.current.packet,
          latestPacketResponseWasNull: packetLoadRef.current.latestResponseWasNull,
          packetLoadUnverified: packetLoadRef.current.unverified,
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
          updatePacketLoad((current) => ({ ...current, unverified: true }));
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
      if (activeComponentGenerationRef.current === expectedGeneration) {
        setPendingCommand(null);
      }
    }
  }, [acceptAuthoritativeStatus, controlConnection, lastAcceptedInspection, updatePacketLoad]);

  useEffect(() => {
    const generation = componentGenerationRef.current + 1;
    componentGenerationRef.current = generation;
    activeComponentGenerationRef.current = generation;
    void fetchPacket(generation);
    return () => {
      if (activeComponentGenerationRef.current === generation) {
        activeComponentGenerationRef.current = null;
      }
      componentGenerationRef.current += 1;
      packetRequestSequenceRef.current += 1;
      packetAbortControllerRef.current?.abort();
    };
  }, [fetchPacket]);

  const availability = browserCommandAvailability({ status, connection: controlConnection, pendingCommand });
  const freshness = useMemo(() => derivePacketFreshness({
    packet: packetLoad.packet,
    latestPacketResponseWasNull: packetLoad.latestResponseWasNull,
    packetLoadUnverified: packetLoad.unverified,
    connection: controlConnection,
    workflowState: status.state,
    lastAcceptedInspection,
    formInvalidatedSinceVerifiedSuccess
  }), [controlConnection, formInvalidatedSinceVerifiedSuccess, lastAcceptedInspection, packetLoad, status.state]);
  const freshnessStatus = freshnessCopy(freshness);

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
        <SecondaryButton type="button" disabled={!availability.GET_STATUS} onClick={() => void invoke({ type: "GET_STATUS" })}>Refresh status</SecondaryButton>
        <PrimaryButton type="button" disabled={!availability.OPEN_TARGET} onClick={() => void invoke({ type: "OPEN_TARGET" })}>Open frozen target</PrimaryButton>
        <PrimaryButton type="button" disabled={!availability.INSPECT_FORM} onClick={() => void invoke({ type: "INSPECT_FORM" })}>{pendingCommand === "INSPECT_FORM" ? "Inspecting…" : "Inspect form"}</PrimaryButton>
        <SecondaryButton type="button" disabled={!availability.CLOSE_WORKFLOW} onClick={() => void invoke({ type: "CLOSE_WORKFLOW" })}>Close workflow</SecondaryButton>
        {shouldOfferRetryConnection(controlConnection, status, pendingCommand) ? <SecondaryButton type="button" onClick={() => void invoke({ type: "GET_STATUS" })}>Retry connection</SecondaryButton> : null}
      </div>

      {controlConnection === "UNAVAILABLE" ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{hasAcceptedAuthoritativeStatus ? "The local companion connection is unavailable. The last accepted browser status is preserved." : "The local companion connection is unavailable. No companion status received."}</p> : null}
      {commandNotice ? <p className={`rounded-lg px-3 py-2 text-sm ${noticeClass(commandNotice.tone)}`}>{commandNotice.text}</p> : null}

      <section className="space-y-4 border-t border-slate-200 pt-5" aria-labelledby="answer-packet-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 id="answer-packet-heading" className="font-semibold text-slate-950">Current answer packet</h2><p className="mt-1 text-sm text-slate-600">Read-only proposed answers from the authenticated ApplicationRun packet API.</p></div>
          <SecondaryButton type="button" disabled={packetLoad.phase === "loading"} onClick={() => void fetchPacket()}>{packetLoad.phase === "loading" ? "Refreshing…" : "Refresh packet"}</SecondaryButton>
        </div>
        {packetLoad.notice ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{packetLoad.notice}</p> : null}
        <p className={`rounded-lg border px-3 py-2 text-sm ${freshnessStatus.className}`}>{freshnessStatus.text}</p>

        {packetLoad.packet ? <div className="space-y-5">
          <dl className="grid gap-3 rounded-lg border border-slate-200 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Inspection version</dt><dd className="mt-1 text-slate-900">{packetLoad.packet.inspectionVersion}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Packet version</dt><dd className="mt-1 text-slate-900">{packetLoad.packet.answerPacketVersion}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Created</dt><dd className="mt-1 text-slate-900">{displayDate(packetLoad.packet.createdAt)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Review time</dt><dd className="mt-1 text-slate-900">{displayDate(packetLoad.packet.reviewedAt)}</dd></div>
            <div className="sm:col-span-2 lg:col-span-4"><dt className="text-xs font-semibold uppercase text-slate-500">Packet hash</dt><dd className="mt-1 break-all font-mono text-xs text-slate-700">{packetLoad.packet.packetHash}</dd></div>
          </dl>

          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-950">Packet summary</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
              {[
                ["Fields", packetLoad.packet.summary.fieldCount], ["Proposable", packetLoad.packet.summary.proposableCount],
                ["Pending review", packetLoad.packet.summary.pendingReviewCount], ["Approved", packetLoad.packet.summary.approvedCount],
                ["Rejected", packetLoad.packet.summary.rejectedCount], ["Manual only", packetLoad.packet.summary.manualOnlyCount],
                ["Excluded", packetLoad.packet.summary.excludedCount], ["Unsupported", packetLoad.packet.summary.unsupportedCount],
                ["Manual required", packetLoad.packet.summary.manualRequiredCount]
              ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-medium text-slate-900">{value}</dd></div>)}
            </dl>
            <p className="mt-4 text-sm text-slate-700">{readinessMessage(packetLoad.packet.summary.readyForRunResolution)}</p>
          </div>

          <div className="space-y-4">
            {packetLoad.packet.answers.map((answer) => {
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
              </article>;
            })}
          </div>
        </div> : null}
      </section>

      <p className="text-xs leading-5 text-slate-500">Apply Pilot inspects the frozen employer form and presents proposed answers for review. It does not fill fields, upload documents, click employer controls, or submit the application.</p>
    </div>
  );
}
