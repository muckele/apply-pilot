import { Check, FileText, ListChecks, ShieldCheck } from "lucide-react";

import { PreviewStatus } from "@/components/landing/product-preview-primitives";

const evidenceItems = [
  "Led a cross-functional intake process that reduced cycle time.",
  "Implemented a standardized triage model used by two distributed teams.",
  "Partnered with engineering and analytics to define and track SLAs."
] as const;

const answerItems = [
  ["Describe a time you improved an operational process.", "Review needed", "amber"],
  ["How do you prioritize competing requests?", "Reviewed", "green"],
  ["Tell us about a time you worked with engineering.", "Reviewed", "green"],
  ["How do you measure success?", "Review needed", "amber"],
  ["Experience with multi-team rollouts.", "Manual decision", "blue"]
] as const;

export function ProductShowcase() {
  return (
    <section className="public-section showcase-section" aria-labelledby="showcase-title">
      <div className="public-container">
        <div className="showcase-grid">
          <div className="showcase-intro">
            <h2 id="showcase-title">Prepare, review,<br />and organize<br />your<br />application.</h2>
            <p>
              Review draft resumes, cover letters, and job-fit estimates before use. Check names,
              experience, skills, and claims against your own records.
            </p>
            <ul>
              <li><Check aria-hidden="true" /> Reviewable job-fit estimates</li>
              <li><ShieldCheck aria-hidden="true" /> Human review before material use</li>
              <li><ListChecks aria-hidden="true" /> Review-before-save job capture</li>
              <li><FileText aria-hidden="true" /> Copy-only answer handoff</li>
            </ul>
          </div>
          <div className="showcase-panels" aria-label="Illustrative product surfaces">
            <article className="showcase-panel fit-panel">
              <h3>Fit reasoning</h3>
              <div className="showcase-score"><span>Illustrative Apply Pilot job-fit estimate</span><strong>86</strong><em>Strong fit</em></div>
              <h4>Illustrative evidence</h4>
              {evidenceItems.map((item) => <p key={item}><Check aria-hidden="true" /><span>{item}<small>Illustrative experience</small></span></p>)}
              <span className="showcase-link">View match details →</span>
            </article>
            <article className="showcase-panel plan-panel">
              <h3>Application packet</h3>
              <div className="plan-table">
                <div><strong>Job requirement</strong><strong>Relevant experience</strong><strong>Gap to review</strong></div>
                <div><span>Improve operational efficiency</span><span><Check aria-hidden="true" /> Led cross-functional initiative</span><span>Scale beyond two teams</span></div>
                <div><span>Design standardized processes</span><span><Check aria-hidden="true" /> Designed intake workflow</span><span>Limited rollout exposure</span></div>
                <div><span>Collaborate with analytics</span><span><Check aria-hidden="true" /> Defined outcome metrics</span><span>SQL depth is intermediate</span></div>
              </div>
              <div className="plan-summary"><strong>Packet summary</strong><p>This illustrative profile shows relevant execution and cross-functional experience. Review scope before use.</p></div>
              <span className="showcase-link">Review packet →</span>
            </article>
            <article className="showcase-panel packet-panel">
              <h3>Answer vault</h3>
              <div className="packet-summary"><span><strong>8</strong>Saved</span><span><strong>5</strong>Ready</span><span><strong>3</strong>Review</span></div>
              <h4>Saved answers</h4>
              {answerItems.map(([question, status, tone]) => (
                <p key={question}><FileText aria-hidden="true" /><span>{question}</span><PreviewStatus tone={tone}>{status}</PreviewStatus></p>
              ))}
              <span className="showcase-link">View answer vault →</span>
            </article>
          </div>
        </div>
        <div className="evidence-lineage" aria-label="From example profile information to reviewed material">
          <h3>From example profile information to reviewed material</h3>
          <div>
            <article><FileText aria-hidden="true" /><span><strong>1&nbsp; Example profile information</strong><b>Resume and profile</b><small>Illustrative source</small><em>Review for accuracy</em></span></article>
            <i aria-hidden="true" />
            <article><ListChecks aria-hidden="true" /><span><strong>2&nbsp; Job-fit estimate</strong><b>Compared with requirement</b><small>“Improve operational efficiency and reduce cycle time”</small><em>Illustrative estimate: Strong</em></span></article>
            <i aria-hidden="true" />
            <article><ShieldCheck aria-hidden="true" /><span><strong>3&nbsp; Prepared material</strong><b>Resume, cover letter, or saved answer</b><small>Applicant review remains required</small><em>Status: Ready for review</em></span></article>
          </div>
        </div>
      </div>
    </section>
  );
}
