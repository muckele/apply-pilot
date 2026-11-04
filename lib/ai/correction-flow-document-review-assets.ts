import { PRODUCT_THEME_BOOTSTRAP_SCRIPT, PRODUCT_THEME_STORAGE_KEY } from "@/lib/theme-preference";

// Match the application's product.css tokens; PDFs retain their printable white page.
export const documentReviewCss = `
:root { color-scheme:light; --product-canvas:#f5faf7; --product-surface:#fff; --product-surface-raised:#fbfefc; --product-text:#17261f; --product-copy:#32473d; --product-muted:#53645c; --product-accent:#19764e; --product-mint:#38c979; --product-border:rgba(41,112,79,.2); --product-primary-text:#03110b; }
html[data-product-theme="dark"] { color-scheme:dark; --product-canvas:#020a08; --product-surface:#071411; --product-surface-raised:#0a1815; --product-text:#f3f6f2; --product-copy:#d6dfdb; --product-muted:#aeb9b5; --product-accent:#6ee2a4; --product-mint:#5bd894; --product-border:rgba(166,204,190,.22); }
* { box-sizing:border-box; }
body { margin:0; background:var(--product-canvas); color:var(--product-text); font:16px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
button,select,input { font:inherit; } button,a,summary,select { touch-action:manipulation; } [hidden] { display:none!important; }
a { color:var(--product-accent); } :is(button,a,input,select,summary):focus-visible { outline:2px solid var(--product-accent); outline-offset:4px; }
main { width:100%; padding:24px 32px 64px; }
.topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; border-bottom:1px solid var(--product-border); padding:0 0 20px; }
.brand { display:flex; align-items:center; gap:12px; font-size:22px; font-weight:750; letter-spacing:-.035em; }
.brand-mark { display:grid; place-items:center; width:40px; height:40px; border-radius:10px; color:var(--product-primary-text); background:var(--product-mint); font-size:14px; letter-spacing:-.04em; }
.appearance { display:flex; align-items:center; gap:8px; color:var(--product-muted); font-size:14px; }
.appearance select { min-height:40px; border:1px solid var(--product-border); border-radius:8px; padding:6px 10px; background:var(--product-surface); color:var(--product-text); }
.review-settings { position:relative; } .review-settings .appearance { position:absolute; right:0; z-index:3; padding:12px; background:var(--product-surface); border:1px solid var(--product-border); border-radius:8px; }
.notice { margin:20px 0 24px; color:var(--product-muted); font-size:13px; }
.notice p { margin:4px 0; } .notice strong { color:var(--product-accent); }
h1 { margin:20px 0 8px; font-size:32px; font-weight:700; letter-spacing:-.04em; line-height:1.2; }
h2 { margin:0 0 10px; font-size:25px; line-height:1.3; letter-spacing:-.025em; } h3 { font-size:18px; margin:24px 0 8px; line-height:1.4; } p { margin:0 0 16px; } .muted { color:var(--product-muted); }
.stage-nav { display:flex; gap:8px; border-bottom:1px solid var(--product-border); padding-bottom:16px; margin:24px 0 28px; }
button { cursor:pointer; min-height:44px; border:1px solid var(--product-border); border-radius:8px; padding:10px 16px; background:var(--product-surface); color:var(--product-text); font-weight:600; }
button:hover { border-color:var(--product-accent); } button[aria-pressed="true"],button[aria-current="step"],.primary { border-color:var(--product-mint); background:var(--product-mint); color:var(--product-primary-text); }
button:disabled { cursor:default; opacity:.7; } .step-number { display:inline-grid; place-items:center; width:24px; height:24px; border-radius:50%; border:1px solid currentColor; margin-right:8px; font-size:12px; }
.section-intro { display:flex; justify-content:space-between; align-items:start; gap:24px; margin-bottom:24px; } .section-intro p { max-width:880px; color:var(--product-muted); }
.background-controls,.document-switch,.view-switch,.page-switch,.actions { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
.context-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; align-items:start; }
.context-grid[data-view="source"],.context-grid[data-view="job"] { grid-template-columns:1fr; }
.context-panel,.document,.correction-panel { min-width:0; border:1px solid var(--product-border); border-radius:12px; background:var(--product-surface); padding:28px; }
.context-copy { font:16px/1.75 Inter,ui-sans-serif,system-ui,sans-serif; color:var(--product-copy); overflow-wrap:anywhere; }
.context-copy p { margin:0 0 12px; } .context-copy h3 { color:var(--product-text); padding-top:16px; border-top:1px solid var(--product-border); font-size:18px; }
.context-copy .record-heading { font-weight:650; margin-top:20px; color:var(--product-text); } .context-copy .candidate { font-size:24px; font-weight:700; color:var(--product-text); }
.context-copy ul { margin:8px 0 20px; padding-left:22px; } .context-copy li { margin:6px 0; }
.context-list { padding-left:22px; color:var(--product-copy); } .context-list li { margin:8px 0; } .context-meta { color:var(--product-muted); } .badge { display:inline-block; padding:4px 10px; border-radius:6px; color:var(--product-accent); background:color-mix(in srgb,var(--product-mint) 12%,var(--product-surface)); font-size:13px; font-weight:600; }
.correction-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; } .correction-history { display:grid; gap:20px; margin-bottom:24px; } .correction-history article { padding:24px; background:var(--product-surface); border:1px solid var(--product-border); border-radius:12px; } .correction-history h3 { margin-top:12px; }
.documents { margin-top:20px; } .document-heading { display:flex; align-items:start; justify-content:space-between; gap:24px; } .pdf-link { display:inline-block; min-height:44px; padding:10px 16px; border-radius:8px; background:var(--product-mint); color:var(--product-primary-text); font-weight:650; text-decoration:none; }
.document-heading h3 { margin:0 0 8px; font-size:22px; scroll-margin-top:140px; } .document-origin { font-size:13px; margin:8px 0; }
main[data-active-stage="documents"] > h1 { display:none; }
main[data-active-stage="documents"] .topbar { padding-bottom:12px; }
main[data-active-stage="documents"] .notice { margin:8px 0; }
main[data-active-stage="documents"] .stage-nav { margin:12px 0; padding-bottom:12px; }
main[data-active-stage="documents"] .section-intro { margin-bottom:8px; }
.document-switch { position:sticky; top:0; z-index:2; background:var(--product-canvas); padding:8px 0; }
.document-page { margin:24px 0; background:#fff; border:1px solid #b6c5bb; color:#172033; border-radius:4px; overflow:hidden; }
.document-page svg { display:block; width:100%; max-height:1100px; aspect-ratio:612/792; }
.page-reading { padding:32px 48px; max-width:1000px; margin:auto; font-size:17px; line-height:1.8; }
.page-reading h3 { border-bottom:1px solid #bfd1c8; color:#0f766e; } .page-reading p { margin:0 0 14px; } .page-reading .record-heading { font-weight:700; margin-top:24px; }
.preview-details { margin:16px 0; } summary { cursor:pointer; min-height:44px; padding:10px 0; } .pdf { width:100%; height:80vh; min-height:520px; border:1px solid var(--product-border); }
.fallback { white-space:pre-wrap; overflow-wrap:anywhere; font:16px/1.7 Inter,ui-sans-serif,system-ui,sans-serif; }
.evidence { border-top:1px solid var(--product-border); padding-top:12px; margin-top:24px; } .evidence li { margin:12px 0; overflow-wrap:anywhere; }
fieldset { border:1px solid var(--product-border); border-radius:10px; padding:20px; margin:24px 0 0; } legend { padding:0 8px; font-weight:650; } label { display:block; min-height:44px; padding:8px 0; } input { accent-color:var(--product-accent); } select { color:var(--product-text); background:var(--product-surface); border:1px solid var(--product-border); border-radius:6px; padding:6px; }
.review-actions { margin-top:24px; } .status { min-height:24px; color:var(--product-accent); } .exact-identifiers { overflow-wrap:anywhere; color:var(--product-muted); font-size:13px; }
@media(min-width:1800px) { main { padding-inline:48px; } .context-copy { font-size:17px; } }
@media(max-width:899px) { main { padding:16px 16px 40px; } .context-grid,.correction-grid { grid-template-columns:1fr; } .stage-nav { display:grid; grid-template-columns:1fr; gap:8px; } .stage-nav button { text-align:left; } .section-intro,.document-heading { display:block; } .context-panel,.document,.correction-panel { padding:20px; } .context-copy { font-size:16px; } .page-reading { padding:24px 20px; font-size:16px; } h1 { font-size:28px; } h2 { font-size:23px; } .compare-choice { display:none; } }
@media(max-width:380px) { .topbar { align-items:start; flex-direction:column; } .context-panel,.document { padding:16px; } }
@media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto!important; } }
`;

