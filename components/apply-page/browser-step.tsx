"use client";

import { CopyButton } from "@/components/apply-kit/copy-button";
import { CompanionSignInCode } from "@/components/companion-sign-in-code";

/** The documented companion command (docs/APPLICATION_BROWSER_COMPANION.md): the origin and run id, nothing else. */
export function browserStartCommand(appOrigin: string, runId: string): string {
  return `npm run application-browser -- --app-origin ${appOrigin} --run-id ${runId}`;
}

export function BrowserStep({ appOrigin, runId }: { appOrigin: string; runId: string }) {
  const command = browserStartCommand(appOrigin, runId);
  return (
    <div className="space-y-3" data-browser-step>
      <p className="job-card-copy">Run this in a terminal in your Apply Pilot folder. It opens the Apply Pilot browser for this application.</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 text-xs" data-browser-start-command>{command}</code>
        <CopyButton value={command} label="start command" />
      </div>
      <p className="job-card-copy">When it asks you to sign in, get a one-time code here and type it into that window.</p>
      <CompanionSignInCode runId={runId} />
    </div>
  );
}
