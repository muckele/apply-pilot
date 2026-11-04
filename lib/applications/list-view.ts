import type { ApplicationStatus } from "@prisma/client";

import { applicationStatusOptions } from "@/lib/applications/pipeline";

export type ApplicationsSearchParams = Record<string, string | string[] | undefined>;

export type ApplicationsView = "list" | "board";

export type ApplicationFilters = {
  q: string;
  status: ApplicationStatus | "";
  attention: boolean;
};

function firstParam(params: ApplicationsSearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseApplicationFilters(params: ApplicationsSearchParams = {}): ApplicationFilters {
  const status = firstParam(params, "status") ?? "";

  return {
    q: firstParam(params, "q")?.trim() ?? "",
    status: applicationStatusOptions.some((option) => option.value === status) ? (status as ApplicationStatus) : "",
    attention: firstParam(params, "attention") === "needs_attention"
  };
}

export function parseApplicationsView(params: ApplicationsSearchParams = {}): ApplicationsView {
  return firstParam(params, "view") === "board" ? "board" : "list";
}

/** Builds the applications URL for a view while keeping the active filters. */
export function applicationsViewHref(filters: ApplicationFilters, view: ApplicationsView) {
  const search = new URLSearchParams();
  if (filters.q) search.set("q", filters.q);
  if (filters.status) search.set("status", filters.status);
  if (filters.attention) search.set("attention", "needs_attention");
  if (view === "board") search.set("view", "board");
  const query = search.toString();
  return query ? `/applications?${query}` : "/applications";
}
