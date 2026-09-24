"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";

type RunDisplay = { id: string; state: string };

const RUN_STATES = [
  "DRAFT", "PREPARING", "READY", "FILLING", "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "BLOCKED", "FAILED", "CANCELLED"
] as const;

const createResponseSchema = z.object({
  run: z.object({
    id: z.string().cuid(),
    applicationId: z.string().cuid(),
    state: z.enum(RUN_STATES)
  })
});

function storageKey(applicationId: string) {
  return `application-run-create:${applicationId}`;
}

function requestKey(applicationId: string): string {
  const key = storageKey(applicationId);
  const retained = window.sessionStorage.getItem(key);
  if (retained) {
    if (!/^[a-f0-9-]{36}$/.test(retained)) throw new Error("The saved creation request is invalid.");
    return retained;
  }
  const generated = crypto.randomUUID();
  window.sessionStorage.setItem(key, generated);
  return generated;
}

export function ApplicationRunEntry({
  applicationId,
  initialRun
}: {
  applicationId: string;
  initialRun: RunDisplay | null;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [createdRun, setCreatedRun] = useState<RunDisplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = initialRun ?? createdRun;

  useEffect(() => {
    if (initialRun) {
      try { window.sessionStorage.removeItem(storageKey(applicationId)); } catch { /* Read-only display remains valid. */ }
    }
  }, [applicationId, initialRun]);

  async function createRun() {
    if (inFlight.current || run) return;
    let idempotencyKey: string;
    try {
      idempotencyKey = requestKey(applicationId);
    } catch {
      setMessage("Browser session storage is unavailable. No creation request was sent.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/application-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId, idempotencyKey }),
        cache: "no-store"
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(response.status === 409
          ? "An active run may already exist. The page is refreshing; any retry uses the same creation request."
          : response.status === 401 || response.status === 403
            ? "Sign in as the application owner to create a browser run."
            : "The run was not confirmed. Refresh the page before retrying; a retry uses the same creation request.");
        router.refresh();
        return;
      }
      const parsed = createResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.run.applicationId !== applicationId) {
        setMessage("The creation response is uncertain. The page is refreshing; a retry uses the same request.");
        router.refresh();
        return;
      }
      setCreatedRun({ id: parsed.data.run.id, state: parsed.data.run.state });
      try { window.sessionStorage.removeItem(storageKey(applicationId)); } catch { /* The run is already confirmed. */ }
      router.refresh();
    } catch {
      setMessage("The creation response is uncertain. The page is refreshing; a retry uses the same request.");
      router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-5 text-sm text-slate-700">
      {run ? (
        <>
          <p>Current browser run state: <strong>{run.state}</strong>.</p>
          <Link
            href={`/application-runs/${run.id}/browser`}
            data-testid="open-browser-run"
            className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3 py-2 font-semibold text-white hover:bg-brand-700"
          >
            Open browser run
          </Link>
        </>
      ) : (
        <button
          type="button"
          data-testid="create-browser-run"
          disabled={busy}
          onClick={() => { void createRun(); }}
          className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Creating browser run…" : "Create browser run"}
        </button>
      )}
      <p>Creating a run does not open or submit the employer form. A new run starts in DRAFT. Opening its control page does not make it ready to inspect or Fill.</p>
      <p>Preparation is separate and checks the allowed host and automation policy, fit and match-confidence scores, a selected tailored resume, and a cover letter when policy requires one.</p>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
