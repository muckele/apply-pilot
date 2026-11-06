import { AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, LineRuleType, Packer, Paragraph, Tab, TabStopType, TextRun } from "docx";
import { PublicApiError } from "@/lib/api-errors";
import { winAnsiCode } from "@/lib/documents/document-typography";
import { buildProductDocument, type ProductDocumentBlock, type ProductDocumentInput, type ProductDocumentLayout, type ProductDocumentParagraph } from "@/lib/documents/product-document-layout";

// Standard PDF fonts support Windows-1252. Refuse unsupported glyphs rather than silently corrupting facts.
function pdfText(text:string) {
  let result="";
  for(const char of text) {
    const byte=winAnsiCode(char);
    if(byte===null)throw new PublicApiError("This PDF font cannot represent part of the document. Download DOCX to preserve the text.",422,{code:"DOCUMENT_PDF_GLYPH_UNSUPPORTED"});
    result+=byte>=128?"\\"+byte.toString(8).padStart(3,"0"):/[()\\]/u.test(char)?"\\"+char:char;
  }
  return result;
}
const rgb=(color:string)=>[1,3,5].map(i=>(parseInt(color.slice(i,i+2),16)/255).toFixed(3)).join(" ");
const fontResource=(block:ProductDocumentBlock)=>block.bold?"F2":block.italic?"F3":"F1";

