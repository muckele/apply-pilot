"use client";

import { useRef, useState } from "react";
import { Loader2, MessageSquareText, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";
import { INTERVIEW_CONSENT_STATEMENT } from "@/lib/interviews/audio-policy";

type AiActionProps = {
  interviewId: string;
  aiAvailable: boolean;
  unavailableMessage: string;
};

async function errorMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

function UnavailableNotice({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
      AI unavailable. {message} No template or placeholder content is generated instead.
    </p>
  );
}

export function InterviewPrepAction({ interviewId, aiAvailable, unavailableMessage, hasPrep }: AiActionProps & { hasPrep: boolean }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function generate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetchWithAiCostConfirmation(`/api/interviews/${interviewId}/prep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      if (!response.ok) {
        setMessage(await errorMessage(response, "Interview prep could not be generated."));
        return;
      }
      setMessage("Prep saved. Review every STAR story and fill in any [add a number here] gaps with numbers you can verify.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Interview prep status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!aiAvailable) return <UnavailableNotice message={unavailableMessage} />;
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-slate-600">
        Uses only your master-resume facts and the linked job post. You confirm the data sent to Google Gemini and the maximum cost first.
      </p>
      <PrimaryButton type="button" onClick={generate} disabled={pending}>
        {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Sparkles className="mr-2" size={15} />}
        {hasPrep ? "Regenerate prep" : "Generate prep brief"}
      </PrimaryButton>
      {message ? <p className="text-xs leading-5 text-slate-700">{message}</p> : null}
    </div>
  );
}

export function InterviewFeedbackAction({ interviewId, aiAvailable, unavailableMessage }: AiActionProps) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [transcript, setTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hasTranscript = transcript.trim().length > 0;

  async function generate() {
    if (inFlight.current) return;
    if (hasTranscript && !consent) {
      setMessage("Confirm participant consent before using a pasted transcript.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetchWithAiCostConfirmation(`/api/interviews/${interviewId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hasTranscript
          ? { transcript, transcriptConsentConfirmed: consent }
          : {})
      });
      if (!response.ok) {
        setMessage(await errorMessage(response, "Interview feedback could not be generated."));
        return;
      }
      setMessage("Feedback saved. The thank-you email is a draft: review it and send it yourself.");
      setTranscript("");
      setConsent(false);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Interview feedback status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!aiAvailable) return <UnavailableNotice message={unavailableMessage} />;
  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold text-slate-700">
        Paste a transcript (optional)
        <textarea
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          rows={5}
          maxLength={60_000}
          placeholder="Apply Pilot does not transcribe audio. Paste your own transcript here; it is used for this request only."
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700"
        />
      </label>
      {hasTranscript ? (
        <label className="flex items-start gap-2 text-xs leading-5 text-slate-700">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1" />
          {INTERVIEW_CONSENT_STATEMENT}
        </label>
      ) : null}
      <SecondaryButton type="button" onClick={generate} disabled={pending}>
        {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <MessageSquareText className="mr-2" size={15} />}
        Generate feedback and thank-you draft
      </SecondaryButton>
      {message ? <p className="text-xs leading-5 text-slate-700">{message}</p> : null}
    </div>
  );
}
