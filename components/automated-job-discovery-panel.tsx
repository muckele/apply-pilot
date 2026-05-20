"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";

type DiscoveryResult = {
  imported: number;
  queries: string[];
  location: string;
  jobs: Array<{
    id: string;
    title: string;
    company: string;
    location?: string | null;
    sourceType: string;
    fitScore?: number | null;
  }>;
  scoredJobs: Array<{ jobId: string; score?: number; error?: string }>;
  reports: Array<{
    name: string;
    type: string;
    status: "imported" | "skipped" | "blocked" | "error";
    imported: number;
    skipped?: number;
    bestRelevanceScore?: number;
    details: string;
  }>;
  restrictedBoards: Array<{
    name: string;
    reason: string;
    allowedPath: string;
    policyUrl: string;
  }>;
  error?: string;
};

const defaultQueryText = [
  "Sales Engineer",
  "Solutions Engineer",
  "Technical Account Manager",
  "Customer Success Engineer",
  "Implementation Specialist",
  "Full-Stack Developer",
  "Junior Software Engineer",
  "SaaS Operations"
].join(", ");

export function AutomatedJobDiscoveryPanel() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiscoveryResult | null>(null);

  async function runDiscovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);

    const formData = new FormData(event.currentTarget);
    const queries = String(formData.get("queries") ?? "")
      .split(",")
      .map((query) => query.trim())
      .filter(Boolean);

    const response = await fetch("/api/jobs/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries,
        location: String(formData.get("location") ?? "") || undefined,
        remoteOnly: formData.get("remoteOnly") === "on",
        scoreImported: formData.get("scoreImported") === "on",
        limitPerQuery: Number(formData.get("limitPerQuery") ?? 8),
        maxJobsToScore: 6
      })
    });
    const json = (await response.json()) as DiscoveryResult;

    setResult(response.ok ? json : { ...json, imported: 0, queries, location: "", jobs: [], scoredJobs: [], reports: [], restrictedBoards: [] });
    setPending(false);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <form onSubmit={runDiscovery} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Target searches
          <textarea
            name="queries"
            defaultValue={defaultQueryText}
            rows={3}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
          <label className="text-sm font-medium text-slate-700">
            Location
            <input
              name="location"
              defaultValue="Los Angeles, CA"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Per search
            <input
              name="limitPerQuery"
              type="number"
              min={1}
              max={25}
              defaultValue={8}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="grid gap-2 text-sm text-slate-700">
          <label className="inline-flex items-center gap-2">
            <input name="remoteOnly" type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" />
            Remote-only where the provider supports it
          </label>
          <label className="inline-flex items-center gap-2">
            <input name="scoreImported" type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" />
            Run AI fit scoring on the first matches
          </label>
        </div>
        <PrimaryButton type="submit" disabled={pending} className="w-full gap-2">
          {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
          Run automated discovery
        </PrimaryButton>
      </form>

      {result?.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{result.error}</div>
      ) : null}

      {result && !result.error ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <CheckCircle2 size={16} aria-hidden="true" />
              {result.imported} jobs imported or updated
            </div>
            <p className="mt-1 text-xs leading-5 text-emerald-800">
              Searched {result.queries.length} target terms around {result.location || "your profile locations"}.
            </p>
          </div>

          {result.jobs.length ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase text-slate-500">Recent imports</p>
              <div className="space-y-2">
                {result.jobs.slice(0, 6).map((job) => (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className="block rounded-lg border border-slate-200 bg-white p-3 text-sm hover:border-brand-200 hover:bg-brand-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-950">{job.title}</p>
                        <p className="mt-1 text-xs text-slate-600">
                          {job.company} · {job.location || "Location not listed"}
                        </p>
                      </div>
                      <StatusBadge status={job.sourceType} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-slate-500">Source run</p>
            <div className="space-y-2">
              {result.reports.map((report) => (
                <div key={`${report.name}-${report.type}`} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Bot size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
                      <p className="truncate text-sm font-semibold text-slate-900">{report.name}</p>
                    </div>
                    <StatusBadge status={report.status} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    {report.imported} imported
                    {typeof report.skipped === "number" ? ` · ${report.skipped} filtered` : ""}
                    {report.bestRelevanceScore ? ` · best relevance ${report.bestRelevanceScore}%` : ""}. {report.details}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle size={16} aria-hidden="true" />
              Restricted job boards
            </div>
            <div className="mt-3 space-y-3">
              {result.restrictedBoards.map((board) => (
                <div key={board.name} className="rounded-lg border border-amber-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{board.name}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">{board.reason}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-700">{board.allowedPath}</p>
                    </div>
                    <a
                      href={board.policyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-800 hover:text-amber-950"
                    >
                      Policy
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <SecondaryButton type="button" onClick={() => router.refresh()} className="w-full">
            Refresh jobs
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
}
