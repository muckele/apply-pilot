import type { ResumeFormat } from "@/lib/documents/resume-format";
import {
  documentFontMeasure,
  winAnsiCode,
  wrapStyledRuns,
  wrapStyledRunsWithoutLoneLastWord,
  type DocumentFontSet,
  type MeasureText,
  type PlacedFragment,
  type StyledRun,
  type TextStyle
} from "@/lib/documents/document-typography";
import { pdfFontNames, type PdfFont } from "@/lib/documents/pdf-font";
import {
  datedRecordGap,
  isResumeSectionHeadingLine,
  isSkillsSectionHeadingLine,
  looksLikeRecordTitle,
  parseDatedRecordHeading,
  parseGroupedSkillLine,
  parseResumeBullet,
  resumeBulletGlyph,
  withoutDatedRecordSeparator,
  wrapSeparatedHeaderLine
} from "@/lib/documents/resume-line-structure";

// Version 5 (2026-11-05): measured standard-font widths, record hierarchy, hanging bullets and
// separator-aware header wrapping. Text and its order are unchanged from version 4.
// Version 6 (2026-11-06): every all-caps heading the résumé parser knows is a section heading,
// skills labels may run to six words, a dated organization line that wraps moves its parenthetical
// under the organization without stranding a word, and the separator mark before right-aligned
// dates is left out (see `productDocumentExportText`).
export const PRODUCT_DOCUMENT_LAYOUT_VERSION = "6";
export type ProductDocumentInput = { content:string; artifactType:"RESUME"|"COVER_LETTER"; resumeFormat:ResumeFormat; pdfFont?:PdfFont };
export type ProductDocumentBlock = { text:string; sourceText:string; paragraphId:number; role:string; x:number; y:number; width:number; height:number; fontSize:number; bold:boolean; italic?:true; color:string; headingRule?:"left"|"bottom" };
export type ProductDocumentLayout = { version:string; pageWidth:number; pageHeight:number; margin:number; fontFamily:string; pdfFont:string; pdfBoldFont:string; pdfItalicFont:string; pages:Array<{number:number;blocks:ProductDocumentBlock[]}> };

export type ProductDocumentRole =
  | "candidate_name" | "contact" | "section_heading" | "record_heading" | "record_title"
  | "bullet" | "skill_group" | "salutation" | "body";
export type ProductDocumentRun = Readonly<{ text:string; style:TextStyle }>;
// One source line, described for DOCX: `runs` are exact source substrings in order. A bullet's
// marker and a record heading's dates are kept apart so the renderer can place them.
export type ProductDocumentParagraph = Readonly<{
  id:number;
  role:ProductDocumentRole;
  fontSize:number;
  color:string;
  indent:number;
  runs:readonly ProductDocumentRun[];
  bullet?:Readonly<{ marker:string; separator:string; markerIndent:number; textIndent:number; markerWidth:number }>;
  // `separator` is the exact source text before the dates; renderers write only its `gap`.
  dates?:Readonly<{ separator:string; gap:string; text:string }>;
  // Offsets into the joined run text where the layout broke a separated header line.
  lineBreakOffsets?:readonly number[];
}>;

const textColor="#172033",secondaryColor="#475569";
// Georgia is wider than the Times metrics that stand in for it in DOCX and the preview.
const GEORGIA_WIDTH_SCALE=1.15;
// Keeps measured text a hair inside the margin for viewers that substitute metric-compatible fonts.
const WRAP_SAFETY=1.5;

type LinePlan = { x:number; fragments:readonly PlacedFragment[] };
type Placed = { text:string; x:number; width:number };
type ParagraphPlan = {
  paragraph:ProductDocumentParagraph;
  sourceText:string;
  lines:LinePlan[];
  marker?:Placed;
  dates?:Placed;
  lineHeight:number;
  before:number;
  after:number;
  headingRule?:"left"|"bottom";
};
type Entry = { kind:"blank" } | { kind:"paragraph"; plan:ParagraphPlan };

function fontsFor(input:ProductDocumentInput):DocumentFontSet {
  const names=pdfFontNames[input.pdfFont??(input.resumeFormat.fontFamily==="GEORGIA"?"TIMES":"HELVETICA")];
  return {regular:names.regular,bold:names.bold,italic:names.italic,widthScale:!input.pdfFont&&input.resumeFormat.fontFamily==="GEORGIA"?GEORGIA_WIDTH_SCALE:1};
}

