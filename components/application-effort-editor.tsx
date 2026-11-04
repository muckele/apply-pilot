"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import { MAX_EFFORT_MINUTES, parseEffortMinutesInput } from "@/lib/applications/self-reported-effort";

// Adds or corrects the self-reported minutes for one application (WP1.9). Each save appends a
// timeline event; Insights uses the latest one.

type ApplicationEffortEditorProps = {
  applicationId: string;
  initialMinutes: number | null;
  canRecord: boolean;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string } | null;
}

export function ApplicationEffortEditor({ applicationId, initialMinutes, canRecord }: ApplicationEffortEditorProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const parsed = parseEffortMinutesInput(input);
  const minutes = parsed.ok ? parsed.minutes : null;

  function startEditing() {
    setInput(initialMinutes === null ? "" : String(initialMinutes));
    setError(null);
    setMessage(null);
    setEditing(true);
  }

  async function save() {
    if (minutes === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/effort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minutes })
      });
      if (!response.ok) {
        const json = await readJson(response);
        setError(json?.error ?? "Could not save the minutes. Nothing was changed.");
        return;
      }
      setEditing(false);
      setMessage(`Saved. Insights now uses ${minutes} minutes for this application.`);
      router.refresh();
    } catch {
      setError("Could not reach Apply Pilot. Nothing was changed; try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 p-5 text-sm text-slate-700">
      <p data-effort-current>
        Minutes this application took:{" "}
        <strong className="text-slate-950">{initialMinutes === null ? "Not recorded" : `${initialMinutes} min`}</strong>
      </p>
      {!canRecord ? (
        <p className="text-xs text-slate-500">You can add minutes once this application has an applied date.</p>
      ) : editing ? (
        <div className="space-y-2">
          <label htmlFor="tracker-effort-minutes" className="block text-sm font-medium text-slate-800">Minutes this application took</label>
          <input
            id="tracker-effort-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_EFFORT_MINUTES}
            step={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-describedby="tracker-effort-minutes-help"
            aria-invalid={parsed.ok ? undefined : true}
            className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            data-effort-minutes
          />
          <p id="tracker-effort-minutes-help" className="text-xs text-slate-500">
            Your own estimate, from reading the posting to submitting the employer&apos;s form. It is used only for your Insights page.
          </p>
          {!parsed.ok ? (
            <p className="text-xs text-amber-900" data-effort-error>Enter whole minutes from 1 to {MAX_EFFORT_MINUTES}.</p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={save} disabled={minutes === null || pending} data-effort-save>
              {pending ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : null}
              Save minutes
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => setEditing(false)} disabled={pending} data-effort-cancel>Cancel</SecondaryButton>
          </div>
        </div>
      ) : (
        <SecondaryButton type="button" onClick={startEditing} data-effort-edit>
          {initialMinutes === null ? "Add minutes" : "Correct minutes"}
        </SecondaryButton>
      )}
      {message ? <p role="status" className="text-xs text-emerald-800" data-effort-message>{message}</p> : null}
    </div>
  );
}
