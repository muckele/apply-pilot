"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

import { PdfFontChoice, ActualPdfPreview } from "@/components/pdf-export-options";
import { defaultPdfFont, type PdfFont } from "@/lib/documents/pdf-font";
import { FormattedDocumentPreview } from "@/components/formatted-document-preview";
import { PrimaryButton, SecondaryButton } from "@/components/ui";
import {
  type ResumeFontFamily,
  type ResumeFormat,
  type ResumePageSize,
  type ResumeTemplate
} from "@/lib/documents/resume-format";

type ResumeVersionEditorProps = {
  version: ResumeFormat & {
    id: string;
    title: string;
    fullText: string;
    jobLabel: string | null;
    evidenceCurrent?: boolean;
  };
};

type ExportFormat = "docx" | "pdf";

const fontLabels: Record<ResumeFontFamily, string> = {
  ARIAL: "Arial",
  CALIBRI: "Calibri",
  GEORGIA: "Georgia"
};

export function ResumeVersionEditor({ version }: ResumeVersionEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(version.title);
  const [fullText, setFullText] = useState(version.fullText);
  const [format, setFormat] = useState<ResumeFormat>({
    template: version.template,
    pageSize: version.pageSize,
    fontFamily: version.fontFamily,
    accentColor: version.accentColor,
    fontSize: version.fontSize,
    lineSpacing: version.lineSpacing
  });
  const [pdfFont, setPdfFont] = useState<PdfFont>(defaultPdfFont);
  const [busy, setBusy] = useState<"save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const dirty = title !== version.title || fullText !== version.fullText || Object.entries(format).some(([key,value]) => value !== version[key as keyof ResumeFormat]);
  function updateFormat<Key extends keyof ResumeFormat>(key: Key, value: ResumeFormat[Key]) {
    setFormat((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!dirty || busy !== null) return;
    setBusy("save");
    setMessage(null);
    const response = await fetch(`/api/resume-versions/${version.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, fullText, ...format })
    });
    setBusy(null);

    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(json?.error ?? "Could not save this resume version.");
      return;
    }

    setMessage("Resume version saved.");
    router.refresh();
  }


  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)]">
      <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Content and formatting</h2>
          <p className="mt-1 text-sm text-slate-500">Keep layouts single-column and review every claim before export.</p>
        </div>

        {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

        <label className="block text-sm font-medium text-slate-700">
          Version title
          <input
            value={title}
            onChange={(event) => { setTitle(event.target.value); }}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Layout
            <select
              value={format.template}
              onChange={(event) => updateFormat("template", event.target.value as ResumeTemplate)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <option value="CLASSIC">Classic</option>
              <option value="MODERN">Modern</option>
              <option value="COMPACT">Compact</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Page size
            <select
              value={format.pageSize}
              onChange={(event) => updateFormat("pageSize", event.target.value as ResumePageSize)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <option value="LETTER">US Letter</option>
              <option value="A4">A4</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            DOCX font
            <select
              aria-label="DOCX font"
              value={format.fontFamily}
              onChange={(event) => updateFormat("fontFamily", event.target.value as ResumeFontFamily)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              {Object.entries(fontLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Accent
            <span className="mt-1 flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3">
              <input
                aria-label="Accent color"
                type="color"
                value={format.accentColor}
                onChange={(event) => updateFormat("accentColor", event.target.value.toUpperCase())}
                className="h-6 w-8 border-0 bg-transparent p-0"
              />
              <span className="text-xs text-slate-500">{format.accentColor}</span>
            </span>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Font size: {format.fontSize} pt
            <input
              type="range"
              min="9"
              max="12"
              step="1"
              value={format.fontSize}
              onChange={(event) => updateFormat("fontSize", Number(event.target.value))}
              className="mt-2 w-full accent-teal-700"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Line spacing: {format.lineSpacing}%
            <input
              type="range"
              min="100"
              max="150"
              step="5"
              value={format.lineSpacing}
              onChange={(event) => updateFormat("lineSpacing", Number(event.target.value))}
              className="mt-2 w-full accent-teal-700"
            />
          </label>
        </div>

        <label className="block text-sm font-medium text-slate-700">
          Resume text
          <textarea
            aria-label="Resume text"
            value={fullText}
            onChange={(event) => { setFullText(event.target.value); }}
            rows={28}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-3 font-mono text-sm leading-6 text-slate-700"
          />
        </label>

        <PdfFontChoice value={pdfFont} disabled={busy === "save"} onChange={font => { setPdfFont(font); setMessage(null); }} />
        <p className="text-sm text-slate-500">PDF font applies to this review only. DOCX retains its selected font. Preview actual PDF before downloading; PDF and DOCX can have different line breaks.</p>
        {version.evidenceCurrent === false ? <p role="status">Regenerate this document from current reviewed evidence before exporting.</p> : null}
        {dirty ? <p role="status">Unsaved changes — save before exporting or previewing the actual PDF. Saving edits requires regeneration from reviewed evidence for job documents.</p> : null}
        <div className="flex flex-wrap gap-2">
          <PrimaryButton type="button" onClick={save} disabled={busy !== null || !dirty}>
            {busy === "save" ? <Loader2 className="mr-2 animate-spin" size={16} /> : <Save className="mr-2" size={16} />}
            Save version
          </PrimaryButton>

        </div>
      </section>

      <div className="min-w-0"><FormattedDocumentPreview text={fullText} title="DOCX layout guide" format={format} headingLevel={2} /><EditorDocumentExports key={JSON.stringify([version,title,fullText,format,pdfFont,busy])} id={version.id} title={title} pdfFont={pdfFont} eligible={!dirty && busy === null && version.evidenceCurrent !== false} /></div>
    </div>
  );
}

// A new saved identity or draft gets a fresh export controller; owner drafts stay above this boundary.
function EditorDocumentExports({ id, title, pdfFont, eligible }: { id: string; title: string; pdfFont: PdfFont; eligible: boolean }) {
  const [busy,setBusy] = useState<"preview" | ExportFormat | null>(null);
  const [message,setMessage] = useState<string | null>(null), [pdfUrl,setPdfUrl] = useState<string | null>(null);
  const alive=useRef(true), url=useRef<string | null>(null), abort=useRef<AbortController | null>(null);
  useEffect(()=>{
    alive.current=true;
    const life=alive,request=abort,objectUrl=url;
    return ()=>{life.current=false;request.current?.abort();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};
  },[]);
  async function exportDocument(exportFormat: ExportFormat, preview=false) {
    if(!eligible||busy!==null||abort.current)return;
    const controller=new AbortController();abort.current=controller;setBusy(preview?"preview":exportFormat);setMessage(null);
    try {
      const response=await fetch("/api/documents/export",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({resumeVersionId:id,format:exportFormat,...(exportFormat==="pdf"?{pdfFont}:{})}),signal:controller.signal});
      if(!response.ok){const json=await response.json().catch(()=>null);throw new Error(json?.error??"Export failed.");}
      const blob=await response.blob();if(!alive.current||controller.signal.aborted)return;
      const objectUrl=URL.createObjectURL(blob);
      if(preview){if(url.current)URL.revokeObjectURL(url.current);url.current=objectUrl;setPdfUrl(objectUrl);}
      else {const link=document.createElement("a");link.href=objectUrl;link.download=response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]??`${title}.${exportFormat}`;link.click();URL.revokeObjectURL(objectUrl);}
    }catch(error){if(alive.current&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:"Export unavailable.");}
    finally{if(alive.current){setBusy(null);abort.current=null;}}
  }
  return <div>
    {message?<p role="status">{message}</p>:null}
    <div className="application-background-actions">
      <SecondaryButton type="button" onClick={()=>exportDocument("pdf",true)} disabled={!eligible||busy!==null}>Preview actual PDF</SecondaryButton>
      {(["docx","pdf"] as const).map(format=><SecondaryButton key={format} type="button" onClick={()=>exportDocument(format)} disabled={!eligible||busy!==null}><Download className="mr-2" size={16}/>{format.toUpperCase()}</SecondaryButton>)}
    </div>
    {pdfUrl?<ActualPdfPreview url={pdfUrl} font={pdfFont}/>:null}
  </div>;
}