// Source offsets where each wrapped line after the first begins. Wrapping only collapses
// whitespace, so the drawn non-space characters match the source's in order.
function lineStartOffsets(source:string,lines:readonly (readonly PlacedFragment[])[]) {
  const offsets:number[]=[];
  let cursor=0;
  const skipSpace=()=>{while(cursor<source.length&&/\s/u.test(source[cursor]!))cursor++;};
  lines.forEach((line,index)=>{
    skipSpace();
    if(index>0)offsets.push(cursor);
    for(const character of line.map(fragment=>fragment.text).join("")) {
      if(/\s/u.test(character))continue;
      skipSpace();
      cursor+=character.length;
    }
  });
  return offsets;
}

// A dated heading's lead wraps beside its dates. When it needs more than one line and the
// organization fits on the first, a parenthetical starts its own line under the organization
// instead of leaving a word or two of it behind. Otherwise the lead wraps as one, and it does not
// end on a lone word where an earlier break avoids it.
function wrapRecordLead(organization:StyledRun,aside:StyledRun,width:number,measure:MeasureText) {
  const whole=wrapStyledRuns([organization,aside],width,measure);
  if(whole.length===1)return whole;
  const organizationLines=wrapStyledRuns([organization],width,measure);
  if(organizationLines.length>1||!aside.text.trim())return wrapStyledRunsWithoutLoneLastWord([organization,aside],width,measure);
  return [...organizationLines,...wrapStyledRunsWithoutLoneLastWord([aside],width,measure)];
}

