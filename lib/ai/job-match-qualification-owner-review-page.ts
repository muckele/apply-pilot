type OwnerReviewPagePaths = {
  statePath: string;
  submissionPath: string;
  cancelPath: string;
};

const css = String.raw`
:root{color-scheme:light;--canvas:#f3f8f5;--surface:#fff;--raised:#f9fcfa;--text:#17261f;--copy:#32473d;--muted:#5d7067;--accent:#146a46;--mint:#38c979;--border:#cee0d6;--strong:#7ab897;--warn:#76510c;--danger:#9a312c;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:radial-gradient(circle at 82% 0%,rgba(126,224,167,.13),transparent 30rem),var(--canvas);line-height:1.55}.skip{position:fixed;left:1rem;top:1rem;z-index:5;transform:translateY(-180%);border-radius:.5rem;padding:.75rem 1rem;background:var(--mint);color:#03110b;font-weight:750}.skip:focus{transform:none}.masthead{border-bottom:1px solid var(--border);background:rgba(255,255,255,.92)}.masthead-inner,main{width:min(1180px,calc(100% - 2rem));margin:0 auto}.masthead-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0}.brand{display:grid;gap:.1rem}.brand strong{font-size:1rem;letter-spacing:-.02em}.brand span{color:var(--muted);font-size:.78rem}.session-badge,.badge{border:1px solid var(--strong);border-radius:999px;padding:.35rem .65rem;background:#edf9f2;color:var(--accent);font-size:.72rem;font-weight:750}.session-badge{text-transform:uppercase;letter-spacing:.06em}main{padding:2rem 0 3rem}.hero{display:grid;gap:.6rem;margin-bottom:1.25rem}.eyebrow,.evidence-label,.section-kicker{margin:0;color:var(--accent);font-size:.72rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase}h1,h2,h3,h4,p{margin-top:0}h1{margin-bottom:0;font-size:clamp(1.8rem,4vw,2.5rem);line-height:1.12;letter-spacing:-.04em}.lede{max-width:58rem;margin:0;color:var(--copy)}.notice,.synthetic-banner,.document-boundary{margin:1rem 0;border:1px solid #dfbd6b;border-radius:.7rem;padding:.9rem 1rem;background:#fff9e9;color:var(--warn);font-size:.88rem}.synthetic-banner{margin:0 0 1rem;border-color:#79b7d4;background:#eef8fc;color:#194e68}.synthetic-banner strong,.document-boundary strong{display:block;margin-bottom:.2rem}.progress{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem}.step{border:1px solid var(--border);border-radius:999px;padding:.35rem .6rem;background:var(--surface);color:var(--muted);font-size:.75rem;font-weight:700}.step.current{border-color:var(--strong);background:#edf9f2;color:var(--accent)}.panel{border:1px solid var(--border);border-radius:.85rem;background:var(--surface);box-shadow:0 18px 50px rgba(31,82,59,.08)}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border);padding:1.1rem 1.25rem}.panel-head h2{margin:0;font-size:1.15rem}.panel-head p{margin:.25rem 0 0;color:var(--muted);font-size:.82rem}.badge{white-space:nowrap}.job-overview{margin:0 1rem 1rem;padding:1rem}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:.8rem}.section-heading h3{margin:0;font-size:1.05rem}.source-link{color:var(--accent);font-size:.82rem;font-weight:750}.fact-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin-bottom:1rem}.fact{border:1px solid var(--border);border-radius:.6rem;padding:.7rem;background:var(--raised)}.fact span{display:block;color:var(--muted);font-size:.7rem;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.fact strong{display:block;margin-top:.2rem;font-size:.85rem;overflow-wrap:anywhere}.responsibilities{margin:0;padding-left:1.2rem;color:var(--copy);font-size:.86rem}.responsibilities li+li{margin-top:.35rem}.tech-list{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.85rem}.chip{border-radius:999px;padding:.25rem .55rem;background:#edf4f0;color:var(--copy);font-size:.74rem}.review-grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(19rem,.92fr);gap:1rem;padding:0 1rem 1rem}.column{min-width:0}.review-grid>.column:last-child{position:sticky;top:1rem;align-self:start}.column>h3{margin-bottom:.65rem;font-size:.95rem}.evidence-list,.resume-section{display:grid;gap:.55rem}.resume-preview{border:1px solid var(--border);border-radius:.75rem;padding:.9rem;background:#fdfefd}.resume-preview>h3{margin-bottom:.1rem}.resume-caption{margin:0 0 .9rem;color:var(--accent);font-size:.75rem;font-weight:750}.resume-section+.resume-section{margin-top:1rem}.resume-section h4{margin:0;font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.evidence{min-width:0;border-left:3px solid var(--strong);border-radius:.25rem;padding:.15rem 0 .15rem .7rem}.evidence-title{margin:.15rem 0 0;color:var(--text);font-size:.88rem;font-weight:750;overflow-wrap:anywhere}.evidence-details{margin:.35rem 0 0;padding-left:1.1rem;color:var(--copy);font-size:.79rem}.evidence-details li+li{margin-top:.18rem}.requirement{margin:0 0 .8rem;border:1px solid var(--border);border-radius:.7rem;padding:.9rem}.requirement legend{max-width:100%;padding:0 .35rem;color:var(--accent);font-size:.75rem;font-weight:750}.requirement-text{margin-bottom:.5rem;color:var(--copy);font-size:.9rem}.field{display:grid;gap:.35rem;margin-top:.65rem}.field label,.field-label{color:var(--copy);font-size:.78rem;font-weight:750}select,textarea{width:100%;min-height:44px;border:1px solid var(--border);border-radius:.5rem;padding:.6rem .7rem;color:var(--text);background:#fff;font:inherit}select[multiple]{min-height:8.5rem}textarea{min-height:7rem;resize:vertical}select:focus,textarea:focus,button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.hint{margin:.25rem 0 0;color:var(--muted);font-size:.72rem}.supporting-evidence[hidden]{display:none}.open-gaps{margin:0 1rem 1rem;padding:1rem;box-shadow:none}.open-gaps h3{font-size:.88rem}.open-gaps ul{margin:0;padding-left:1.2rem;color:var(--copy);font-size:.82rem}.decision{border-top:1px solid var(--border);padding:1rem}.preference-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem}.confirmation{display:flex;align-items:flex-start;gap:.6rem;margin:1rem 0;color:var(--copy);font-size:.82rem}.confirmation input{width:1.1rem;height:1.1rem;margin-top:.15rem;accent-color:var(--accent)}.actions{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.75rem;margin-top:1rem}.button{min-height:44px;border:1px solid var(--strong);border-radius:.55rem;padding:.65rem 1rem;font:inherit;font-size:.85rem;font-weight:750;cursor:pointer}.button-primary{border-color:var(--mint);background:linear-gradient(145deg,#46d485,#2cc675);color:#03110b}.button-secondary{background:#fff;color:var(--copy)}.button-danger{border-color:#d9aaa7;background:#fff;color:var(--danger)}.button:disabled{cursor:not-allowed;opacity:.55}.error{min-height:1.5rem;margin:.75rem 0 0;color:var(--danger);font-size:.82rem;font-weight:750}.consent-stop{margin:1rem;border:1px solid var(--strong);border-radius:.65rem;padding:1rem;background:#edf9f2}.consent-stop strong{display:block;margin-bottom:.35rem;color:var(--accent)}.technical-details{margin:0 1rem 1rem;border:1px solid var(--border);border-radius:.65rem;background:var(--raised)}.technical-details summary{cursor:pointer;padding:.8rem 1rem;color:var(--accent);font-weight:750}.manifest{display:grid;gap:.2rem;margin:0;padding:0 1rem 1rem}.manifest-row{display:grid;grid-template-columns:13rem minmax(0,1fr);gap:.75rem;border-top:1px solid var(--border);padding:.55rem 0}.manifest-row dt{color:var(--muted);font-size:.78rem;font-weight:700}.manifest-row dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--copy);font-size:.82rem}.status{position:fixed;left:-9999px}.loading{padding:2rem;color:var(--muted)}.caution-list{display:grid;gap:.5rem;margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem}.caution-list h3{margin:0;color:var(--warn);font-size:.85rem}.caution-list .evidence{border-color:#dfbd6b}.preference-evidence{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin-bottom:.75rem}
.source-reference{display:grid;justify-items:end;gap:.15rem;max-width:17rem;text-align:right}.source-reference span{color:var(--muted);font-size:.7rem}.raw-source{margin:0 0 1rem;border:1px solid var(--border);border-radius:.55rem;background:var(--raised)}.raw-source summary{cursor:pointer;padding:.65rem .75rem;color:var(--accent);font-size:.8rem;font-weight:750}.raw-source-lines{border-top:1px solid var(--border);padding:.6rem .75rem}.raw-source-lines p{margin:0;color:var(--copy);font-size:.78rem}.raw-source-lines p+p{margin-top:.3rem}.evidence-choices{display:grid;gap:.6rem;max-height:23rem;overflow:auto;border:1px solid var(--border);border-radius:.55rem;padding:.65rem;background:var(--raised)}.evidence-choice-group{display:grid;gap:.25rem;margin:0;border:0;padding:0}.evidence-choice-group legend{padding:0;color:var(--muted);font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.evidence-choice{display:flex;align-items:flex-start;gap:.5rem;border-radius:.4rem;padding:.35rem .4rem;background:#fff;color:var(--copy);font-size:.78rem;cursor:pointer}.evidence-choice:hover{background:#edf9f2}.evidence-choice input{flex:0 0 auto;width:1rem;height:1rem;margin:.15rem 0 0;accent-color:var(--accent)}
.fit-summary,.questions,.confirmed-gaps,.review-details{margin:0 1rem 1rem}.fit-summary,.questions,.confirmed-gaps{border:1px solid var(--border);border-radius:.75rem;padding:1rem;background:var(--raised)}.fit-summary h3,.questions h3,.confirmed-gaps h3{margin-bottom:.3rem}.summary-counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.65rem;margin:.85rem 0}.summary-count{border:1px solid var(--border);border-radius:.55rem;padding:.65rem;background:#fff}.summary-count dt{color:var(--muted);font-size:.72rem;font-weight:750}.summary-count dd{margin:.1rem 0 0;font-size:1.25rem;font-weight:800}.summary-count.supported dd{color:var(--accent)}.summary-count.gap dd{color:var(--danger)}.section-copy{color:var(--copy);font-size:.86rem}.clarification-card{margin:.8rem 0 0;border:1px solid var(--border);border-radius:.65rem;padding:.9rem;background:#fff}.clarification-card legend{padding:0 .35rem;color:var(--accent);font-weight:800}.clarification-question{margin-bottom:.35rem;font-weight:700}.why{margin:.2rem 0;color:var(--muted);font-size:.78rem}.related-requirements{margin:.65rem 0;border-left:3px solid var(--border);padding-left:.65rem}.related-requirements summary{cursor:pointer;color:var(--copy);font-size:.78rem;font-weight:750}.related-requirements ul{margin:.4rem 0 0;padding-left:1.1rem;color:var(--copy);font-size:.78rem}.answer-choices{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem;margin-top:.75rem}.answer-choice{display:flex;align-items:flex-start;gap:.45rem;border:1px solid var(--border);border-radius:.5rem;padding:.55rem;background:var(--raised);font-size:.78rem;cursor:pointer}.answer-choice:has(input:checked){border-color:var(--strong);background:#edf9f2}.answer-choice input{flex:0 0 auto;margin:.15rem 0 0;accent-color:var(--accent)}.clarification-context textarea{min-height:5rem}.review-details{border:1px solid var(--border);border-radius:.65rem;background:#fff}.review-details>summary{cursor:pointer;padding:.8rem 1rem;color:var(--accent);font-weight:800}.mapped-list,.all-requirements-list,.source-details>.evidence-list{border-top:1px solid var(--border);padding:1rem}.mapped-requirement+.mapped-requirement{margin-top:1rem}.mapped-requirement h4,.gap-card h4{margin-bottom:.2rem}.mapped-evidence{display:grid;gap:.45rem;margin-top:.55rem}.all-requirements-list{display:grid;gap:.7rem;margin:0;list-style-position:inside}.requirement-row{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:.65rem;align-items:start}.requirement-row p{margin:.2rem 0 0;color:var(--muted);font-size:.76rem}.requirement-labels{display:grid;gap:.3rem}.status-label,.materiality-label{border-radius:999px;padding:.25rem .5rem;text-align:center;text-transform:capitalize;font-size:.68rem;font-weight:800;background:#edf4f0;color:var(--copy)}.status-label.supported{background:#e7f7ee;color:var(--accent)}.status-label.confirmed_gap{background:#fff0ef;color:var(--danger)}.status-label.unknown{background:#fff8e5;color:var(--warn)}.materiality-label.must_have{background:#f5ebff;color:#62358c}.materiality-label.preferred{background:#edf4ff;color:#315a8a}.document-approval-unavailable{display:grid;gap:.15rem;margin:.6rem 0 1rem;border:1px solid #dfbd6b;border-radius:.55rem;padding:.75rem;background:#fff9e9;color:var(--warn);font-size:.8rem}
@media(max-width:900px){.review-grid{grid-template-columns:1fr}.review-grid>.column:last-child{position:static}.fact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.preference-grid,.preference-evidence{grid-template-columns:1fr}.panel-head,.section-heading{display:grid}.source-reference{justify-items:start;text-align:left}.badge{justify-self:start}.manifest-row{grid-template-columns:1fr;gap:.15rem}}
@media(max-width:760px){.summary-counts{grid-template-columns:repeat(2,minmax(0,1fr))}.answer-choices{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.masthead-inner,main{width:min(100% - 1rem,1180px)}main{padding-top:1rem}.review-grid,.decision,.open-gaps,.job-overview,.fit-summary,.questions,.confirmed-gaps,.review-details{padding:.75rem;margin-left:.5rem;margin-right:.5rem}.review-details{padding:0}.panel-head{padding:.85rem}.fact-grid,.summary-counts,.answer-choices{grid-template-columns:1fr}.requirement-row{grid-template-columns:1fr}.status-label{justify-self:start}.actions{display:grid}.button{width:100%}}
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
    submit: body.dataset.submissionPath,
    cancel: body.dataset.cancelPath
  };
  let sessionEnded = false;
  let pollTimer;
  let renderedPhase = "";
  let renderedCaseIndex = -1;

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
    document.getElementById("memory-notice").textContent = "The local evidence view is closed. This page does not retain a persistent copy.";
    app.replaceChildren(element("section", { className: "panel loading", text: copy }));
    live.textContent = message;
  };

  const cancelSession = async () => {
    if (sessionEnded) return;
    sessionEnded = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      const response = await fetch(paths.cancel, { method: "POST", keepalive: true });
      if (!response.ok) throw new Error("Cancellation was not acknowledged");
      clearRenderedEvidence("Local review ended.");
    } catch {
      clearRenderedEvidence(
        "This tab cleared its evidence, but the server did not acknowledge cancellation.",
        "This tab cleared its rendered applicant evidence, but server release was not confirmed. Stop the terminal process now; its timeout remains the fallback."
      );
    }
  };

  const renderFinal = (state) => {
    const manifest = state.finalManifest;
    const section = element("section", { className: "panel", attrs: { "data-phase": "consent-gate" } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: "Review complete. Google remains blocked." }));
    copy.append(element("p", { text: "The loopback server retains the exact inputs and four attestations while this tab displays only this final manifest." }));
    head.append(copy, element("span", { className: "badge", text: "Separate consent required" }));
    section.append(head, renderProgress(state.caseCount, state.caseCount, true));
    const stop = element("div", { className: "consent-stop" });
    stop.append(element("strong", { text: "No provider action is available on this screen." }));
    stop.append(element("p", { text: "Before any Google request, obtain separate approval for this exact final manifest, four sequential calls, no retries, the displayed maximum cost, private-data sharing, and use of the existing Gemini credential. Keep this process open; exiting loses the in-memory inputs and reviews." }));
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
    const actions = element("div", { className: "actions decision" });
    const end = element("button", { className: "button button-danger", text: "End local session", attrs: { type: "button" } });
    end.addEventListener("click", () => { void cancelSession(); });
    actions.append(element("span", { className: "hint", text: "Ending the process requires a future recapture; hashes can verify equality but cannot restore memory." }), end);
    section.append(actions);
    app.replaceChildren(section);
    live.textContent = "Four reviews complete. Google consent is still required.";
  };

  const renderReview = (state) => {
    const reviewCase = state.cases[0];
    const form = element("form", { className: "panel", attrs: { "data-case-id": reviewCase.id } });
    const head = element("div", { className: "panel-head" });
    const copy = element("div");
    copy.append(element("h2", { text: reviewCase.safeLabel }));
    copy.append(element("p", { text: "Case " + (state.currentCaseIndex + 1) + " of " + state.caseCount + " · compare the captured posting with the submitted source evidence" }));
    head.append(copy, element("span", { className: "badge", text: "Proposed: " + reviewCase.proposedRecommendation }));
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
    summary.append(counts, element("p", { className: "hint", text: "Supported items come only from the independently reviewed evidence map. Model output does not exist yet and cannot grade itself." }));
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
      context.append(element("label", { text: "Optional explanation", attrs: { for: "clarification-context-" + index } }));
      const textarea = element("textarea", { attrs: { id: "clarification-context-" + index, maxlength: "2000", rows: "3", placeholder: "Add only truthful, job-relevant context." } });
      context.append(textarea, element("p", { className: "hint", text: "Required only for Yes. This answer is tagged USER_ATTESTATION for this job review and is not résumé history." }));
      card.append(choices, context);
      questions.append(card);
    });
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
      row.append(labels, copy);
      allList.append(row);
    });
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
    const cancel = element("button", { className: "button button-secondary", text: "Cancel and release memory", attrs: { type: "button" } });
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
      try {
        const response = await fetch(paths.submit, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error("Review rejected");
        await load(true);
        window.scrollTo({ top: 0, behavior: "auto" });
      } catch {
        error.textContent = "The local review was rejected. No provider action occurred.";
        submit.disabled = false;
      }
    });
    app.replaceChildren(form);
    live.textContent = "Reviewing case " + (state.currentCaseIndex + 1) + " of " + state.caseCount + ".";
  };

  const schedulePoll = () => {
    if (sessionEnded) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void poll(); }, 1000);
  };

  const applyState = (state) => {
    renderedPhase = state.phase;
    renderedCaseIndex = state.currentCaseIndex ?? -1;
    document.getElementById("synthetic-banner").hidden = state.syntheticPreview !== true;
    document.getElementById("memory-notice").textContent = state.memoryNotice ?? "Waiting for the exact local capture.";
    if (state.phase === "awaiting_capture") {
      app.replaceChildren(element("section", { className: "panel loading", text: "Waiting for the approved one-shot capture. No applicant input has been admitted yet; this page will advance automatically after an exact hash match." }));
      return;
    }
    if (state.phase === "awaiting_separate_google_consent") renderFinal(state);
    else renderReview(state);
  };

  async function fetchState() {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(paths.state, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("State unavailable");
      return response.json();
    } finally {
      clearTimeout(deadline);
    }
  }

  async function load(focusHeading = false) {
    if (pollTimer) clearTimeout(pollTimer);
    const state = await fetchState();
    applyState(state);
    if (focusHeading) {
      const heading = app.querySelector("h2");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
    schedulePoll();
  }

  async function poll() {
    try {
      const state = await fetchState();
      if (state.phase !== renderedPhase || (state.currentCaseIndex ?? -1) !== renderedCaseIndex) applyState(state);
      schedulePoll();
    } catch {
      sessionEnded = true;
      navigator.sendBeacon(paths.cancel, "state_contact_lost");
      clearRenderedEvidence(
        "Contact with the local review process was lost. No provider action occurred.",
        "This tab cleared its rendered applicant evidence after losing contact with the loopback server. Cancellation was sent best-effort; stop the terminal process now or rely on its timeout fallback."
      );
    }
  }

  window.addEventListener("pagehide", () => {
    if (sessionEnded) return;
    sessionEnded = true;
    if (pollTimer) clearTimeout(pollTimer);
    navigator.sendBeacon(paths.cancel, "navigation_loss");
    clearRenderedEvidence("Navigation ended the local review.");
  }, { once: true });

  load().catch(() => {
    sessionEnded = true;
    clearRenderedEvidence("The local review session is unavailable. No provider action occurred.");
  });
})();
`;

