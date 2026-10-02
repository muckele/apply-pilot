"use client";

import { useEffect } from "react";

import {
  isProductThemePreference,
  PRODUCT_THEME_CHANGE_EVENT,
  PRODUCT_THEME_STORAGE_KEY,
  resolveProductTheme,
  type ProductThemePreference
} from "@/lib/theme-preference";

function readPreference(): ProductThemePreference {
  try {
    const value = window.localStorage.getItem(PRODUCT_THEME_STORAGE_KEY);
    return isProductThemePreference(value) ? value : "system";
  } catch {
    const value = document.documentElement.dataset.productThemePreference;
    return isProductThemePreference(value) ? value : "system";
  }
}

export function applyProductTheme(preference: ProductThemePreference, systemPrefersDark: boolean) {
  const root = document.documentElement;
  root.dataset.productThemePreference = preference;
  root.dataset.productTheme = resolveProductTheme(preference, systemPrefersDark);
}

export function saveProductThemePreference(preference: ProductThemePreference) {
  try {
    window.localStorage.setItem(PRODUCT_THEME_STORAGE_KEY, preference);
  } catch {}

  applyProductTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
  window.dispatchEvent(new CustomEvent(PRODUCT_THEME_CHANGE_EVENT, { detail: preference }));
}

export function ThemePreferenceSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyProductTheme(readPreference(), media.matches);
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== PRODUCT_THEME_STORAGE_KEY) return;
      const preference = isProductThemePreference(event.newValue) ? event.newValue : "system";
      applyProductTheme(preference, media.matches);
      window.dispatchEvent(new CustomEvent(PRODUCT_THEME_CHANGE_EVENT, { detail: preference }));
    };

    sync();
    media.addEventListener("change", sync);
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(PRODUCT_THEME_CHANGE_EVENT, sync);

    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(PRODUCT_THEME_CHANGE_EVENT, sync);
    };
  }, []);

  return null;
}
