"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";

import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import { PREPARE_BLOCKER_COPY, PREPARE_FAILURE_COPY } from "@/lib/application-runs/blocker-copy";
import { allowHostForRun, prepareRun } from "@/lib/application-runs/client-run";
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

const blockingMessages: Record<string, string> = Object.fromEntries(
  Object.entries(PREPARE_BLOCKER_COPY).map(([reason, copy]) => [reason, copy.text])
);

const failureMessages: Record<string, string> = PREPARE_FAILURE_COPY;

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

const ASSISTED_FILL_CONFIRMATION =
  "Turn on assisted Fill for your whole account? When you click Fill on a browser run, Apply Pilot can fill your approved answers on that employer's page, once. It leaves values already there alone, and you still click Submit yourself.";

// Prepare and pretrial setup are PREPARE_ONLY actions, so turning Fill on too early would
// hide them. This only prevents that dead end: the server's Fill gates stay the authority.
function assistedFillBlocker(run: RunView, policy: PolicyView): string | null {
  if (canStartPreparation(run.state) || run.state === "PREPARING") {
    return "Prepare this job first. You can turn on assisted Fill once it's prepared.";
  }
  if (run.state !== "READY" && run.state !== "REVIEW_REQUIRED") {
    return "This browser run is past the point where Fill can start.";
  }
  if (!policy.enabled || !allowedForRun(run, policy) || !safeSetupHost(run, policy)) {
    return "This job isn't set up for automation, so assisted Fill can't be turned on from here.";
  }
  if (!policy.effectiveEnabled) {
    return "Automation is unavailable in this environment, so assisted Fill can't be turned on here.";
  }
  return null;
}