function renderPdf(layout:ProductDocumentLayout) {
  const fonts=[layout.pdfFont,layout.pdfBoldFont,layout.pdfItalicFont];
  const firstPageId=3+fonts.length;
  const objects=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Kids [${layout.pages.map((_,i)=>`${firstPageId+i*2} 0 R`).join(" ")}] /Count ${layout.pages.length} >>`,...fonts.map(font=>`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`)];
  const resources=fonts.map((_,i)=>`/F${i+1} ${3+i} 0 R`).join(" ");
  for(const [i,page] of layout.pages.entries()) {
    const commands=page.blocks.flatMap(block=>{
      const text=["BT",`${rgb(block.color)} rg`,`/${fontResource(block)} ${block.fontSize} Tf`,`${block.x.toFixed(2)} ${(layout.pageHeight-block.y-block.fontSize).toFixed(2)} Td`,`(${pdfText(block.text)}) Tj`,"ET"];
      if(!block.headingRule)return text;
      const left=block.headingRule==="left",x=left?block.x-6:block.x,y=layout.pageHeight-block.y-block.height-1;
      return [...text,`${rgb(block.color)} RG`,left?"2 w":"0.7 w",`${x.toFixed(2)} ${y.toFixed(2)} m`,left?`${x.toFixed(2)} ${(y+block.height).toFixed(2)} l`:`${(layout.pageWidth-layout.margin).toFixed(2)} ${y.toFixed(2)} l`,"S"];
    }).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${layout.pageWidth} ${layout.pageHeight}] /Resources << /Font << ${resources} >> >> /Contents ${firstPageId+1+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
  }
  let bytes="%PDF-1.4\n";const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(bytes));bytes+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const offset=Buffer.byteLength(bytes);bytes+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(value=>`${String(value).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(bytes,"utf8");
}

const twips=(points:number)=>Math.round(points*20);
const BULLET_LIST="product-document-bullets";

// DOCX runs are the paragraph's exact source substrings; only weight, slant, tabs and breaks differ.
function docxRuns(paragraph:ProductDocumentParagraph,layout:ProductDocumentLayout) {
  const base={font:layout.fontFamily,size:Math.round(paragraph.fontSize*2),color:paragraph.color.slice(1)};
  const run=(text:string,style:"regular"|"bold"|"italic",extra:object={})=>new TextRun({...base,text,bold:style==="bold",...(style==="italic"?{italics:true}:{}),...extra});
  const runs:TextRun[]=[];
  if(paragraph.bullet&&!paragraph.bullet.separator) {
    // A marker written without a following space keeps exactly its source text; widened character
    // spacing, not an inserted character, carries the text to the hanging indent.
    const gap=paragraph.bullet.textIndent-paragraph.bullet.markerIndent-paragraph.bullet.markerWidth;
    runs.push(run(paragraph.bullet.marker,"regular",{characterSpacing:twips(Math.max(0,gap))}));
  }
  const texts=paragraph.runs.map(entry=>entry.text);
  if(paragraph.dates)texts[texts.length-1]+=paragraph.dates.separator;
  // Split runs where the layout started a new line; a break precedes each continuation line.
  const breaks=paragraph.lineBreakOffsets??[];
  let offset=0;
  paragraph.runs.forEach((entry,index)=>{
    const text=texts[index]!;
    const cuts=[0,...breaks.filter(cut=>cut>offset&&cut<offset+text.length).map(cut=>cut-offset),text.length];
    cuts.slice(1).forEach((end,part)=>{
      const start=cuts[part]!;
      runs.push(run(text.slice(start,end),entry.style,breaks.includes(offset+start)?{break:1}:{}));
    });
    offset+=text.length;
  });
  if(paragraph.dates) {
    const tab=paragraph.dates.separator.includes("\t")?[]:[new Tab()];
    runs.push(new TextRun({...base,children:[...tab,paragraph.dates.text]}));
  }
  return runs;
}

function renderDocx(layout:ProductDocumentLayout,paragraphs:readonly ProductDocumentParagraph[],input:ProductDocumentInput) {
  const contentWidth=layout.pageWidth-layout.margin*2;
  const children:Paragraph[]=[];
  const emitted=new Set<number>();
  const bulletIndent=paragraphs.find(paragraph=>paragraph.bullet)?.bullet;
  for(const [pageIndex,page] of layout.pages.entries()) {
    let bottom=layout.margin;
    for(const [index,block] of page.blocks.entries()) {
      if(emitted.has(block.paragraphId))continue;
      emitted.add(block.paragraphId);
      const paragraph=paragraphs[block.paragraphId]!;
      const blocks=page.blocks.filter(item=>item.paragraphId===block.paragraphId);
      const top=Math.min(...blocks.map(item=>item.y));
      const bullet=paragraph.bullet;
      children.push(new Paragraph({
        ...(paragraph.role==="section_heading"?{heading:HeadingLevel.HEADING_1}:paragraph.role==="record_heading"?{heading:HeadingLevel.HEADING_2}:{}),
        keepNext:["section_heading","record_heading","record_title"].includes(paragraph.role),
        children:docxRuns(paragraph,layout),
        pageBreakBefore:pageIndex>0&&index===0,
        ...(bullet?.separator?{numbering:{reference:BULLET_LIST,level:0}}:{}),
        indent:bullet?{left:twips(bullet.textIndent),hanging:twips(bullet.textIndent-bullet.markerIndent)}:{left:twips(paragraph.indent)},
        ...(paragraph.dates?{tabStops:[{type:TabStopType.RIGHT,position:twips(contentWidth)}]}:{}),
        spacing:{before:twips(Math.max(0,top-bottom)),after:0,line:twips(block.height),lineRule:LineRuleType.EXACT},
        ...(block.headingRule?{border:{[block.headingRule]:{style:BorderStyle.SINGLE,size:block.headingRule==="left"?12:4,color:block.color.slice(1),space:0}}}:{})
      }));
      bottom=Math.max(...blocks.map(item=>item.y+item.height));
    }
  }
  const listIndent=bulletIndent??{textIndent:input.resumeFormat.fontSize*1.8,markerIndent:input.resumeFormat.fontSize*.6};
  return Packer.toBuffer(new Document({
    numbering:{config:[{reference:BULLET_LIST,levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,
      style:{paragraph:{indent:{left:twips(listIndent.textIndent),hanging:twips(listIndent.textIndent-listIndent.markerIndent)}},run:{font:layout.fontFamily}}}]}]},
    styles:{default:{document:{run:{font:layout.fontFamily,size:input.resumeFormat.fontSize*2},paragraph:{spacing:{before:0,after:0,line:input.resumeFormat.fontSize*input.resumeFormat.lineSpacing/5,lineRule:LineRuleType.EXACT}}}}},
    sections:[{properties:{page:{size:{width:twips(layout.pageWidth),height:twips(layout.pageHeight)},margin:{top:twips(layout.margin),right:twips(layout.margin),bottom:twips(layout.margin),left:twips(layout.margin)}}},children}]
  }));
}

export async function renderProductDocument(input:ProductDocumentInput & {format:"pdf"|"docx"}) {
  // PDF choice is an export preference, never a DOCX font or approval setting. The PDF is always
  // measured with the exact font it embeds by name.
  if(input.format==="pdf")return renderPdf(buildProductDocument({...input,pdfFont:input.pdfFont??(input.resumeFormat.fontFamily==="GEORGIA"?"TIMES":"HELVETICA")}).layout);
  const {layout,paragraphs}=buildProductDocument({...input,pdfFont:undefined});
  return renderDocx(layout,paragraphs,input);
}
