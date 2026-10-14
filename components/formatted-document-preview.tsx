"use client";
import { useState } from "react";
import { defaultResumeFormat, type ResumeFormat } from "@/lib/documents/resume-format";
import { buildProductDocumentLayout } from "@/lib/documents/product-document-layout";

export function FormattedDocumentPreview({text,title,format=defaultResumeFormat,headingLevel=3,artifactType="RESUME",showTitle=true}:{text:string;title:string;format?:ResumeFormat;headingLevel?:2|3;artifactType?:"RESUME"|"COVER_LETTER";showTitle?:boolean}) {
  const [view,setView]=useState("auto");
  const layout=buildProductDocumentLayout({content:text,artifactType,resumeFormat:format}),Heading=headingLevel===2?"h2":"h3";
  return <section className="product-document-preview" data-document-preview={title} data-document-view={view} aria-label={title}>
    {showTitle?<Heading>{title}</Heading>:null}<p className="text-sm product-review-metadata">{layout.pages.length} {layout.pages.length===1?"page":"pages"} · preview and ordinary exports use the selected settings</p>
    {format.fontFamily==="GEORGIA"?<p className="text-sm product-review-metadata">DOCX preserves Georgia. The current PDF export uses Times.</p>:null}
    <div className="application-background-actions"><button className="min-h-[44px]" aria-pressed={view==="layout"} onClick={()=>setView("layout")}>Page layout</button><button className="min-h-[44px]" aria-pressed={view==="reading"} onClick={()=>setView("reading")}>Readable text</button></div>
    <p className="text-sm mb-3" data-mobile-full-document-cue>Full document preview · review every page. Open the actual PDF to inspect the exported file.</p>
    <div className="product-document-reading" data-reading-content>{text.split(/\r?\n/u).filter(line=>line.trim()).map((line,index)=><p key={index}>{line}</p>)}</div>
    <div className="product-document-layout">{layout.pages.map(page=><article className="product-document-paper" key={page.number} data-document-page>
      <svg viewBox={"0 0 "+layout.pageWidth+" "+layout.pageHeight} role="img" aria-label={"Page "+page.number+" layout"} style={{fontFamily:layout.fontFamily}}>{page.blocks.map((block,index)=><g key={index}><text x={block.x} y={block.y+block.fontSize} fontSize={block.fontSize} fontWeight={block.bold?700:400} fill={block.color}>{block.text}</text>{block.headingRule?<line x1={block.headingRule==="left"?block.x-6:block.x} x2={block.headingRule==="left"?block.x-6:layout.pageWidth-layout.margin} y1={block.y+block.height+1} y2={block.headingRule==="left"?block.y+1:block.y+block.height+1} stroke={block.color} strokeWidth={block.headingRule==="left"?2:.7}/>:null}</g>)}</svg>
    </article>)}</div>
  </section>;
}