export const documentReviewJavascript = `${PRODUCT_THEME_BOOTSTRAP_SCRIPT}
(() => {
  const root = document.querySelector('[data-document-review-page]');
  if (!root) return;
  const paths = { state:root.dataset.statePath, submit:root.dataset.submissionPath, cancel:root.dataset.cancelPath };
  const status = document.getElementById('review-status');
  const byKind = (kind) => document.querySelector('[data-document-card="' + kind + '"]');
  let state = null;
  let terminalOutcome = null;
  let expiryTimer;
  const draftKey = 'apply-pilot-document-review-feedback';
  const clearDraft = () => { try { sessionStorage.removeItem(draftKey); } catch {} };
  const finishLocalReview = (outcome) => { terminalOutcome=outcome;clearTimeout(expiryTimer);clearDraft();state=null;document.getElementById('submit-review').disabled=true;document.getElementById('cancel-review').disabled=true; };
  const decisions = () => ['resume','cover_letter'].map(kind=>{const card=byKind(kind);return {kind,disposition:card.querySelector('input[name="'+kind+'-disposition"]:checked')?.value,reason:card.querySelector('select').value||null,reviewedAllPages:card.querySelector('[data-attestation="all-pages"]').checked,reviewedWritingQuality:card.querySelector('[data-attestation="writing"]').checked,reviewedVisualLayout:card.querySelector('[data-attestation="layout"]').checked};});
  const saveDraft = () => {
    if (!state) return;
    // Tab-scoped feedback metadata only: no document text, source evidence, PDF bytes, or credentials.
    try { sessionStorage.setItem(draftKey, JSON.stringify({envelopeHash:state.envelopeHash,expiresAt:state.expiresAt,documents:decisions()})); } catch {}
  };
  const restoreDraft = () => {
    try {
      const draft=JSON.parse(sessionStorage.getItem(draftKey)||'null');
      if(!draft)return;
      if(draft.envelopeHash!==state.envelopeHash||draft.expiresAt!==state.expiresAt||Date.now()>=draft.expiresAt||!Array.isArray(draft.documents)||draft.documents.length!==2){clearDraft();return;}
      for(const [index,kind] of ['resume','cover_letter'].entries()) {
        const value=draft.documents[index];if(value.kind!==kind){clearDraft();return;}
        const card=byKind(kind);
        if(['approved','needs_revision'].includes(value.disposition))card.querySelector('input[value="'+value.disposition+'"]').checked=true;
        if(['clarity','tone','formatting','length','other'].includes(value.reason))card.querySelector('select').value=value.reason;
        for(const [field,selector] of [['reviewedAllPages','all-pages'],['reviewedWritingQuality','writing'],['reviewedVisualLayout','layout']])card.querySelector('[data-attestation="'+selector+'"]').checked=value[field]===true;
      }
    } catch { clearDraft(); }
  };
  root.addEventListener('change',saveDraft);
  const media = matchMedia('(prefers-color-scheme: dark)');
  const theme = document.getElementById('review-theme');
  const applyTheme = (preference) => {
    theme.value = preference;
    document.documentElement.dataset.productThemePreference = preference;
    document.documentElement.dataset.productTheme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  };
  applyTheme(document.documentElement.dataset.productThemePreference || 'system');
  theme.addEventListener('change', () => {
    applyTheme(theme.value);
    try { localStorage.setItem(${JSON.stringify(PRODUCT_THEME_STORAGE_KEY)}, theme.value); }
    catch { theme.title = 'This browser could not save the appearance preference.'; }
  });
  media.addEventListener('change', () => applyTheme(theme.value));
  window.addEventListener('storage', (event) => {
    if(event.key === ${JSON.stringify(PRODUCT_THEME_STORAGE_KEY)}) applyTheme(['light','dark','system'].includes(event.newValue) ? event.newValue : 'system');
  });
  const node = (tag,text,className) => { const element=document.createElement(tag); element.textContent=text; if(className)element.className=className; return element; };
  const renderReadable = (target,text,kind) => {
    target.replaceChildren(); let list=null; let index=0;
    for(const rawLine of text.split(/\\r?\\n/)) {
      const line=rawLine.trim(); if(!line) { list=null; continue; }
      if(/^[-*•]\\s+/.test(line)) { if(!list){list=document.createElement('ul');target.append(list);} list.append(node('li',line.replace(/^[-*•]\\s+/,''))); }
      else { list=null; const heading=kind!=='cover_letter' && /^(SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION)$/.test(line); target.append(node(heading?'h3':'p',line,index===0?'candidate':line.includes('|')&&!line.includes('@')?'record-heading':'')); }
      index++;
    }
  };
  const stage = (name,focus=true) => {
    root.dataset.activeStage=name;
    document.querySelectorAll('[data-review-stage]').forEach(panel=>{panel.hidden=panel.dataset.reviewStage!==name;});
    document.querySelectorAll('[data-go-stage]').forEach(button=>{if(button.closest('.stage-nav'))button.setAttribute('aria-current',button.dataset.goStage===name?'step':'false');});
    if(focus) {
      if(name==='documents') focusDocument(document.querySelector('[data-document-card]:not([hidden])'));
      else document.querySelector('[data-review-stage="'+name+'"] h2').focus();
    }
  };
  document.querySelectorAll('[data-go-stage]').forEach(button=>button.addEventListener('click',()=>stage(button.dataset.goStage)));
  const chooseBackground = (view) => {
    const grid=document.querySelector('.context-grid');grid.dataset.view=view;
    document.querySelector('[data-source-panel]').hidden=view==='job';
    document.querySelector('[data-job-panel]').hidden=view==='source';
    document.querySelectorAll('[data-background-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.backgroundView===view)));
  };
  document.querySelectorAll('[data-background-view]').forEach(button=>button.addEventListener('click',()=>chooseBackground(button.dataset.backgroundView)));
  chooseBackground(matchMedia('(min-width:900px)').matches?'both':'source');
  const focusDocument = (card) => { const title=card.querySelector('[data-document-title]');title.focus({preventScroll:true});title.scrollIntoView({block:'start',behavior:'auto'}); };
  const choosePage = (card,index) => {
    card.querySelectorAll('[data-layout-page]').forEach((page,i)=>{page.hidden=i!==index;});
    card.querySelectorAll('[data-page-choice]').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));
  };
  const drawLayout = (card,documentView) => {
    const container=card.querySelector('[data-document-pages]');container.replaceChildren();
    const rail=card.querySelector('[data-page-switch]');rail.replaceChildren();
    for(const [index,page] of documentView.layout.pages.entries()) {
      const frame=node('div','','document-page');frame.dataset.layoutPage=String(index);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 '+documentView.layout.pageWidth+' '+documentView.layout.pageHeight);svg.setAttribute('role','img');svg.setAttribute('aria-label','Page '+page.number+' layout preview');
      for(const block of page.blocks) {
        const text=document.createElementNS(svg.namespaceURI,'text');text.setAttribute('x',block.x);text.setAttribute('y',block.y+block.fontSize);text.setAttribute('font-family',documentView.layout.fontFamily);text.setAttribute('font-size',block.fontSize);text.setAttribute('font-weight',block.bold?'700':'400');text.setAttribute('fill',block.color);text.textContent=block.text;svg.append(text);
        if(block.headingRule){const line=document.createElementNS(svg.namespaceURI,'line');const left=block.headingRule==='left';line.setAttribute('x1',left?block.x-6:block.x);line.setAttribute('x2',left?block.x-6:documentView.layout.pageWidth-documentView.layout.margin);line.setAttribute('y1',block.y+block.height+1);line.setAttribute('y2',left?block.y+1:block.y+block.height+1);line.setAttribute('stroke',block.color);line.setAttribute('stroke-width',left?2:.7);svg.append(line);}
      }
      frame.append(svg);container.append(frame);
      const button=node('button','Page '+page.number);button.dataset.pageChoice=String(index);button.addEventListener('click',()=>choosePage(card,index));rail.append(button);
    }
    choosePage(card,0);
  };
  const render = (view) => {
    if(terminalOutcome)return;
    state=view;
    restoreDraft();
    expiryTimer=setTimeout(()=>{if(!state)return;finishLocalReview('expired');status.textContent='This review expired. Its original 15-minute limit has ended. Check the runner receipt for its final status.';},Math.max(0,view.expiresAt-Date.now()));
    document.querySelector('[data-output-origin]').textContent=view.context.outputOrigin==='authored_sample'?'Authored synthetic sample · no provider call was made.':'Review generated documents against your source evidence.';
    document.querySelector('[data-correction-history-label]').textContent=view.context.outputOrigin==='authored_sample'?'Illustrative saved correction history':'Saved correction history';
    renderReadable(document.querySelector('[data-source-resume]'),view.context.sourceResumeText,'resume');
    const job=view.context.targetJob;
    document.querySelector('[data-workspace-job]').textContent=job.title+' · '+job.company;
    document.querySelector('[data-job-title]').textContent=job.title;
    document.querySelector('[data-job-meta]').textContent=[job.company,job.location].filter(Boolean).join(' · ');
    document.querySelector('[data-job-description]').textContent=job.description;
    for(const [selector,values] of [['[data-job-requirements]',job.requirements],['[data-job-preferred]',job.preferredQualifications],['[data-job-stack]',job.detectedTechStack],['[data-reviewed-facts]',view.context.reviewedFacts],['[data-reviewed-resume-facts]',view.context.reviewedResumeFacts||[]]]) {
      const list=document.querySelector(selector);list.replaceChildren();values.forEach(value=>list.append(node('li',value)));
    }
    document.querySelector('[data-reviewed-resume-panel]').hidden=!(view.context.reviewedResumeFacts||[]).length;
    const history=document.querySelector('[data-correction-history]');history.replaceChildren();
    (view.context.correctionHistory||[]).forEach(item=>{const card=document.createElement('article');card.append(node('span',item.provenance==='OWNER_ATTESTED'?'User-added · this job only':'Resolved from master résumé','badge'),node('h3',item.requirement),node('p',item.evidenceBefore),node('p',item.fact));history.append(card);});
    for(const documentView of view.documents) {
      const card=byKind(documentView.kind);card.querySelector('[data-document-title]').textContent=documentView.title;
      card.querySelector('[data-document-origin]').textContent=view.context.outputOrigin==='authored_sample'?'Authored synthetic sample · no provider call was made.':'Synthetic local review · check every page against the source.';
      card.querySelector('[data-page-count]').textContent=documentView.pages.length+' '+(documentView.pages.length===1?'page':'pages');
      card.querySelector('[data-document-hash]').textContent='Output '+documentView.validatedOutputHash+' · PDF '+documentView.renderedPdfHash;
      drawLayout(card,documentView);
      renderReadable(card.querySelector('[data-reading-content]'),documentView.text,documentView.kind);
      const fallback=card.querySelector('[data-document-text]');fallback.replaceChildren();documentView.pages.forEach((page,index)=>fallback.append(node('h3','Text fallback · page '+(index+1)),node('p',page.join('\\n'),'fallback')));
      const evidence=card.querySelector('[data-document-evidence]');evidence.replaceChildren();documentView.evidence.forEach(entry=>evidence.append(node('li',entry.claim+' — '+entry.citations.map(citation=>citation.excerpt).join(' · '))));
      const reading=matchMedia('(max-width:899px)').matches;card.querySelector('[data-readable-document]').hidden=!reading;card.querySelector('[data-layout-document]').hidden=reading;card.querySelectorAll('[data-document-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.documentView===(reading?'reading':'layout'))));
    }
  };
  document.querySelectorAll('[data-review-kind]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-document-card]').forEach(card=>{card.hidden=card.dataset.documentCard!==button.dataset.reviewKind;});document.querySelectorAll('[data-review-kind]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));focusDocument(byKind(button.dataset.reviewKind));}));
  document.querySelectorAll('[data-document-view]').forEach(button=>button.addEventListener('click',()=>{const card=button.closest('[data-document-card]');card.querySelector('[data-readable-document]').hidden=button.dataset.documentView!=='reading';card.querySelector('[data-layout-document]').hidden=button.dataset.documentView!=='layout';card.querySelectorAll('[data-document-view]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));}));
  document.querySelectorAll('[data-embedded-preview]').forEach(details=>details.addEventListener('toggle',()=>{const frame=details.querySelector('iframe');if(details.open&&!frame.getAttribute('src'))frame.src=frame.dataset.pdfPath;}));
  fetch(paths.state, { cache: 'no-store', credentials: 'omit' }).then(response=>response.ok?response.json():Promise.reject(new Error('state'))).then(render).catch(()=>{if(terminalOutcome)return;finishLocalReview('unavailable');status.textContent='Review unavailable. The local session may have ended or the connection failed. Reopening this address cannot restart it; check the runner receipt.';});
  const collect=()=>({envelopeHash:state.envelopeHash,documents:decisions().map(value=>{const identity=state.documents.find(entry=>entry.kind===value.kind);return {...value,validatedOutputHash:identity.validatedOutputHash,renderedPdfHash:identity.renderedPdfHash};})});
  const documentName=kind=>kind==='resume'?'Résumé':'Cover letter';
  const explain=(body)=>{
    if(body.error==='PDF_DELIVERY_REQUIRED')return (body.documents||[]).map(kind=>documentName(kind)+': open the exact PDF using its link or embedded preview and wait for it to load.').join(' ');
    if(body.error==='REVIEW_FIELDS_REQUIRED')return (body.fields||[]).map(path=>{
      const [,index,field]=path.split('.');const name=documentName(index==='0'?'resume':'cover_letter');
      const labels={disposition:'choose Approve or Needs revision',reason:'choose a revision category for Needs revision, or None for approval',reviewedAllPages:'confirm you reviewed every PDF page',reviewedWritingQuality:'confirm you reviewed the writing quality',reviewedVisualLayout:'confirm you reviewed the visual layout'};
      return labels[field]?name+': '+labels[field]+'.':'The review no longer matches these documents. Check the runner receipt.';
    }).join(' ')||'Complete both document decisions and inspection checks.';
    if(body.error==='REVIEW_IDENTITY_MISMATCH')return 'The review no longer matches these exact documents. No decision was recorded; check the runner receipt.';
    if(body.error==='REVIEW_UNAVAILABLE')return 'This review is no longer available. Check the runner receipt for its final status.';
    if(body.error==='REVIEW_SUBMISSION_PENDING')return 'Another review submission is being processed. Your choices remain here; check the runner receipt before trying again.';
    return 'The review request was rejected. No decision was recorded; check the runner receipt.';
  };
  const submit=document.getElementById('submit-review');
  submit.addEventListener('click',async()=>{
    if(terminalOutcome)return;
    if(!state){status.textContent='Review unavailable. Check the runner receipt for this session.';return;}
    submit.disabled=true;
    try {
      const response=await fetch(paths.submit,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collect())});
      // A confirmed accepted submission is authoritative even if its response arrives after the local deadline.
      if(response.ok){finishLocalReview('recorded');status.textContent='Review recorded. This local session is closed.';}
      else {const body=await response.json().catch(()=>({}));if(terminalOutcome)return;if(['REVIEW_IDENTITY_MISMATCH','REVIEW_UNAVAILABLE'].includes(body.error))finishLocalReview('unavailable');status.textContent=explain(body);}
    } catch {if(!terminalOutcome)status.textContent='Could not confirm the review submission because the local connection failed. Your choices remain here; check the runner receipt before trying again.';}
    finally {submit.disabled=Boolean(terminalOutcome);}
  });
  document.getElementById('cancel-review').addEventListener('click',async()=>{
    if(terminalOutcome)return;
    try {const response=await fetch(paths.cancel,{method:'POST'});if(!response.ok)throw new Error('cancel');if(terminalOutcome==='recorded')return;finishLocalReview('cancelled');status.textContent='Review cancelled.';}
    catch {if(!terminalOutcome)status.textContent='Could not confirm cancellation. Stop the local runner to close the review.';}
  });
  // Reload and PDF navigation do not cancel. Explicit Cancel, runner stop, and the original deadline still close it.
})();
`;
