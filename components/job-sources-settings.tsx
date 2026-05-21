"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Pencil, Play, Plus, Power, Trash2, Wifi } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";

type JobSourceItem = {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  boardToken: string | null;
  allowlisted: boolean;
  robotsChecked: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  syncEnabled: boolean;
  notes: string | null;
  _count?: {
    jobPostings: number;
  };
};

type SourceFormState = {
  name: string;
  type: string;
  baseUrl: string;
  boardToken: string;
  syncEnabled: boolean;
  allowlisted: boolean;
  notes: string;
};

const sourceTypes = [
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "WORKABLE",
  "RSS",
  "COMPANY_CAREERS",
  "REMOTIVE",
  "ADZUNA",
  "THEIRSTACK",
  "SERPAPI",
  "USAJOBS"
];

const emptyForm: SourceFormState = {
  name: "",
  type: "GREENHOUSE",
  baseUrl: "",
  boardToken: "",
  syncEnabled: true,
  allowlisted: false,
  notes: ""
};

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function sourceHelp(type: string) {
  if (["GREENHOUSE", "LEVER", "ASHBY", "WORKABLE"].includes(type)) {
    return "Use board token / query for the company slug, such as acme or acme-careers.";
  }

  if (["RSS", "COMPANY_CAREERS"].includes(type)) {
    return "Use source URL for the feed or permitted careers page.";
  }

  return "Use board token / query for the default search term. Provider API keys still live in environment variables.";
}

function toForm(source: JobSourceItem): SourceFormState {
  return {
    name: source.name,
    type: source.type,
    baseUrl: source.baseUrl ?? "",
    boardToken: source.boardToken ?? "",
    syncEnabled: source.syncEnabled,
    allowlisted: source.allowlisted,
    notes: source.notes ?? ""
  };
}

