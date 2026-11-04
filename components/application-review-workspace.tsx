"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { EvidenceCorrectionReview } from "@/components/evidence-correction-review";
import { JobDocumentWorkspace, type JobCoverLetterOption, type JobResumeVersionOption } from "@/components/job-document-workspace";
import { ThemePreferenceControl } from "@/components/theme-preference-control";
import type { EvidenceCorrectionReview as EvidenceReview } from "@/lib/jobs/evidence-correction-review";

export function ReadableResumeText({text}:{text:string}) {
  return <div className="application-source-copy">{text.split(/\r?\n/u).map((line,index)=> {
    if(!line.trim())return null;
    const heading=/^(SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION)[:]?$/iu.test(line.trim());
    return heading?<h3 key={index}>{line}</h3>:<p className={index===0?"candidate":line.includes("|")&&!line.includes("@")?"record-heading":""} key={index}>{line}</p>;
  })}</div>;
}

export function ApplicationReviewWorkspace({sourceText,job,correctionReview,resumeVersions,coverLetters,generationControls}:{
  sourceText:string;job:{title:string;company:string;description:string;requirements:string[];preferredQualifications:string[]};
  correctionReview:EvidenceReview|null;resumeVersions:JobResumeVersionOption[];coverLetters:JobCoverLetterOption[];generationControls:ReactNode;
}) {
  const router=useRouter();
  const [stage,setStage]=useState("background"),[expanded,setExpanded]=useState(false),[evidenceChanged,setEvidenceChanged]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  function chooseStage(next:string){setStage(next);requestAnimationFrame(()=>{const title=root.current?.querySelector<HTMLElement>(`[data-product-review-stage="${next}"] h2`);title?.focus({preventScroll:true});title?.scrollIntoView({block:"start"});});}
  return <div ref={root} className="application-review-workspace product-page product-page-themed" data-application-review-workspace>
    <div className="application-review-top"><p className="text-sm product-review-metadata">Review your source, resolve missing evidence, then inspect the documents for this job.</p><details><summary>Appearance</summary><ThemePreferenceControl/></details></div>
    <nav className="application-review-nav" aria-label="Application review stages">{[["background","Background and target job"],["corrections","Missing-fact corrections"],["documents","Tailored documents"]].map(([name,label],index)=><button key={name} className="application-stage-button" aria-current={stage===name?"step":undefined} onClick={()=>chooseStage(name!)}>{index+1}. {label}</button>)}</nav>
    <section data-product-review-stage="background" hidden={stage!=="background"}>
      <h2 tabIndex={-1}>Background and target job</h2>
      <div className="application-background-actions"><button onClick={()=>setExpanded(!expanded)}>{expanded?"Compare source and job":"Expand master résumé"}</button><button onClick={()=>chooseStage("corrections")}>Continue to corrections</button></div>
      <div className="application-source-grid" data-expanded={expanded}>
        <article className="application-review-panel" data-product-source><h2>Master résumé</h2>{sourceText?<ReadableResumeText text={sourceText}/>:<p>Add a master résumé before reviewing source evidence.</p>}</article>
        <article className="application-review-panel" data-product-job hidden={expanded}><h2>{job.title}</h2><p>{job.company}</p><h3>Full job description</h3><p className="whitespace-pre-wrap">{job.description}</p><h3>Requirements</h3><ul>{job.requirements.map((item,index)=><li key={index}>{item}</li>)}</ul><h3>Preferred qualifications</h3><ul>{job.preferredQualifications.map((item,index)=><li key={index}>{item}</li>)}</ul></article>
      </div>
    </section>
    <section data-product-review-stage="corrections" hidden={stage!=="corrections"}>
      <h2 tabIndex={-1}>Missing-fact corrections</h2><p className="mb-4">Review source facts and saved job-only attestations separately. Saving changes requires reassessment and regeneration; earlier documents do not become current through navigation.</p>
      <div className="application-review-panel">{correctionReview?<EvidenceCorrectionReview review={correctionReview} onReviewChanged={()=>setEvidenceChanged(true)} onReassessmentSaved={()=>router.refresh()}/>:<p>A master résumé is required to review missing facts.</p>}</div>
      <button onClick={()=>chooseStage("documents")}>Continue to documents</button>
    </section>
    <section data-product-review-stage="documents" hidden={stage!=="documents"}>
      <h2 tabIndex={-1}>Tailored documents</h2><p className="mb-3">Inspect the selected document and its actual exported PDF. Document review does not authorize an application or submission.</p>
      {evidenceChanged?<p role="status" className="mb-3">Evidence review changed. Save, reassess explicitly, then regenerate documents before previewing or exporting.</p>:null}
      <details className="application-review-panel mb-4"><summary>Generate documents and manage the application packet</summary><fieldset disabled={evidenceChanged}>{generationControls}</fieldset></details>
      <JobDocumentWorkspace resumeVersions={resumeVersions} coverLetters={coverLetters} evidenceInvalidated={evidenceChanged}/>
    </section>
  </div>;
}
