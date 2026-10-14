import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormattedDocumentPreview } from "@/components/formatted-document-preview";
import { realisticDocumentQualityPayload } from "@/evaluation/document-quality-career-fixture";
import { defaultResumeFormat } from "@/lib/documents/resume-format";
import { buildProductDocumentLayout } from "@/lib/documents/product-document-layout";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";

const content = realisticDocumentQualityPayload().resume!.rawText as string;
const normalize = (text:string) => text.replace(/[•]/gu, "-").replace(/\s+/gu," ").trim();
// PDF.js expects copying Uint8Array.slice semantics, not Buffer.slice views.
const readPdf = (bytes:Buffer) => pdf(new Uint8Array(bytes) as unknown as Buffer, {version:"v2.0.550"});

test("Georgia review discloses the direct PDF font while DOCX preserves the selected font", async () => {
  const resumeFormat={...defaultResumeFormat,fontFamily:"GEORGIA" as const};
  const input={artifactType:"RESUME" as const,content:"Synthetic Owner\nSUMMARY\nSource-backed experience.",resumeFormat};
  const html=renderToStaticMarkup(createElement(FormattedDocumentPreview,{text:input.content,title:"Selected document",format:resumeFormat}));
  assert.ok(html.includes("DOCX preserves Georgia. The current PDF export uses Times."));
  assert.match((await renderProductDocument({...input,format:"pdf"})).toString("latin1"),/BaseFont \/Times-Roman/u);
  const zip=await JSZip.loadAsync(await renderProductDocument({...input,format:"docx"}));
  assert.match(await zip.file("word/document.xml")!.async("string"),/w:ascii="Georgia"/u);
});

test("ordinary product preview, PDF and DOCX share complete ordered multi-job text and page breaks", async () => {
  const input={artifactType:"RESUME" as const,content,resumeFormat:defaultResumeFormat};
  const layout=buildProductDocumentLayout(input);
  assert.equal(layout.pages.length,2);
  assert.equal(normalize(layout.pages.flatMap(page=>page.blocks).map(block=>block.text).join(" ")),normalize(content));
  const docx=await renderProductDocument({...input,format:"docx"});
  assert.equal(normalize((await mammoth.extractRawText({buffer:docx})).value),normalize(content));
  const zip=await JSZip.loadAsync(docx);
  const xml=await zip.file("word/document.xml")!.async("string");
  assert.equal((xml.match(/<w:pageBreakBefore\/>/gu)||[]).length,layout.pages.length-1);
  const parsed=await readPdf(await renderProductDocument({...input,format:"pdf"}));
  assert.equal(parsed.numpages,layout.pages.length);
  assert.equal(normalize(parsed.text),normalize(content));
});

test("ordinary product layout honors custom formatting, long content and Western Unicode without shrinking or loss", async () => {
  const resumeFormat={template:"MODERN" as const,pageSize:"A4" as const,fontFamily:"GEORGIA" as const,accentColor:"#A1B2C3",fontSize:12,lineSpacing:150};
  const input={artifactType:"RESUME" as const,content:content.replace("Taylor Boundary","Renée O’Connor"),resumeFormat};
  const layout=buildProductDocumentLayout(input);
  assert.equal(layout.pageWidth,595);
  assert.equal(layout.pageHeight,842);
  assert.equal(layout.fontFamily,"Georgia");
  for(const page of layout.pages)for(const block of page.blocks) {
    assert.ok(block.fontSize>=resumeFormat.fontSize||block.role==="contact");
    assert.ok(block.y+block.height<=layout.pageHeight-layout.margin);
  }
  const parsed=await readPdf(await renderProductDocument({...input,format:"pdf"}));
  assert.match(parsed.text,/Renée O’Connor/u);
  const zip=await JSZip.loadAsync(await renderProductDocument({...input,format:"docx"}));
  const xml=await zip.file("word/document.xml")!.async("string");
  assert.match(xml,/w:w="11900" w:h="16840"/u);
  assert.match(xml,/w:ascii="Georgia"/u);
  assert.match(xml,/A1B2C3/u);
  assert.match(xml,/w:left w:val="single"/u);
});

test("wide PDF glyphs stay within the page and DOCX preserves continuous identifiers", async () => {
  const identifier="W".repeat(100);
  const input={artifactType:"RESUME" as const,content:"Synthetic Owner\nSUMMARY\n"+identifier,resumeFormat:defaultResumeFormat};
  const layout=buildProductDocumentLayout(input);
  const docx=await renderProductDocument({...input,format:"docx"});
  assert.ok((await mammoth.extractRawText({buffer:docx})).value.includes(identifier),"A continuous identifier must remain continuous in DOCX text.");
  let measured=0;
  await pdf(new Uint8Array(await renderProductDocument({...input,format:"pdf"})) as unknown as Buffer,{version:"v2.0.550",pagerender:async(page)=>{
    const result=await page.getTextContent();
    for(const item of result.items) {
      measured++;
      assert.ok(item.transform[4]+item.width<=layout.pageWidth-layout.margin+1,"Actual rendered PDF glyph width must fit the printable page.");
    }
    return "";
  }});
  assert.ok(measured>0);
});

test("actual PDF glyph geometry fits wide tokens and DOCX preserves continuous identifiers", async () => {
  const token="W".repeat(100),url="https://example.test/"+"W".repeat(100);
  const input={artifactType:"RESUME" as const,content:"Synthetic Owner\nSUMMARY\n"+token+"\n"+url,resumeFormat:defaultResumeFormat};
  const layout=buildProductDocumentLayout(input);
  const bytes=await renderProductDocument({...input,format:"pdf"});
  const measured:Array<{str:string;width:number;transform:number[]}>=[];
  await pdf(new Uint8Array(bytes) as unknown as Buffer,{version:"v2.0.550",pagerender:async (page:{getTextContent():Promise<{items:Array<{str:string;width:number;transform:number[]}>}>})=>{
    const {items}=await page.getTextContent();
    measured.push(...items);
    return items.map(item=>item.str).join(" ");
  }});
  assert.ok(measured.length>0);
  for(const item of measured)assert.ok(item.transform[4]!+item.width<=layout.pageWidth-layout.margin+1,"Actual PDF glyphs must fit the printable page.");
  const extracted=(await mammoth.extractRawText({buffer:await renderProductDocument({...input,format:"docx"})})).value;
  assert.ok(extracted.includes(token));assert.ok(extracted.includes(url));
});

test("bold at-sign runs stay within actual PDF printable bounds", async () => {
  const input={artifactType:"RESUME" as const,content:"@".repeat(100),resumeFormat:defaultResumeFormat};
  const layout=buildProductDocumentLayout(input);let overflow=false;
  await pdf(new Uint8Array(await renderProductDocument({...input,format:"pdf"})) as unknown as Buffer,{version:"v2.0.550",pagerender:async(page)=>{
    const {items}=await page.getTextContent();
    for(const item of items)if(item.transform[4]+item.width>layout.pageWidth-layout.margin+1)overflow=true;
    return "";
  }});
  assert.equal(overflow,false);
});
