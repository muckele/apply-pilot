type OwnerReviewPagePaths = {
  statePath: string;
  guideSubmissionPath: string;
  submissionPath: string;
  consentPath: string;
  executionReviewPath: string;
  cancelPath: string;
};

const css = String.raw`
:root{color-scheme:light;--canvas:#f3f8f5;--surface:#fff;--raised:#f9fcfa;--text:#17261f;--copy:#32473d;--muted:#5d7067;--accent:#146a46;--mint:#38c979;--border:#cee0d6;--strong:#7ab897;--warn:#76510c;--danger:#9a312c;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:radial-gradient(circle at 82% 0%,rgba(126,224,167,.13),transparent 30rem),var(--canvas);line-height:1.55}.skip{position:fixed;left:1rem;top:1rem;z-index:5;transform:translateY(-180%);border-radius:.5rem;padding:.75rem 1rem;background:var(--mint);color:#03110b;font-weight:750}.skip:focus{transform:none}.masthead{border-bottom:1px solid var(--border);background:rgba(255,255,255,.92)}.masthead-inner,main{width:min(1180px,calc(100% - 2rem));margin:0 auto}.masthead-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0}.brand{display:grid;gap:.1rem}.brand strong{font-size:1rem;letter-spacing:-.02em}.brand span{color:var(--muted);font-size:.78rem}.session-badge,.badge{border:1px solid var(--strong);border-radius:999px;padding:.35rem .65rem;background:#edf9f2;color:var(--accent);font-size:.72rem;font-weight:750}.session-badge{text-transform:uppercase;letter-spacing:.06em}main{padding:2rem 0 3rem}.hero{display:grid;gap:.6rem;margin-bottom:1.25rem}.eyebrow,.evidence-label,.section-kicker{margin:0;color:var(--accent);font-size:.72rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase}h1,h2,h3,h4,p{margin-top:0}h1{margin-bottom:0;font-size:clamp(1.8rem,4vw,2.5rem);line-height:1.12;letter-spacing:-.04em}.lede{max-width:58rem;margin:0;color:var(--copy)}.notice,.synthetic-banner,.document-boundary{margin:1rem 0;border:1px solid #dfbd6b;border-radius:.7rem;padding:.9rem 1rem;background:#fff9e9;color:var(--warn);font-size:.88rem}.synthetic-banner{margin:0 0 1rem;border-color:#79b7d4;background:#eef8fc;color:#194e68}.synthetic-banner strong,.document-boundary strong{display:block;margin-bottom:.2rem}.progress{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem}.step{border:1px solid var(--border);border-radius:999px;padding:.35rem .6rem;background:var(--surface);color:var(--muted);font-size:.75rem;font-weight:700}.step.current{border-color:var(--strong);background:#edf9f2;color:var(--accent)}.panel{border:1px solid var(--border);border-radius:.85rem;background:var(--surface);box-shadow:0 18px 50px rgba(31,82,59,.08)}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border);padding:1.1rem 1.25rem}.panel-head h2{margin:0;font-size:1.15rem}.panel-head p{margin:.25rem 0 0;color:var(--muted);font-size:.82rem}.badge{white-space:nowrap}.job-overview{margin:0 1rem 1rem;padding:1rem}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:.8rem}.section-heading h3{margin:0;font-size:1.05rem}.source-link{color:var(--accent);font-size:.82rem;font-weight:750}.fact-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin-bottom:1rem}.fact{border:1px solid var(--border);border-radius:.6rem;padding:.7rem;background:var(--raised)}.fact span{display:block;color:var(--muted);font-size:.7rem;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.fact strong{display:block;margin-top:.2rem;font-size:.85rem;overflow-wrap:anywhere}.responsibilities{margin:0;padding-left:1.2rem;color:var(--copy);font-size:.86rem}.responsibilities li+li{margin-top:.35rem}.tech-list{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.85rem}.chip{border-radius:999px;padding:.25rem .55rem;background:#edf4f0;color:var(--copy);font-size:.74rem}.review-grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(19rem,.92fr);gap:1rem;padding:0 1rem 1rem}.column{min-width:0}.review-grid>.column:last-child{position:sticky;top:1rem;align-self:start}.column>h3{margin-bottom:.65rem;font-size:.95rem}.evidence-list,.resume-section{display:grid;gap:.55rem}.resume-preview{border:1px solid var(--border);border-radius:.75rem;padding:.9rem;background:#fdfefd}.resume-preview>h3{margin-bottom:.1rem}.resume-caption{margin:0 0 .9rem;color:var(--accent);font-size:.75rem;font-weight:750}.resume-section+.resume-section{margin-top:1rem}.resume-section h4{margin:0;font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.evidence{min-width:0;border-left:3px solid var(--strong);border-radius:.25rem;padding:.15rem 0 .15rem .7rem}.evidence-title{margin:.15rem 0 0;color:var(--text);font-size:.88rem;font-weight:750;overflow-wrap:anywhere}.evidence-details{margin:.35rem 0 0;padding-left:1.1rem;color:var(--copy);font-size:.79rem}.evidence-details li+li{margin-top:.18rem}.requirement{margin:0 0 .8rem;border:1px solid var(--border);border-radius:.7rem;padding:.9rem}.requirement legend{max-width:100%;padding:0 .35rem;color:var(--accent);font-size:.75rem;font-weight:750}.requirement-text{margin-bottom:.5rem;color:var(--copy);font-size:.9rem}.field{display:grid;gap:.35rem;margin-top:.65rem}.field label,.field-label{color:var(--copy);font-size:.78rem;font-weight:750}select,textarea{width:100%;min-height:44px;border:1px solid var(--border);border-radius:.5rem;padding:.6rem .7rem;color:var(--text);background:#fff;font:inherit}select[multiple]{min-height:8.5rem}textarea{min-height:7rem;resize:vertical}select:focus,textarea:focus,button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.hint{margin:.25rem 0 0;color:var(--muted);font-size:.72rem}.supporting-evidence[hidden]{display:none}.open-gaps{margin:0 1rem 1rem;padding:1rem;box-shadow:none}.open-gaps h3{font-size:.88rem}.open-gaps ul{margin:0;padding-left:1.2rem;color:var(--copy);font-size:.82rem}.decision{border-top:1px solid var(--border);padding:1rem}.preference-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem}.confirmation{display:flex;align-items:flex-start;gap:.6rem;margin:1rem 0;color:var(--copy);font-size:.82rem}.confirmation input{width:1.1rem;height:1.1rem;margin-top:.15rem;accent-color:var(--accent)}.actions{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.75rem;margin-top:1rem}.button{min-height:44px;border:1px solid var(--strong);border-radius:.55rem;padding:.65rem 1rem;font:inherit;font-size:.85rem;font-weight:750;cursor:pointer}.button-primary{border-color:var(--mint);background:linear-gradient(145deg,#46d485,#2cc675);color:#03110b}.button-secondary{background:#fff;color:var(--copy)}.button-danger{border-color:#d9aaa7;background:#fff;color:var(--danger)}.button:disabled{cursor:not-allowed;opacity:.55}.error{min-height:1.5rem;margin:.75rem 0 0;color:var(--danger);font-size:.82rem;font-weight:750}.consent-stop{margin:1rem;border:1px solid var(--strong);border-radius:.65rem;padding:1rem;background:#edf9f2}.consent-stop strong{display:block;margin-bottom:.35rem;color:var(--accent)}.technical-details{margin:0 1rem 1rem;border:1px solid var(--border);border-radius:.65rem;background:var(--raised)}.technical-details summary{cursor:pointer;padding:.8rem 1rem;color:var(--accent);font-weight:750}.manifest{display:grid;gap:.2rem;margin:0;padding:0 1rem 1rem}.manifest-row{display:grid;grid-template-columns:13rem minmax(0,1fr);gap:.75rem;border-top:1px solid var(--border);padding:.55rem 0}.manifest-row dt{color:var(--muted);font-size:.78rem;font-weight:700}.manifest-row dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--copy);font-size:.82rem}.status{position:fixed;left:-9999px}.loading{padding:2rem;color:var(--muted)}.caution-list{display:grid;gap:.5rem;margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem}.caution-list h3{margin:0;color:var(--warn);font-size:.85rem}.caution-list .evidence{border-color:#dfbd6b}.preference-evidence{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin-bottom:.75rem}
.source-reference{display:grid;justify-items:end;gap:.15rem;max-width:17rem;text-align:right}.source-reference span{color:var(--muted);font-size:.7rem}.raw-source{margin:0 0 1rem;border:1px solid var(--border);border-radius:.55rem;background:var(--raised)}.raw-source summary{cursor:pointer;padding:.65rem .75rem;color:var(--accent);font-size:.8rem;font-weight:750}.raw-source-lines{border-top:1px solid var(--border);padding:.6rem .75rem}.raw-source-lines p{margin:0;color:var(--copy);font-size:.78rem}.raw-source-lines p+p{margin-top:.3rem}.evidence-choices{display:grid;gap:.6rem;max-height:23rem;overflow:auto;border:1px solid var(--border);border-radius:.55rem;padding:.65rem;background:var(--raised)}.evidence-choice-group{display:grid;gap:.25rem;margin:0;border:0;padding:0}.evidence-choice-group legend{padding:0;color:var(--muted);font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.evidence-choice{display:flex;align-items:flex-start;gap:.5rem;border-radius:.4rem;padding:.35rem .4rem;background:#fff;color:var(--copy);font-size:.78rem;cursor:pointer}.evidence-choice:hover{background:#edf9f2}.evidence-choice input{flex:0 0 auto;width:1rem;height:1rem;margin:.15rem 0 0;accent-color:var(--accent)}
.fit-summary,.questions,.confirmed-gaps,.review-details{margin:0 1rem 1rem}.fit-summary,.questions,.confirmed-gaps{border:1px solid var(--border);border-radius:.75rem;padding:1rem;background:var(--raised)}.fit-summary h3,.questions h3,.confirmed-gaps h3{margin-bottom:.3rem}.summary-counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.65rem;margin:.85rem 0}.summary-count{border:1px solid var(--border);border-radius:.55rem;padding:.65rem;background:#fff}.summary-count dt{color:var(--muted);font-size:.72rem;font-weight:750}.summary-count dd{margin:.1rem 0 0;font-size:1.25rem;font-weight:800}.summary-count.supported dd{color:var(--accent)}.summary-count.gap dd{color:var(--danger)}.section-copy{color:var(--copy);font-size:.86rem}.clarification-card{margin:.8rem 0 0;border:1px solid var(--border);border-radius:.65rem;padding:.9rem;background:#fff}.clarification-card legend{padding:0 .35rem;color:var(--accent);font-weight:800}.clarification-question{margin-bottom:.35rem;font-weight:700}.why{margin:.2rem 0;color:var(--muted);font-size:.78rem}.related-requirements{margin:.65rem 0;border-left:3px solid var(--border);padding-left:.65rem}.related-requirements summary{cursor:pointer;color:var(--copy);font-size:.78rem;font-weight:750}.related-requirements ul{margin:.4rem 0 0;padding-left:1.1rem;color:var(--copy);font-size:.78rem}.answer-choices{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem;margin-top:.75rem}.answer-choice{display:flex;align-items:flex-start;gap:.45rem;border:1px solid var(--border);border-radius:.5rem;padding:.55rem;background:var(--raised);font-size:.78rem;cursor:pointer}.answer-choice:has(input:checked){border-color:var(--strong);background:#edf9f2}.answer-choice input{flex:0 0 auto;margin:.15rem 0 0;accent-color:var(--accent)}.clarification-context textarea{min-height:5rem}.review-details{border:1px solid var(--border);border-radius:.65rem;background:#fff}.review-details>summary{cursor:pointer;padding:.8rem 1rem;color:var(--accent);font-weight:800}.mapped-list,.all-requirements-list,.source-details>.evidence-list{border-top:1px solid var(--border);padding:1rem}.mapped-requirement+.mapped-requirement{margin-top:1rem}.mapped-requirement h4,.gap-card h4{margin-bottom:.2rem}.mapped-evidence{display:grid;gap:.45rem;margin-top:.55rem}.all-requirements-list{display:grid;gap:.7rem;margin:0;list-style-position:inside}.requirement-row{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:.65rem;align-items:start}.requirement-row p{margin:.2rem 0 0;color:var(--muted);font-size:.76rem}.requirement-labels{display:grid;gap:.3rem}.status-label,.materiality-label{border-radius:999px;padding:.25rem .5rem;text-align:center;text-transform:capitalize;font-size:.68rem;font-weight:800;background:#edf4f0;color:var(--copy)}.status-label.supported{background:#e7f7ee;color:var(--accent)}.status-label.confirmed_gap{background:#fff0ef;color:var(--danger)}.status-label.unknown{background:#fff8e5;color:var(--warn)}.materiality-label.must_have{background:#f5ebff;color:#62358c}.materiality-label.preferred{background:#edf4ff;color:#315a8a}.document-approval-unavailable{display:grid;gap:.15rem;margin:.6rem 0 1rem;border:1px solid #dfbd6b;border-radius:.55rem;padding:.75rem;background:#fff9e9;color:var(--warn);font-size:.8rem}.execution-copy{margin:1rem;color:var(--copy)}.consent-checks{display:grid;gap:.5rem;margin:1rem}.consent-checks .confirmation{margin:0}.result-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.65rem}.result-grid .fact{min-width:0;overflow-wrap:anywhere}.result-grid .fact span{text-transform:none;letter-spacing:0;font-size:.76rem}.readable-result{display:grid;gap:1rem;margin-top:1rem}.readable-section{border:1px solid var(--border);border-radius:.75rem;padding:1rem;background:var(--raised)}.readable-section>h3{margin-bottom:.25rem;color:var(--text)}.readable-section>h4{margin:.8rem 0 .35rem;font-size:.86rem;color:var(--accent)}.readable-section .section-copy{margin-bottom:.7rem}.result-card{border:1px solid var(--border);border-radius:.65rem;padding:.85rem;background:#fff}.result-card+.result-card{margin-top:.65rem}.result-card h4{margin:0 0 .35rem;color:var(--text);font-size:.92rem}.citation-columns,.context-grid,.safe-report-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}.citation-group{min-width:0;border-left:3px solid var(--strong);padding-left:.65rem}.citation-group h5{margin:0 0 .35rem;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}.citation-list{display:grid;gap:.45rem;margin:0;padding:0;list-style:none}.citation-list li{min-width:0;color:var(--copy);font-size:.8rem;overflow-wrap:anywhere}.source-provenance{display:block;margin-top:.1rem;color:var(--muted);font-size:.7rem}.keyword-line{margin:.45rem 0 0;color:var(--copy);font-size:.78rem}.empty-result{margin:0;border:1px dashed var(--border);border-radius:.55rem;padding:.75rem;color:var(--muted);background:#fff;font-size:.82rem}.context-grid .fact{min-width:0}.advisory-list{margin:.4rem 0 0;padding-left:1.2rem;color:var(--copy);font-size:.84rem}.advisory-list li+li{margin-top:.35rem}.review-choice-copy{display:grid;gap:.1rem}.review-choice-copy strong{color:var(--text)}.review-choice-copy span{color:var(--muted);font-size:.76rem}.safe-report-grid{margin-top:.75rem}.safe-result{display:grid;gap:.3rem}.safe-result dl{display:grid;grid-template-columns:1fr auto;gap:.25rem .7rem;margin:0}.safe-result dt{color:var(--muted);font-size:.76rem}.safe-result dd{margin:0;font-size:.78rem;font-weight:750;text-align:right}
@media(max-width:900px){.review-grid{grid-template-columns:1fr}.review-grid>.column:last-child{position:static}.fact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.preference-grid,.preference-evidence{grid-template-columns:1fr}.panel-head,.section-heading{display:grid}.source-reference{justify-items:start;text-align:left}.badge{justify-self:start}.manifest-row{grid-template-columns:1fr;gap:.15rem}}
@media(max-width:760px){.summary-counts{grid-template-columns:repeat(2,minmax(0,1fr))}.answer-choices{grid-template-columns:repeat(2,minmax(0,1fr))}.citation-columns,.context-grid,.safe-report-grid{grid-template-columns:1fr}}
@media(max-width:520px){.masthead-inner,main{width:min(100% - 1rem,1180px)}main{padding-top:1rem}.review-grid,.decision,.open-gaps,.job-overview,.fit-summary,.questions,.confirmed-gaps,.review-details{padding:.75rem;margin-left:.5rem;margin-right:.5rem}.review-details{padding:0}.panel-head{padding:.85rem}.badge{white-space:normal;overflow-wrap:anywhere}.fact-grid,.summary-counts,.answer-choices{grid-template-columns:1fr}.execution-copy{margin:.5rem}.result-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}.result-grid [data-result-metric="recommendation"]{grid-column:1/-1}.result-grid .fact{padding:.6rem}.readable-result{gap:.65rem;margin-top:.75rem}.readable-section{padding:.75rem}.result-card{padding:.7rem}.requirement-row{grid-template-columns:1fr}.status-label{justify-self:start}.actions{display:grid}.button{width:100%}}
@media(max-width:340px){.result-grid{grid-template-columns:1fr}.result-grid [data-result-metric="recommendation"]{grid-column:auto}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

const javascript = String.raw`
(() => {
  "use strict";
  const body = document.body;
  const app = document.getElementById("app");
  const live = document.getElementById("status");
  const paths = {
    state: body.dataset.statePath,
    guide: body.dataset.guideSubmissionPath,
    submit: body.dataset.submissionPath,
    consent: body.dataset.consentPath,
    executionReview: body.dataset.executionReviewPath,
    cancel: body.dataset.cancelPath
  };
  const disagreementLabels = Object.freeze({
    recommendation: "Recommendation is wrong",
    missing_material_gap: "A material gap is missing",
    unsupported_positive_match: "A positive match lacks support",
    compensation: "Compensation assessment is wrong",
    preference: "Preference assessment is wrong",
    advice_claim: "Advice overstates the evidence",
    other_review_required: "Another issue needs review"
  });
  let sessionEnded = false;
  let pollTimer;
  let consecutivePollFailures = 0;
  let suspendedControls = [];
  let renderedPhase = "";
  let renderedCaseIndex = -1;
  let renderedCaptureFailureNotice = "";

  const cancellationUrl = (trigger) => paths.cancel + "?trigger=" + encodeURIComponent(trigger);

  const element = (tag, options = {}) => {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value);
    return node;
  };

  const labeledSelect = (id, label, values, selected = "") => {
    const wrap = element("div", { className: "field" });
    wrap.append(element("label", { text: label, attrs: { for: id } }));
    const select = element("select", { attrs: { id, name: id, required: "" } });
    select.append(element("option", { text: "Choose…", attrs: { value: "" } }));
    for (const [value, text] of values) {
      const option = element("option", { text, attrs: { value } });
      if (value === selected) option.selected = true;
      select.append(option);
    }
    wrap.append(select);
    return { wrap, select };
  };

  const renderProgress = (current, count, final = false) => {
    const progress = element("div", { className: "progress", attrs: { "aria-label": "Review progress" } });
    for (let index = 0; index < count; index += 1) {
      progress.append(element("span", {
        className: "step " + (!final && index === current ? "current" : ""),
        text: "Job " + (index + 1) + (index < current || final ? " reviewed" : "")
      }));
    }
    progress.append(element("span", {
      className: "step " + (final ? "current" : ""),
      text: "Google consent"
    }));
    return progress;
  };

  const renderExecutionTracker = (current, count, reviewing = false) => {
    const progress = element("div", { className: "progress", attrs: { "aria-label": "Provider execution progress" } });
    for (let index = 0; index < count; index += 1) {
      const completed = index < current - (reviewing ? 1 : 0);
      const active = reviewing ? index === current - 1 : index === current;
      progress.append(element("span", {
        className: "step " + (active ? "current" : ""),
        text: "Provider job " + (index + 1) + (completed ? " completed" : active ? (reviewing ? " awaiting your review" : " in progress") : " waiting")
      }));
    }
    return progress;
  };

  const evidenceCard = (item) => {
    const article = element("article", { className: "evidence" });
    article.append(element("p", { className: "evidence-label", text: item.label }));
    article.append(element("p", { className: "evidence-title", text: item.title }));
    if (item.details.length) {
      const details = element("ul", { className: "evidence-details" });
      item.details.forEach((detail) => details.append(element("li", { text: detail })));
      article.append(details);
    }
    return article;
  };

  const presentValue = (value, fallback = "Not provided") => {
    if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
    if (value === null || value === undefined || value === "") return fallback;
    return String(value);
  };

  const moneyRange = (minimum, maximum) => {
    const money = (value) => new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(value);
    if (typeof minimum === "number" && typeof maximum === "number") return money(minimum) + "–" + money(maximum);
    if (typeof minimum === "number") return money(minimum) + "+";
    if (typeof maximum === "number") return "Up to " + money(maximum);
    return "Not provided";
  };

  const citationGroup = (title, citations) => {
    const group = element("section", { className: "citation-group" });
    group.append(element("h5", { text: title }));
    const list = element("ul", { className: "citation-list" });
    citations.forEach((citation) => {
      const item = element("li", { attrs: { "data-source-ref": citation.ref } });
      item.append(
        element("span", { text: citation.excerpt }),
        element("span", { className: "source-provenance", text: citation.sourceOriginLabel })
      );
      list.append(item);
    });
    if (!citations.length) list.append(element("li", { text: "No citation was supplied." }));
    group.append(list);
    return group;
  };

  const factCard = (label, value) => {
    const fact = element("div", { className: "fact" });
    fact.append(element("span", { text: label }), element("strong", { text: presentValue(value) }));
    return fact;
  };

  const renderEvidenceSection = (title, items) => {
    if (!items.length) return null;
    const section = element("section", { className: "resume-section" });
    section.append(element("h4", { text: title }));
    items.forEach((item) => section.append(evidenceCard(item)));
    return section;
  };

  const renderJobContext = (reviewCase) => {
    const context = reviewCase.jobContext;
    const section = element("section", { className: "job-overview panel", attrs: { "aria-labelledby": "job-overview-heading" } });
    const heading = element("div", { className: "section-heading" });
    const headingCopy = element("div");
    headingCopy.append(element("p", { className: "section-kicker", text: "Exact captured projection" }));
    headingCopy.append(element("h3", { text: "Frozen job posting", attrs: { id: "job-overview-heading" } }));
    headingCopy.append(element("p", { className: "hint", text: context.title + " at " + context.company + " · captured " + context.capturedAtLabel }));
    heading.append(headingCopy);
    if (context.sourceUrl) {
      const source = element("div", { className: "source-reference" });
      source.append(element("a", {
        className: "source-link",
        text: "Open original posting URL",
        attrs: { href: context.sourceUrl, target: "_blank", rel: "noopener noreferrer" }
      }));
      source.append(element("span", { text: "The external page may have changed since capture." }));
      heading.append(source);
    }
    section.append(heading);
    const facts = element("div", { className: "fact-grid" });
    for (const [label, value] of [
      ["Company", context.company],
      ["Location", context.location],
      ["Work arrangement", context.workArrangement],
      ["Listed compensation", context.compensation]
    ]) {
      const fact = element("div", { className: "fact" });
      fact.append(element("span", { text: label }), element("strong", { text: value }));
      facts.append(fact);
    }
    section.append(facts, element("h4", { text: "Role overview and responsibilities" }));
    const responsibilities = element("ul", { className: "responsibilities" });
    context.responsibilities.forEach((entry) => responsibilities.append(element("li", { text: entry })));
    if (!context.responsibilities.length) responsibilities.append(element("li", { text: "Not listed" }));
    section.append(responsibilities, element("h4", { text: "Technologies mentioned" }));
    const technologies = element("div", { className: "tech-list" });
    (context.technologies.length ? context.technologies : ["Not listed"]).forEach((entry) =>
      technologies.append(element("span", { className: "chip", text: entry })));
    section.append(technologies);
    return section;
  };

  const renderSourceResume = (reviewCase) => {
    const preview = reviewCase.sourceResume;
    const section = element("section", { className: "resume-preview", attrs: { "aria-label": "Formatted source resume preview" } });
    section.append(element("h3", { text: preview.title }));
    section.append(element("p", { className: "resume-caption", text: "Source evidence — not a tailored résumé" }));
    if (preview.originalText.length) {
      const original = element("details", { className: "raw-source" });
      original.append(element("summary", { text: "Original captured résumé text" }));
      const lines = element("div", { className: "raw-source-lines" });
      preview.originalText[0].details.forEach((line) => lines.append(element("p", { text: line })));
      original.append(lines);
      section.append(original);
    }
    for (const [title, items] of [
      ["Summary", preview.summary],
      ["Work experience", preview.workHistory],
      ["Projects", preview.projects],
      ["Education", preview.education],
      ["Certifications", preview.certifications],
      ["Achievements", preview.achievements],
      ["Skills", preview.skills]
    ]) {
      const evidenceSection = renderEvidenceSection(title, items);
      if (evidenceSection) section.append(evidenceSection);
    }
    return section;
  };

  const clearRenderedEvidence = (message, copy = "Local review ended. This tab cleared its rendered applicant evidence.") => {
    if (pollTimer) clearTimeout(pollTimer);
    document.getElementById("connection-notice").hidden = true;
    document.getElementById("memory-notice").textContent = "The local evidence view is closed. This page does not retain a persistent copy.";
    app.replaceChildren(element("section", { className: "panel loading", text: copy }));
    live.textContent = message;
  };

  const suspendInteractiveControls = () => {
    suspendedControls = [...app.querySelectorAll("button:not([data-session-cancel]),input,select,textarea")]
      .map((control) => [control, control.disabled]);
    for (const [control] of suspendedControls) control.disabled = true;
    document.getElementById("connection-notice").hidden = false;
  };

  const restoreInteractiveControls = () => {
    for (const [control, wasDisabled] of suspendedControls) {
      if (control.isConnected) control.disabled = wasDisabled;
    }
    suspendedControls = [];
    document.getElementById("connection-notice").hidden = true;
  };

  const isTransientStateFailure = (error) =>
    error instanceof TypeError || error?.name === "AbortError";

  const fetchStateWithTransientRetry = async () => {
    try {
      return await fetchState();
    } catch (error) {
      if (!isTransientStateFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return fetchState();
    }
  };

  const cancelSession = async () => {
    if (sessionEnded) return;
    const providerOutcomeUncertain = renderedPhase === "execution_starting"
      || renderedPhase === "executing"
      || renderedPhase === "reviewing_provider_result";
    sessionEnded = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      const response = await fetch(cancellationUrl("owner_cancel"), { method: "POST", keepalive: true });
      if (!response.ok) throw new Error("Cancellation was not acknowledged");
      clearRenderedEvidence(
        providerOutcomeUncertain
          ? "Execution stopped. Started or completed calls may be billable; check the terminal receipt."
          : "Local review ended.",
        providerOutcomeUncertain
          ? "The server acknowledged the stop and no later call can start. A request already started may still have completed and may be billable; use the terminal receipt for the final call and cost status."
          : "Local review ended. This tab cleared its rendered applicant evidence."
      );
    } catch {
      clearRenderedEvidence(
        providerOutcomeUncertain
          ? "This tab cleared its evidence, but execution cancellation was not acknowledged; provider outcome is uncertain."
          : "This tab cleared its evidence, but the server did not acknowledge cancellation.",
        providerOutcomeUncertain
          ? "Server release was not confirmed. An in-flight request may finish and may be billable; stop the terminal process now. No later call can start after cancellation is acknowledged."
          : "This tab cleared its rendered applicant evidence, but server release was not confirmed. Stop the terminal process now; its timeout remains the fallback."
      );
    }
  };

  const handleAmbiguousMutation = async ({ providerOutcomeUncertain }) => {
    sessionEnded = true;
    let cancellationAcknowledged = false;
    try {
      const response = await fetch(cancellationUrl("action_acknowledgement_lost"), { method: "POST", keepalive: true });
      cancellationAcknowledged = response.ok;
    } catch {
      // The terminal timeout or process exit remains the fallback.
    }
    clearRenderedEvidence(
      providerOutcomeUncertain
        ? "The action may have been accepted; provider completion and billing are uncertain."
        : "The local action may have been accepted, but its acknowledgement was lost.",
      (providerOutcomeUncertain
        ? "The loopback response was lost after dispatch. The action may have been accepted, and a request may have started, completed, and may be billable. No later call can start after cancellation is acknowledged."
        : "The loopback response was lost after dispatch, so the local action may have been accepted. This tab cleared its evidence and sent cancellation best-effort.")
        + (cancellationAcknowledged
          ? " The server acknowledged cancellation."
          : " Server acknowledgement was not received; stop the terminal process now or rely on its timeout fallback.")
    );
  };

  const refreshAfterAcceptedMutation = async ({ nextPhase, providerOutcomeUncertain }) => {
    renderedPhase = nextPhase;
    try {
      const state = await fetchStateWithTransientRetry();
      applyLoadedState(state, true);
      window.scrollTo({ top: 0, behavior: "auto" });
      return true;
    } catch {
      sessionEnded = true;
      let cancellationAcknowledged = false;
      try {
        const response = await fetch(cancellationUrl("status_poll_failure"), { method: "POST", keepalive: true });
        cancellationAcknowledged = response.ok;
      } catch {
        // The terminal timeout or process exit remains the fallback.
      }
      const providerCopy = providerOutcomeUncertain
        ? "The action was accepted, but refreshed execution state was unavailable. A started request may have completed and may be billable. The tab sent cancellation best-effort; no later call can start after cancellation is acknowledged."
        : "The action was accepted, but the refreshed local state was unavailable. The tab cleared its evidence and sent cancellation best-effort.";
      clearRenderedEvidence(
        providerOutcomeUncertain
          ? "Execution contact was lost after an accepted action; provider outcome is uncertain."
          : "The accepted local action could not be refreshed.",
        providerCopy + (cancellationAcknowledged
          ? " The server acknowledged cancellation."
          : " Server acknowledgement was not received; stop the terminal process now or rely on its timeout fallback.")
      );
      return false;
    }
  };

  const renderFinal = (state) => {
    const manifest = state.finalManifest;
    const section = element("section", { className: "panel", attrs: { "data-phase": "consent-gate" } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: "Review complete. Google remains blocked." }));
    copy.append(element("p", { text: state.executionAvailable
      ? "The loopback server retains the exact inputs and four attestations while this tab displays only this final manifest. No credential has been activated."
      : "This review-only preview has released its private execution input and displays only the safe final manifest." }));
    head.append(copy, element("span", { className: "badge", text: "Separate consent required" }));
    section.append(head, renderProgress(state.caseCount, state.caseCount, true));
    const stop = element("div", { className: "consent-stop" });
    stop.append(element("strong", { text: state.executionAvailable ? "No provider action occurs until you approve these exact terms." : "No provider action is available on this screen." }));
    stop.append(element("p", { text: state.executionAvailable
      ? "This approval is bound to the exact final manifest below. It authorizes only four sequential Google Gemini requests, no retries, the displayed maximum reservation, and sharing the exact reviewed private applicant projection with Google."
      : "This review-only preview has no provider action. A future real run requires a new exact capture and separately displayed consent." }));
    section.append(stop);
    const technical = element("details", { className: "technical-details" });
    technical.append(element("summary", { text: "Technical run details" }));
    const details = element("dl", { className: "manifest" });
    const rows = [
      ["Final manifest hash", manifest.manifestHash],
      ["Résumé projection hash", manifest.resumeProjectionHash],
      ["Profile projection hash", manifest.profileProjectionHash],
      ["Readiness", manifest.readiness],
      ["Model / prompt", manifest.model + " / " + manifest.promptVersion],
      ["Call order", manifest.cases.map((entry) => entry.safeLabel).join(" → ")],
      ["Requests", manifest.caseCount + " sequential; retry disabled"],
      ["Maximum reservation", manifest.maximumCostMicros + " micros"],
      ["Database writes", manifest.noDatabaseWrites ? "Disabled" : "Unexpected"]
    ];
    for (const [label, value] of rows) {
      const row = element("div", { className: "manifest-row" });
      row.append(element("dt", { text: label }), element("dd", { text: String(value) }));
      details.append(row);
    }
    technical.append(details);
    section.append(technical);
    if (state.executionAvailable) {
      const consent = element("form", { className: "consent-checks", attrs: { "data-execution-consent": "" } });
      for (const text of [
        "I approve sending this exact reviewed applicant projection and the four frozen public jobs to the Google Gemini Developer API.",
        "I explicitly approve activating and using the existing Gemini credential only for this exact consented run.",
        "I approve exactly " + manifest.caseCount + " sequential " + manifest.model + " calls in the displayed order, prompt " + manifest.promptVersion + ", " + String(manifest.thinkingLevel).toLowerCase() + " thinking, no retry, with a maximum reservation of $" + (manifest.maximumCostMicros / 1000000).toFixed(6) + ".",
        "I understand this run performs no database write, routing change, or employer interaction."
      ]) {
        const label = element("label", { className: "confirmation" });
        label.append(element("input", { attrs: { type: "checkbox", required: "" } }), element("span", { text }));
        consent.append(label);
      }
      const consentError = element("p", { className: "error", attrs: { role: "alert" } });
      const approve = element("button", { className: "button button-primary", text: "Approve this exact four-call test", attrs: { type: "submit" } });
      consent.append(consentError, approve);
      consent.addEventListener("submit", async (event) => {
        event.preventDefault();
        consentError.textContent = "";
        if (!consent.reportValidity()) return;
        approve.disabled = true;
        const payload = {
          recipient: manifest.recipient,
          model: manifest.model,
          promptVersion: manifest.promptVersion,
          approvedManifestHash: manifest.manifestHash,
          approvedCallCount: manifest.caseCount,
          approvedMaximumCostMicros: manifest.maximumCostMicros,
          privateApplicantDataSharingApproved: true,
          existingCredentialUseApproved: true,
          noRetry: true,
          noDatabaseWrites: true,
          noRoutingWrites: true,
          noEmployerInteraction: true
        };
        let response;
        try {
          response = await fetch(paths.consent, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
        } catch {
          await handleAmbiguousMutation({ providerOutcomeUncertain: true });
          return;
        }
        if (!response.ok) {
          consentError.textContent = "Consent was rejected. No new provider request was started.";
          approve.disabled = false;
          return;
        }
        await refreshAfterAcceptedMutation({ nextPhase: "execution_starting", providerOutcomeUncertain: true });
      });
      section.append(consent);
    }
    const actions = element("div", { className: "actions decision" });
    const end = element("button", { className: "button button-danger", text: "End local session", attrs: { type: "button", "data-session-cancel": "" } });
    end.addEventListener("click", () => { void cancelSession(); });
    actions.append(element("span", { className: "hint", text: "Ending the process requires a future recapture; hashes can verify equality but cannot restore memory." }), end);
    section.append(actions);
    app.replaceChildren(section);
    live.textContent = "Four reviews complete. Exact Google consent is still required.";
  };

  const renderExecutionProgress = (state) => {
    const section = element("section", { className: "panel loading", attrs: { "data-phase": state.phase } });
    section.append(element("h2", { text: state.phase === "execution_starting" ? "Activating the consented transport." : "Running one consented call." }));
    section.append(element("p", { text: "Calls completed or in flight: " + state.providerCallCount + " of " + state.caseCount + ". Calls are sequential and never retried." }));
    section.append(renderExecutionTracker(Math.min(Math.max(state.providerCallCount - 1, 0), state.caseCount - 1), state.caseCount));
    section.append(element("p", { className: "hint", text: "Each provider request has a 180-second deadline. Closing or navigating away stops progression. An in-flight request may finish, but it cannot start a duplicate or later case." }));
    const actions = element("div", { className: "actions" });
    const stop = element("button", { className: "button button-danger", text: "Stop and release memory", attrs: { type: "button", "data-session-cancel": "" } });
    stop.addEventListener("click", () => { void cancelSession(); });
    actions.append(stop);
    section.append(actions);
    app.replaceChildren(section);
    live.textContent = "Qualification execution is in progress.";
  };

  const renderProviderResultReview = (state) => {
    const pending = state.providerResultReview;
    const output = pending.normalizedOutput;
    const form = element("form", { className: "panel", attrs: { "data-provider-review-case-id": pending.caseId } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: "Review the model result for " + pending.safeLabel }));
    copy.append(element("p", { text: "Result " + pending.index + " of " + state.caseCount + " · the next call stays blocked until this review is recorded" }));
    head.append(copy, element("span", { className: "badge", text: "Provider calls: " + state.providerCallCount }));
    form.append(head, renderExecutionTracker(pending.index, state.caseCount, true));
    const summary = element("section", { className: "execution-copy" });
    summary.append(element("h3", { text: "Normalized provider result" }));
    const facts = element("div", { className: "result-grid" });
    for (const [id, label, value] of [
      ["recommendation", "Model recommendation", output.recommendation],
      ["fit-score", "Fit score", output.overallFitScore + " / 100"],
      ["model-confidence", "Model confidence", output.confidenceScore + " / 100"]
    ]) {
      const fact = element("div", { className: "fact", attrs: { "data-result-metric": id } });
      fact.append(element("span", { text: label }), element("strong", { text: String(value) }));
      facts.append(fact);
    }
    summary.append(facts, element("p", { className: "hint", text: "Scores are model estimates, not hiring probabilities. Verify the cited evidence and gaps." }));

    const readable = element("div", { className: "readable-result" });

    const whyFits = element("section", { className: "readable-section" });
    whyFits.append(element("h3", { text: "Why this fits" }));
    whyFits.append(element("p", { className: "section-copy", text: "Only matches backed by both submitted applicant evidence and the frozen job are shown here." }));
    whyFits.append(element("h4", { text: "Source-backed factual matches" }));
    if (!output.factualMatches.length) {
      whyFits.append(element("p", { className: "empty-result", text: "The model reported no source-backed factual matches for this job." }));
    }
    output.factualMatches.forEach((match) => {
      const card = element("article", { className: "result-card" });
      card.append(element("h4", { text: match.claim }));
      if (match.supportedKeywords.length) {
        card.append(element("p", { className: "keyword-line", text: "Supported keywords: " + match.supportedKeywords.join(", ") }));
      }
      card.append(element("h4", { text: "Evidence used" }));
      const citations = element("div", { className: "citation-columns" });
      citations.append(citationGroup("Applicant source", match.applicantEvidence), citationGroup("Job source", match.jobEvidence));
      card.append(citations);
      whyFits.append(card);
    });
    readable.append(whyFits);

    const missing = element("section", { className: "readable-section" });
    missing.append(element("h3", { text: "Not evidenced in the submitted resume" }));
    missing.append(element("p", { className: "section-copy", text: "Exact terms not found are evidence-review signals, not proof that the applicant lacks the capability." }));
    missing.append(element("p", { className: "section-copy", text: "These are requirements the model said were not supported by the submitted applicant evidence. Confirm each against the cited source." }));
    missing.append(element("h4", { text: "Important gaps reported by the model" }));
    if (!output.requirementGaps.length) {
      missing.append(element("p", { className: "empty-result", text: "The model reported no requirement gaps. That does not prove every requirement is satisfied." }));
    }
    output.requirementGaps.forEach((gap) => {
      const card = element("article", { className: "result-card" });
      card.append(element("h4", { text: gap.requirement }));
      card.append(citationGroup("Job requirement cited", [gap.jobRequirement]));
      card.append(element("p", { className: "keyword-line", text: "Exact terms not found: " + (gap.missingKeywords.length ? gap.missingKeywords.join(", ") : "None listed") }));
      missing.append(card);
    });
    readable.append(missing);

    const context = element("section", { className: "readable-section" });
    context.append(element("h3", { text: "Compensation and preference context" }));
    context.append(element("p", { className: "section-copy", text: "These values may affect personal fit, but they are not evidence that the applicant meets a job qualification." }));
    const contextGrid = element("div", { className: "context-grid" });
    contextGrid.append(
      factCard("Applicant salary target", moneyRange(pending.matchInput.profile?.salaryTargetMin, pending.matchInput.profile?.salaryTargetMax)),
      factCard("Job-listed salary", moneyRange(pending.matchInput.job.salaryMin, pending.matchInput.job.salaryMax)),
      factCard("Applicant preferred locations", pending.displayContext.applicantPreferredLocations),
      factCard("Job location", pending.displayContext.jobLocation),
      factCard("Applicant work preference", pending.displayContext.applicantWorkPreference),
      factCard("Job work arrangement", pending.displayContext.jobWorkArrangement),
      factCard("Model compensation score", output.compensationAssessment.score === null ? "Not scored" : output.compensationAssessment.score),
      factCard("Why compensation was scored this way", output.compensationAssessment.reason.replaceAll("_", " "))
    );
    context.append(contextGrid);
    readable.append(context);

    const limitations = element("section", { className: "readable-section" });
    limitations.append(element("h3", { text: "What needs your review" }));
    limitations.append(element("p", { className: "section-copy", text: "Check whether the recommendation follows from the displayed evidence and gaps. The confidence value is the model's own uncalibrated estimate, not a hiring probability." }));
    limitations.append(element("h4", { text: "Limitations and advisory output" }));
    const advisory = element("ul", { className: "advisory-list" });
    advisory.append(element("li", { text: "Confidence basis: " + presentValue(output.confidenceAssessment.basis) }));
    advisory.append(element("li", { text: "Keywords suggested for emphasis: " + presentValue(output.keywordsToEmphasize, "None") }));
    advisory.append(element("li", { text: "Suggested résumé angle (advice only; no document was generated): " + presentValue(output.suggestedResumeAngle) }));
    advisory.append(element("li", { text: "Suggested cover-letter angle (advice only; no document was generated): " + presentValue(output.suggestedCoverLetterAngle) }));
    advisory.append(element("li", { text: "Other concerns: " + presentValue(output.concerns, "None reported") }));
    limitations.append(advisory);
    readable.append(limitations);

    summary.append(readable);
    form.append(summary);
    const categories = element("fieldset", { className: "questions" });
    categories.append(element("legend", { text: "Mark any model mistake (optional)" }));
    categories.append(element("p", { className: "section-copy", text: "Leave every box unchecked if the result is acceptable. These boxes record mistakes; they do not approve the recommendation." }));
    for (const [value, label, description] of [
      ["recommendation", disagreementLabels.recommendation, "The recommendation band seems wrong for the displayed evidence and gaps."],
      ["missing_material_gap", disagreementLabels.missing_material_gap, "An important requirement is absent from the model's gap list."],
      ["unsupported_positive_match", disagreementLabels.unsupported_positive_match, "A claimed match is not supported by both cited applicant and job evidence."],
      ["compensation", disagreementLabels.compensation, "The salary values or compensation conclusion are incorrect."],
      ["preference", disagreementLabels.preference, "The location or work-arrangement interpretation is incorrect."],
      ["advice_claim", disagreementLabels.advice_claim, "The résumé or cover-letter advice adds or exaggerates a claim."],
      ["other_review_required", disagreementLabels.other_review_required, "A different result error should be recorded for follow-up."]
    ]) {
      const choice = element("label", { className: "confirmation" });
      const choiceCopy = element("span", { className: "review-choice-copy" });
      choiceCopy.append(element("strong", { text: label }), element("span", { text: description }));
      choice.append(element("input", { attrs: { type: "checkbox", value } }), choiceCopy);
      categories.append(choice);
    }
    form.append(categories);
    const error = element("p", { className: "error", attrs: { role: "alert" } });
    const actions = element("div", { className: "actions decision" });
    const cancel = element("button", { className: "button button-danger", text: "Stop and release memory", attrs: { type: "button", "data-session-cancel": "" } });
    cancel.addEventListener("click", () => { void cancelSession(); });
    const submit = element("button", { className: "button button-primary", text: "Record result review and continue", attrs: { type: "submit" } });
    actions.append(cancel, submit);
    form.append(error, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      let response;
      try {
        response = await fetch(paths.executionReview, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            caseId: pending.caseId,
            disagreementCategories: [...categories.querySelectorAll("input:checked")].map((input) => input.value)
          })
        });
      } catch {
        await handleAmbiguousMutation({ providerOutcomeUncertain: true });
        return;
      }
      if (!response.ok) {
        error.textContent = "The result review was rejected. No later provider call was started.";
        submit.disabled = false;
        return;
      }
      await refreshAfterAcceptedMutation({ nextPhase: "executing", providerOutcomeUncertain: true });
    });
    app.replaceChildren(form);
    live.textContent = "Reviewing provider result " + pending.index + " of " + state.caseCount + ".";
  };

  const renderExecutionOutcome = (state) => {
    const section = element("section", { className: "panel", attrs: { "data-phase": state.phase } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: state.phase === "execution_complete" ? "Four-call qualification completed." : "Qualification stopped safely." }));
    copy.append(element("p", { text: "Only the bounded safe report remains in this local process." }));
    head.append(copy, element("span", { className: "badge", text: "Provider calls: " + state.providerCallCount }));
    section.append(head);
    const report = element("div", { className: "execution-copy" });
    const safeReport = state.safeReport && typeof state.safeReport === "object" ? state.safeReport : {};
    report.append(element("h3", { text: "Safe final report" }));
    report.append(element("p", { className: "section-copy", text: state.phase === "execution_complete"
      ? "All four bounded calls and their owner reviews completed. This report contains only retained safe metadata, not model prose or private source inputs."
      : "The run stopped before all four reviews completed. No retry was attempted; use the failure summary below to understand where it stopped." }));
    const reportFacts = element("div", { className: "result-grid" });
    const knownCostMicros = typeof safeReport.totalEstimatedCostMicros === "number"
      ? safeReport.totalEstimatedCostMicros
      : safeReport.totalKnownEstimatedCostMicros;
    reportFacts.append(
      factCard("Status", presentValue(safeReport.status, state.phase === "execution_complete" ? "completed" : "stopped")),
      factCard("Cases completed", presentValue(safeReport.completedCaseCount, 0) + " of " + state.caseCount),
      factCard("Known estimated cost", typeof knownCostMicros === "number"
        ? "$" + (knownCostMicros / 1000000).toFixed(6)
        : "Not available")
    );
    report.append(reportFacts);
    if (safeReport.failureCode) {
      const stopped = element("section", { className: "readable-section" });
      stopped.append(element("h3", { text: "Why execution stopped" }));
      const failureMeanings = {
        CREDENTIAL_ACTIVATION_FAILED: "The provider credential could not be activated, so no provider request started.",
        INTERNAL_EXECUTION_FAILED: "The local bounded execution stopped because of an internal error.",
        TRANSPORT_FAILED: "The provider request did not return a usable response.",
        PROVIDER_RESPONSE_REJECTED: "The provider response did not finish normally.",
        RESPONSE_BODY_LIMIT_EXCEEDED: "The provider response exceeded the approved response-size bound.",
        REQUEST_TIME_LIMIT_EXCEEDED: "The provider request exceeded the approved time bound.",
        TOKEN_LIMIT_EXCEEDED: "The provider reported token use outside the approved bound.",
        COST_LIMIT_EXCEEDED: "The estimated provider cost exceeded the per-call bound.",
        MODEL_OUTPUT_VALIDATION_FAILED: "The returned model data failed contract or evidence validation before owner review.",
        TRANSIENT_HUMAN_REVIEW_FAILED: "The transient owner result review could not be completed."
      };
      stopped.append(element("p", { text: "Case " + presentValue(safeReport.failedCaseIndex, "unknown") + " stopped. " + (failureMeanings[safeReport.failureCode] ?? "The run stopped at a protected execution boundary.") + " No automatic retry was attempted." }));
      const failedCall = safeReport.failedCall && typeof safeReport.failedCall === "object" ? safeReport.failedCall : {};
      const failureFacts = element("div", { className: "context-grid" });
      failureFacts.append(
        factCard("Failure code", safeReport.failureCode),
        factCard("Validation stage", safeReport.validationStage ?? "Not applicable"),
        factCard("Validation code", safeReport.validationCode ?? "Not available"),
        factCard("Validation field", safeReport.failureFieldPath ?? "Not available"),
        factCard("Provider responded", failedCall.providerResponded === true ? "Yes" : failedCall.providerResponded === false ? "No" : "Unknown"),
        factCard("Billing status", presentValue(failedCall.billingDisposition, "Unknown")),
        factCard("HTTP status", failedCall.httpStatus ?? "Not available"),
        factCard("Provider error code", failedCall.providerCode ?? "Not available")
      );
      stopped.append(failureFacts);
      report.append(stopped);
    }
    const resultList = Array.isArray(safeReport.results) ? safeReport.results : [];
    if (resultList.length) {
      const results = element("section", { className: "readable-section" });
      results.append(element("h3", { text: "Reviewed result summary" }));
      results.append(element("p", { className: "section-copy", text: "Each card is retained metadata from a completed provider result and owner review. Scores are model estimates, not hiring probabilities." }));
      const grid = element("div", { className: "safe-report-grid" });
      resultList.forEach((result) => {
        const card = element("article", { className: "result-card safe-result" });
        card.append(element("h4", { text: presentValue(result.safeLabel, "Reviewed job") }));
        const values = element("dl");
        for (const [label, value] of [
          ["Model recommendation", result.modelRecommendation],
          ["Reviewed recommendation", result.reviewedRecommendation],
          ["Recommendation agreement", result.humanBandAgreement === true ? "Matches reviewed expectation" : "Differs from reviewed expectation"],
          ["Fit score", presentValue(result.overallFitScore) + " / 100"],
          ["Model confidence", presentValue(result.confidenceScore) + " / 100"],
          ["Factual matches", result.factualMatchCount],
          ["Requirements not evidenced", result.requirementGapCount],
          ["Recorded issues", Array.isArray(result.disagreementCategories) && result.disagreementCategories.length
            ? result.disagreementCategories.map((category) => disagreementLabels[category] ?? "Unknown recorded issue").join(", ")
            : "None"]
        ]) values.append(element("dt", { text: label }), element("dd", { text: presentValue(value, "None") }));
        card.append(values);
        grid.append(card);
      });
      results.append(grid);
      report.append(results);
    }
    section.append(report);
    const actions = element("div", { className: "actions decision" });
    const end = element("button", { className: "button button-danger", text: "End local session", attrs: { type: "button", "data-session-cancel": "" } });
    end.addEventListener("click", () => { void cancelSession(); });
    actions.append(element("span", { className: "hint", text: "Ending the session releases the remaining safe in-process report." }), end);
    section.append(actions);
    app.replaceChildren(section);
    live.textContent = state.phase === "execution_complete" ? "Qualification completed." : "Qualification stopped safely.";
  };

  const renderGuideAuthoring = (state) => {
    const reviewCase = state.cases[0];
    const form = element("form", { className: "panel", attrs: { "data-guide-case-id": reviewCase.id } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: "Author the private evidence guide for " + reviewCase.safeLabel }));
    copy.append(element("p", { text: "Guide " + (state.currentCaseIndex + 1) + " of " + state.caseCount + " · this exact-input map remains only in the current process" }));
    head.append(copy, element("span", { className: "badge", text: "Provider calls: 0" }));
    form.append(head, renderProgress(state.currentCaseIndex, state.caseCount));
    form.append(renderJobContext(reviewCase));

    const instructions = element("section", { className: "fit-summary" });
    instructions.append(element("h3", { text: "Map only source-backed support" }));
    instructions.append(element("p", { className: "section-copy", text: "Every requirement starts Unknown. Mark Supported only when the displayed applicant source directly supports it. Mark Confirmed gap only after independent review; absence alone stays Unknown. Ask a question only when an unresolved must-have or important fact could change the decision." }));
    form.append(instructions);

    const guideRequirements = element("section", { className: "review-grid" });
    const requirementColumn = element("div", { className: "column" });
    requirementColumn.append(element("h3", { text: "Exact requirements" }));
    const evidenceColumn = element("div", { className: "column" });
    evidenceColumn.append(element("h3", { text: "Submitted applicant evidence" }));
    const evidencePreview = element("div", { className: "resume-preview" });
    evidencePreview.append(renderSourceResume(reviewCase));
    evidenceColumn.append(evidencePreview);

    reviewCase.allRequirements.forEach((entry, index) => {
      const fieldset = element("fieldset", { className: "requirement", attrs: { "data-job-ref": entry.requirement.ref } });
      fieldset.append(element("legend", { text: "Requirement " + (index + 1) }));
      fieldset.append(element("p", { className: "requirement-text", text: entry.requirement.title }));
      const disposition = labeledSelect("guide-disposition-" + index, "Evidence disposition", [
        ["unknown", "Unknown — no sufficient support or confirmed gap"],
        ["supported", "Supported by selected source evidence"],
        ["confirmed_gap", "Confirmed material gap"],
        ["not_material", "Not material to this fit decision"]
      ], "unknown");
      const materiality = labeledSelect("guide-materiality-" + index, "Job importance", [
        ["must_have", "Must-have"],
        ["important", "Important"],
        ["preferred", "Preferred"]
      ], entry.materiality);
      fieldset.append(disposition.wrap, materiality.wrap);

      const evidence = element("div", { className: "field supporting-evidence", attrs: { hidden: "" } });
      evidence.append(element("span", { className: "field-label", text: "Direct supporting evidence" }));
      const choices = element("div", { className: "evidence-choices" });
      reviewCase.applicantEvidence.forEach((item) => {
        const choice = element("label", { className: "evidence-choice" });
        choice.append(
          element("input", { attrs: { type: "checkbox", value: item.ref } }),
          element("span", { text: item.selectionLabel })
        );
        choices.append(choice);
      });
      if (!reviewCase.applicantEvidence.length) {
        choices.append(element("p", { className: "empty-result", text: "No submitted applicant evidence is available for this requirement." }));
      }
      evidence.append(choices, element("p", { className: "hint", text: "Do not select a source merely because it shares a keyword." }));
      fieldset.append(evidence);

      const rationale = element("div", { className: "field" });
      rationale.append(element("label", { text: "Reviewer rationale", attrs: { for: "guide-rationale-" + index } }));
      rationale.append(element("textarea", { attrs: { id: "guide-rationale-" + index, required: "", maxlength: "2000", rows: "3", placeholder: "Explain the evidence decision without adding applicant facts." } }));
      fieldset.append(rationale);

      const questionToggle = element("label", { className: "confirmation" });
      const questionCheckbox = element("input", { attrs: { type: "checkbox", "data-question-toggle": "" } });
      questionToggle.append(questionCheckbox, element("span", { text: "Ask one decision-changing question for this unresolved material requirement" }));
      const questionFields = element("div", { className: "supporting-evidence", attrs: { hidden: "" } });
      for (const [suffix, label, placeholder] of [
        ["title", "Question group title", "Short topic"],
        ["question", "Exact owner question", "Ask only for the missing decision-changing fact."],
        ["why", "Why it could change the decision", "Explain its effect on the fit decision."]
      ]) {
        const field = element("div", { className: "field" });
        field.append(element("label", { text: label, attrs: { for: "guide-question-" + suffix + "-" + index } }));
        field.append(element("textarea", { attrs: { id: "guide-question-" + suffix + "-" + index, maxlength: suffix === "question" || suffix === "why" ? "1000" : "300", rows: "2", placeholder } }));
        questionFields.append(field);
      }
      const updateControls = () => {
        evidence.hidden = disposition.select.value !== "supported";
        const questionAllowed = disposition.select.value === "unknown";
        questionToggle.hidden = !questionAllowed;
        if (!questionAllowed) questionCheckbox.checked = false;
        questionFields.hidden = !questionAllowed || !questionCheckbox.checked;
      };
      disposition.select.addEventListener("change", updateControls);
      materiality.select.addEventListener("change", updateControls);
      questionCheckbox.addEventListener("change", updateControls);
      updateControls();
      fieldset.append(questionToggle, questionFields);
      requirementColumn.append(fieldset);
    });
    if (!reviewCase.allRequirements.length) {
      requirementColumn.append(element("p", { className: "empty-result", text: "No structured requirements were captured, so there is no evidence guide to author for this case." }));
    }
    guideRequirements.append(requirementColumn, evidenceColumn);
    form.append(guideRequirements);

    const error = element("p", { className: "error", attrs: { role: "alert" } });
    const actions = element("div", { className: "actions decision" });
    const cancel = element("button", { className: "button button-secondary", text: "Cancel and release memory", attrs: { type: "button", "data-session-cancel": "" } });
    cancel.addEventListener("click", () => { void cancelSession(); });
    const submit = element("button", { className: "button button-primary", text: "Bind guide to this exact case", attrs: { type: "submit" } });
    actions.append(cancel, submit);
    form.append(error, actions);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      const requirements = [...form.querySelectorAll("fieldset.requirement")].map((fieldset, index) => {
        const disposition = fieldset.querySelector("#guide-disposition-" + index).value;
        const materiality = fieldset.querySelector("#guide-materiality-" + index).value;
        const questionChecked = fieldset.querySelector("[data-question-toggle]").checked;
        return {
          jobRef: fieldset.dataset.jobRef,
          disposition,
          materiality,
          applicantRefs: disposition === "supported"
            ? [...fieldset.querySelectorAll(".evidence-choices input:checked")].map((input) => input.value)
            : [],
          rationale: fieldset.querySelector("#guide-rationale-" + index).value,
          question: questionChecked ? {
            id: "decision-question-" + (index + 1),
            title: fieldset.querySelector("#guide-question-title-" + index).value,
            question: fieldset.querySelector("#guide-question-question-" + index).value,
            whyItMatters: fieldset.querySelector("#guide-question-why-" + index).value,
            decisionChanging: true,
            jobRefs: [fieldset.dataset.jobRef]
          } : null
        };
      });
      const invalidSupport = requirements.some((entry) => entry.disposition === "supported" && !entry.applicantRefs.length);
      const invalidQuestion = requirements.some((entry) => entry.question && (
        entry.disposition !== "unknown"
        || !entry.question.title.trim()
        || !entry.question.question.trim()
        || !entry.question.whyItMatters.trim()
      ));
      if (invalidSupport || invalidQuestion || !form.reportValidity()) {
        error.textContent = invalidSupport
          ? "Supported requirements need at least one direct source reference."
          : invalidQuestion
            ? "Decision-changing questions require an unresolved material target, title, question, and rationale."
            : "Complete every required guide rationale.";
        submit.disabled = false;
        return;
      }
      const payload = {
        caseId: reviewCase.id,
        requirements: requirements.map(({ question: _question, ...entry }) => entry),
        clarifications: requirements.flatMap((entry) => entry.question ? [entry.question] : [])
      };
      let response;
      try {
        response = await fetch(paths.guide, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch {
        await handleAmbiguousMutation({ providerOutcomeUncertain: false });
        return;
      }
      if (!response.ok) {
        error.textContent = "The exact-input evidence guide was rejected. No provider action occurred.";
        submit.disabled = false;
        return;
      }
      await refreshAfterAcceptedMutation({ nextPhase: "authoring_evidence_guides", providerOutcomeUncertain: false });
    });
    app.replaceChildren(form);
    live.textContent = "Authoring evidence guide " + (state.currentCaseIndex + 1) + " of " + state.caseCount + ".";
  };

  const renderReview = (state) => {
    const reviewCase = state.cases[0];
    const form = element("form", { className: "panel", attrs: { "data-case-id": reviewCase.id } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: reviewCase.safeLabel }));
    copy.append(element("p", { text: "Case " + (state.currentCaseIndex + 1) + " of " + state.caseCount + " · compare the captured posting with the submitted source evidence" }));
    head.append(copy, element("span", { className: "badge", text: "Frozen benchmark expectation: " + reviewCase.proposedRecommendation }));
    form.append(head, renderProgress(state.currentCaseIndex, state.caseCount));
    form.append(renderJobContext(reviewCase));

    const boundary = element("aside", { className: "document-boundary" });
    boundary.append(element("strong", { text: "Application-document approval is a separate gate" }));
    boundary.append(element("span", { text: "This matching test shows the captured source résumé. It does not generate or approve a tailored résumé or cover letter. Before any application, the owner must separately review formatted tailored documents." }));
    form.append(boundary);

    const summary = element("section", { className: "fit-summary", attrs: { "aria-labelledby": "fit-summary-title" } });
    summary.append(element("h3", { text: "Evidence-backed fit summary", attrs: { id: "fit-summary-title" } }));
    const counts = element("dl", { className: "summary-counts" });
    for (const [label, value, tone] of [
      ["Supported", reviewCase.fitSummary.supportedCount, "supported"],
      ["Unresolved requirements", reviewCase.fitSummary.unresolvedCount, "unknown"],
      ["Grouped questions", reviewCase.fitSummary.questionGroupCount, "unknown"],
      ["Confirmed gaps", reviewCase.fitSummary.confirmedGapCount, "gap"],
      ["Total requirements", reviewCase.fitSummary.totalCount, "total"]
    ]) {
      const item = element("div", { className: "summary-count " + tone });
      item.append(element("dt", { text: label }), element("dd", { text: String(value) }));
      counts.append(item);
    }
    summary.append(counts, element("p", { className: "hint", text: "Supported items come only from the local deterministic source map that you are reviewing now. Model output does not exist yet and cannot grade itself." }));
    form.append(summary);

    const questions = element("section", { className: "questions", attrs: { "aria-labelledby": "questions-title" } });
    questions.append(element("h3", { text: "Questions that could change the decision", attrs: { id: "questions-title" } }));
    questions.append(element("p", { className: "section-copy", text: "Answer only these unresolved points. A Yes that adds experience needs context and stays attached to this job review; it never rewrites your résumé or profile. No, Not sure, and Skip remain unknown rather than becoming permanent history or a confirmed gap." }));
    reviewCase.clarificationGroups.forEach((question, index) => {
      const card = element("fieldset", { className: "clarification-card", attrs: { "data-question-id": question.id } });
      card.append(element("legend", { text: question.title }));
      card.append(element("p", { className: "clarification-question", text: question.question }));
      card.append(element("p", { className: "why", text: "Why this matters: " + question.whyItMatters }));
      if (question.requirements.length) {
        const related = element("details", { className: "related-requirements" });
        related.append(element("summary", { text: "Requirements affected (" + question.requirements.length + ")" }));
        const list = element("ul");
        question.requirements.forEach((requirement) => list.append(element("li", { text: requirement.title })));
        related.append(list);
        card.append(related);
      }
      const choices = element("div", { className: "answer-choices", attrs: { role: "radiogroup", "aria-label": question.title } });
      for (const [value, label] of [
        ["yes", "Yes — I can add context"],
        ["no", "No"],
        ["not_sure", "Not sure"],
        ["skip", "Skip for now"]
      ]) {
        const choice = element("label", { className: "answer-choice" });
        const input = element("input", { attrs: { type: "radio", name: "clarification-" + index, value, required: "" } });
        choice.append(input, element("span", { text: label }));
        choices.append(choice);
      }
      const context = element("div", { className: "field clarification-context" });
      context.append(element("label", { text: "Explanation (required for Yes)", attrs: { for: "clarification-context-" + index } }));
      const textarea = element("textarea", { attrs: { id: "clarification-context-" + index, maxlength: "2000", rows: "3", placeholder: "Add only truthful, job-relevant context." } });
      context.append(textarea, element("p", { className: "hint", text: "Required only for Yes. This answer is tagged USER_ATTESTATION for this job review and is not résumé history." }));
      card.append(choices, context);
      questions.append(card);
    });
    if (!reviewCase.clarificationGroups.length) {
      questions.append(element("p", { className: "empty-result", text: "No decision-changing clarification questions were identified for this case." }));
    }
    form.append(questions);

    const evidenceDetails = element("details", { className: "review-details supported-details" });
    evidenceDetails.append(element("summary", { text: "Supported qualifications (" + reviewCase.supportedRequirements.length + ")" }));
    const supportedList = element("div", { className: "mapped-list" });
    reviewCase.supportedRequirements.forEach((entry) => {
      const card = element("article", { className: "mapped-requirement" });
      card.append(element("h4", { text: entry.requirement.title }));
      card.append(element("p", { className: "why", text: entry.rationale }));
      const evidence = element("div", { className: "mapped-evidence" });
      entry.evidence.forEach((item) => evidence.append(evidenceCard(item)));
      card.append(evidence);
      supportedList.append(card);
    });
    if (!reviewCase.supportedRequirements.length) {
      supportedList.append(element("p", { className: "empty-result", text: "No requirements are currently mapped to direct applicant evidence." }));
    }
    evidenceDetails.append(supportedList);
    form.append(evidenceDetails);

    if (reviewCase.confirmedGaps.length) {
      const gaps = element("section", { className: "confirmed-gaps", attrs: { "aria-labelledby": "confirmed-gaps-title" } });
      gaps.append(element("h3", { text: "Material confirmed gaps", attrs: { id: "confirmed-gaps-title" } }));
      reviewCase.confirmedGaps.forEach((entry) => {
        const card = element("article", { className: "gap-card" });
        card.append(element("h4", { text: entry.requirement.title }), element("p", { text: entry.rationale }));
        gaps.append(card);
      });
      form.append(gaps);
    }

    const all = element("details", { className: "review-details all-requirements" });
    all.append(element("summary", { text: "All requirements (" + reviewCase.allRequirements.length + ")" }));
    const allList = element("ol", { className: "all-requirements-list" });
    reviewCase.allRequirements.forEach((entry) => {
      const row = element("li", { className: "requirement-row" });
      const labels = element("div", { className: "requirement-labels" });
      labels.append(
        element("span", { className: "status-label " + entry.disposition, text: entry.disposition.replaceAll("_", " ") }),
        element("span", { className: "materiality-label " + entry.materiality, text: entry.materiality.replaceAll("_", "-") })
      );
      const copy = element("div");
      copy.append(element("strong", { text: entry.requirement.title }), element("p", { text: entry.rationale }));
      const candidates = element("details", { className: "related-requirements evidence-candidates" });
      candidates.append(element("summary", {
        text: "Relevant " + entry.candidateCategory + " source candidates (" + entry.candidateEvidence.length + ")"
      }));
      const candidateList = element("div", { className: "mapped-evidence" });
      entry.candidateEvidence.forEach((item) => candidateList.append(evidenceCard(item)));
      if (!entry.candidateEvidence.length) {
        candidateList.append(element("p", {
          className: "hint",
          text: "No applicant fact in this evidence category was available for local review."
        }));
      }
      candidates.append(candidateList);
      copy.append(candidates);
      row.append(labels, copy);
      allList.append(row);
    });
    if (!reviewCase.allRequirements.length) {
      allList.append(element("li", { className: "empty-result", text: "No structured requirements were captured for this job." }));
    }
    all.append(allList);
    form.append(all);

    const sourceDetails = element("details", { className: "review-details source-details" });
    sourceDetails.append(element("summary", { text: "Source résumé and profile evidence" }));
    const sourceList = element("div", { className: "evidence-list" });
    sourceList.append(renderSourceResume(reviewCase));
    const profileItems = reviewCase.applicantEvidence.filter((item) => item.ref.startsWith("profile."));
    const profileSection = renderEvidenceSection("Applicant preferences used for fit", profileItems);
    if (profileSection) sourceList.append(profileSection);
    if (reviewCase.applicantCautions.length) {
      const caution = element("section", { className: "caution-list", attrs: { "aria-label": "Applicant evidence cautions" } });
      caution.append(element("h3", { text: "Do not use as supporting evidence" }));
      caution.append(element("p", { className: "hint", text: "These owner-supplied cautions are excluded from positive evidence." }));
      reviewCase.applicantCautions.forEach((item) => caution.append(evidenceCard(item)));
      sourceList.append(caution);
    }
    sourceDetails.append(sourceList);
    form.append(sourceDetails);

    const decision = element("section", { className: "decision" });
    decision.append(element("h3", { text: "Final fit decision" }));
    const documents = element("div", { className: "document-approval-unavailable" });
    documents.append(element("strong", { text: "Application document approval: unavailable" }));
    documents.append(element("span", { text: "No tailored résumé or cover letter exists in this qualification harness. Document review remains a separate future gate." }));
    decision.append(documents);
    const preferenceEvidence = element("div", { className: "preference-evidence", attrs: { "aria-label": "Job preference evidence" } });
    reviewCase.preferenceContext.forEach((item) => preferenceEvidence.append(evidenceCard(item)));
    if (!reviewCase.preferenceContext.length) {
      preferenceEvidence.append(element("p", { className: "empty-result", text: "No applicant preference context is available for this case." }));
    }
    decision.append(preferenceEvidence);
    const preferenceGrid = element("div", { className: "preference-grid" });
    const preferenceOptions = [
      ["aligned", "Aligned"], ["conflict", "Conflict"], ["unknown", "Unknown"], ["not_applicable", "Not applicable"]
    ];
    const preferenceSelects = {};
    for (const [key, label] of [["location", "Location"], ["workStyle", "Work style"], ["compensation", "Compensation"]]) {
      const field = labeledSelect("preference-" + key, label, preferenceOptions);
      preferenceSelects[key] = field.select;
      preferenceGrid.append(field.wrap);
    }
    decision.append(preferenceGrid);
    const recommendation = labeledSelect("recommendation", "Reviewed recommendation", [
      ["apply now", "Apply now" + (reviewCase.proposedRecommendation === "apply now" ? " — proposed" : "")],
      ["consider", "Consider" + (reviewCase.proposedRecommendation === "consider" ? " — proposed" : "")],
      ["skip", "Skip" + (reviewCase.proposedRecommendation === "skip" ? " — proposed" : "")]
    ]);
    decision.append(recommendation.wrap);
    const rationale = element("div", { className: "field" });
    rationale.append(element("label", { text: "Owner rationale", attrs: { for: "rationale" } }));
    const rationaleInput = element("textarea", { attrs: { id: "rationale", required: "", maxlength: "2000" } });
    rationale.append(rationaleInput);
    decision.append(rationale);
    const confirmation = element("label", { className: "confirmation" });
    const confirmationInput = element("input", { attrs: { type: "checkbox", required: "" } });
    confirmation.append(confirmationInput, element("span", { text: "I reviewed the submitted applicant evidence shown here and confirm it is current enough for this private evaluation." }));
    decision.append(confirmation);
    const error = element("p", { className: "error", attrs: { role: "alert" } });
    const actions = element("div", { className: "actions" });
    const cancel = element("button", { className: "button button-secondary", text: "Cancel and release memory", attrs: { type: "button", "data-session-cancel": "" } });
    cancel.addEventListener("click", () => { void cancelSession(); });
    const submit = element("button", { className: "button button-primary", text: "Record review and continue", attrs: { type: "submit" } });
    actions.append(cancel, submit);
    decision.append(error, actions);
    form.append(decision);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      const clarifications = [...form.querySelectorAll(".clarification-card")].map((fieldset) => ({
        questionId: fieldset.dataset.questionId,
        answer: fieldset.querySelector("input[type=radio]:checked")?.value ?? "",
        context: fieldset.querySelector("textarea").value
      }));
      const unanswered = clarifications.some((entry) => !entry.answer);
      const yesWithoutContext = clarifications.some((entry) => entry.answer === "yes" && !entry.context.trim());
      if (unanswered || yesWithoutContext) {
        error.textContent = unanswered
          ? "Answer each decision-changing question before continuing."
          : "A Yes answer needs truthful source context.";
        submit.disabled = false;
        return;
      }
      const payload = {
        caseId: reviewCase.id,
        factsCurrent: confirmationInput.checked,
        clarifications,
        preferences: {
          location: preferenceSelects.location.value,
          workStyle: preferenceSelects.workStyle.value,
          compensation: preferenceSelects.compensation.value
        },
        recommendation: recommendation.select.value,
        rationale: rationaleInput.value
      };
      let response;
      try {
        response = await fetch(paths.submit, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch {
        await handleAmbiguousMutation({ providerOutcomeUncertain: false });
        return;
      }
      if (!response.ok) {
        error.textContent = "The local review was rejected. No provider action occurred.";
        submit.disabled = false;
        return;
      }
      await refreshAfterAcceptedMutation({ nextPhase: "reviewing", providerOutcomeUncertain: false });
    });
    app.replaceChildren(form);
    live.textContent = "Reviewing case " + (state.currentCaseIndex + 1) + " of " + state.caseCount + ".";
  };

  const schedulePoll = () => {
    if (sessionEnded) return;
    if (renderedPhase === "execution_complete" || renderedPhase === "execution_stopped") return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void poll(); }, 1000);
  };

  const applyState = (state) => {
    document.getElementById("connection-notice").hidden = true;
    renderedPhase = state.phase;
    renderedCaseIndex = state.currentCaseIndex ?? -1;
    renderedCaptureFailureNotice = state.captureFailureNotice ?? "";
    document.getElementById("synthetic-banner").hidden = state.syntheticPreview !== true;
    document.getElementById("memory-notice").textContent = state.memoryNotice ?? "Waiting for the exact local capture.";
    if (state.phase === "awaiting_capture") {
      const waiting = element("section", { className: "panel loading" });
      waiting.append(element("h2", { text: state.captureFailureNotice ? "Capture was not accepted." : "Waiting for the approved one-shot capture." }));
      waiting.append(element("p", { text: state.captureFailureNotice
        ? state.captureFailureNotice
        : "No applicant input has been admitted yet; this page will advance automatically after an exact checkpoint match." }));
      app.replaceChildren(waiting);
      return;
    }
    if (state.phase === "awaiting_separate_google_consent") renderFinal(state);
    else if (state.phase === "execution_starting" || state.phase === "executing") renderExecutionProgress(state);
    else if (state.phase === "reviewing_provider_result") renderProviderResultReview(state);
    else if (state.phase === "execution_complete" || state.phase === "execution_stopped") renderExecutionOutcome(state);
    else if (state.phase === "authoring_evidence_guides") renderGuideAuthoring(state);
    else renderReview(state);
  };

  async function fetchState() {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(paths.state, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Invalid local state response");
      let state;
      try {
        state = await response.json();
      } catch {
        throw new Error("Invalid local state response");
      }
      if (!state || typeof state !== "object" || typeof state.phase !== "string") {
        throw new Error("Invalid local state response");
      }
      return state;
    } finally {
      clearTimeout(deadline);
    }
  }

  function applyLoadedState(state, focusHeading = false) {
    applyState(state);
    document.getElementById("connection-notice").hidden = true;
    suspendedControls = [];
    consecutivePollFailures = 0;
    if (focusHeading) {
      const heading = app.querySelector("h2");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
    schedulePoll();
  }

  async function load(focusHeading = false) {
    if (pollTimer) clearTimeout(pollTimer);
    const state = await fetchState();
    applyLoadedState(state, focusHeading);
  }

  const failClosedAfterStateLoss = () => {
    sessionEnded = true;
    navigator.sendBeacon(cancellationUrl("status_poll_failure"));
    const providerMayHaveActed = renderedPhase === "execution_starting"
      || renderedPhase === "executing"
      || renderedPhase === "reviewing_provider_result";
    clearRenderedEvidence(
      providerMayHaveActed
        ? "Contact was lost during execution; provider completion and billing are uncertain."
        : "Contact with the local review process was lost before execution.",
      providerMayHaveActed
        ? "This tab cleared its rendered evidence and sent cancellation best-effort. A started request may have completed and may be billable; no later call can start after cancellation is acknowledged. Stop the terminal process now if acknowledgement is unavailable."
        : "This tab cleared its rendered applicant evidence after losing contact with the loopback server. No consented provider execution had started. Cancellation was sent best-effort; stop the terminal process now or rely on its timeout fallback."
    );
  };

  async function poll() {
    let state;
    try {
      state = await fetchState();
    } catch (error) {
      const retryable = isTransientStateFailure(error);
      if (retryable && consecutivePollFailures === 0) {
        consecutivePollFailures = 1;
        suspendInteractiveControls();
        live.textContent = "Local status was briefly unavailable. Retrying before ending the review.";
        pollTimer = setTimeout(() => { void poll(); }, 250);
        return;
      }
      failClosedAfterStateLoss();
      return;
    }
    try {
      const recovered = consecutivePollFailures > 0;
      const stateChanged = state.phase !== renderedPhase
        || (state.currentCaseIndex ?? -1) !== renderedCaseIndex
        || (state.captureFailureNotice ?? "") !== renderedCaptureFailureNotice;
      if (stateChanged) {
        applyState(state);
        suspendedControls = [];
      } else if (recovered) {
        restoreInteractiveControls();
      }
      consecutivePollFailures = 0;
      schedulePoll();
    } catch {
      failClosedAfterStateLoss();
    }
  }

  window.addEventListener("pagehide", () => {
    if (sessionEnded) return;
    sessionEnded = true;
    if (pollTimer) clearTimeout(pollTimer);
    navigator.sendBeacon(cancellationUrl("pagehide"));
    clearRenderedEvidence("Navigation ended the local review.");
  }, { once: true });

  load().catch(() => {
    sessionEnded = true;
    const providerMayHaveActed = renderedPhase === "execution_starting"
      || renderedPhase === "executing"
      || renderedPhase === "reviewing_provider_result";
    clearRenderedEvidence(providerMayHaveActed
      ? "The local execution session is unavailable; provider completion and billing are uncertain."
      : "The local review session is unavailable before execution.");
  });
})();
`;

function html({
  statePath,
  guideSubmissionPath,
  submissionPath,
  consentPath,
  executionReviewPath,
  cancelPath
}: OwnerReviewPagePaths) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply Pilot · Local match review</title><link rel="stylesheet" href="/review.css"></head>
<body data-state-path="${statePath}" data-guide-submission-path="${guideSubmissionPath}" data-submission-path="${submissionPath}" data-consent-path="${consentPath}" data-execution-review-path="${executionReviewPath}" data-cancel-path="${cancelPath}">
<a class="skip" href="#app">Skip to review</a>
<header class="masthead"><div class="masthead-inner"><div class="brand"><strong>Apply Pilot</strong><span>Private qualification review</span></div><span class="session-badge">Local · memory only</span></div></header>
<main><aside id="synthetic-banner" class="synthetic-banner" hidden><strong>Synthetic preview</strong><span>Every applicant detail on this screen is a public test fixture. Do not treat it as a real person or an application packet.</span></aside><section class="hero" aria-labelledby="page-title"><p class="eyebrow">Owner evidence review</p><h1 id="page-title">Resolve only the qualifications that could change the decision.</h1><p class="lede">Applicant evidence moves only between the local loopback server and this tab. The app does not persist it. Provider access remains unavailable until a separately displayed, exact-manifest consent is explicitly approved.</p></section>
<p id="memory-notice" class="notice">Loading the memory boundary…</p><p id="connection-notice" class="notice" role="status" hidden>Local status is briefly unavailable. Controls are paused while this page retries once.</p><p id="status" class="status" role="status" aria-live="polite"></p><div id="app" class="loading">Loading local review…</div></main>
<script src="/review.js" defer></script></body></html>`;
}

export const qualificationOwnerReviewHtml = Object.assign(html, { css, javascript });
