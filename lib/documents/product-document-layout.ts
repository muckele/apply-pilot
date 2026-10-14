import { isResumeBullet, stripResumeBullet, type ResumeFormat } from "@/lib/documents/resume-format";

import { pdfFontNames, type PdfFont } from "@/lib/documents/pdf-font";

export const PRODUCT_DOCUMENT_LAYOUT_VERSION = "3";
export type ProductDocumentInput = { content:string; artifactType:"RESUME"|"COVER_LETTER"; resumeFormat:ResumeFormat; pdfFont?:PdfFont };
export type ProductDocumentBlock = { text:string; sourceText:string; paragraphId:number; role:string; x:number; y:number; width:number; height:number; fontSize:number; bold:boolean; color:string; headingRule?:"left"|"bottom" };
export type ProductDocumentLayout = { version:string; pageWidth:number; pageHeight:number; margin:number; fontFamily:string; pdfFont:string; pdfBoldFont:string; pages:Array<{number:number;blocks:ProductDocumentBlock[]}> };
const headings=/^(SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL(?: INFORMATION)?)[:]?$/iu;

function wrap(text:string,width:number,size:number) {
  // Conservative per-glyph bounds for the supported standard PDF font substitutions.
  const measure=(value:string)=>Array.from(value).reduce((sum,char)=>sum+size*(/[WM@]/u.test(char)?1.1:/[mw%]/u.test(char)?.95:/[A-Z]/u.test(char)?.85:/[ilI.,'’:;!|]/u.test(char)?.35:/\s/u.test(char)?.35:/[0-9a-z]/u.test(char)?.65:1.1),0);
  const lines:string[]=[];let line="";
  for(const word of text.split(/\s+/u)) {
    if(measure(word)>width) {
      if(line)lines.push(line);line="";
      let part="";for(const char of word){if(part&&measure(part+char)>width){lines.push(part);part="";}part+=char;}if(part)line=part;
    } else if(!line)line=word;
    else if(measure(line+" "+word)<=width)line+=" "+word;
    else {lines.push(line);line=word;}
  }
  if(line)lines.push(line);return lines;
}

export function buildProductDocumentLayout(input:ProductDocumentInput):ProductDocumentLayout {
  const f=input.resumeFormat;
  const pageWidth=f.pageSize==="A4"?595:612,pageHeight=f.pageSize==="A4"?842:792;
  const margin=f.template==="COMPACT"?36:46.8;
  const fontFamily={ARIAL:"Arial",CALIBRI:"Calibri",GEORGIA:"Georgia"}[f.fontFamily];
  const layout:ProductDocumentLayout={version:PRODUCT_DOCUMENT_LAYOUT_VERSION,pageWidth,pageHeight,margin,fontFamily,pdfFont:f.fontFamily==="GEORGIA"?"Times-Roman":"Helvetica",pdfBoldFont:f.fontFamily==="GEORGIA"?"Times-Bold":"Helvetica-Bold",pages:[{number:1,blocks:[]}]};
  if(input.pdfFont){layout.pdfFont=pdfFontNames[input.pdfFont].regular;layout.pdfBoldFont=pdfFontNames[input.pdfFont].bold;}
  let page=layout.pages[0]!,y=margin,index=0;
  const nextPage=()=>{page={number:layout.pages.length+1,blocks:[]};layout.pages.push(page);y=margin;};
  const sourceLines=input.content.split(/\r?\n/u);
  for(const [sourceIndex,raw] of sourceLines.entries()) {
    const line=raw.trim();if(!line){y+=f.template==="COMPACT"?4:7;continue;}
    const heading=input.artifactType==="RESUME"&&headings.test(line),bullet=isResumeBullet(line);
    const role=heading?"section_heading":index===0?"candidate_name":index===1&&/@|\||\+\d/u.test(line)?"contact":bullet?"bullet":line.includes("|")&&!line.includes("@")?"record_heading":/^Dear\b/iu.test(line)?"salutation":"body";
    const size=role==="candidate_name"?f.fontSize*1.6:role==="contact"?Math.max(9,f.fontSize*.9):f.fontSize;
    const bold=["section_heading","candidate_name","record_heading","salutation"].includes(role);
    const indent=bullet?12:heading&&f.template==="MODERN"?8:0;
    const width=pageWidth-margin*2-indent;
    const text=bullet?"• "+stripResumeBullet(line):line;
    const parts=wrap(text,width,size),height=size*f.lineSpacing/100;
    const before=heading?(f.template==="COMPACT"?7:11):role==="record_heading"?5:0;
    const after=heading?5:role==="candidate_name"?3:3;
    // Keep a section/record heading with the following record and first details, including their spacing.
    let keepNext=0;
    if(heading||role==="record_heading") {
      for(const nextRaw of sourceLines.slice(sourceIndex+1)) {
        const next=nextRaw.trim();
        if(!next){keepNext+=f.template==="COMPACT"?4:7;continue;}
        if(headings.test(next))break;
        const nextBullet=isResumeBullet(next),record=!nextBullet&&next.includes("|")&&!next.includes("@");
        const nextWidth=pageWidth-margin*2-(nextBullet?12:0);
        const nextText=nextBullet?"• "+stripResumeBullet(next):next;
        keepNext+=(record?5:0)+wrap(nextText,nextWidth,f.fontSize).length*f.fontSize*f.lineSpacing/100+3;
        if(!record)break;
      }
    }
    if(y+before+parts.length*height+after+keepNext>pageHeight-margin&&page.blocks.length)nextPage();
    y+=before;
    for(const part of parts) {
      if(y+height>pageHeight-margin&&page.blocks.length)nextPage();
      page.blocks.push({text:part,sourceText:text,paragraphId:index,role,x:margin+indent,y,width,height,fontSize:size,bold,color:heading?f.accentColor:role==="contact"?"#475569":"#172033",...(heading?{headingRule:f.template==="MODERN"?"left" as const:"bottom" as const}: {})});y+=height;
    }
    y+=after;index++;
  }
  // Balance only complete trailing sections; never reduce type or reorder facts.
  if(input.artifactType==="RESUME"&&layout.pages.length>1) {
    const a=layout.pages.at(-2)!,b=layout.pages.at(-1)!;
    const bottom=(blocks:ProductDocumentBlock[])=>{const last=blocks.at(-1)!;return last.y+last.height;};
    let difference=Math.abs(bottom(a.blocks)-bottom(b.blocks)),chosen=-1;
    for(let i=1;i<a.blocks.length;i++) {
      const block=a.blocks[i]!;if(block.role!=="section_heading"||a.blocks[i-1]!.role==="section_heading")continue;
      const moved=bottom(a.blocks)-block.y,combined=moved+12+bottom(b.blocks)-margin;
      const candidate=Math.abs(bottom(a.blocks.slice(0,i))-margin-combined);
      if(combined<=pageHeight-margin*2&&candidate<difference){difference=candidate;chosen=i;}
    }
    if(chosen>=0){const first=a.blocks[chosen]!,moved=bottom(a.blocks)-first.y;b.blocks=[...a.blocks.slice(chosen).map(block=>({...block,y:block.y-first.y+margin})),...b.blocks.map(block=>({...block,y:block.y+moved+12}))];a.blocks=a.blocks.slice(0,chosen);}
  }
  return layout;
}