export function ApplicationRunPretrialSetup({
  applicationId,
  jobPostingId,
  initialRun,
  initialPolicy,
  planner
}: {
  applicationId: string;
  jobPostingId: string;
  initialRun: RunView;
  initialPolicy: PolicyView;
  // Which planner Prepare will use on this server: Gemini when it is configured, otherwise
  // the deterministic local rules. Only changes what the panel says.
  planner: "gemini" | "local";
}) {
  const router = useRouter();
  const { confirm, dialog } = useInPageConfirm();
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
  const fillIsOn = policy.mode === "FILL_AND_REVIEW";
  const turnOnBlocker = assistedFillBlocker(run, policy);
  // Turning off is the safe direction, so it stays available unless a write is pending.
  const switchDisabled = busy || (!fillIsOn && (uncertain || turnOnBlocker !== null));

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
        setMessage("Assisted Fill is on, so no setup was sent. Turn it off first to set up this job.");
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
      if (!(await confirm({
        title: "Before this runs",
        body: `Enable PREPARE_ONLY application automation and allow ${latestRun.applyHost} for this run? This does not authorize Fill.`
      }))) return;
      try {
        await allowHostForRun(latestRun.id);
      } catch {
        setUncertain(true);
        setMessage("Policy setup was not confirmed. Refresh the page to review the current policy before another action.");
        router.refresh();
        return;
      }
      // The write is confirmed; the policy it left is read back rather than assumed.
      const updated = await readPolicy();
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

  async function writeAssistedFillMode(mode: PolicyView["mode"]) {
    const state = (value: PolicyView["mode"]) => value === "FILL_AND_REVIEW" ? "on" : "off";
    const unconfirmed = "Assisted Fill could not be confirmed. Refresh the page before another action.";
    let updated: PolicyView | null = null;
    try {
      const response = await fetch("/api/application-automation-policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
        cache: "no-store"
      });
      if (response.ok) updated = policySchema.parse(await response.json());
    } catch {
      // A lost response never authorizes an automatic replay.
    }
    if (updated) {
      setPolicy(updated);
      if (updated.mode === mode) {
        setMessage(`Assisted Fill is ${state(mode)}.`);
      } else {
        setUncertain(true);
        setMessage(unconfirmed);
      }
    } else {
      try {
        const latest = await readPolicy();
        setPolicy(latest);
        setMessage(latest.mode === mode
          ? `Assisted Fill is ${state(mode)}.`
          : `The change was not confirmed. Assisted Fill is still ${state(latest.mode)}.`);
      } catch {
        setUncertain(true);
        setMessage(unconfirmed);
      }
    }
    router.refresh();
  }

  async function turnOnAssistedFill() {
    if (inFlight.current || uncertain || turnOnBlocker !== null) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const latestRun = await readRun();
      if (!latestRun) return;
      const latestPolicy = await readPolicy();
      setPolicy(latestPolicy);
      if (latestPolicy.mode === "FILL_AND_REVIEW") {
        setMessage("Assisted Fill is already on. No change was needed.");
        return;
      }
      if (assistedFillBlocker(latestRun, latestPolicy) !== null) {
        setMessage("This run or its policy has changed, so assisted Fill stays off. No change was sent.");
        return;
      }
      if (!(await confirm({ title: "Turn on assisted Fill?", body: ASSISTED_FILL_CONFIRMATION }))) return;
      await writeAssistedFillMode("FILL_AND_REVIEW");
    } catch {
      setUncertain(true);
      setMessage("Assisted Fill could not be confirmed. Refresh the page before another action.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Deliberately one click with no reads first: stopping Fill must not depend on anything else working.
  async function turnOffAssistedFill() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await writeAssistedFillMode("PREPARE_ONLY");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function startPreparation() {
    if (inFlight.current || !showPrepare) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const costQuestion = { asked: false };
    let requestSucceeded = false;
    try {
      // This panel keeps its rule: it never sends the cost confirmation, so a cost question from
      // the server stops at the durable blocker. (The Apply page's step 4 asks it in the page.)
      const response = await prepareRun(run.id, () => {
        costQuestion.asked = true;
        return false;
      });
      requestSucceeded = response.ok;
    } catch {
      // A declined cost question or a lost response: neither authorizes an automatic replay.
    }
    const costConfirmationRequired = costQuestion.asked;
    if (costConfirmationRequired) setCostConfirmationStop(true);

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
      {planner === "gemini" ? (
        <p>Preparing sends this job, your résumé evidence and the lines you added for it to Google Gemini to build an application plan. It uses your AI budget, usually a few cents.</p>
      ) : (
        <p>This MVP uses deterministic local rule-based planning. Preparing does not send planning data to an AI provider.</p>
      )}
      <p>Preparation is separate from employer inspection and Fill. Preparing does not open an employer page or grant Fill authority.</p>
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
        <button type="button" data-testid="prepare-run" onClick={() => { void startPreparation(); }}
          className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white">
          {planner === "gemini" ? "Prepare with Gemini" : "Prepare with local rules"}
        </button>
      ) : null}
      <div className="space-y-2 rounded-lg border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-3">
          <p>
            <span className="font-semibold text-slate-950">Assisted Fill</span>
            {": "}
            <strong>{fillIsOn ? "On" : "Off"}</strong>
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={fillIsOn}
            aria-label="Assisted Fill"
            data-testid="assisted-fill-switch"
            disabled={switchDisabled}
            onClick={() => { void (fillIsOn ? turnOffAssistedFill() : turnOnAssistedFill()); }}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50 ${fillIsOn ? "bg-brand-600" : "bg-slate-300"}`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${fillIsOn ? "translate-x-[22px]" : "translate-x-0.5"}`}
            />
          </button>
        </div>
        {fillIsOn ? (
          <p>This is on for your whole account. When you click Fill on a browser run, Apply Pilot fills your approved answers once and leaves values already there alone. You still click Submit yourself. To set up or prepare another job, turn this off first, then back on.</p>
        ) : (
          <p>Apply Pilot won&apos;t fill anything on employer pages while this is off. Turn it on before you click Fill on a browser run.</p>
        )}
        {!fillIsOn && turnOnBlocker ? <p data-testid="assisted-fill-blocker">{turnOnBlocker}</p> : null}
      </div>
      {dialog}
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
