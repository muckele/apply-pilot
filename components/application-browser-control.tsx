"use client";

import { useState } from "react";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import type { B1Command, B1Status } from "@/lib/application-browser/types";

const BINDING_NAME = "__applyPilotB1Command";

type ControlWindow = Window & {
  __applyPilotB1Command?: (command: B1Command) => Promise<B1Status>;
};

export function ApplicationBrowserControl({ runId }: { runId: string }) {
  const [status, setStatus] = useState<B1Status>({ state: "STARTING", runId });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("Start the local companion, then refresh status.");

  async function invoke(command: B1Command) {
    setPending(true);
    setMessage("");
    try {
      const binding = (window as ControlWindow)[BINDING_NAME];
      if (typeof binding !== "function") {
        setMessage("Local browser companion is not connected to this control page.");
        return;
      }
      const nextStatus = await binding(command);
      if (nextStatus.runId !== runId) {
        setMessage("The local browser companion is connected to a different run.");
        return;
      }
      setStatus(nextStatus);
      setMessage(command.type === "OPEN_TARGET" ? "Frozen employer target opened." : "Browser status updated.");
    } catch {
      setMessage("The browser command stopped safely. Check the local companion output.");
    } finally {
      setPending(false);
    }
  }

  const canOpen = status.state === "CONTROL_READY";
  const canClose = status.state !== "CLOSED";

  return (
    <div className="space-y-4 p-5">
      <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase text-slate-500">Workflow state</dt>
          <dd className="mt-1 font-medium text-slate-950">{status.state}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase text-slate-500">Run ID</dt>
          <dd className="mt-1 break-all font-mono text-xs text-slate-800">{runId}</dd>
        </div>
        {status.targetHost ? (
          <div>
            <dt className="text-xs font-semibold uppercase text-slate-500">Target host</dt>
            <dd className="mt-1 text-slate-800">{status.targetHost}</dd>
          </div>
        ) : null}
        {status.errorCode ? (
          <div>
            <dt className="text-xs font-semibold uppercase text-slate-500">Safe stop code</dt>
            <dd className="mt-1 font-mono text-xs text-rose-700">{status.errorCode}</dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row">
        <SecondaryButton type="button" disabled={pending} onClick={() => invoke({ type: "GET_STATUS" })}>
          Refresh status
        </SecondaryButton>
        <PrimaryButton type="button" disabled={pending || !canOpen} onClick={() => invoke({ type: "OPEN_TARGET" })}>
          Open frozen target
        </PrimaryButton>
        <SecondaryButton type="button" disabled={pending || !canClose} onClick={() => invoke({ type: "CLOSE_WORKFLOW" })}>
          Close workflow
        </SecondaryButton>
      </div>

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}
      <p className="text-xs leading-5 text-slate-500">
        B1 opens the frozen anonymous employer target only. It does not inspect, fill, upload, click, type, or submit.
      </p>
    </div>
  );
}
