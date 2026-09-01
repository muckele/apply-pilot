import { Check, FileText, Search, ShieldCheck, UserRound } from "lucide-react";

const stages = [
  {
    title: "Discover",
    copy: "Find relevant opportunities from permitted sources.",
    icon: Search,
    visual: "opportunity"
  },
  {
    title: "Evaluate",
    copy: "Prioritize fit with evidence-backed reasoning.",
    icon: Check,
    visual: "reasoning"
  },
  {
    title: "Prepare",
    copy: "Build application material from verified experience.",
    icon: FileText,
    visual: "evidence"
  },
  {
    title: "Review",
    copy: "Approve, reject, or revise every proposed answer.",
    icon: ShieldCheck,
    visual: "review"
  },
  {
    title: "You submit",
    copy: "Use controlled browser assistance, then personally submit.",
    icon: UserRound,
    visual: "browser"
  }
] as const;

function WorkflowVisual({ type }: { type: (typeof stages)[number]["visual"] }) {
  if (type === "opportunity") {
    return (
      <div className="workflow-mini opportunity-mini">
        <span>← All opportunities</span>
        <strong>Product Operations Lead</strong>
        <small>Northstar Labs</small>
        <i /><i /><i className="is-active" />
      </div>
    );
  }
  if (type === "reasoning") {
    return (
      <div className="workflow-mini reasoning-mini">
        <div><strong>Fit reasoning</strong><span>Strong fit</span></div>
        {['Cross-functional ops', 'Process design', 'Operational impact'].map((label) => (
          <p key={label}><Check aria-hidden="true" /> <span><strong>{label}</strong><small>Verified experience</small></span></p>
        ))}
      </div>
    );
  }
  if (type === "evidence") {
    return (
      <div className="workflow-mini evidence-mini">
        <strong>Evidence map</strong>
        {['Cross-functional initiative', 'Process design', 'Impact metrics', 'Stakeholder alignment'].map((label) => (
          <p key={label}><i aria-hidden="true" /><span>{label}<small>Verified source</small></span></p>
        ))}
      </div>
    );
  }
  if (type === "review") {
    return (
      <div className="workflow-mini review-mini">
        <div><strong>Answer review</strong><span>1 of 6</span></div>
        <small>Question</small>
        <p>Describe a time you improved an operational process.</p>
        <div><span>Reject</span><span>Approve</span></div>
      </div>
    );
  }
  return (
    <div className="workflow-mini browser-mini">
      <div><strong>Controlled browser</strong><span><i /> Active</span></div>
      <div className="browser-chrome"><i /><i /><i /><span /></div>
      <div className="browser-form"><i /><i /><b /></div>
      <p><ShieldCheck aria-hidden="true" /> You review and submit.<br />Always in control.</p>
    </div>
  );
}

export function WorkflowSection() {
  return (
    <section className="public-section workflow-section" id="how-it-works" aria-labelledby="workflow-title">
      <div className="public-container">
        <div className="public-section-heading public-section-heading-narrow">
          <h2 id="workflow-title">A deliberate path from<br />discovery to application.</h2>
          <p>Move faster through the work that benefits from assistance—and keep the decisions that matter.</p>
          <a href="#product">See the product <span aria-hidden="true">→</span></a>
        </div>
        <ol className="workflow-grid">
          {stages.map(({ title, copy, icon: Icon, visual }, index) => (
            <li key={title} className={index === stages.length - 1 ? "is-final" : undefined}>
              <div className="workflow-stage-icon"><Icon aria-hidden="true" /></div>
              <div className="workflow-stage-copy">
                <span>{index + 1}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
              <WorkflowVisual type={visual} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
