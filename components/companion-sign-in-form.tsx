"use client";

import { useState, type FormEvent } from "react";

// Shown in the companion's window, which Google refuses to sign in. The owner types the
// one-time code they got from the run's application page in their own signed-in browser.
export function CompanionSignInForm({
  callbackUrl,
  navigate = (url: string) => window.location.assign(url)
}: {
  callbackUrl: string;
  navigate?: (url: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/companion-sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, callbackUrl }),
        cache: "no-store"
      });
      const body = (await response.json().catch(() => null)) as { redirectTo?: unknown } | null;
      if (response.ok && typeof body?.redirectTo === "string" && body.redirectTo.startsWith("/application-runs/")) {
        navigate(body.redirectTo);
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => { void submit(event); }} className="space-y-3">
      <label className="block text-sm font-medium">
        Sign-in code
        <input
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono tracking-wider"
        />
      </label>
      <button type="submit" disabled={busy} className="public-button public-button-primary">
        {busy ? "Signing in…" : "Sign in the companion"}
      </button>
      {failed ? (
        <p role="status">
          That code didn&apos;t work. Codes work once, for 5 minutes. Get a new code from this run&apos;s application page
          in your signed-in browser.
        </p>
      ) : null}
    </form>
  );
}