export function JobSourcesSettings({ initialSources }: { initialSources: JobSourceItem[] }) {
  const router = useRouter();
  const [sources, setSources] = useState(initialSources);
  const [form, setForm] = useState<SourceFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabledCount = useMemo(() => sources.filter((source) => source.syncEnabled).length, [sources]);

  async function refreshSources() {
    const response = await fetch("/api/job-sources", { cache: "no-store" });
    const json = await response.json();

    if (response.ok) {
      setSources(json.sources);
      router.refresh();
    }
  }

  async function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingKey("save");
    setError(null);
    setMessage(null);

    const payload = {
      ...form,
      baseUrl: form.baseUrl || null,
      boardToken: form.boardToken || null,
      notes: form.notes || null
    };
    const response = await fetch(editingId ? `/api/job-sources/${editingId}` : "/api/job-sources", {
      method: editingId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await response.json();

    if (!response.ok) {
      setError(json.error ?? "Unable to save source.");
    } else {
      setMessage(editingId ? "Source updated." : "Source added.");
      setEditingId(null);
      setForm(emptyForm);
      await refreshSources();
    }

    setPendingKey(null);
  }

  async function runSourceAction(source: JobSourceItem, action: "test" | "sync" | "delete" | "toggle") {
    if (action === "delete") {
      const savedJobs = source._count?.jobPostings ?? 0;
      const confirmed = window.confirm(
        `Delete ${source.name}? ${savedJobs} saved job${savedJobs === 1 ? "" : "s"} will keep their job records but lose this source link.`
      );

      if (!confirmed) {
        return;
      }
    }

    const key = `${action}:${source.id}`;
    setPendingKey(key);
    setError(null);
    setMessage(null);

    const endpoint =
      action === "test"
        ? `/api/job-sources/${source.id}/test`
        : action === "sync"
          ? `/api/job-sources/${source.id}/sync`
          : action === "delete"
            ? `/api/job-sources/${source.id}?confirm=${encodeURIComponent(source.id)}`
            : `/api/job-sources/${source.id}`;
    const method = action === "delete" ? "DELETE" : action === "toggle" ? "PATCH" : "POST";
    const body =
      action === "toggle"
        ? JSON.stringify({ syncEnabled: !source.syncEnabled })
        : action === "delete"
          ? undefined
          : JSON.stringify({ limit: action === "test" ? 1 : 25 });

    const response = await fetch(endpoint, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body
    });
    const json = await response.json();

    if (!response.ok) {
      setError(json.error ?? `${action} failed.`);
    } else {
      const actionMessage =
        action === "test"
          ? `Test passed${json.sample?.title ? `: ${json.sample.title}` : "."}`
          : action === "sync"
            ? `Sync complete: ${json.imported} imported or updated, ${json.skipped} filtered.`
            : action === "toggle"
              ? `Sync ${source.syncEnabled ? "disabled" : "enabled"} for ${source.name}.`
              : "Source deleted.";
      setMessage(actionMessage);
      await refreshSources();
    }

    setPendingKey(null);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <section className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
            <p className="text-xs font-medium uppercase text-slate-500">Sources</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{sources.length}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
            <p className="text-xs font-medium uppercase text-slate-500">Sync enabled</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{enabledCount}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
            <p className="text-xs font-medium uppercase text-slate-500">Saved postings</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {sources.reduce((total, source) => total + (source._count?.jobPostings ?? 0), 0)}
            </p>
          </div>
        </div>

        {message ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            {message}
          </div>
        ) : null}
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-soft">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-950">Configured sources</h2>
            <p className="mt-1 text-xs text-slate-500">
              Manual sync is allowed here. Scheduled sync only runs for enabled sources.
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {sources.length ? (
              sources.map((source) => (
                <div key={source.id} className="space-y-4 px-5 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-950">{source.name}</p>
                        <StatusBadge status={source.type} />
                        <StatusBadge status={source.syncEnabled ? "Sync enabled" : "Sync disabled"} />
                        {source.lastSyncStatus ? <StatusBadge status={source.lastSyncStatus} /> : null}
                      </div>
                      <p className="mt-1 text-sm text-slate-600">
                        {source.baseUrl || source.boardToken || "No URL or token configured"}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Last synced: {formatDate(source.lastSyncedAt)} · Saved postings:{" "}
                        {source._count?.jobPostings ?? 0}
                      </p>
                      {source.lastSyncError ? (
                        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                          {source.lastSyncError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <SecondaryButton
                        type="button"
                        className="gap-2"
                        disabled={Boolean(pendingKey)}
                        onClick={() => runSourceAction(source, "test")}
                      >
                        {pendingKey === `test:${source.id}` ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Wifi size={15} aria-hidden="true" />
                        )}
                        Test
                      </SecondaryButton>
                      <PrimaryButton
                        type="button"
                        className="gap-2"
                        disabled={Boolean(pendingKey)}
                        onClick={() => runSourceAction(source, "sync")}
                      >
                        {pendingKey === `sync:${source.id}` ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Play size={15} aria-hidden="true" />
                        )}
                        Sync
                      </PrimaryButton>
                      <SecondaryButton
                        type="button"
                        className="gap-2"
                        disabled={Boolean(pendingKey)}
                        onClick={() => runSourceAction(source, "toggle")}
                      >
                        <Power size={15} aria-hidden="true" />
                        {source.syncEnabled ? "Disable" : "Enable"}
                      </SecondaryButton>
                      <SecondaryButton
                        type="button"
                        className="gap-2"
                        disabled={Boolean(pendingKey)}
                        onClick={() => {
                          setEditingId(source.id);
                          setForm(toForm(source));
                          setMessage(null);
                          setError(null);
                        }}
                      >
                        <Pencil size={15} aria-hidden="true" />
                        Edit
                      </SecondaryButton>
                      <SecondaryButton
                        type="button"
                        className="gap-2"
                        disabled={Boolean(pendingKey)}
                        onClick={() => runSourceAction(source, "delete")}
                      >
                        {pendingKey === `delete:${source.id}` ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 size={15} aria-hidden="true" />
                        )}
                        Delete
                      </SecondaryButton>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-5 py-8 text-center text-sm text-slate-600">
                No job sources yet. Add one to start syncing from a permitted source.
              </div>
            )}
          </div>
        </div>
      </section>

      <aside>
        <form onSubmit={submitForm} className="rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
          <div className="mb-4 flex items-center gap-2">
            {editingId ? <Pencil size={17} className="text-brand-600" aria-hidden="true" /> : <Plus size={17} className="text-brand-600" aria-hidden="true" />}
            <h2 className="text-sm font-semibold text-slate-950">{editingId ? "Edit source" : "Add source"}</h2>
          </div>
          <div className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              Name
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Source type
              <select
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                {sourceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs leading-5 text-slate-500">{sourceHelp(form.type)}</span>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Source URL
              <input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="https://company.com/careers or RSS feed"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Board token / query
              <input
                value={form.boardToken}
                onChange={(event) => setForm({ ...form, boardToken: event.target.value })}
                placeholder="company slug or default search query"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Notes
              <textarea
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                rows={4}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <div className="space-y-2 text-sm text-slate-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.syncEnabled}
                  onChange={(event) => setForm({ ...form, syncEnabled: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                Enable scheduled sync
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.allowlisted}
                  onChange={(event) => setForm({ ...form, allowlisted: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                I reviewed this source as permitted or API-approved
              </label>
            </div>
            <PrimaryButton type="submit" disabled={pendingKey === "save"} className="w-full gap-2">
              {pendingKey === "save" ? (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={16} aria-hidden="true" />
              )}
              {editingId ? "Save changes" : "Add source"}
            </PrimaryButton>
            {editingId ? (
              <SecondaryButton
                type="button"
                className="w-full"
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm);
                }}
              >
                Cancel editing
              </SecondaryButton>
            ) : null}
          </div>
        </form>
      </aside>
    </div>
  );
}
