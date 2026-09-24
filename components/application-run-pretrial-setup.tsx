"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";

import {
  canonicalizePolicyHostEntry,
  isHostAllowedForExecution,
  isHostBlocked
} from "@/lib/application-runs/host-policy";

const runStates = [
  "DRAFT", "PREPARING", "READY", "FILLING", "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "BLOCKED", "FAILED", "CANCELLED"
] as const;

const runSchema = z.object({
  id: z.string().cuid(),
  applicationId: z.string().cuid(),
  state: z.enum(runStates),
  applyHost: z.string(),
  blockingReason: z.string().nullable(),
  errorCategory: z.string().nullable()
});

const policySchema = z.object({
  enabled: z.boolean(),
  effectiveEnabled: z.boolean(),
  mode: z.enum(["PREPARE_ONLY", "FILL_AND_REVIEW"]),
  allowedHosts: z.array(z.string()),
  blockedHosts: z.array(z.string())
});

export type RunView = z.infer<typeof runSchema>;
export type PolicyView = z.infer<typeof policySchema>;

const blockingMessages: Record<string, string> = {
  automation_disabled: "Application automation is disabled by the current policy.",
  automation_disabled_during_preparation: "Application automation was disabled during preparation.",
  host_blocked: "The run's target host is blocked by the current policy.",
  fit_below_threshold: "The job's current fit score does not meet the existing policy threshold.",
  match_confidence_below_threshold: "The job's current match confidence does not meet the existing policy threshold.",
  resume_required: "An eligible tailored resume must be explicitly assigned to this application in the job packet.",
  cover_letter_required: "An eligible cover letter must be explicitly assigned to this application in the job packet.",
  daily_application_cap_reached: "The daily preparation cap has been reached.",
  ai_budget_exceeded: "The existing AI budget does not permit preparation.",
  ai_request_cost_limit: "This planner request exceeds the existing per-request cost limit.",
  ai_cost_confirmation_required: "Preparation requires a separate AI cost confirmation. No additional planner request was sent.",
  ai_duplicate_in_progress: "Another planner request is in progress. Review the run state before deciding whether to retry."
};

const failureMessages: Record<string, string> = {
  planner_input_invalid: "Preparation failed because the bounded planner input was invalid.",
  planner_output_invalid: "Preparation failed because the planner output was invalid.",
  planner_confidence_invalid: "Preparation failed because the planner confidence was invalid.",
  planner_provider_failure: "Preparation failed at the planner provider.",
  ai_provider_usage_exceeded_reservation: "Preparation failed because provider usage exceeded its reservation."
};

function canStartPreparation(state: RunView["state"]) {
  return state === "DRAFT" || state === "BLOCKED" || state === "FAILED";
}

function allowedForRun(run: RunView, policy: PolicyView) {
  return isHostAllowedForExecution(run.applyHost, policy);
}

function safeSetupHost(run: RunView, policy: PolicyView) {
  return canonicalizePolicyHostEntry(run.applyHost) === run.applyHost &&
    !isHostBlocked(run.applyHost, policy);
}

