"use client";

import { useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { PrimaryButton, SecondaryButton } from "@/components/ui";

export type ProfileSettingsData = {
  name: string;
  email: string;
  location: string;
  careerGoals: string;
  preferredRoles: string[];
  preferredLocations: string[];
  remotePreference: "REMOTE" | "HYBRID" | "ONSITE" | "FLEXIBLE";
  salaryTargetMin: number | null;
  salaryTargetMax: number | null;
  industriesOfInterest: string[];
  dealBreakers: string[];
  skillsToEmphasize: string[];
  skillsNotToExaggerate: string[];
  workAuthorizationNotes: string;
  availabilityNotes: string;
  preferredResumeTone: string;
};

type FormState = Omit<
  ProfileSettingsData,
  | "preferredRoles"
  | "preferredLocations"
  | "industriesOfInterest"
  | "dealBreakers"
  | "skillsToEmphasize"
  | "skillsNotToExaggerate"
> & {
  preferredRoles: string;
  preferredLocations: string;
  industriesOfInterest: string;
  dealBreakers: string;
  skillsToEmphasize: string;
  skillsNotToExaggerate: string;
};

function toLines(values: string[]) {
  return values.join("\n");
}

function toLineList(value: string) {
  return value
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toKeywordList(value: string) {
  return value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumberOrNull(value: string | number | null) {
  if (value === null || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function fieldClass(className = "") {
  return `mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${className}`;
}

function labelClass() {
  return "block text-sm font-medium text-slate-700";
}

export function ProfileSettingsForm({ initialProfile }: { initialProfile: ProfileSettingsData }) {
  const initialState = useMemo<FormState>(
    () => ({
      ...initialProfile,
      preferredRoles: toLines(initialProfile.preferredRoles),
      preferredLocations: toLines(initialProfile.preferredLocations),
      industriesOfInterest: toLines(initialProfile.industriesOfInterest),
      dealBreakers: toLines(initialProfile.dealBreakers),
      skillsToEmphasize: toLines(initialProfile.skillsToEmphasize),
      skillsNotToExaggerate: toLines(initialProfile.skillsNotToExaggerate)
    }),
    [initialProfile]
  );
  const [form, setForm] = useState<FormState>(initialState);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  function updateField<Field extends keyof FormState>(field: Field, value: FormState[Field]) {
    setForm((current) => ({ ...current, [field]: value }));
    setStatus("idle");
    setMessage("");
  }

  async function saveProfile() {
    setStatus("saving");
    setMessage("");

    const payload = {
      name: form.name || null,
      location: form.location,
      careerGoals: form.careerGoals || null,
      preferredRoles: toLineList(form.preferredRoles),
      preferredLocations: toLineList(form.preferredLocations),
      remotePreference: form.remotePreference,
      salaryTargetMin: toNumberOrNull(form.salaryTargetMin),
      salaryTargetMax: toNumberOrNull(form.salaryTargetMax),
      industriesOfInterest: toLineList(form.industriesOfInterest),
      dealBreakers: toLineList(form.dealBreakers),
      skillsToEmphasize: toKeywordList(form.skillsToEmphasize),
      skillsNotToExaggerate: toKeywordList(form.skillsNotToExaggerate),
      workAuthorizationNotes: form.workAuthorizationNotes || null,
      availabilityNotes: form.availabilityNotes || null,
      preferredResumeTone: form.preferredResumeTone
    };

    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      setStatus("error");
      setMessage(error?.error ?? "Profile could not be saved.");
      return;
    }

    setStatus("saved");
    setMessage("Profile saved. Future matching and document drafts will use these preferences.");
  }

  return (
    <div className="space-y-6 p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className={labelClass()}>
          Name
          <input
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            className={fieldClass()}
          />
        </label>
        <label className={labelClass()}>
          Sign-in email
          <input readOnly value={form.email} className={fieldClass("bg-slate-50 text-slate-500")} />
        </label>
        <label className={labelClass()}>
          Location
          <input
            value={form.location}
            onChange={(event) => updateField("location", event.target.value)}
            placeholder="Los Angeles, CA"
            className={fieldClass()}
          />
        </label>
        <label className={labelClass()}>
          Work style
          <select
            value={form.remotePreference}
            onChange={(event) => updateField("remotePreference", event.target.value as FormState["remotePreference"])}
            className={fieldClass()}
          >
            <option value="FLEXIBLE">Flexible</option>
            <option value="REMOTE">Remote</option>
            <option value="HYBRID">Hybrid</option>
            <option value="ONSITE">On-site</option>
          </select>
        </label>
      </div>

      <label className={labelClass()}>
        Career goals
        <textarea
          rows={4}
          value={form.careerGoals}
          onChange={(event) => updateField("careerGoals", event.target.value)}
          className={fieldClass("leading-6")}
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <label className={labelClass()}>
          Preferred roles
          <textarea
            rows={6}
            value={form.preferredRoles}
            onChange={(event) => updateField("preferredRoles", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
        <label className={labelClass()}>
          Preferred locations
          <textarea
            rows={6}
            value={form.preferredLocations}
            onChange={(event) => updateField("preferredLocations", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className={labelClass()}>
          Salary minimum
          <input
            type="number"
            min={0}
            step={1000}
            value={form.salaryTargetMin ?? ""}
            onChange={(event) => updateField("salaryTargetMin", toNumberOrNull(event.target.value))}
            className={fieldClass()}
          />
        </label>
        <label className={labelClass()}>
          Salary maximum
          <input
            type="number"
            min={0}
            step={1000}
            value={form.salaryTargetMax ?? ""}
            onChange={(event) => updateField("salaryTargetMax", toNumberOrNull(event.target.value))}
            className={fieldClass()}
          />
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <label className={labelClass()}>
          Industries of interest
          <textarea
            rows={5}
            value={form.industriesOfInterest}
            onChange={(event) => updateField("industriesOfInterest", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
        <label className={labelClass()}>
          Deal-breakers
          <textarea
            rows={5}
            value={form.dealBreakers}
            onChange={(event) => updateField("dealBreakers", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <label className={labelClass()}>
          Skills to emphasize
          <textarea
            rows={6}
            value={form.skillsToEmphasize}
            onChange={(event) => updateField("skillsToEmphasize", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
        <label className={labelClass()}>
          Skills not to exaggerate
          <textarea
            rows={6}
            value={form.skillsNotToExaggerate}
            onChange={(event) => updateField("skillsNotToExaggerate", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className={labelClass()}>
          Work authorization notes
          <textarea
            rows={4}
            value={form.workAuthorizationNotes}
            onChange={(event) => updateField("workAuthorizationNotes", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
        <label className={labelClass()}>
          Availability notes
          <textarea
            rows={4}
            value={form.availabilityNotes}
            onChange={(event) => updateField("availabilityNotes", event.target.value)}
            className={fieldClass("leading-6")}
          />
        </label>
      </div>

      <label className={labelClass()}>
        Preferred resume tone
        <input
          value={form.preferredResumeTone}
          onChange={(event) => updateField("preferredResumeTone", event.target.value)}
          className={fieldClass()}
        />
      </label>

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p
          className={`min-h-5 text-sm ${
            status === "error" ? "text-red-700" : status === "saved" ? "text-emerald-700" : "text-slate-500"
          }`}
        >
          {message}
        </p>
        <div className="flex gap-2">
          <SecondaryButton type="button" onClick={() => setForm(initialState)} disabled={status === "saving"}>
            Reset
          </SecondaryButton>
          <PrimaryButton type="button" onClick={saveProfile} disabled={status === "saving"}>
            {status === "saving" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
            Save profile
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
