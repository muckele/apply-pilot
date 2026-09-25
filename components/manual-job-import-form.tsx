"use client";

import { useState } from "react";
import { Import, Loader2 } from "lucide-react";
import Link from "next/link";

import { PrimaryButton } from "@/components/ui";

type ImportResult = {
  job: { id: string; title: string; company: string };
  application: { id: string };
  match: { match: { overallFitScore: number } } | null;
  scoring: { status: "scored" | "unavailable" | "failed" | "not_requested" };
} | { error: string } | { uncertain: string };

export function ManualJobImportForm() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    const formData = new FormData(event.currentTarget);
    const payload = {
      title: String(formData.get("title") ?? ""),
      company: String(formData.get("company") ?? ""),
      location: String(formData.get("location") ?? ""),
      remoteStatus: String(formData.get("remoteStatus") ?? ""),
      sourceUrl: String(formData.get("sourceUrl") ?? ""),
      applyUrl: String(formData.get("applyUrl") ?? "") || undefined,
      description: String(formData.get("description") ?? ""),
      runMatch: true
    };

    try {
      const response = await fetch("/api/jobs/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = (await response.json()) as ImportResult;
      setResult(response.ok ? json : { error: "error" in json ? json.error : "The request could not be completed." });
    } catch {
      setResult({ uncertain: "Import status could not be confirmed. Check your jobs before trying again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Job title
          <input name="title" required className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Company
          <input name="company" required className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Location
          <input name="location" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Work style
          <select name="remoteStatus" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2">
            <option>Remote</option>
            <option>Hybrid</option>
            <option>On-site</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Source URL
          <input name="sourceUrl" type="url" required className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Apply URL
          <input name="applyUrl" type="url" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
      </div>
      <label className="block text-sm font-medium text-slate-700">
        Job description
        <textarea
          name="description"
          required
          rows={7}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
        />
      </label>
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? <Loader2 className="mr-2 animate-spin" size={16} aria-hidden="true" /> : <Import className="mr-2" size={16} aria-hidden="true" />}
        Import and score
      </PrimaryButton>
      {result ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          {"error" in result ? (
            <p className="text-red-700">Import failed: {result.error}</p>
          ) : "uncertain" in result ? (
            <p className="text-amber-800">{result.uncertain}</p>
          ) : (
            <>
              <p>
                {result.scoring.status === "scored" ? (
                  <>Imported {result.job.company} · {result.job.title}. Fit score: {result.match?.match.overallFitScore}.</>
                ) : result.scoring.status === "unavailable" ? (
                  <>Imported {result.job.company} · {result.job.title}. Match scoring is currently unavailable; you can score this job later.</>
                ) : result.scoring.status === "failed" ? (
                  <>Job imported successfully, but match scoring failed. Open the job to retry scoring.</>
                ) : (
                  <>Imported {result.job.company} · {result.job.title}. Match scoring was not requested.</>
                )}
              </p>
              <Link href={`/jobs/${result.job.id}`} className="mt-2 inline-block font-semibold text-brand-700 underline">
                Open imported job
              </Link>
            </>
          )}
        </div>
      ) : null}
    </form>
  );
}
