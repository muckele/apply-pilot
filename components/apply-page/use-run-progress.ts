"use client";

import { useEffect, useState } from "react";

import type { ApplyProgressInput } from "@/lib/apply-page/apply-progress";

type RunProgress = ApplyProgressInput["run"];

/**
 * The run's current state for the progress list. It reads the run once on mount and again each time
 * the tab becomes visible (steps 5 to 10 happen in another window, so this is when the user comes
 * back). No timers. The run endpoint gives the run state but no companion state, so that stays as
 * the initial value. A failed read keeps the last known value.
 */
export function useRunProgress(runId: string | null, initial: RunProgress): RunProgress {
  const [run, setRun] = useState<RunProgress>(initial);

  useEffect(() => {
    if (!runId) return undefined;
    let active = true;
    let latest = 0;
    const read = async () => {
      const ticket = ++latest;
      try {
        const response = await fetch(`/api/application-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { run?: { state?: unknown } };
        const state = body?.run?.state;
        if (!active || ticket !== latest || typeof state !== "string") return;
        setRun((previous) => ({ state, companionState: previous?.companionState ?? null }));
      } catch {
        // Keep the last known value.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runId]);

  return run;
}
