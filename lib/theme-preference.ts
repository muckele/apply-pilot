export const PRODUCT_THEME_STORAGE_KEY = "apply-pilot-theme";
export const PRODUCT_THEME_CHANGE_EVENT = "apply-pilot-theme-change";

export type ProductThemePreference = "light" | "dark" | "system";
export type ResolvedProductTheme = "light" | "dark";

export function isProductThemePreference(value: unknown): value is ProductThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveProductTheme(
  preference: ProductThemePreference,
  systemPrefersDark: boolean
): ResolvedProductTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export const PRODUCT_THEME_BOOTSTRAP_SCRIPT = `(() => {
  const root = document.documentElement;
  const key = ${JSON.stringify(PRODUCT_THEME_STORAGE_KEY)};
  let preference = "system";
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
  } catch {}
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.productThemePreference = preference;
  root.dataset.productTheme = dark ? "dark" : "light";
})();`;
