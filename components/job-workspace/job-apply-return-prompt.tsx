"use client";

import { useState } from "react";

import {
  ApplyRecordedNotice,
  ApplyReturnDeclinedNotice,
  ApplyReturnWindow,
  useApplyReturnAnswer
} from "@/components/apply-kit/apply-return-card";
import type { ApplyReturnState } from "@/lib/applications/apply-return";

// "Did you apply?" on the job page, in the same large window as on the Apply page (G-7). "Yes, I
// applied" records Applied in one click with the documents attached to the application; if that is
// refused, the window links to the Apply page's full confirmation. "Not yet" (or Esc) hides it until
// the next visit.
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
  const [recorded, setRecorded] = useState(false);
  const answer = useApplyReturnAnswer(jobId);
  const busy = answer.busy !== null;

  if (recorded) return <ApplyRecordedNotice variant="job" />;
  if (pending && pending.openedEventId !== dismissedOpenedEventId) {
    return (
      <ApplyReturnWindow
        company={company}
        onYes={async () => {
          if (await answer.recordApplied()) setRecorded(true);
        }}
        onNotYet={() => {
          answer.clearError();
          setDismissedOpenedEventId(pending.openedEventId);
        }}
        onNotApplying={async () => {
          if (await answer.send("NOT_APPLYING")) setDismissedOpenedEventId(pending.openedEventId);
        }}
        busy={answer.busy}
        error={answer.error}
        choose={answer.yesRefused ? { href: `/jobs/${jobId}/apply?didYouApply=yes` } : null}
      />
    );
  }
  if (declined) {
    return <ApplyReturnDeclinedNotice variant="job" onUndo={() => { setDismissedOpenedEventId(null); void answer.send("UNDO_NOT_APPLYING"); }} busy={busy} error={answer.error} />;
  }
  return null;
}
