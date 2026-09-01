import { Clock3, FileCheck2, Focus, ShieldCheck, Sparkles, UserRound } from "lucide-react";

const pillars = [
  { icon: FileCheck2, title: "Evidence-backed", copy: "Application material stays grounded in information you have actually provided.", label: "VERIFIED SOURCE", detail: "Resume.pdf · Added 2 days ago" },
  { icon: Sparkles, title: "Review before action", copy: "See what Apply Pilot proposes before controlled application actions.", label: "PROPOSED MATERIAL", detail: "Custom cover letter · Proposed" },
  { icon: Clock3, title: "Current by design", copy: "Sensitive actions depend on the current form and application state—not stale information.", label: "CURRENT STATE", detail: "Form version · Updated just now" },
  { icon: UserRound, title: "You stay in control", copy: "Apply Pilot assists with the workflow. You personally submit the final employer application.", label: "YOU SUBMIT", detail: "Employer application · Submitted by you" }
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
            <p className="precision-caption"><ShieldCheck aria-hidden="true" /> From your verified information to your submitted application—every step is intentional.</p>
          </div>
        </div>
        <div className="precision-benefits">
          <article><Focus aria-hidden="true" /><span><strong>More focus</strong><p>Work on the applications that are the right fit.</p></span></article>
          <article><ShieldCheck aria-hidden="true" /><span><strong>Stronger evidence</strong><p>Applications draw from what you’ve actually provided.</p></span></article>
          <article><UserRound aria-hidden="true" /><span><strong>Clearer decisions</strong><p>Review proposals with confidence before you take action.</p></span></article>
        </div>
      </div>
    </section>
  );
}
