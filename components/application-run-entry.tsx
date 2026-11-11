"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { clearRunCreateKey, ensureApplicationRun, RunRequestError } from "@/lib/application-runs/client-run";

type RunDisplay = { id: string; state: string };

function failureMessage(error: unknown): string {
  const kind = error instanceof RunRequestError ? error.kind : "uncertain";
  if (kind === "storage") return "Browser session storage is unavailable. No creation request was sent.";
  if (kind === "conflict") return "An active run may already exist. The page is refreshing; any retry uses the same creation request.";
  if (kind === "unauthorized") return "Sign in as the application owner to create a browser run.";
  if (kind === "refused") return "The run was not confirmed. Refresh the page before retrying; a retry uses the same creation request.";
  return "The creation response is uncertain. The page is refreshing; a retry uses the same request.";
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
    if (initialRun) clearRunCreateKey(applicationId);
  }, [applicationId, initialRun]);

  async function createRun() {
    if (inFlight.current || run) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const created = await ensureApplicationRun(applicationId);
      setCreatedRun({ id: created.id, state: created.state });
      router.refresh();
    } catch (error) {
      setMessage(failureMessage(error));
      // Nothing was sent without session storage; otherwise the server may hold a run now.
      if (!(error instanceof RunRequestError && error.kind === "storage")) router.refresh();
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
