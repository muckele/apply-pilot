"use client";

import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton } from "@/components/ui";

type Settings = {
  monthlyBudgetCents: number;
  maxAnalysesPerSync: number;
  aiDiscoveryEnabled: boolean;
  modelOverride: string | null;
};

export function AiSettingsPanel({ initialSettings, allowedModels }: { initialSettings: Settings; allowedModels: string[] }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setMessage(null);
    const response = await fetch("/api/ai/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings)
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    setPending(false);

    if (!response.ok) {
      setMessage(json?.error ?? "AI settings could not be saved.");
      return;
    }

    setMessage("AI controls saved.");
    router.refresh();
  }

  return (
    <div className="space-y-5 p-5">
      <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={settings.aiDiscoveryEnabled}
          onChange={(event) => setSettings((current) => ({ ...current, aiDiscoveryEnabled: event.target.checked }))}
          className="mt-1"
        />
        <span>
          <span className="block font-semibold text-slate-950">AI-score top discovery candidates</span>
          <span className="mt-1 block leading-6">
            Deterministic filtering runs first. Only the strongest newly discovered jobs, up to the limit below, receive an AI match analysis.
          </span>
        </span>
      </label>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm font-medium text-slate-700">
          Monthly budget (USD)
          <input
            type="number"
            min={1}
            max={1000}
            step="0.50"
            value={(settings.monthlyBudgetCents / 100).toFixed(2)}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                monthlyBudgetCents: Math.max(100, Math.round(Number(event.target.value || 0) * 100))
              }))
            }
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          AI analyses per source sync
          <input
            type="number"
            min={0}
            max={25}
            value={settings.maxAnalysesPerSync}
            onChange={(event) =>
              setSettings((current) => ({ ...current, maxAnalysesPerSync: Number(event.target.value || 0) }))
            }
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Model override
          <select
            value={settings.modelOverride ?? ""}
            onChange={(event) => setSettings((current) => ({ ...current, modelOverride: event.target.value || null }))}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            <option value="">Use server default</option>
            {allowedModels.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-h-5 text-sm text-slate-600">{message}</p>
        <PrimaryButton type="button" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
          Save AI controls
        </PrimaryButton>
      </div>
    </div>
  );
}
