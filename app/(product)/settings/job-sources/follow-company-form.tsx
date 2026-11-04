"use client";

import { useMemo, useState } from "react";
import { Building2, CheckCircle2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton } from "@/components/ui";
import { resolveBoardUrl, type BoardAts } from "@/lib/job-sources/board-url";

const atsLabels: Record<BoardAts, string> = { GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby" };

type FollowResponse = {
  created?: boolean;
  reenabled?: boolean;
  source?: { name: string };
  error?: string;
};

export function FollowCompanyForm({ directorySize }: { directorySize: number }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolved locally: the resolver is pure and never fetches the pasted URL.
  const resolution = useMemo(() => (url.trim() ? resolveBoardUrl(url) : null), [url]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resolution?.ok) {
      return;
    }

    setPending(true);
    setMessage(null);
    setError(null);

    const response = await fetch("/api/job-sources/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, name: name.trim() || undefined })
    });
    const json = (await response.json()) as FollowResponse;

    if (!response.ok) {
      setError(json.error ?? "Unable to follow this board.");
    } else {
      const company = json.source?.name ?? resolution.token;
      setMessage(
        json.created
          ? `Following ${company}. Its board is checked during discovery and the daily run.`
          : json.reenabled
            ? `Following ${company} again.`
            : `You already follow ${company}.`
      );
      setUrl("");
      setName("");
      router.refresh();
    }

    setPending(false);
  }

  return (
    <form onSubmit={submit} className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
      <div className="flex items-center gap-2">
        <Building2 size={17} className="text-brand-600" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-950">Follow a company</h2>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Paste any Greenhouse, Lever or Ashby job or board link. Apply Pilot reads that company&apos;s public job board
        during discovery; it never submits applications.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] lg:items-end">
        <label className="block text-sm font-medium text-slate-700">
          Job or board link
          <input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setMessage(null);
              setError(null);
            }}
            placeholder="https://boards.greenhouse.io/company/jobs/123"
            inputMode="url"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Company name (optional)
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!resolution?.ok}
            maxLength={120}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
          />
        </label>
        <PrimaryButton type="submit" disabled={!resolution?.ok || pending} className="gap-2">
          {pending ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={16} aria-hidden="true" />
          )}
          Follow board
        </PrimaryButton>
      </div>
      {resolution ? (
        <p className={`mt-2 text-xs ${resolution.ok ? "text-emerald-700" : "text-slate-500"}`} aria-live="polite">
          {resolution.ok
            ? `${atsLabels[resolution.ats]} board "${resolution.token}"${resolution.region === "eu" ? " (EU)" : ""} found in this ${resolution.kind === "job" ? "job" : "board"} link.`
            : resolution.reason}
        </p>
      ) : null}
      {message ? (
        <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p>
      ) : null}
      {error ? <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      <p className="mt-3 text-xs leading-5 text-slate-500">
        Discovery also checks up to {directorySize} reviewed company boards from the Apply Pilot directory that match
        your industries, locations and remote preference. Disable a followed board below to stop checking it.
      </p>
    </form>
  );
}
