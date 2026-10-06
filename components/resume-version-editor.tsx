"use client";

import { useState } from "react";
import { Download, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

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
  const [busy, setBusy] = useState<"save" | ExportFormat | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function updateFormat<Key extends keyof ResumeFormat>(key: Key, value: ResumeFormat[Key]) {
    setFormat((current) => ({ ...current, [key]: value }));
  }

  async function save() {
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

  async function exportDocument(exportFormat: ExportFormat) {
    setBusy(exportFormat);
    setMessage(null);
    const response = await fetch("/api/documents/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeVersionId: version.id, format: exportFormat })
    });

    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(json?.error ?? "Export failed.");
      setBusy(null);
      return;
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition");
    const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `${title}.${exportFormat}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setBusy(null);
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
            onChange={(event) => setTitle(event.target.value)}
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
            Font
            <select
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
            value={fullText}
            onChange={(event) => setFullText(event.target.value)}
            rows={28}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-3 font-mono text-sm leading-6 text-slate-700"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <PrimaryButton type="button" onClick={save} disabled={busy !== null}>
            {busy === "save" ? <Loader2 className="mr-2 animate-spin" size={16} /> : <Save className="mr-2" size={16} />}
            Save version
          </PrimaryButton>
          {(["docx", "pdf"] as const).map((exportFormat) => (
            <SecondaryButton key={exportFormat} type="button" onClick={() => exportDocument(exportFormat)} disabled={busy !== null}>
              {busy === exportFormat ? <Loader2 className="mr-2 animate-spin" size={16} /> : <Download className="mr-2" size={16} />}
              {exportFormat.toUpperCase()}
            </SecondaryButton>
          ))}
        </div>
      </section>

      <FormattedDocumentPreview text={fullText} title="Live preview" format={format} headingLevel={2} />
    </div>
  );
}
