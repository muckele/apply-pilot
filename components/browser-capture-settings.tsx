"use client";

import { useState } from "react";
import { Clipboard, KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";

type BrowserToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function BrowserCaptureSettings({
  initialTokens,
  appUrl
}: {
  initialTokens: BrowserToken[];
  appUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("Chrome on this computer");
  const [includeAnswers, setIncludeAnswers] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createToken() {
    setPending("create");
    setMessage(null);
    setCreatedToken(null);
    const response = await fetch("/api/browser-capture/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, includeAnswers, expiresInDays: Number(expiresInDays) })
    });
    const json = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    setPending(null);

    if (!response.ok || !json?.token) {
      setMessage(json?.error ?? "The browser token could not be created.");
      return;
    }

    setCreatedToken(json.token);
    setMessage("Token created. It is shown once; add it to the extension before leaving this page.");
    router.refresh();
  }

  async function revokeToken(id: string) {
    if (!window.confirm("Revoke this browser token? The extension will stop working until it receives a new token.")) return;

    setPending(id);
    setMessage(null);
    const response = await fetch(`/api/browser-capture/tokens/${id}`, { method: "DELETE" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    setPending(null);

    if (!response.ok) {
      setMessage(json?.error ?? "The token could not be revoked.");
      return;
    }

    setMessage("Browser token revoked.");
    router.refresh();
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setMessage(`Clipboard access was blocked. Select and copy the ${label.toLowerCase()} manually.`);
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_140px]">
          <label className="text-sm font-medium text-slate-700">
            Token name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Expires in days
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
            />
          </label>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={includeAnswers}
            onChange={(event) => setIncludeAnswers(event.target.checked)}
            className="mt-1"
          />
          Allow this token to read active answers from the Application Answer Vault. The extension only displays and copies them.
        </label>
        <PrimaryButton type="button" onClick={createToken} disabled={pending !== null || name.trim().length < 2} className="mt-4">
          {pending === "create" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <KeyRound className="mr-2" size={15} />}
          Generate browser token
        </PrimaryButton>
      </div>

      {createdToken ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <p className="text-sm font-semibold">Copy this token now</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={createdToken} className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2 font-mono text-xs" />
            <SecondaryButton type="button" onClick={() => copy(createdToken, "Token")} title="Copy token">
              <span className="sr-only">Copy token</span>
              <Clipboard size={16} />
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-xs font-semibold uppercase text-slate-500">App URL</p>
          <p className="mt-2 break-all font-mono text-xs text-slate-800">{appUrl}</p>
          <SecondaryButton type="button" onClick={() => copy(appUrl, "App URL")} className="mt-3">
            <Clipboard className="mr-2" size={15} /> Copy URL
          </SecondaryButton>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-2">
            <PlugZap size={17} className="text-brand-600" />
            <p className="text-sm font-semibold text-slate-950">Load the extension</p>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Open <span className="font-mono text-xs">chrome://extensions</span>, enable Developer mode, choose Load unpacked,
            and select the repository&apos;s <span className="font-mono text-xs">browser-extension</span> folder.
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {initialTokens.length ? (
          initialTokens.map((token) => {
            const inactive = Boolean(token.revokedAt) || Boolean(token.expiresAt && new Date(token.expiresAt) <= new Date());
            return (
              <div key={token.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-950">{token.name}</p>
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${inactive ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"}`}>
                      {inactive ? "Inactive" : "Active"}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-slate-500">{token.tokenPrefix}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Last used {formatDate(token.lastUsedAt)} - Expires {formatDate(token.expiresAt)}
                  </p>
                </div>
                {!inactive ? (
                  <button
                    type="button"
                    onClick={() => revokeToken(token.id)}
                    disabled={pending === token.id}
                    className="inline-flex items-center justify-center rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {pending === token.id ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Trash2 className="mr-2" size={15} />}
                    Revoke
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="p-6 text-center text-sm text-slate-600">No browser tokens created.</div>
        )}
      </div>
    </div>
  );
}
