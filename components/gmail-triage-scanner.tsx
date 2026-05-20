"use client";

import { AlertCircle, CheckCircle2, ExternalLink, Inbox, MailOpen, RefreshCw, Save } from "lucide-react";
import { useState } from "react";

import { PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";

type TriageMessage = {
  gmailMessageId: string;
  gmailUrl: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  flagged: boolean;
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  reason: string;
  requestedAction: string;
  matchedApplicationId?: string;
};

type TriageResponse = {
  scannedCount: number;
  flaggedCount: number;
  savedCount: number;
  messages: TriageMessage[];
};

function formatEmailDate(value: string) {
  if (!value) {
    return "No date";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function priorityClass(priority: TriageMessage["priority"]) {
  if (priority === "HIGH") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (priority === "MEDIUM") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-600";
}

export function GmailTriageScanner({ connected }: { connected: boolean }) {
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<"scan" | "save" | null>(null);

  async function runTriage(saveFlagged: boolean) {
    setError(null);
    setLoadingAction(saveFlagged ? "save" : "scan");

    try {
      const response = await fetch("/api/gmail/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResultsPerQuery: 12, saveFlagged })
      });
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error ?? "Gmail triage failed.");
      }

      setResult(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Gmail triage failed.");
    } finally {
      setLoadingAction(null);
    }
  }

  const flaggedMessages = result?.messages.filter((message) => message.flagged) ?? [];
  const ignoredCount = result ? result.scannedCount - result.flaggedCount : 0;

  return (
    <div className="space-y-4 p-5">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
        <div className="flex items-start gap-3">
          <Inbox className="mt-0.5 text-brand-600" size={18} aria-hidden="true" />
          <div>
            <p className="font-semibold text-slate-950">Recruiter inbox triage</p>
            <p className="mt-1">
              Scans recent Gmail metadata and snippets for recruiter outreach, hiring-team replies, interview requests,
              assessments, offers, rejections, and application updates. Full email bodies are not stored.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <PrimaryButton disabled={!connected || loadingAction !== null} onClick={() => runTriage(false)}>
          <RefreshCw className={loadingAction === "scan" ? "animate-spin" : ""} size={15} aria-hidden="true" />
          <span className="ml-2">Scan Gmail</span>
        </PrimaryButton>
        <SecondaryButton
          disabled={!connected || loadingAction !== null || !flaggedMessages.length}
          onClick={() => runTriage(true)}
        >
          <Save size={15} aria-hidden="true" />
          <span className="ml-2">Save flagged snippets</span>
        </SecondaryButton>
      </div>

      {!connected ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Connect Gmail first, then run the triage scan.
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <AlertCircle className="mt-0.5" size={16} aria-hidden="true" />
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 text-sm">
            <div>
              <p className="font-semibold text-slate-950">
                {result.flaggedCount} likely employment email{result.flaggedCount === 1 ? "" : "s"} from{" "}
                {result.scannedCount} scanned
              </p>
              {ignoredCount ? (
                <p className="mt-1 text-xs text-slate-500">
                  Ignored {ignoredCount} low-confidence social, newsletter, vendor, quote, or unrelated messages.
                </p>
              ) : null}
            </div>
            {result.savedCount ? (
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 size={16} aria-hidden="true" />
                Saved {result.savedCount} snippet{result.savedCount === 1 ? "" : "s"} to CRM
              </div>
            ) : null}
          </div>
          <div className="divide-y divide-slate-100">
            {flaggedMessages.length ? flaggedMessages.slice(0, 12).map((message) => (
              <article
                key={message.gmailMessageId}
                className="p-4 transition hover:bg-slate-50"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-start gap-2">
                      <MailOpen className="mt-0.5 shrink-0 text-brand-600" size={17} aria-hidden="true" />
                      <div className="min-w-0">
                        <a
                          href={message.gmailUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-semibold text-slate-950 hover:text-brand-700 hover:underline"
                        >
                          {message.subject}
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span className="max-w-full truncate">{message.from}</span>
                          <span>{formatEmailDate(message.date)}</span>
                          <span>{message.confidence}% confidence</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <StatusBadge status={message.category} />
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold ${priorityClass(message.priority)}`}
                    >
                      {message.priority}
                    </span>
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-sm leading-6 text-slate-700">{message.snippet}</p>
                </div>

                <div className="mt-3 grid gap-3 text-xs leading-5 text-slate-600 lg:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="font-semibold text-slate-800">Why flagged</p>
                    <p className="mt-1">{message.reason}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="font-semibold text-slate-800">Suggested action</p>
                    <p className="mt-1">{message.requestedAction}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    {message.matchedApplicationId ? <span>Matched to CRM application</span> : null}
                    {!message.flagged ? <span>Not saved unless manually reviewed</span> : null}
                  </div>
                  <a
                    href={message.gmailUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                    Open in Gmail
                  </a>
                </div>
              </article>
            )) : (
              <div className="p-6 text-sm leading-6 text-slate-600">
                No likely recruiter, employer, interview, or application-update emails were found in this scan.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
