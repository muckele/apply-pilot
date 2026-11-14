"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { BigWindow } from "@/components/ui/big-window";
import { SENT_TO_GEMINI } from "@/lib/apply-page/ai-data-copy";
import { hasSeenGeminiNotice, rememberGeminiNotice } from "@/lib/apply-page/gemini-notice";

export const GEMINI_NOTICE_TITLE = "Before Apply Pilot starts";

function browserStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

// The Apply page tells the user once (per account on this browser) what it sends to Google Gemini.
// `ensure` resolves true straight away once seen; the first time it opens the big window and
// resolves when the user answers. "Continue" is the consent the AI requests' headers carry.
export function useGeminiNotice(accountKey: string): { ensure: () => Promise<boolean>; window: ReactNode } {
  const [asking, setAsking] = useState(false);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const titleId = useId();

  const settle = useCallback((answer: boolean) => {
    if (answer) rememberGeminiNotice(browserStorage(), accountKey);
    const resolve = resolver.current;
    resolver.current = null;
    setAsking(false);
    resolve?.(answer);
  }, [accountKey]);

  const ensure = useCallback(() => {
    if (hasSeenGeminiNotice(browserStorage(), accountKey)) return Promise.resolve(true);
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setAsking(true);
    });
  }, [accountKey]);

  useEffect(() => () => {
    resolver.current?.(false);
    resolver.current = null;
  }, []);

  const window = asking ? (
    <BigWindow labelledBy={titleId} onClose={() => settle(false)} dataAttribute="data-gemini-notice">
      <h2 id={titleId} tabIndex={-1} className="big-window-title">{GEMINI_NOTICE_TITLE}</h2>
      <p className="big-window-copy">
        Apply Pilot uses Google Gemini to check your match and write your documents. It sends {SENT_TO_GEMINI}. It never
        sends your contact details or your saved answers.
      </p>
      <p className="job-hint">You&apos;ll see this once.</p>
      <div className="big-window-actions">
        <button type="button" className="job-button job-button-primary job-button-large" onClick={() => settle(true)}>Continue</button>
        <button type="button" className="job-link-button" onClick={() => settle(false)}>Not now</button>
      </div>
    </BigWindow>
  ) : null;

  return { ensure, window };
}
