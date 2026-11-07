"use client";

import { useState } from "react";

import { ApplyReturnCard, ApplyReturnDeclinedNotice, useApplyReturnAnswer } from "@/components/apply-kit/apply-return-card";
import type { ApplyReturnState } from "@/lib/applications/apply-return";

// "Did you apply?" on the job page. The confirmation that records "I applied" lives in the Apply
// Kit, so "Yes" goes there and opens it straight away; "Not yet" hides the card until the next visit.
export function JobApplyReturnPrompt({
  jobId,
  company,
  pending,
  declined
}: {
  jobId: string;
  company: string;
  pending: ApplyReturnState["pending"];
  declined: ApplyReturnState["declined"];
}) {
  const [dismissedOpenedEventId, setDismissedOpenedEventId] = useState<string | null>(null);
  const answer = useApplyReturnAnswer(jobId);
  const busy = answer.busy !== null;

  if (pending && pending.openedEventId !== dismissedOpenedEventId) {
    return (
      <ApplyReturnCard
        company={company}
        variant="job"
        yes={{ href: `/jobs/${jobId}/apply?didYouApply=yes` }}
        onNotYet={() => setDismissedOpenedEventId(pending.openedEventId)}
        onNotApplying={async () => {
          if (await answer.send("NOT_APPLYING")) setDismissedOpenedEventId(pending.openedEventId);
        }}
        busy={busy}
        error={answer.error}
      />
    );
  }
  if (declined) {
    return <ApplyReturnDeclinedNotice variant="job" onUndo={() => { setDismissedOpenedEventId(null); void answer.send("UNDO_NOT_APPLYING"); }} busy={busy} error={answer.error} />;
  }
  return null;
}
