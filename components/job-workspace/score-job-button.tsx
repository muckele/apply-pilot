"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

// The one control that asks Apply Pilot to (re)score a job. It uses the existing
// cost-confirmed /api/jobs/[id]/match request and refreshes the page on success.
export function ScoreJobButton({
  jobId,
  label = "Score this job",
  variant = "primary",
  disabled = false
}: {
  jobId: string;
  label?: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function score() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetchWithAiCostConfirmation(`/api/jobs/${jobId}/match`, { method: "POST" });
      const json = (await response.json().catch(() => null)) as { error?: string; billingStatus?: string } | null;
      if (!response.ok) {
        const charged = json?.billingStatus === "not_charged" ? " You weren't charged." : "";
        setMessage({ error: true, text: `${json?.error ?? "Apply Pilot couldn't score this job. Nothing was saved."}${charged}` });
        return;
      }
      setMessage({ error: false, text: "Scored. Loading your match…" });
      router.refresh();
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
