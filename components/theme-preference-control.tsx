"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { saveProductThemePreference } from "@/components/theme-preference-sync";
import {
  isProductThemePreference,
  PRODUCT_THEME_CHANGE_EVENT,
  type ProductThemePreference
} from "@/lib/theme-preference";

const choices = [
  { value: "light", label: "Light", description: "Bright workspace", icon: Sun },
  { value: "dark", label: "Dark", description: "Low-light workspace", icon: Moon },
  { value: "system", label: "System", description: "Follow this device", icon: Monitor }
] satisfies Array<{
  value: ProductThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}>;

export function ThemePreferenceControl() {
  const [preference, setPreference] = useState<ProductThemePreference>("system");

  useEffect(() => {
    const sync = () => {
      const value = document.documentElement.dataset.productThemePreference;
      setPreference(isProductThemePreference(value) ? value : "system");
    };

    sync();
    window.addEventListener(PRODUCT_THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(PRODUCT_THEME_CHANGE_EVENT, sync);
  }, []);

  function choose(nextPreference: ProductThemePreference) {
    setPreference(nextPreference);
    saveProductThemePreference(nextPreference);
  }

  return (
    <fieldset className="p-5">
      <legend className="sr-only">Appearance</legend>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
        {choices.map(({ value, label, description, icon: Icon }) => (
          <label
            key={value}
            data-theme-choice={value}
            className="theme-choice group relative flex min-h-20 cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors"
          >
            <input
              type="radio"
              name="product-theme"
              value={value}
              checked={preference === value}
              onChange={() => choose(value)}
              className="peer sr-only"
            />
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 bg-white/80 text-brand-700 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-brand-700">
              <Icon size={18} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-500">
        Saved only in this browser. System follows your device and updates when its appearance changes.
      </p>
    </fieldset>
  );
}
