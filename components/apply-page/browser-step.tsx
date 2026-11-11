"use client";

import { CopyButton } from "@/components/apply-kit/copy-button";
import { CompanionSignInCode } from "@/components/companion-sign-in-code";

/** The documented companion command (docs/APPLICATION_BROWSER_COMPANION.md): the origin and run id, nothing else. */
export function browserStartCommand(appOrigin: string, runId: string): string {
  return `npm run application-browser -- --app-origin ${appOrigin} --run-id ${runId}`;
}

const ORIGIN_PLACEHOLDER = "<this site's address>";

/**
 * Step 5: the start command and the sign-in code for a prepared run. It stays while the run is
 * open (prepared, filling or waiting for your Submit), so closing the Apply Pilot browser never
 * loses the way back in. Without a known app origin it shows the command with a placeholder.
 */
export function BrowserStep({ appOrigin, runId }: { appOrigin: string | null; runId: string }) {
  const command = browserStartCommand(appOrigin ?? ORIGIN_PLACEHOLDER, runId);
  return (
    <div className="space-y-3" data-browser-step>
      <p className="job-card-copy">
        Run this in a terminal in your Apply Pilot folder. It opens the Apply Pilot browser for this application; if you
        closed that window, run it again to continue.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 text-xs" data-browser-start-command>{command}</code>
        {appOrigin ? <CopyButton value={command} label="start command" /> : null}
      </div>
      {appOrigin ? null : (
        <p className="job-hint" data-origin-unknown>
          Apply Pilot can&apos;t tell this site&apos;s address here. Replace {ORIGIN_PLACEHOLDER} with the address in your
          browser&apos;s address bar, up to the first single slash (for example https://apply.example.com).
        </p>
      )}
      <p className="job-card-copy">When it asks you to sign in, get a one-time code here and type it into that window.</p>
      <CompanionSignInCode runId={runId} />
    </div>
  );
}
