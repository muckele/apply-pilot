import { BriefcaseBusiness, FileText, MapPin, MessageSquareText, ShieldCheck, UserRound } from "lucide-react";

import { PreviewCheck, PreviewIcon } from "@/components/landing/product-preview-primitives";

const stages = ["Discover", "Evaluate", "Prepare", "Review", "You submit"] as const;

export function ProductPreview() {
  return (
    <figure className="product-preview" id="product" aria-label="Illustrative Apply Pilot opportunity and answer review">
      <div className="preview-topbar">
        <span>←&nbsp; All opportunities</span>
        <span className="preview-current"><i aria-hidden="true" /> Current packet · Ready for review</span>
      </div>
      <div className="preview-opportunity">
        <div>
          <h2>Product Operations Lead</h2>
          <p>Northstar Labs</p>
          <div className="preview-meta">
            <span><MapPin aria-hidden="true" /> Remote</span>
            <span><BriefcaseBusiness aria-hidden="true" /> Full-time</span>
          </div>
        </div>
        <div className="preview-fit">
          <span>FIT SCORE</span>
          <strong>86</strong>
          <em>Strong fit</em>
        </div>
        <div className="preview-match">
          <strong>Why this is a strong match</strong>
          <p>Your background aligns with cross-functional operations, process design, and scalable execution.</p>
          <span>View evidence (4) →</span>
        </div>
      </div>
      <ol className="preview-stage-rail" aria-label="Apply Pilot workflow">
        {stages.map((stage, index) => (
          <li key={stage} className={index === stages.length - 1 ? "is-user-stage" : undefined}>
            <span className="preview-stage-dot" aria-hidden="true">
              {index === stages.length - 1 ? <UserRound /> : <PreviewCheck />}
            </span>
            <span>{stage}</span>
          </li>
        ))}
      </ol>
      <div className="preview-review-layout">
        <aside className="preview-packet" aria-label="Application packet contents">
          <span className="preview-label">PACKET</span>
          {['Resume', 'Cover letter', 'Answers', 'Skills mapping', 'Additional docs'].map((item) => (
            <span key={item} className={item === 'Answers' ? 'is-selected' : undefined}><PreviewCheck /> {item}</span>
          ))}
        </aside>
        <div className="preview-answer">
          <div className="preview-answer-heading">
            <span><PreviewIcon icon={MessageSquareText} /></span>
            <div><strong>Answer review</strong><span>1 of 6</span></div>
          </div>
          <span className="preview-label">Question</span>
          <p className="preview-question">Describe a time you improved an operational process that had cross-functional impact.</p>
          <span className="preview-label preview-desktop-detail">Proposed answer</span>
          <p className="preview-proposal preview-desktop-detail">
            At my current role, I led a cross-functional initiative to streamline the intake process for new operations requests.
          </p>
          <div className="preview-evidence preview-desktop-detail">
            <FileText aria-hidden="true" />
            <span><strong>Operations process redesign</strong><small>Case study · Lines 45–87</small></span>
            <ShieldCheck aria-hidden="true" />
          </div>
          <div className="preview-actions preview-desktop-detail" aria-label="Illustrative review outcomes">
            <span>Reject</span><span className="is-approved">Approve</span>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Synthetic product illustration showing discovery, evidence-backed fit evaluation,
        application preparation, answer review, and an applicant-owned submission endpoint.
      </figcaption>
    </figure>
  );
}
