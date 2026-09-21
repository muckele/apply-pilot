import { Clock3, FileCheck2, Focus, ShieldCheck, Sparkles, UserRound } from "lucide-react";

const pillars = [
  { icon: FileCheck2, title: "Check against your records", copy: "Treat prepared material and job-fit estimates as drafts. Confirm every name, experience, skill, and claim before use.", label: "EXAMPLE PROFILE INFORMATION", detail: "Resume and profile · Illustrative" },
  { icon: Sparkles, title: "Review before use", copy: "See what Apply Pilot prepares before you save, copy, or use it.", label: "PREPARED MATERIAL", detail: "Tailored document · Ready for review" },
  { icon: Clock3, title: "Current by design", copy: "Work from the current job, profile, and saved application materials—not stale drafts.", label: "CURRENT MATERIALS", detail: "Application packet · Updated just now" },
  { icon: UserRound, title: "You stay in control", copy: "Apply Pilot assists with preparation. You enter information and personally submit the final employer application.", label: "YOU SUBMIT", detail: "Employer application · Submitted by you" }
] as const;

export function PrecisionSection() {
  return (
    <section className="public-section precision-section" id="why-apply-pilot" aria-labelledby="precision-title">
      <div className="public-container">
        <div className="precision-grid">
          <div className="precision-copy">
            <h2 id="precision-title">Precision<br />over volume.</h2>
            <p>Apply Pilot is designed to help you make better, more accurate applications—not blindly send more of them.</p>
            <a href="#how-it-works">See how it works <span aria-hidden="true">→</span></a>
          </div>
          <div className="precision-panel">
            <h3>A more deliberate application</h3>
            <ol>
              {pillars.map(({ icon: Icon, title, copy, label, detail }, index) => (
                <li key={title}>
                  <div className="precision-icon"><Icon aria-hidden="true" /></div>
                  <h4><span>{index + 1}</span>{title}</h4>
                  <p>{copy}</p>
                  <div className="precision-artifact"><strong>{label}</strong><span>{detail}</span></div>
                </li>
              ))}
            </ol>
            <p className="precision-caption"><ShieldCheck aria-hidden="true" /> From an example profile to a personally submitted application—every step shown is illustrative.</p>
          </div>
        </div>
        <div className="precision-benefits">
          <article><Focus aria-hidden="true" /><span><strong>More focus</strong><p>Work on the applications that are the right fit.</p></span></article>
          <article><ShieldCheck aria-hidden="true" /><span><strong>Careful review</strong><p>Check prepared material against your own records.</p></span></article>
          <article><UserRound aria-hidden="true" /><span><strong>Clearer decisions</strong><p>Review prepared material before you take action.</p></span></article>
        </div>
      </div>
    </section>
  );
}
