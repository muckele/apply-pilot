"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import type { ConfirmFn } from "@/lib/ai/browser-request";
import { PREPARE_BLOCKER_COPY, PREPARE_FAILURE_COPY, type ReadyFix } from "@/lib/application-runs/blocker-copy";
import {
  allowHostForRun,
  ensureApplicationRun,
  prepareRun,
  readApplicationRun,
  RunRequestError,
  runSnapshotFromBody,
  turnOffAssistedFill,
  type RunSnapshot
} from "@/lib/application-runs/client-run";
import type { PreparationBlockingReason, PreparationErrorCategory } from "@/lib/application-runs/preparation";
import { ensureApplication } from "@/lib/applications/client";
import type { ReadyLine } from "@/lib/apply-page/ready-list";

// Step 4 of the Apply page: the ready list, then one "Allow and prepare" that asks once in the page,
// then creates the browser run if there isn't one, allows the employer's host and runs Prepare.
// Every request is single flight. The create request keeps its key until a run is confirmed, and a
// run this step created is reused on retry, so a retry never makes a second run. The server's gates
// stay the authority: its answer (READY, BLOCKED or FAILED) is what the step shows.

export type PrepareStepRun = { id: string; state: string; blockingReason?: string | null; errorCategory?: string | null };

export type PrepareStepProps = {
  jobId: string;
  applicationId: string | null;
  /** The run's host once a run exists, else the host its apply link would give. Empty when there is no usable link. */
  applyHost: string;
  readyList: ReadyLine[];
  fillMode: "PREPARE_ONLY" | "FILL_AND_REVIEW";
  run: PrepareStepRun | null;
};

const STARTABLE = new Set(["DRAFT", "BLOCKED", "FAILED"]);
const CANCELED = "Canceled. Prepare didn't run and nothing was charged.";
const UNCONFIRMED = "Preparation wasn't confirmed. Refresh the page before trying again.";
const NO_LINK = "This job has no secure (https) application link, so Apply Pilot can't prepare it. You can still apply on your own.";

export function prepareQuestion(host: string) {
  return `Prepare plans this application with Google Gemini (usually under 1¢) and lets Apply Pilot work on ${host}.`;
}

function blockerCopy(reason: string | null | undefined): { text: string; fix: ReadyFix | null } {
  return (reason && PREPARE_BLOCKER_COPY[reason as PreparationBlockingReason]) ||
    { text: "Preparation is blocked. Check the list above, then try again.", fix: null };
}

// What the step says about the run's current state; null when there is nothing to say.
function runStatus(run: PrepareStepRun | null): { text: string; fix: ReadyFix | null } | null {
  switch (run?.state) {
    case undefined:
    case "DRAFT":
      return null;
    case "BLOCKED":
      return blockerCopy(run.blockingReason);
    case "FAILED":
      return {
        text: PREPARE_FAILURE_COPY[run.errorCategory as PreparationErrorCategory] ?? "Preparation failed. You can try again.",
        fix: null
      };
    case "PREPARING":
      return { text: "Preparation is in progress. Refresh the page in a moment to see how it went.", fix: null };
    case "READY":
      return { text: "Prepared. Continue with step 5.", fix: null };
    case "REVIEW_REQUIRED":
      return { text: "Prepared, with things for you to check. Continue with step 5.", fix: null };
    default:
      return { text: "This application's browser run is already past Prepare.", fix: null };
  }
}

function runFailureText(error: unknown) {
  const kind = error instanceof RunRequestError ? error.kind : "uncertain";
  switch (kind) {
    case "storage":
      return "This browser's session storage is unavailable, so no browser run was created.";
    case "conflict":
      return "This application already has a browser run. The page is refreshing; then try again.";
    case "unauthorized":
      return "Sign in again to prepare this application.";
    case "refused":
      return "The browser run wasn't created. Try again.";
    default:
      return "The browser run wasn't confirmed. Trying again reuses the same request, so it won't create a second run.";
  }
}

