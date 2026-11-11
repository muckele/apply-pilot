"use client";

import { useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import {
  companionCodeCaret,
  formatCompanionCodeInput,
  hasImpossibleCompanionCodeCharacter
} from "@/lib/companion-sign-in-code-format";

type Problem = "refused" | "too-many-tries" | "unreachable";

// Shown in the Apply Pilot browser window, which Google refuses to sign in. You type the
// one-time code you got from this job's application page in your usual, signed-in browser.
export function CompanionSignInForm({
  callbackUrl,
  navigate = (url: string) => window.location.assign(url)
}: {
  callbackUrl: string;
  navigate?: (url: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const impossibleCharacter = hasImpossibleCompanionCodeCharacter(code);

  // Formatting adds and moves dashes; put the caret back after the character you just typed.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = caretRef.current;
    caretRef.current = null;
    if (input && caret !== null && input.ownerDocument.activeElement === input) {
      input.setSelectionRange(caret, caret);
    }
  }, [code]);

  function change(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const formatted = formatCompanionCodeInput(raw);
    caretRef.current = companionCodeCaret(raw, event.target.selectionStart ?? raw.length, formatted);
    setCode(formatted);
    setProblem(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
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
      setProblem(response.status === 429 ? "too-many-tries" : response.status === 400 ? "refused" : "unreachable");
    } catch {
      setProblem("unreachable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => { void submit(event); }} className="public-code-form">
      <label className="public-code-label" htmlFor="companion-code">Code</label>
      <div className="public-code-row">
        <input
          ref={inputRef}
          id="companion-code"
          name="code"
          value={code}
          onChange={change}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          aria-invalid={impossibleCharacter}
          aria-describedby={impossibleCharacter ? "companion-code-hint" : undefined}
          className="public-code-input"
        />
        <button type="submit" disabled={busy} className="public-button public-button-primary public-code-submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
      {impossibleCharacter ? (
        <p id="companion-code-hint" role="status" className="public-code-hint">
          Codes use letters and the digits 2–9. There&apos;s no O, I, 0 or 1.
        </p>
      ) : null}
      {problem === "refused" ? (
        <div role="alert" className="public-code-problem">
          <p><strong>That code didn&apos;t work.</strong> Usually it&apos;s one of these:</p>
          <ul>
            <li>It was mistyped.</li>
            <li>It&apos;s older than 5 minutes.</li>
            <li>It was replaced by a newer code. Getting a new code cancels the old one.</li>
            <li>It was already used.</li>
          </ul>
          <p>Get a new code from this job&apos;s application page in your usual browser, then type it here.</p>
        </div>
      ) : null}
      {problem === "too-many-tries" ? (
        <div role="alert" className="public-code-problem">
          <p>
            <strong>Too many tries.</strong> Wait 10 minutes, then get a new code from this job&apos;s application page
            in your usual browser.
          </p>
        </div>
      ) : null}
      {problem === "unreachable" ? (
        <div role="alert" className="public-code-problem">
          <p>
            <strong>Apply Pilot couldn&apos;t check the code.</strong> Check your internet connection and press Sign in
            again.
          </p>
        </div>
      ) : null}
    </form>
  );
}
