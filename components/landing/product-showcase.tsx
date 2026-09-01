import { Check, FileText, ListChecks, ShieldCheck } from "lucide-react";

import { PreviewStatus } from "@/components/landing/product-preview-primitives";

const evidenceItems = [
  "Led a cross-functional intake process that reduced cycle time.",
  "Implemented a standardized triage model used by two distributed teams.",
  "Partnered with engineering and analytics to define and track SLAs."
] as const;

const packetItems = [
  ["Describe a time you improved an operational process.", "Pending review", "amber"],
  ["How do you prioritize competing requests?", "Approved", "green"],
  ["Tell us about a time you worked with engineering.", "Approved", "green"],
  ["How do you measure success?", "Pending review", "amber"],
  ["Experience with multi-team rollouts.", "Manual required", "blue"]
] as const;

export function ProductShowcase() {
  return (
    <section className="public-section showcase-section" aria-labelledby="showcase-title">
      <div className="public-container">
        <div className="showcase-grid">
          <div className="showcase-intro">
            <h2 id="showcase-title">Automation,<br />grounded in<br />what’s true.</h2>
            <p>
              Apply Pilot helps organize the search, evaluate fit, and prepare application material
              without inventing qualifications or taking over the final decision.
            </p>
            <ul>
              <li><Check aria-hidden="true" /> Evidence-grounded answers</li>
              <li><ShieldCheck aria-hidden="true" /> Human review before application actions</li>
              <li><ListChecks aria-hidden="true" /> Controlled browser workflows</li>
              <li><FileText aria-hidden="true" /> No fabricated qualifications</li>
            </ul>
          </div>
          <div className="showcase-panels" aria-label="Illustrative product surfaces">
            <article className="showcase-panel fit-panel">
              <h3>Fit reasoning</h3>
              <div className="showcase-score"><span>FIT SCORE</span><strong>86</strong><em>Strong fit</em></div>
              <h4>Top evidence</h4>
              {evidenceItems.map((item) => <p key={item}><Check aria-hidden="true" /><span>{item}<small>Verified experience</small></span></p>)}
              <span className="showcase-link">View all evidence (6) →</span>
            </article>
            <article className="showcase-panel plan-panel">
              <h3>Application plan</h3>
              <div className="plan-table">
                <div><strong>Job requirement</strong><strong>Verified experience</strong><strong>Gap (honest)</strong></div>
                <div><span>Improve operational efficiency</span><span><Check aria-hidden="true" /> Led cross-functional initiative</span><span>Scale beyond two teams</span></div>
                <div><span>Design standardized processes</span><span><Check aria-hidden="true" /> Designed intake workflow</span><span>Limited rollout exposure</span></div>
                <div><span>Collaborate with analytics</span><span><Check aria-hidden="true" /> Defined outcome metrics</span><span>SQL depth is intermediate</span></div>
              </div>
              <div className="plan-summary"><strong>Plan summary</strong><p>Strong evidence for execution and cross-functional partnership. Address scope honestly.</p></div>
              <span className="showcase-link">Edit plan →</span>
            </article>
            <article className="showcase-panel packet-panel">
              <h3>Answer packet</h3>
              <div className="packet-summary"><span><strong>8</strong>Total</span><span><strong>5</strong>Ready</span><span><strong>3</strong>Need review</span></div>
              <h4>Proposed answers</h4>
              {packetItems.map(([question, status, tone]) => (
                <p key={question}><FileText aria-hidden="true" /><span>{question}</span><PreviewStatus tone={tone}>{status}</PreviewStatus></p>
              ))}
              <span className="showcase-link">View full packet →</span>
            </article>
          </div>
        </div>
        <div className="evidence-lineage" aria-label="From verified source to proposed answer">
          <h3>From source to proposed answer</h3>
          <div>
            <article><FileText aria-hidden="true" /><span><strong>1&nbsp; Source (verified)</strong><b>Operations process redesign</b><small>Case study · Lines 45–87</small><em>✓ Verified</em></span></article>
            <i aria-hidden="true" />
            <article><ListChecks aria-hidden="true" /><span><strong>2&nbsp; Planning (mapped)</strong><b>Maps to requirement</b><small>“Improve operational efficiency and reduce cycle time”</small><em>Evidence strength: Strong</em></span></article>
            <i aria-hidden="true" />
            <article><ShieldCheck aria-hidden="true" /><span><strong>3&nbsp; Proposed answer</strong><b>Question</b><small>Describe a time you improved an operational process.</small><em>Status: Pending review</em></span></article>
          </div>
        </div>
      </div>
    </section>
  );
}
