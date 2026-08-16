"use client";

import { FormEvent, useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

type InterviewOption = {
  id: string;
  label: string;
  jobPostingId?: string | null;
};

type InterviewCreateFormProps = {
  applications: InterviewOption[];
  jobs: InterviewOption[];
};

type InterviewType = "RECRUITER" | "HIRING_MANAGER" | "TECHNICAL" | "PANEL" | "FINAL" | "OTHER";

async function responseMessage(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Could not save interview.";
}

export function InterviewCreateForm({ applications, jobs }: InterviewCreateFormProps) {
  const router = useRouter();
  const [recordId, setRecordId] = useState(applications[0] ? `application:${applications[0].id}` : jobs[0] ? `job:${jobs[0].id}` : "");
  const [type, setType] = useState<InterviewType>("RECRUITER");
  const [scheduledAt, setScheduledAt] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [locationOrLink, setLocationOrLink] = useState("");
  const [interviewers, setInterviewers] = useState("");
  const [generatePrep, setGeneratePrep] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);

    const [recordType, id] = recordId.split(":");
    const body = {
      type,
      applicationId: recordType === "application" ? id : undefined,
      jobPostingId: recordType === "job" ? id : undefined,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
      locationOrLink: locationOrLink.trim() || undefined,
      interviewerNames: interviewers
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      generatePrep
    };

    try {
      const response = await fetchWithAiCostConfirmation("/api/interviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        setMessage(await responseMessage(response));
        return;
      }

      setMessage("Interview saved.");
      setScheduledAt("");
      setDurationMinutes("");
      setLocationOrLink("");
      setInterviewers("");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save interview.");
    } finally {
      setPending(false);
    }
  }

  const hasTarget = Boolean(recordId);

  return (
    <form onSubmit={submit} className="space-y-4 p-5">
      <label className="block text-xs font-semibold text-slate-700">
        Link to
        <select
          value={recordId}
          onChange={(event) => setRecordId(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-700"
        >
          {applications.map((application) => (
            <option key={`application:${application.id}`} value={`application:${application.id}`}>
              Application: {application.label}
            </option>
          ))}
          {jobs.map((job) => (
            <option key={`job:${job.id}`} value={`job:${job.id}`}>
              Job: {job.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-700">
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value as InterviewType)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-700"
          >
            <option value="RECRUITER">Recruiter</option>
            <option value="HIRING_MANAGER">Hiring manager</option>
            <option value="TECHNICAL">Technical</option>
            <option value="PANEL">Panel</option>
            <option value="FINAL">Final</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          Duration
          <input
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(event.target.value)}
            placeholder="45"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700"
          />
        </label>
      </div>

      <label className="block text-xs font-semibold text-slate-700">
        Date and time
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700"
        />
      </label>

      <label className="block text-xs font-semibold text-slate-700">
        Location or link
        <input
          value={locationOrLink}
          onChange={(event) => setLocationOrLink(event.target.value)}
          placeholder="Zoom, phone, office, or notes"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700"
        />
      </label>

      <label className="block text-xs font-semibold text-slate-700">
        Interviewers
        <input
          value={interviewers}
          onChange={(event) => setInterviewers(event.target.value)}
          placeholder="Comma-separated names"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-700"
        />
      </label>

      <label className="flex items-start gap-2 text-xs font-medium leading-5 text-slate-600">
        <input
          type="checkbox"
          checked={generatePrep}
          onChange={(event) => setGeneratePrep(event.target.checked)}
          className="mt-1"
        />
        Generate an interview prep brief from the linked job and profile.
      </label>

      <button
        type="submit"
        disabled={pending || !hasTarget}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <CalendarPlus size={16} aria-hidden="true" />}
        Save interview
      </button>

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p> : null}
      {!hasTarget ? <p className="text-xs leading-5 text-slate-500">Save or apply to a job before adding an interview.</p> : null}
    </form>
  );
}
