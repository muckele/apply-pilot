"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { fetchWithAiConsent, fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";
import { aiErrorText } from "@/lib/apply-page/ai-error-text";

// The one control that asks Apply Pilot to (re)score a job, through /api/jobs/[id]/match.
//
// On the Apply page (beforeRun and onScored given) it is one click with no price (D037): beforeRun
// shows the one-time Gemini notice, the request carries the consent headers, and the page is told
// so it can refresh and show the result window. Elsewhere it keeps the server's cost question.
export function ScoreJobButton({
  jobId,
  label = "Score this job",
  variant = "primary",
  disabled = false,
  beforeRun,
  onScored
}: {
  jobId: string;
  label?: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  // Resolves false when the user declines the Gemini notice: then nothing is sent.
  beforeRun?: () => Promise<boolean>;
  // Called after a successful score instead of refreshing here.
  onScored?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const oneClick = beforeRun !== undefined;

  async function score() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      if (beforeRun && !(await beforeRun())) {
        setMessage({ error: false, text: "Nothing was sent." });
        return;
      }
      const url = `/api/jobs/${jobId}/match`;
      const response = oneClick
        ? await fetchWithAiConsent(url, { method: "POST" })
        : await fetchWithAiCostConfirmation(url, { method: "POST" });
      const json = (await response.json().catch(() => null)) as { error?: string; code?: string; billingStatus?: string } | null;
      if (!response.ok) {
        const fallback = "Apply Pilot couldn't score this job. Nothing was saved.";
        if (oneClick) {
          setMessage({ error: true, text: aiErrorText(json, fallback) });
        } else {
          const charged = json?.billingStatus === "not_charged" ? " You weren't charged." : "";
          setMessage({ error: true, text: `${json?.error ?? fallback}${charged}` });
        }
        return;
      }
      setMessage({ error: false, text: "Scored. Loading your match…" });
      if (onScored) onScored();
      else router.refresh();
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Apply Pilot couldn't score this job." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="job-score-action">
      <button
        type="button"
        className={`job-button ${variant === "primary" ? "job-button-primary" : ""}`}
        onClick={score}
        disabled={pending || disabled}
      >
        {pending ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        {label}
      </button>
      {message ? <p role={message.error ? "alert" : "status"} className={`job-message ${message.error ? "job-message-error" : "job-message-info"}`}>{message.text}</p> : null}
    </div>
  );
}