function html({ statePath, submissionPath, cancelPath }: OwnerReviewPagePaths) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply Pilot · Local match review</title><link rel="stylesheet" href="/review.css"></head>
<body data-state-path="${statePath}" data-submission-path="${submissionPath}" data-cancel-path="${cancelPath}">
<a class="skip" href="#app">Skip to review</a>
<header class="masthead"><div class="masthead-inner"><div class="brand"><strong>Apply Pilot</strong><span>Private qualification review</span></div><span class="session-badge">Local · memory only</span></div></header>
<main><aside id="synthetic-banner" class="synthetic-banner" hidden><strong>Synthetic preview</strong><span>Every applicant detail on this screen is a public test fixture. Do not treat it as a real person or an application packet.</span></aside><section class="hero" aria-labelledby="page-title"><p class="eyebrow">Owner evidence review</p><h1 id="page-title">Resolve only the qualifications that could change the decision.</h1><p class="lede">Independently reviewed source evidence is already linked and collapsed. Applicant evidence moves only between the local loopback server and this tab. The app does not persist it, and this screen cannot call a provider.</p></section>
<p id="memory-notice" class="notice">Loading the memory boundary…</p><p id="status" class="status" role="status" aria-live="polite"></p><div id="app" class="loading">Loading local review…</div></main>
<script src="/review.js" defer></script></body></html>`;
}

export const qualificationOwnerReviewHtml = Object.assign(html, { css, javascript });
