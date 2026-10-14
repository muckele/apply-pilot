"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FormattedDocumentPreview } from "@/components/formatted-document-preview";
import { defaultResumeFormat, type ResumeFormat } from "@/lib/documents/resume-format";

export type JobResumeVersionOption = {id:string;title:string;fullText:string;summary:string|null;atsCompatibility:number|null;jobFitScore:number|null;evidenceCurrent:boolean;createdAt:string;resumeFormat?:ResumeFormat};
export type JobCoverLetterOption = {id:string;title:string;content:string;evidenceCurrent:boolean;createdAt:string};
type ExportFormat="markdown"|"docx"|"pdf";

export function JobDocumentWorkspace({resumeVersions,coverLetters,evidenceInvalidated=false}:{resumeVersions:JobResumeVersionOption[];coverLetters:JobCoverLetterOption[];evidenceInvalidated?:boolean}) {
  const [kind,setKind]=useState<"resume"|"cover">("resume"),[resumeId,setResumeId]=useState(resumeVersions[0]?.id??""),[coverId,setCoverId]=useState(coverLetters[0]?.id??"");
  const root=useRef<HTMLDivElement>(null);
  const [drafts,setDrafts]=useState<Record<string,{baseText:string;text:string}>>({});
  const resume=resumeVersions.find(item=>item.id===resumeId)??resumeVersions[0]??null,cover=coverLetters.find(item=>item.id===coverId)??coverLetters[0]??null;
  const selected=kind==="resume"?resume:cover,stored=kind==="resume"?resume?.fullText??"":cover?.content??"";
  const format=kind==="resume"?resume?.resumeFormat??defaultResumeFormat:defaultResumeFormat;
  const identity=JSON.stringify([kind,selected?.id,stored,format,selected?.evidenceCurrent,evidenceInvalidated]);
  const draftKey=kind+":"+(selected?.id??""),draft=drafts[draftKey];
  const text=draft?.text??stored,conflict=!!draft&&draft.baseText!==stored&&draft.text!==stored;
  function changeText(next:string){setDrafts(previous=>({...previous,[draftKey]:{baseText:previous[draftKey]?.baseText??stored,text:next}}));}
  function clearDraft(){setDrafts(previous=>{const next={...previous};delete next[draftKey];return next;});}
  function confirmSaved(next:string){setDrafts(previous=>({...previous,[draftKey]:{baseText:next,text:next}}));}
  function focusSelected(){requestAnimationFrame(()=>{const title=root.current?.querySelector<HTMLElement>(".application-document-title");title?.focus({preventScroll:true});title?.scrollIntoView({block:"start"});});}
  function chooseKind(next:"resume"|"cover"){setKind(next);focusSelected();}
  function chooseVersion(id:string){if(kind==="resume")setResumeId(id);else setCoverId(id);focusSelected();}
  return <div ref={root} className="application-documents" data-product-documents>
    <nav className="application-document-nav" aria-label="Choose document"><button aria-pressed={kind==="resume"} onClick={()=>chooseKind("resume")}>Review résumé</button><button aria-pressed={kind==="cover"} onClick={()=>chooseKind("cover")}>Review cover letter</button></nav>
    <DocumentReviewCard key={identity} kind={kind} selected={selected} stored={stored} text={text} conflict={conflict} changeText={changeText} clearDraft={clearDraft} confirmSaved={confirmSaved} format={format} evidenceInvalidated={evidenceInvalidated} versions={kind==="resume"?resumeVersions:coverLetters} chooseVersion={chooseVersion}/>
  </div>;
}
function DocumentReviewCard({kind,selected,stored,text,conflict,changeText,clearDraft,confirmSaved,format,evidenceInvalidated,versions,chooseVersion}:{kind:"resume"|"cover";selected:JobResumeVersionOption|JobCoverLetterOption|null;stored:string;text:string;conflict:boolean;changeText:(text:string)=>void;clearDraft:()=>void;confirmSaved:(text:string)=>void;format:ResumeFormat;evidenceInvalidated:boolean;versions:Array<JobResumeVersionOption|JobCoverLetterOption>;chooseVersion:(id:string)=>void}) {
  const router=useRouter();
  const [busy,setBusy]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[pdfUrl,setPdfUrl]=useState<string|null>(null);
  const revision=useRef(0),url=useRef<string|null>(null),abort=useRef<AbortController|null>(null),operation=useRef(false);
  const dirty=text!==stored;
  const eligible=!!selected?.evidenceCurrent&&!evidenceInvalidated&&!dirty&&!conflict;
  function invalidate(){revision.current++;abort.current?.abort();abort.current=null;operation.current=false;if(url.current)URL.revokeObjectURL(url.current);url.current=null;setPdfUrl(null);setBusy(null);}
  useEffect(()=>()=>{revision.current++;abort.current?.abort();if(url.current)URL.revokeObjectURL(url.current);},[]);
  async function exportFile(exportFormat:ExportFormat,preview=false) {
    if(!eligible||operation.current||!selected)return;
    operation.current=true;
    const started=revision.current,controller=new AbortController();abort.current=controller;setBusy(preview?"preview":"export");setMessage(null);
    try {
      const response=await fetch("/api/documents/export",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...(kind==="resume"?{resumeVersionId:selected.id}:{documentId:selected.id}),format:exportFormat}),signal:controller.signal});
      if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(body?.error??"Export failed.");}
      const blob=await response.blob();if(started!==revision.current||controller.signal.aborted)return;
      const objectUrl=URL.createObjectURL(blob);
      if(preview){if(url.current)URL.revokeObjectURL(url.current);url.current=objectUrl;setPdfUrl(objectUrl);}
      else {const link=document.createElement("a");link.href=objectUrl;link.download=response.headers.get("content-disposition")?.match(/filename="([^"]+)"/u)?.[1]??("document."+exportFormat);link.click();URL.revokeObjectURL(objectUrl);}
    }catch(error){if(started===revision.current&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:"Export unavailable.");}
    finally{if(started===revision.current){setBusy(null);abort.current=null;operation.current=false;}}
  }
  async function save() {
    if(!selected||operation.current||conflict)return;
    operation.current=true;
    const started=revision.current;setBusy("save");setMessage(null);
    try {
      const response=await fetch(kind==="resume"?"/api/resume-versions/"+selected.id:"/api/generated-documents/"+selected.id,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(kind==="resume"?{fullText:text}:{content:text})});
      if(started!==revision.current)return;
      if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(body?.error??"Could not save edits.");}
      const saved=await response.json();
      if(started!==revision.current)return;
      confirmSaved(kind==="resume"?saved.version.fullText:saved.document.content);
      setMessage("Edits saved. Regenerate from reviewed evidence before exporting.");router.refresh();
    }catch(error){if(started===revision.current)setMessage(error instanceof Error?error.message:"Could not save edits.");}
    finally{if(started===revision.current){setBusy(null);operation.current=false;}}
  }
  return <section className="application-review-panel" data-selected-document={kind}>
      <h3 tabIndex={-1} className="application-document-title">{kind==="resume"?"Tailored résumé":"Cover letter"}</h3>
      {selected&&!selected.evidenceCurrent?<p role="status">Older reviewed evidence — regenerate before export.</p>:null}
      {dirty?<p role="status">Unsaved edits — export and actual PDF preview are unavailable.</p>:null}
      {conflict?<p role="status">The saved document changed while this draft was open. Copy your draft, then discard it to review the current version before editing again.</p>:null}
      {message?<p role="status">{message}</p>:null}
      {selected?<FormattedDocumentPreview text={text} title={kind==="resume"?"Résumé page layout":"Cover letter page layout"} format={format} artifactType={kind==="resume"?"RESUME":"COVER_LETTER"} showTitle={false}/>:<p>No saved document yet. Generate explicitly after reviewing the evidence.</p>}
      <div className="application-background-actions"><button disabled={!eligible||!!busy} onClick={()=>exportFile("pdf",true)}>{busy==="preview"?"Loading PDF…":"Preview actual PDF"}</button>{(["markdown","docx","pdf"] as const).map(item=><button key={item} disabled={!eligible||!!busy} onClick={()=>exportFile(item)}>Download {item.toUpperCase()}</button>)}</div>
      {pdfUrl?<div data-actual-product-pdf><a href={pdfUrl} target="_blank" rel="noreferrer">Open this exact PDF in a new tab</a><iframe title="Actual exported document PDF" className="w-full min-h-[600px]" src={pdfUrl}/></div>:null}
      <details><summary>Selected version and formatting</summary><label className="block">{kind==="resume"?"Résumé version":"Cover-letter version"}<select className="block w-full mt-1" value={selected?.id??""} disabled={!selected} onChange={event=>chooseVersion(event.target.value)}>{versions.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}</select></label><p>{format.template} · {format.pageSize} · {format.fontFamily} · {format.fontSize} pt · {format.lineSpacing}% line spacing</p></details>
      <details><summary>Edit document text</summary><label className="block">{kind==="resume"?"Tailored résumé text":"Cover-letter text"}<textarea className="w-full mt-2" rows={14} value={text} disabled={!selected||busy==="save"} onChange={event=>{invalidate();changeText(event.target.value);setMessage(null);}}/></label><button onClick={save} disabled={!selected||!!busy||!dirty||conflict}>{busy==="save"?"Saving…":"Save edits"}</button>{dirty||conflict?<button disabled={!!busy} onClick={()=>{invalidate();clearDraft();setMessage(null);}}>Discard unsaved edits</button>:null}</details>
      {kind==="resume"&&selected?.evidenceCurrent?<Link href={"/resumes/"+selected.id}>Format and preview résumé</Link>:null}
    </section>;
}
