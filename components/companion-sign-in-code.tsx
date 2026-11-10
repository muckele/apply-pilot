"use client";

import { useState } from "react";

type CodeState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "issued"; code: string; expiresAt: string }
  | { kind: "error" };

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

// Shown in the owner's own signed-in browser. The code it issues is typed into the
// companion's separate window, where Google sign-in is refused.
export function CompanionSignInCode({ runId }: { runId: string }) {
  const [state, setState] = useState<CodeState>({ kind: "idle" });

  async function getCode() {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    try {
      const response = await fetch(`/api/application-runs/${runId}/companion-sign-in-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-store"
      });
      const body = (await response.json().catch(() => null)) as { code?: unknown; expiresAt?: unknown } | null;
      if (!response.ok || typeof body?.code !== "string" || typeof body.expiresAt !== "string") {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "issued", code: body.code, expiresAt: body.expiresAt });
    } catch {
      setState({ kind: "error" });
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-950">Companion sign-in</p>
      <p>
        Google won&apos;t sign in inside the companion&apos;s automated window. Get a one-time code here and type it
        into that window instead.
      </p>
      <button
        type="button"
        data-testid="companion-code-button"
        disabled={state.kind === "busy"}
        onClick={() => { void getCode(); }}
        className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-60"
      >
        {state.kind === "issued" ? "Get a new code" : "Get a companion sign-in code"}
      </button>
      {state.kind === "issued" ? (
        <div role="status" className="space-y-1">
          <p>
            Code: <strong data-testid="companion-code" className="font-mono text-base tracking-wider text-slate-950">{state.code}</strong>
          </p>
          <p>
            Type it in the companion window (the separate &ldquo;Google Chrome for Testing&rdquo; window) when it asks you
            to sign in. It works once, for 5 minutes (until {timeFormat.format(new Date(state.expiresAt))}), and only for
            this run. Don&apos;t share it.
          </p>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <p role="status">Apply Pilot couldn&apos;t get a code. Refresh the page and try again.</p>
      ) : null}
    </div>
  );
}
