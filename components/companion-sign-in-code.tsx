"use client";

import { useState } from "react";

import { CopyButton } from "@/components/apply-kit/copy-button";

type CodeState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "issued"; code: string; expiresAt: string }
  | { kind: "error" };

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

// Shown in the owner's own signed-in browser. The code it issues is typed into the separate
// Apply Pilot browser window that the companion opens, where Google sign-in is refused.
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

  // The Apply page is dark: this box uses the page's own styles, so the code is readable there.
  return (
    <div className="space-y-2 rounded-lg border border-[var(--product-border)] p-3">
      <p className="job-card-title">Sign in the Apply Pilot browser window</p>
      <p className="job-note">
        Google won&apos;t sign in inside the Apply Pilot browser window (it shows as &lsquo;Google Chrome for
        Testing&rsquo;). Get a one-time code here and type it into that window instead.
      </p>
      <button
        type="button"
        data-testid="companion-code-button"
        disabled={state.kind === "busy"}
        onClick={() => { void getCode(); }}
        className={state.kind === "issued" ? "job-button" : "job-button job-button-primary"}
      >
        {state.kind === "issued" ? "Get a new code" : "Get a sign-in code"}
      </button>
      <p className="job-hint">Getting a new code cancels the previous one.</p>
      {state.kind === "issued" ? (
        <div role="status" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="job-note">
              Code: <strong data-testid="companion-code" className="font-mono text-lg tracking-wider text-[var(--product-text)]">{state.code}</strong>
            </p>
            <CopyButton value={state.code} label="sign-in code" />
          </div>
          <p className="job-note">
            Paste or type it into the Apply Pilot browser window when it asks you to sign in. It works once, for 5
            minutes (until {timeFormat.format(new Date(state.expiresAt))}), and only for this browser run. Don&apos;t share it.
          </p>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <p role="status" className="job-hint job-problem">Apply Pilot couldn&apos;t get a code. Refresh the page and try again.</p>
      ) : null}
    </div>
  );
}