export function ApplicationRunPretrialSetup({
  applicationId,
  jobPostingId,
  initialRun,
  initialPolicy
}: {
  applicationId: string;
  jobPostingId: string;
  initialRun: RunView;
  initialPolicy: PolicyView;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [run, setRun] = useState(initialRun);
  const [policy, setPolicy] = useState(initialPolicy);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [costConfirmationStop, setCostConfirmationStop] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const hostAllowed = allowedForRun(run, policy);
  const hostSafe = safeSetupHost(run, policy);
  const eligibleState = canStartPreparation(run.state);
  const inPrepareOnlyMode = policy.mode === "PREPARE_ONLY";
  const needsSetup = !policy.enabled || !hostAllowed;
  const showSetup = !busy && !uncertain && eligibleState && inPrepareOnlyMode && hostSafe && needsSetup;
  const showPrepare = !busy && !uncertain && !costConfirmationStop && eligibleState &&
    inPrepareOnlyMode && policy.enabled && policy.effectiveEnabled && hostAllowed &&
    run.blockingReason !== "ai_cost_confirmation_required";

  async function readRun(): Promise<RunView | null> {
    try {
      const response = await fetch(`/api/application-runs/${run.id}`, { method: "GET", cache: "no-store" });
      if (!response.ok) throw new Error("Run read failed");
      const parsed = runSchema.safeParse((await response.json() as { run?: unknown }).run);
      if (
        !parsed.success ||
        parsed.data.id !== initialRun.id ||
        parsed.data.applicationId !== applicationId ||
        parsed.data.applyHost !== initialRun.applyHost
      ) throw new Error("Run identity changed");
      setRun(parsed.data);
      setUncertain(false);
      return parsed.data;
    } catch {
      setUncertain(true);
      setMessage("The run state could not be confirmed. Refresh run state before any retry.");
      return null;
    }
  }

  async function readPolicy(): Promise<PolicyView> {
    const response = await fetch("/api/application-automation-policy", { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error("Policy read failed");
    return policySchema.parse(await response.json());
  }

  async function enablePretrial() {
    if (inFlight.current || !showSetup) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const latestRun = await readRun();
      if (!latestRun || !canStartPreparation(latestRun.state)) return;
      const latestPolicy = await readPolicy();
      setPolicy(latestPolicy);
      if (latestPolicy.mode !== "PREPARE_ONLY") {
        setMessage("The current policy is FILL_AND_REVIEW. Review that mode separately before pretrial setup.");
        return;
      }
      if (!safeSetupHost(latestRun, latestPolicy)) {
        setMessage("This run host is blocked or invalid under the current policy. No setup request was sent.");
        return;
      }
      if (latestPolicy.enabled && allowedForRun(latestRun, latestPolicy)) {
        setMessage("This run already has the PREPARE_ONLY capability and an allowed host. No policy change was needed.");
        return;
      }
      if (!window.confirm(
        `Enable PREPARE_ONLY application automation and allow ${latestRun.applyHost} for this run? This does not authorize Fill.`
      )) return;
      const response = await fetch("/api/application-automation-policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enablePretrialForRunId: latestRun.id }),
        cache: "no-store"
      });
      if (!response.ok) {
        setUncertain(true);
        setMessage("Policy setup was not confirmed. Refresh the page to review the current policy before another action.");
        router.refresh();
        return;
      }
      const updated = policySchema.parse(await response.json());
      setPolicy(updated);
      if (updated.mode !== "PREPARE_ONLY" || !updated.enabled || !allowedForRun(latestRun, updated)) {
        setUncertain(true);
        setMessage("The setup result did not confirm PREPARE_ONLY access for this run. Refresh the page.");
      } else if (!updated.effectiveEnabled) {
        setMessage("Automation is unavailable in this environment even though the owner policy is enabled. Preparation was not started.");
      } else {
        setMessage("PREPARE_ONLY setup is saved. Preparation remains a separate action.");
      }
      router.refresh();
    } catch {
      setUncertain(true);
      setMessage("Policy setup could not be confirmed. Refresh the page before another action.");
      router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function prepareRun() {
    if (inFlight.current || !showPrepare) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    let costConfirmationRequired = false;
    let requestSucceeded = false;
    try {
      const response = await fetch(`/api/application-runs/${run.id}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        cache: "no-store"
      });
      requestSucceeded = response.ok;
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        costConfirmationRequired = Boolean(body && typeof body === "object" &&
          "code" in body && body.code === "AI_COST_CONFIRMATION_REQUIRED");
        if (costConfirmationRequired) setCostConfirmationStop(true);
      }
    } catch {
      // A lost response never authorizes an automatic replay.
    }

    const latestRun = await readRun();
    if (latestRun) {
      if (costConfirmationRequired || latestRun.blockingReason === "ai_cost_confirmation_required") {
        setCostConfirmationStop(true);
        setMessage(blockingMessages.ai_cost_confirmation_required);
      } else if (!requestSucceeded && latestRun.state === "DRAFT") {
        setMessage("Preparation was not confirmed. Review the authoritative DRAFT state before a manual retry.");
      }
      router.refresh();
    } else if (costConfirmationRequired) {
      setMessage(`${blockingMessages.ai_cost_confirmation_required} The run state is unconfirmed; refresh it before another decision.`);
    }
    inFlight.current = false;
    setBusy(false);
  }

  async function refreshRunState() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await readRun();
    inFlight.current = false;
    setBusy(false);
  }

  return (
    <div className="space-y-3 p-5 text-sm text-slate-700">
      <p>Run state: <strong>{run.state}</strong>. Canonical target host: <strong>{run.applyHost}</strong>.</p>
      <p>Automation policy: owner enabled <strong>{policy.enabled ? "yes" : "no"}</strong>; effective enabled <strong>{policy.effectiveEnabled ? "yes" : "no"}</strong>; mode <strong>{policy.mode}</strong>.</p>
      <p>Execution host: <strong>{hostAllowed ? "allowed" : "not allowed"}</strong> under the current policy.</p>
      <p>Preparation is separate from employer inspection and Fill. Preparing does not open an employer page or grant Fill authority.</p>
      {policy.mode === "FILL_AND_REVIEW" ? (
        <p>The current policy is FILL_AND_REVIEW. This pretrial setup does not change that mode; review it separately.</p>
      ) : null}
      {policy.enabled && !policy.effectiveEnabled ? (
        <p>Automation is unavailable in this environment. Preparation cannot start here.</p>
      ) : null}
      {!hostSafe ? <p>This host is blocked or invalid under the current policy.</p> : null}
      {run.state === "PREPARING" ? <p>Preparation is in progress. No additional request will be sent automatically.</p> : null}
      {run.state === "BLOCKED" ? (
        <p role="status">Preparation is blocked: {blockingMessages[run.blockingReason ?? ""] ?? "Review the current policy and run prerequisites."}</p>
      ) : null}
      {run.state === "FAILED" ? (
        <p role="status">{failureMessages[run.errorCategory ?? ""] ?? "Preparation failed. Review the run before deciding whether to retry."}</p>
      ) : null}
      {(run.blockingReason === "resume_required" || run.blockingReason === "cover_letter_required") ? (
        <Link href={`/jobs/${jobPostingId}`} data-testid="job-packet-link" className="font-semibold text-brand-700 underline">
          Review the job packet and assign the required document
        </Link>
      ) : null}
      {showSetup ? (
        <button type="button" data-testid="enable-pretrial" onClick={() => { void enablePretrial(); }}
          className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white">
          Enable PREPARE_ONLY for this run
        </button>
      ) : null}
      {showPrepare ? (
        <button type="button" data-testid="prepare-run" onClick={() => { void prepareRun(); }}
          className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white">
          Prepare run
        </button>
      ) : null}
      {uncertain && !busy ? (
        <button type="button" data-testid="refresh-run-state" onClick={() => { void refreshRunState(); }}
          className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-800">
          Refresh run state
        </button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
