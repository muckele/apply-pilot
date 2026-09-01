import { BriefcaseBusiness, Check, Compass, FileText, ListChecks, LockKeyhole, MousePointerClick, Search, ShieldCheck, UserRound } from "lucide-react";

const safetyItems = [
  [FileText, "No invented claims"],
  [ShieldCheck, "No CAPTCHA bypass"],
  [BriefcaseBusiness, "No automatic employer submission"],
  [Search, "Evidence-backed answers"],
  [UserRound, "Human review"],
  [MousePointerClick, "User-controlled final submission"]
] as const;

const boundaryStages = [
  [Compass, "Discover"],
  [ListChecks, "Evaluate"],
  [FileText, "Prepare"],
  [ShieldCheck, "Review"],
  [Check, "Review complete"],
  [MousePointerClick, "Personally submit"]
] as const;

export function SafetySection() {
  return (
    <section className="public-section safety-section" id="safety" aria-labelledby="safety-title">
      <div className="public-container safety-grid">
        <div className="safety-copy">
          <h2 id="safety-title">The applicant<br />stays in command.</h2>
          <p>Automation should represent you accurately—not apply everywhere on your behalf.</p>
          <ul>
            {safetyItems.map(([Icon, label]) => (
              <li key={label}><Check aria-hidden="true" /><Icon aria-hidden="true" /><span>{label}</span></li>
            ))}
          </ul>
        </div>
        <figure className="submission-boundary">
          <h3>Submission boundary</h3>
          <div className="boundary-assist">Apply Pilot can inspect and propose.</div>
          <ol>
            {boundaryStages.map(([Icon, label], index) => (
              <li key={label} className={index === 4 ? "is-boundary" : index === 5 ? "is-user" : undefined}>
                <span><Icon aria-hidden="true" /></span><strong>{label}</strong>
              </li>
            ))}
          </ol>
          <div className="boundary-lock" aria-hidden="true"><LockKeyhole /></div>
          <div className="boundary-user-copy">Only you can submit.</div>
          <div className="boundary-status"><span><UserRound aria-hidden="true" /> Review authority · <em>Current</em></span><span><UserRound aria-hidden="true" /> Employer submission · User only</span></div>
          <figcaption className="sr-only">Apply Pilot assists through review, then stops before the applicant’s personal submission action.</figcaption>
        </figure>
      </div>
    </section>
  );
}
