"use client";

import { useState } from "react";
import { Import, Loader2 } from "lucide-react";
import Link from "next/link";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

type ImportResult = {
  job: { id: string; title: string; company: string };
  application: { id: string };
  match: { match: { overallFitScore: number } } | null;
  scoring: { status: "scored" | "unavailable" | "failed" | "not_requested" };
} | { error: string } | { uncertain: string };

function optionalNumber(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number(value);
}

function optionalText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalLineList(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const items = value.split("\n").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function ManualJobImportForm() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    const formData = new FormData(event.currentTarget);
    const runMatch = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "true";
    const salaryMin = optionalNumber(formData, "salaryMin");
    const salaryMax = optionalNumber(formData, "salaryMax");
    const datePosted = optionalText(formData, "datePosted");
    const requirements = optionalLineList(formData, "requirements");
    const preferredQualifications = optionalLineList(formData, "preferredQualifications");
    const payload = {
      title: String(formData.get("title") ?? ""),
      company: String(formData.get("company") ?? ""),
      location: String(formData.get("location") ?? ""),
      remoteStatus: String(formData.get("remoteStatus") ?? ""),
      ...(salaryMin !== undefined ? { salaryMin } : {}),
      ...(salaryMax !== undefined ? { salaryMax } : {}),
      ...(datePosted ? { datePosted } : {}),
      sourceUrl: String(formData.get("sourceUrl") ?? ""),
      applyUrl: String(formData.get("applyUrl") ?? "") || undefined,
      description: String(formData.get("description") ?? ""),
      ...(requirements ? { requirements } : {}),
      ...(preferredQualifications ? { preferredQualifications } : {}),
      runMatch
    };

    try {
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      };
      const response = runMatch
        ? await fetchWithAiCostConfirmation("/api/jobs/import", request)
        : await fetch("/api/jobs/import", request);
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
          Minimum annual salary
          <input name="salaryMin" type="number" min="0" step="1" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Maximum annual salary
          <input name="salaryMax" type="number" min="0" step="1" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Date posted
          <input name="datePosted" type="date" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
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
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Requirements
          <textarea
            name="requirements"
            rows={5}
            placeholder="One requirement per line"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Preferred qualifications
          <textarea
            name="preferredQualifications"
            rows={5}
            placeholder="One preferred qualification per line"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>
      </div>
      <p className="text-xs leading-5 text-slate-500">
        Import only saves the job without requesting AI scoring. You can score it later from the job page.
      </p>
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="submit" value="false" disabled={pending}>
          {pending ? <Loader2 className="mr-2 animate-spin" size={16} aria-hidden="true" /> : <Import className="mr-2" size={16} aria-hidden="true" />}
          Import only
        </PrimaryButton>
        <SecondaryButton type="submit" value="true" disabled={pending}>
          Import and score
        </SecondaryButton>
      </div>
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
