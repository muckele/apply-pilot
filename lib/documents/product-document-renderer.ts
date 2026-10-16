import { BorderStyle, Document, HeadingLevel, LineRuleType, Packer, Paragraph, TextRun } from "docx";
import { PublicApiError } from "@/lib/api-errors";
import { buildProductDocumentLayout, type ProductDocumentInput, type ProductDocumentLayout } from "@/lib/documents/product-document-layout";

// Standard PDF fonts support Windows-1252. Refuse unsupported glyphs rather than silently corrupting facts.
function pdfText(text:string) {
  const extra="€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
  let result="";
  for(const char of text) {
    const code=char.codePointAt(0)!;
    const byte=code<=255?code:extra.includes(char)?128+extra.indexOf(char):-1;
    if(byte<0)throw new PublicApiError("This PDF font cannot represent part of the document. Download DOCX to preserve the text.",422,{code:"DOCUMENT_PDF_GLYPH_UNSUPPORTED"});
    result+=byte>=128?"\\"+byte.toString(8).padStart(3,"0"):/[()\\]/u.test(char)?"\\"+char:char;
  }
  return result;
}
const rgb=(color:string)=>[1,3,5].map(i=>(parseInt(color.slice(i,i+2),16)/255).toFixed(3)).join(" ");

function renderPdf(layout:ProductDocumentLayout) {
  const objects=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Kids [${layout.pages.map((_,i)=>`${5+i*2} 0 R`).join(" ")}] /Count ${layout.pages.length} >>`,`<< /Type /Font /Subtype /Type1 /BaseFont /${layout.pdfFont} /Encoding /WinAnsiEncoding >>`,`<< /Type /Font /Subtype /Type1 /BaseFont /${layout.pdfBoldFont} /Encoding /WinAnsiEncoding >>`];
  for(const [i,page] of layout.pages.entries()) {
    const commands=page.blocks.flatMap(block=>{
      const text=["BT",`${rgb(block.color)} rg`,`/${block.bold?"F2":"F1"} ${block.fontSize} Tf`,`${block.x.toFixed(2)} ${(layout.pageHeight-block.y-block.fontSize).toFixed(2)} Td`,`(${pdfText(block.text)}) Tj`,"ET"];
      if(!block.headingRule)return text;
      const left=block.headingRule==="left",x=left?block.x-6:block.x,y=layout.pageHeight-block.y-block.height-1;
      return [...text,`${rgb(block.color)} RG`,left?"2 w":"0.7 w",`${x.toFixed(2)} ${y.toFixed(2)} m`,left?`${x.toFixed(2)} ${(y+block.height).toFixed(2)} l`:`${(layout.pageWidth-layout.margin).toFixed(2)} ${y.toFixed(2)} l`,"S"];
    }).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${layout.pageWidth} ${layout.pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
  }
  let bytes="%PDF-1.4\n";const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(bytes));bytes+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const offset=Buffer.byteLength(bytes);bytes+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(value=>`${String(value).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(bytes,"utf8");
}

export async function renderProductDocument(input:ProductDocumentInput & {format:"pdf"|"docx"}) {
  // PDF choice is an export preference, never a DOCX font or approval setting.
  const layout=buildProductDocumentLayout(input.format==="docx"?{...input,pdfFont:undefined}:input);
  if(input.format==="pdf")return renderPdf(layout);
  const children:Paragraph[]=[];
  const emitted=new Set<number>();
  for(const [pageIndex,page] of layout.pages.entries()) {
    let bottom=layout.margin;
    for(const [index,block] of page.blocks.entries()) {
      if(emitted.has(block.paragraphId))continue;
      emitted.add(block.paragraphId);
      const paragraph=page.blocks.filter(item=>item.paragraphId===block.paragraphId);
      children.push(new Paragraph({
        ...(block.role==="section_heading"?{heading:HeadingLevel.HEADING_1}:block.role==="record_heading"?{heading:HeadingLevel.HEADING_2}: {}),
        keepNext:["section_heading","record_heading"].includes(block.role),
        children:[new TextRun({text:block.sourceText,font:layout.fontFamily,size:Math.round(block.fontSize*2),bold:block.bold,color:block.color.slice(1)})],
        pageBreakBefore:pageIndex>0&&index===0,
        indent:{left:Math.round((block.x-layout.margin)*20)},
        spacing:{before:Math.round(Math.max(0,block.y-bottom)*20),after:0,line:Math.round(block.height*20),lineRule:LineRuleType.EXACT},
        ...(block.headingRule?{border:{[block.headingRule]:{style:BorderStyle.SINGLE,size:block.headingRule==="left"?12:4,color:block.color.slice(1),space:0}}}: {})
      }));bottom=paragraph.at(-1)!.y+block.height;
    }
  }
  return Packer.toBuffer(new Document({styles:{default:{document:{run:{font:layout.fontFamily,size:input.resumeFormat.fontSize*2},paragraph:{spacing:{before:0,after:0,line:input.resumeFormat.fontSize*input.resumeFormat.lineSpacing/5,lineRule:LineRuleType.EXACT}}}}},sections:[{properties:{page:{size:{width:Math.round(layout.pageWidth*20),height:Math.round(layout.pageHeight*20)},margin:{top:Math.round(layout.margin*20),right:Math.round(layout.margin*20),bottom:Math.round(layout.margin*20),left:Math.round(layout.margin*20)}}},children}]}));
}
