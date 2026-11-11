import Link from "next/link";

import { Panel, PanelHeader } from "@/components/ui";
import type { ApplyProgress } from "@/lib/apply-page/apply-progress";
import { stepHeading } from "@/lib/assisted-apply/control-steps";

/**
 * Where this application is in the Apply flow, with a way back to it. Everything before the Apply
 * Pilot browser (Prepare, the start command, the sign-in code) lives on the Apply page, so this
 * card only summarises and links; it never starts or opens a run.
 */
export function ApplicationRunSummaryCard({ jobId, progress }: { jobId: string; progress: ApplyProgress }) {
  return (
    <Panel>
      <PanelHeader title="Apply" />
      <div className="space-y-3 p-5" data-testid="application-run-summary">
        <p className="text-sm font-semibold text-slate-950">{stepHeading(progress.current)}</p>
        <p className="text-sm leading-6 text-slate-700">{progress.now}</p>
        <Link href={`/jobs/${jobId}/apply`} className="inline-block text-sm font-semibold text-brand-700 underline">
          Continue on the Apply page
        </Link>
      </div>
    </Panel>
  );
}
