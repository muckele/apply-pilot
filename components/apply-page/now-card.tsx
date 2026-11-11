import type { ReactNode } from "react";

import { stepHeading } from "@/lib/assisted-apply/control-steps";
import type { ApplyProgress } from "@/lib/apply-page/apply-progress";

export function NowCard({ progress, action }: { progress: ApplyProgress; action?: ReactNode }) {
  return (
    <section className="job-card apply-now-card" data-now-card aria-labelledby="apply-now-heading">
      <h2 id="apply-now-heading" className="job-section-title">{stepHeading(progress.current)}</h2>
      <p className="job-card-copy">{progress.now}</p>
      {action ? <div className="apply-now-action">{action}</div> : null}
      {progress.next ? <p className="job-hint">Next: {progress.next}</p> : null}
      <ol className="job-steps" aria-label="Steps">
        {progress.steps.map((step) => (
          <li key={step.number} data-state={step.state} aria-current={step.state === "now" ? "step" : undefined}>
            <span className="job-step-number">{step.number}</span>{step.name}
          </li>
        ))}
      </ol>
    </section>
  );
}
