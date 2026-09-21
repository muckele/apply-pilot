import { BriefcaseBusiness, FileText, MapPin, MessageSquareText, ShieldCheck, UserRound } from "lucide-react";

import { PreviewCheck, PreviewIcon } from "@/components/landing/product-preview-primitives";

const stages = ["Discover", "Evaluate", "Prepare", "Review", "You submit"] as const;

export function ProductPreview() {
  return (
    <figure className="product-preview" id="product" aria-label="Illustrative Apply Pilot opportunity and material review">
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
          <span>Illustrative Apply Pilot job-fit estimate</span>
          <strong>86</strong>
          <em>Strong fit</em>
        </div>
        <div className="preview-match">
          <strong>Why this illustrative profile may match</strong>
          <p>This example profile aligns with cross-functional operations, process design, and scalable execution.</p>
          <span>View match details →</span>
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
          {['Resume', 'Cover letter', 'Saved answers', 'Fit reasoning', 'Exported files'].map((item) => (
            <span key={item} className={item === 'Saved answers' ? 'is-selected' : undefined}><PreviewCheck /> {item}</span>
          ))}
        </aside>
        <div className="preview-answer">
          <div className="preview-answer-heading">
            <span><PreviewIcon icon={MessageSquareText} /></span>
            <div><strong>Saved answer</strong><span>1 of 6</span></div>
          </div>
          <span className="preview-label">Question</span>
          <p className="preview-question">Describe a time you improved an operational process that had cross-functional impact.</p>
          <span className="preview-label preview-desktop-detail">Reviewed answer</span>
          <p className="preview-proposal preview-desktop-detail">
            At my current role, I led a cross-functional initiative to streamline the intake process for new operations requests.
          </p>
          <div className="preview-evidence preview-desktop-detail">
            <FileText aria-hidden="true" />
            <span><strong>Saved application answer</strong><small>Answer vault · Review before copy</small></span>
            <ShieldCheck aria-hidden="true" />
          </div>
          <div className="preview-actions preview-desktop-detail" aria-label="Illustrative answer actions">
            <span>Edit</span><span className="is-approved">Copy</span>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Synthetic product illustration showing discovery, fit evaluation, application preparation,
        saved-answer review, and an applicant-owned submission endpoint.
      </figcaption>
    </figure>
  );
}
