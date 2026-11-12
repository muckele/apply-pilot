"use client";

import { useRef, useState } from "react";

import { Panel, PanelHeader, SecondaryButton } from "@/components/ui";
import {
  readAssistedFillMode,
  RunRequestError,
  turnOffAssistedFill,
  type AssistedFillMode
} from "@/lib/application-runs/client-run";

// Settings' permanent Assisted Fill switch (UX-6, D035 D-B). Turning Fill off is always one click
// with no question: it's the safe direction. Turning it on happens only at step 8 of a prepared
// application, where it's used, so this card has no turn-on button.
export function AssistedFillSettingsCard({ initialMode }: { initialMode: AssistedFillMode }) {
  const [mode, setMode] = useState<AssistedFillMode>(initialMode);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const on = mode === "FILL_AND_REVIEW";

  async function turnOff() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      await turnOffAssistedFill();
      setMode("PREPARE_ONLY");
    } catch (error) {
      if (error instanceof RunRequestError && error.kind === "refused") {
        setMessage("Assisted Fill wasn't turned off. Try again in a moment.");
      } else {
        // A lost response is never replayed: read what the server has now.
        try {
          setMode(await readAssistedFillMode());
        } catch {
          setMessage("Apply Pilot couldn't confirm whether Assisted Fill is off. Refresh the page to check.");
        }
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Panel>
      <PanelHeader title="Assisted Fill" />
      <div data-testid="assisted-fill-card" className="space-y-3 p-5 text-sm text-slate-700">
        <p className="font-semibold text-slate-950">{on ? "Assisted Fill is on" : "Assisted Fill is off"}</p>
        {on ? (
          <>
            <p>When you press Fill in the Apply Pilot browser, Apply Pilot types the answers you approved, once. It turns off by itself when you record or stop an application.</p>
            <SecondaryButton type="button" data-testid="assisted-fill-turn-off" disabled={pending} onClick={() => { void turnOff(); }}>
              Turn off
            </SecondaryButton>
          </>
        ) : (
          <p>Turn it on at step 8 of an application you&apos;ve prepared.</p>
        )}
        {message ? <p role="status" className="text-amber-900">{message}</p> : null}
      </div>
    </Panel>
  );
}