export function buildProductDocument(input:ProductDocumentInput):{layout:ProductDocumentLayout;paragraphs:readonly ProductDocumentParagraph[]} {
  const f=input.resumeFormat,resume=input.artifactType==="RESUME";
  const pageWidth=f.pageSize==="A4"?595:612,pageHeight=f.pageSize==="A4"?842:792;
  const margin=f.template==="COMPACT"?36:46.8,contentWidth=pageWidth-margin*2;
  const fontFamily={ARIAL:"Arial",CALIBRI:"Calibri",GEORGIA:"Georgia"}[f.fontFamily];
  const fonts=fontsFor(input);
  const layout:ProductDocumentLayout={version:PRODUCT_DOCUMENT_LAYOUT_VERSION,pageWidth,pageHeight,margin,fontFamily,pdfFont:fonts.regular,pdfBoldFont:fonts.bold,pdfItalicFont:fonts.italic,pages:[{number:1,blocks:[]}]};
  const blankGap=f.template==="COMPACT"?4:7;
  const lineHeightFor=(size:number)=>size*f.lineSpacing/100;

  const entries:Entry[]=[];
  const paragraphs:ProductDocumentParagraph[]=[];
  let section="",previousDated=false;
  for(const raw of input.content.split(/\r?\n/u)) {
    const line=raw.trim();
    if(!line){entries.push({kind:"blank"});previousDated=false;continue;}
    const id=paragraphs.length;
    const heading=resume&&isResumeSectionHeadingLine(line),bullet=parseResumeBullet(line);
    const dated=resume&&!heading&&id>1?parseDatedRecordHeading(line):null;
    const skill=resume&&!heading&&id>1?parseGroupedSkillLine(line,isSkillsSectionHeadingLine(section)):null;
    const role:ProductDocumentRole=heading?"section_heading":id===0?"candidate_name":id===1&&/@|\||\+\d/u.test(line)?"contact":bullet?"bullet"
      :line.includes("|")&&!line.includes("@")?"record_heading":dated?"record_heading":resume&&previousDated&&looksLikeRecordTitle(line)?"record_title"
      :skill?"skill_group":/^Dear\b/iu.test(line)?"salutation":"body";
    if(heading)section=line;
    previousDated=Boolean(dated)&&role==="record_heading";

    let fontSize=role==="candidate_name"?f.fontSize*1.6:role==="contact"?Math.max(9,f.fontSize*.9):f.fontSize;
    const measureAt=(size:number)=>documentFontMeasure(fonts,size);
    let measure=measureAt(fontSize);
    const color=heading?f.accentColor:role==="contact"?secondaryColor:textColor;
    const indent=heading&&f.template==="MODERN"?8:0;
    const strongRole=["section_heading","candidate_name","record_heading","salutation"].includes(role);
    let runs:StyledRun[]=[{text:line,style:strongRole?"bold":role==="record_title"?"italic":"regular"}];
    let wrapWidth=contentWidth-indent-WRAP_SAFETY;
    let lines:PlacedFragment[][]|undefined,lineBreakOffsets:readonly number[]|undefined;
    let bulletInfo:ProductDocumentParagraph["bullet"],datesInfo:ProductDocumentParagraph["dates"];
    let marker:Placed|undefined,dates:Placed|undefined;
    const textX=margin+indent;
    let lineX=textX;

    if(role==="bullet"&&bullet) {
      const markerIndent=fontSize*.6,textIndent=fontSize*1.8;
      const glyph=resumeBulletGlyph(bullet,character=>winAnsiCode(character)!==null);
      const markerText=bullet.separator?`${glyph} `:glyph;
      marker={text:markerText,x:margin+markerIndent,width:measure(markerText,"regular")};
      bulletInfo={marker:bullet.marker,separator:bullet.separator,markerIndent,textIndent,markerWidth:measure(glyph,"regular")};
      runs=[{text:bullet.body,style:"regular"}];
      lineX=margin+textIndent;
      wrapWidth=contentWidth-textIndent-WRAP_SAFETY;
    } else if(role==="record_heading"&&dated) {
      runs=[{text:dated.organization,style:"bold"},{text:dated.aside,style:"regular"}];
      const width=measure(dated.dates,"regular");
      dates={text:dated.dates,x:margin+contentWidth-width,width};
      datesInfo={separator:dated.separator,gap:datedRecordGap(dated),text:dated.dates};
      wrapWidth=contentWidth-width-fontSize*1.2-WRAP_SAFETY;
      lines=wrapRecordLead(runs[0]!,runs[1]!,wrapWidth,measure);
    } else if(role==="skill_group"&&skill) {
      runs=[{text:skill.label,style:"bold"},{text:skill.items,style:"regular"}];
    } else if(role==="contact") {
      // Prefer slightly smaller contact type when that keeps the whole line on one line.
      const floor=Math.max(8,Math.floor(f.fontSize*1.6)/2);
      for(let size=fontSize;size>=floor-1e-9;size-=.5) {
        if(measureAt(size)(line.replace(/\s+/gu," "),"regular")<=wrapWidth){fontSize=size;break;}
      }
      measure=measureAt(fontSize);
    }
    if(role==="contact"||(role==="record_heading"&&!dated)) {
      const separated=wrapSeparatedHeaderLine(line,runs[0]!.style,wrapWidth,measure);
      lines=separated.lines;lineBreakOffsets=separated.lineBreakOffsets;
    }
    lines??=wrapStyledRuns(runs,wrapWidth,measure);
    // DOCX breaks a wrapped organization line where the PDF does, so a right-tabbed date never
    // collides with a long lead in Word.
    if(dates&&lines.length>1)lineBreakOffsets=lineStartOffsets(runs.map(run=>run.text).join(""),lines);
    if(dates&&lines.length===1) {
      // The dates continue this baseline: keep a space so extracted text reads "Org Dates".
      const last=lines[0]!.at(-1)!,text=last.text+" ";
      lines[0]=[...lines[0]!.slice(0,-1),{...last,text,width:measure(text,last.style)}];
    }
    const paragraph:ProductDocumentParagraph=Object.freeze({id,role,fontSize,color,indent,runs:Object.freeze(runs.filter(run=>run.text).map(run=>Object.freeze({...run}))),
      ...(bulletInfo?{bullet:Object.freeze(bulletInfo)}:{}),...(datesInfo?{dates:Object.freeze(datesInfo)}:{}),...(lineBreakOffsets?{lineBreakOffsets:Object.freeze([...lineBreakOffsets])}:{})});
    paragraphs.push(paragraph);
    entries.push({kind:"paragraph",plan:{
      paragraph,sourceText:bullet&&role==="bullet"?`${marker!.text}${bullet.body}`:line,
      lines:lines.map(fragments=>({x:lineX,fragments})),marker,dates,lineHeight:lineHeightFor(fontSize),
      before:heading?(f.template==="COMPACT"?7:11):role==="record_heading"?5:0,
      after:heading?5:role==="record_heading"&&dated?1:3,
      ...(heading?{headingRule:f.template==="MODERN"?"left" as const:"bottom" as const}:{})
    }});
  }

  const heightOf=(plan:ParagraphPlan)=>plan.before+plan.lines.length*plan.lineHeight+plan.after;
  // Keep a section/record heading (and a record title) with the following record and first details.
  const keepWithNext=(index:number)=>{
    let height=0;
    for(const entry of entries.slice(index+1)) {
      if(entry.kind==="blank"){height+=blankGap;continue;}
      if(entry.plan.paragraph.role==="section_heading")break;
      height+=heightOf(entry.plan);
      if(!["record_heading","record_title"].includes(entry.plan.paragraph.role))break;
    }
    return height;
  };

  let page=layout.pages[0]!,y=margin;
  const nextPage=()=>{page={number:layout.pages.length+1,blocks:[]};layout.pages.push(page);y=margin;};
  for(const [index,entry] of entries.entries()) {
    if(entry.kind==="blank"){y+=blankGap;continue;}
    const plan=entry.plan,{paragraph}=plan;
    const keep=["section_heading","record_heading","record_title"].includes(paragraph.role)?keepWithNext(index):0;
    // Space after a paragraph need not fit at the foot of a page; the page break absorbs it.
    if(y+heightOf(plan)-plan.after+keep>pageHeight-margin&&page.blocks.length)nextPage();
    y+=plan.before;
    const block=(placed:Placed,style:TextStyle,lineY:number):ProductDocumentBlock=>({
      text:placed.text,sourceText:plan.sourceText,paragraphId:paragraph.id,role:paragraph.role,x:placed.x,y:lineY,width:placed.width,height:plan.lineHeight,
      fontSize:paragraph.fontSize,bold:style==="bold",...(style==="italic"?{italic:true as const}:{}),color:paragraph.color,
      ...(plan.headingRule?{headingRule:plan.headingRule}:{})
    });
    let first:{page:typeof page;y:number}|undefined;
    for(const line of plan.lines) {
      if(y+plan.lineHeight>pageHeight-margin&&page.blocks.length)nextPage();
      if(!first){first={page,y};if(plan.marker)page.blocks.push(block(plan.marker,"regular",y));}
      for(const fragment of line.fragments)page.blocks.push(block({text:fragment.text,x:line.x+fragment.x,width:fragment.width},fragment.style,y));
      y+=plan.lineHeight;
    }
    // Dates follow the whole organization text in reading order, drawn on its first line.
    if(plan.dates&&first)first.page.blocks.push(block(plan.dates,"regular",first.y));
    y+=plan.after;
  }

  // Balance only complete trailing sections; never reduce type or reorder facts.
  if(resume&&layout.pages.length>1) {
    const a=layout.pages.at(-2)!,b=layout.pages.at(-1)!;
    const bottom=(blocks:ProductDocumentBlock[])=>Math.max(...blocks.map(block=>block.y+block.height));
    let difference=Math.abs(bottom(a.blocks)-bottom(b.blocks)),chosen=-1;
    for(let i=1;i<a.blocks.length;i++) {
      const block=a.blocks[i]!;if(block.role!=="section_heading"||a.blocks[i-1]!.role==="section_heading")continue;
      const moved=bottom(a.blocks)-block.y,combined=moved+12+bottom(b.blocks)-margin;
      const candidate=Math.abs(bottom(a.blocks.slice(0,i))-margin-combined);
      if(combined<=pageHeight-margin*2&&candidate<difference){difference=candidate;chosen=i;}
    }
    if(chosen>=0){const first=a.blocks[chosen]!,moved=bottom(a.blocks)-first.y;b.blocks=[...a.blocks.slice(chosen).map(block=>({...block,y:block.y-first.y+margin})),...b.blocks.map(block=>({...block,y:block.y+moved+12}))];a.blocks=a.blocks.slice(0,chosen);}
  }
  return {layout,paragraphs:Object.freeze(paragraphs)};
}

export function buildProductDocumentLayout(input:ProductDocumentInput):ProductDocumentLayout {
  return buildProductDocument(input).layout;
}

// The text an export of this document draws, line for line: the source, except that a line laid
// out as a dated record heading leaves out the separator mark before its right-aligned dates
// ("Academy, Oct 2019" draws "Academy" and "Oct 2019"). Every other character, including a bullet's
// own comma before a date, is unchanged. Export verification compares extracted text against this.
export function productDocumentExportText(input:ProductDocumentInput) {
  const {paragraphs}=buildProductDocument(input);
  let id=0;
  return input.content.split(/\r?\n/u).map(raw=>!raw.trim()?raw:paragraphs[id++]!.dates?withoutDatedRecordSeparator(raw.trim()):raw).join("\n");
}
