"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Save } from "lucide-react";

import { PrimaryButton } from "@/components/ui";
import type {
  ApplicationDetailKey,
  ApplicationDetailStatus,
  ApplicationDetailView,
  ApplicationDetailsView
} from "@/lib/application-details";

type Values = Record<ApplicationDetailKey, string>;

function valuesOf(details: ApplicationDetailsView): Values {
  return Object.fromEntries(details.fields.map((field) => [field.key, field.value])) as Values;
}

const STATUS_COPY: Record<ApplicationDetailStatus, { text: string; tone: string }> = {
  CONFIRMED: { text: "Fill uses this", tone: "text-emerald-700" },
  FROM_RESUME: { text: "From your résumé — save to confirm", tone: "text-amber-700" },
  NOT_USED: { text: "Saved but turned off for Fill — save to use it", tone: "text-amber-700" },
  DUPLICATE: { text: "Saved more than once — save to keep one", tone: "text-amber-700" },
  MISSING: { text: "Not added", tone: "text-slate-500" }
};

function statusFor(field: ApplicationDetailView, value: string): { text: string; tone: string } {
  if (value.trim() !== field.value.trim()) return { text: "Not saved yet", tone: "text-amber-700" };
  if (field.status === "MISSING" && field.importance === "required") {
    return { text: "Missing — forms ask for this", tone: "text-rose-700" };
  }
  return STATUS_COPY[field.status];
}

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

export function ApplicationDetailsForm({ initialDetails }: { initialDetails: ApplicationDetailsView }) {
  const [details, setDetails] = useState(initialDetails);
  const [values, setValues] = useState<Values>(() => valuesOf(initialDetails));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const total = details.fields.length;

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const response = await fetch("/api/application-details", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values)
      });
      const body = (await response.json().catch(() => null)) as
        | { details?: ApplicationDetailsView; error?: string }
        | null;
      if (!response.ok || !body?.details) {
        setResult({ ok: false, message: body?.error ?? "Your details could not be saved. Try again." });
        return;
      }
      setDetails(body.details);
      setValues(valuesOf(body.details));
      setResult({ ok: true, message: "Saved. Fill will use these details on your next application." });
    } catch {
      setResult({ ok: false, message: "Your details could not be saved. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700" data-summary>
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
        <span>
          {details.confirmedCount} of {total} details confirmed for Fill.
        </span>
      </div>

      {details.missingRequired.length > 0 ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" data-missing role="status">
          Most application forms ask for your {details.missingRequired.join(", ")}. Add{" "}
          {details.missingRequired.length === 1 ? "it" : "them"} below so you don&apos;t have to type{" "}
          {details.missingRequired.length === 1 ? "it" : "them"} on every form.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {details.fields.map((field) => {
          const status = statusFor(field, values[field.key]);
          return (
            <label key={field.key} className="block text-sm font-medium text-slate-700">
              {field.label}
              {field.importance === "optional" ? <span className="font-normal text-slate-500"> (optional)</span> : null}
              <input
                name={field.key}
                type={field.inputType}
                value={values[field.key]}
                placeholder={field.placeholder}
                autoComplete="off"
                onChange={(event) => {
                  const value = event.target.value;
                  setValues((current) => ({ ...current, [field.key]: value }));
                  setResult(null);
                }}
                className={inputClass}
              />
              <span className={`mt-1 block text-xs font-normal ${status.tone}`} data-status-for={field.key}>
                {status.text}
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <PrimaryButton type="button" data-action="save" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-2 h-4 w-4" aria-hidden />}
          Save and use for Fill
        </PrimaryButton>
        <p
          className={`text-sm ${result?.ok === false ? "text-rose-700" : "text-slate-600"}`}
          data-save-status
          role="status"
        >
          {result?.message ?? "Saving confirms these are yours. Fill only types them into matching fields you approve."}
        </p>
      </div>
    </div>
  );
}