function allowFailureText(error: unknown, host: string) {
  const code = error instanceof RunRequestError ? error.code : null;
  if (code === "AUTOMATION_POLICY_MODE_REQUIRES_REVIEW") {
    return `Assisted Fill is on, so Apply Pilot wasn't allowed on ${host}. Turn it off, then try again.`;
  }
  if (code === "RUN_HOST_BLOCKED") return `${host} is blocked or isn't a usable application site, so nothing was prepared.`;
  if (code === "RUN_INVALID_STATE") return "This browser run can't be prepared from its current state. The page is refreshing.";
  return `Apply Pilot wasn't allowed on ${host}, so nothing was prepared. Try again.`;
}

// The run after a Prepare request. A 2xx carries the run; otherwise (or when the response was lost)
// the run's durable state is read, since a lost or refused response never authorizes a replay.
async function preparedRun(response: Response | null, runId: string): Promise<RunSnapshot | null> {
  if (response?.ok) {
    try {
      return runSnapshotFromBody(await response.json(), runId);
    } catch {
      // Unreadable: fall back to reading the run.
    }
  }
  try {
    return await readApplicationRun(runId);
  } catch {
    return null;
  }
}

export function PrepareStep({ jobId, applicationId, applyHost, readyList, fillMode, run }: PrepareStepProps) {
  const router = useRouter();
  const { confirm, confirmFn, dialog } = useInPageConfirm();
  const inFlight = useRef(false);
  const mainButton = useRef<HTMLButtonElement>(null);
  // What this step created, until the refreshed page brings it: retries reuse them.
  const savedApplicationId = useRef<string | null>(null);
  const createdRunId = useRef<string | null>(null);
  const [phase, setPhase] = useState<"asking" | "working" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Local knowledge, each kept only while the server props it was learned against are unchanged:
  // a refreshed page (new props) is the authority again.
  const runKey = JSON.stringify(run);
  const listKey = JSON.stringify(readyList);
  const [learned, setLearned] = useState<{ basis: string; run: RunSnapshot } | null>(null);
  const [fillOffBasis, setFillOffBasis] = useState<string | null>(null);
  const [dismissedBasis, setDismissedBasis] = useState<string | null>(null);

  const current: PrepareStepRun | null = learned && learned.basis === runKey ? learned.run : run;
  const currentKey = JSON.stringify(current);
  const fillTurnedOff = fillOffBasis === listKey;
  const lines = fillTurnedOff ? readyList.filter((line) => line.key !== "fill_on") : readyList;
  const fillOn = fillMode === "FILL_AND_REVIEW" && !fillTurnedOff;
  const busy = phase !== null;
  const blocked = lines.some((line) => line.blocking && !line.ok);
  const state = current?.state ?? null;
  // Until the run is prepared. After that the list is moot (and Fill being on is expected at step 8).
  const showButton = state === null || STARTABLE.has(state) || state === "PREPARING";
  const canStart = !busy && !blocked && !fillOn && applyHost !== "" && (state === null || STARTABLE.has(state));
  const status = dismissedBasis === currentKey ? null : runStatus(current);

  async function allowAndPrepare() {
    if (inFlight.current || !canStart) return;
    inFlight.current = true;
    setPhase("asking");
    setMessage(null);
    const host = applyHost;
    const basis = runKey;
    let changedServer = false;
    let stage: "application" | "run" | "allow" | "prepare" = "application";
    try {
      if (!(await confirm({ title: "Allow and prepare?", body: prepareQuestion(host) }))) return;
      setPhase("working");

      let appId = applicationId ?? savedApplicationId.current;
      if (!appId) {
        appId = (await ensureApplication(jobId)).id;
        savedApplicationId.current = appId;
        changedServer = true;
      }

      stage = "run";
      let runId = current?.id ?? createdRunId.current;
      if (!runId) {
        const created = await ensureApplicationRun(appId);
        changedServer = true;
        createdRunId.current = created.id;
        setLearned({ basis, run: { id: created.id, state: created.state, blockingReason: null, errorCategory: null } });
        // The question named a host; never allow a different one.
        if (created.applyHost && created.applyHost !== host) {
          setMessage(`This job's application link now goes to ${created.applyHost}, so nothing was allowed. Check it, then try again.`);
          return;
        }
        runId = created.id;
      }

      stage = "allow";
      await allowHostForRun(runId);
      changedServer = true;

      stage = "prepare";
      // A second question only when the server asks about cost (over its threshold), with its maximum.
      const cost = { answer: null as boolean | null };
      const askCost: ConfirmFn = async (text) => {
        cost.answer = await confirmFn(text);
        return cost.answer;
      };
      let response: Response | null = null;
      try {
        response = await prepareRun(runId, askCost);
      } catch {
        if (cost.answer === false) {
          setMessage(CANCELED);
          return;
        }
        // Lost response: read what happened instead of sending it again.
      }
      const outcome = await preparedRun(response, runId);
      if (!outcome) {
        setMessage(UNCONFIRMED);
        return;
      }
      setLearned({ basis, run: outcome });
    } catch (error) {
      if (stage === "application") setMessage("Apply Pilot couldn't save this job, so nothing was prepared. Try again.");
      else if (stage === "run") setMessage(runFailureText(error));
      else if (stage === "allow") setMessage(allowFailureText(error, host));
      else setMessage(UNCONFIRMED);
      // These change what the server holds (or say it holds something else): let the page catch up.
      const code = error instanceof RunRequestError ? error.code : null;
      if ((error instanceof RunRequestError && error.kind === "conflict") || code === "RUN_INVALID_STATE") changedServer = true;
    } finally {
      if (changedServer) router.refresh();
      inFlight.current = false;
      setPhase(null);
    }
  }

  // The safe direction: no question, no reads first.
  async function turnOff() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("working");
    setMessage(null);
    try {
      await turnOffAssistedFill();
      setFillOffBasis(listKey);
    } catch {
      setMessage("Assisted Fill wasn't confirmed off. Refresh the page before trying again.");
    } finally {
      router.refresh();
      inFlight.current = false;
      setPhase(null);
    }
  }

  function retry() {
    setDismissedBasis(currentKey);
    mainButton.current?.focus();
  }

  function renderFix(fix: ReadyFix) {
    switch (fix.target) {
      case "step-1":
      case "step-2":
      case "step-3":
        return <a className="job-inline-link" href={`#${fix.target}`}>{fix.label}</a>;
      case "settings-ai":
        return <a className="job-inline-link" href="/settings/ai">{fix.label}</a>;
      case "turn-off-fill":
        return <button type="button" className="job-button" disabled={busy} onClick={() => { void turnOff(); }}>{fix.label}</button>;
      case "retry":
        return <button type="button" className="job-button" onClick={retry}>{fix.label}</button>;
    }
  }

  return (
    <div className="space-y-3" data-prepare-step>
      {showButton ? <ul className="space-y-2" aria-label="Ready to prepare">
        {lines.map((line) => (
          <li key={line.key} data-ready-line={line.key} data-ok={String(line.ok)} className="flex flex-wrap items-center gap-2">
            {line.ok
              ? <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" />
              : <XCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-rose-600" />}
            <span className="sr-only">{line.ok ? "Done: " : "Not yet: "}</span>
            <span className="job-card-copy">{line.text}</span>
            {!line.ok && line.fix ? renderFix(line.fix) : null}
            {!line.ok && line.key === "application_details"
              ? <a className="job-inline-link" href="/settings/application-details">Your application details</a>
              : null}
          </li>
        ))}
      </ul> : null}
      {showButton && applyHost === "" ? <p className="job-note">{NO_LINK}</p> : null}
      {showButton ? (
        <div className="job-actions">
          <button
            ref={mainButton}
            type="button"
            className="job-button job-button-primary"
            disabled={!canStart}
            aria-busy={busy || undefined}
            onClick={() => { void allowAndPrepare(); }}
          >
            Allow and prepare
          </button>
        </div>
      ) : null}
      {dialog}
      {phase === "working" ? (
        <p role="status" className="job-note">
          <Loader2 aria-hidden="true" className="mr-1 inline h-4 w-4 animate-spin" />
          Preparing. This can take a minute.
        </p>
      ) : null}
      {status ? (
        <p role="status" className="job-card-copy" data-prepare-outcome>
          {status.text}
          {status.fix ? <> {renderFix(status.fix)}</> : null}
        </p>
      ) : null}
      {message ? <p role="status" className="job-message job-message-info" data-prepare-message>{message}</p> : null}
    </div>
  );
}
