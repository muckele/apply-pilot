"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";

export type JobResumeVersionOption = {
  id: string;
  title: string;
  fullText: string;
  summary: string | null;
  atsCompatibility: number | null;
  jobFitScore: number | null;
  createdAt: string;
};

export type JobCoverLetterOption = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

type ExportFormat = "markdown" | "docx" | "pdf";

type SaveState = "idle" | "saving" | "exporting";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

async function downloadGeneratedFile(payload: { resumeVersionId?: string; documentId?: string; format: ExportFormat }) {
  const response = await fetch("/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(json?.error ?? "Export failed.");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `jobmatch-document.${payload.format}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function JobDocumentWorkspace({
  resumeVersions,
  coverLetters
}: {
  resumeVersions: JobResumeVersionOption[];
  coverLetters: JobCoverLetterOption[];
}) {
  const router = useRouter();
  const [selectedResumeId, setSelectedResumeId] = useState(resumeVersions[0]?.id ?? "");
  const [selectedCoverId, setSelectedCoverId] = useState(coverLetters[0]?.id ?? "");
  const selectedResume = useMemo(
    () => resumeVersions.find((version) => version.id === selectedResumeId) ?? null,
    [resumeVersions, selectedResumeId]
  );
  const selectedCover = useMemo(
    () => coverLetters.find((document) => document.id === selectedCoverId) ?? null,
    [coverLetters, selectedCoverId]
  );
  const [resumeText, setResumeText] = useState(selectedResume?.fullText ?? "");
  const [coverText, setCoverText] = useState(selectedCover?.content ?? "");
  const [resumeState, setResumeState] = useState<SaveState>("idle");
  const [coverState, setCoverState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!resumeVersions.length) {
      setSelectedResumeId("");
      setResumeText("");
      return;
    }

    if (!resumeVersions.some((version) => version.id === selectedResumeId)) {
      setSelectedResumeId(resumeVersions[0].id);
      setResumeText(resumeVersions[0].fullText);
    }
  }, [resumeVersions, selectedResumeId]);

  useEffect(() => {
    if (!coverLetters.length) {
      setSelectedCoverId("");
      setCoverText("");
      return;
    }

    if (!coverLetters.some((document) => document.id === selectedCoverId)) {
      setSelectedCoverId(coverLetters[0].id);
      setCoverText(coverLetters[0].content);
    }
  }, [coverLetters, selectedCoverId]);

  function chooseResume(id: string) {
    const next = resumeVersions.find((version) => version.id === id) ?? null;
    setSelectedResumeId(id);
    setResumeText(next?.fullText ?? "");
    setMessage(null);
  }

  function chooseCover(id: string) {
    const next = coverLetters.find((document) => document.id === id) ?? null;
    setSelectedCoverId(id);
    setCoverText(next?.content ?? "");
    setMessage(null);
  }

  async function saveResume() {
    if (!selectedResume) return;
    setResumeState("saving");
    setMessage(null);
    const response = await fetch(`/api/resume-versions/${selectedResume.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullText: resumeText })
    });
    setResumeState("idle");

    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(json?.error ?? "Could not save resume edits.");
      return;
    }

    setMessage("Resume edits saved.");
    router.refresh();
  }

  async function saveCoverLetter() {
    if (!selectedCover) return;
    setCoverState("saving");
    setMessage(null);
    const response = await fetch(`/api/generated-documents/${selectedCover.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: coverText })
    });
    setCoverState("idle");

    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(json?.error ?? "Could not save cover letter edits.");
      return;
    }

    setMessage("Cover letter edits saved.");
    router.refresh();
  }

  async function exportResume(format: ExportFormat) {
    if (!selectedResume) return;
    setResumeState("exporting");
    setMessage(null);
    try {
      await downloadGeneratedFile({ resumeVersionId: selectedResume.id, format });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setResumeState("idle");
    }
  }

  async function exportCoverLetter(format: ExportFormat) {
    if (!selectedCover) return;
    setCoverState("exporting");
    setMessage(null);
    try {
      await downloadGeneratedFile({ documentId: selectedCover.id, format });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setCoverState("idle");
    }
  }

  return (
    <div className="space-y-5 p-5">
      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      <section className="rounded-lg border border-slate-200">
        <div className="border-b border-slate-200 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Tailored resume</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Edit the selected resume draft before exporting or marking the job as applied.
              </p>
            </div>
            <select
              value={selectedResumeId}
              onChange={(event) => chooseResume(event.target.value)}
              className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 lg:w-72"
              disabled={!resumeVersions.length}
            >
              {resumeVersions.length ? (
                resumeVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.title}
                  </option>
                ))
              ) : (
                <option value="">No tailored resumes yet</option>
              )}
            </select>
          </div>
          {selectedResume ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
              <span>Created {formatDate(selectedResume.createdAt)}</span>
              {selectedResume.atsCompatibility ? <span>{selectedResume.atsCompatibility}% ATS compatible</span> : null}
              {selectedResume.jobFitScore ? <span>{selectedResume.jobFitScore}% job fit</span> : null}
            </div>
          ) : null}
        </div>
        <div className="space-y-3 p-4">
          <textarea
            value={resumeText}
            onChange={(event) => setResumeText(event.target.value)}
            rows={14}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-700"
            placeholder="Generate a tailored resume to preview and edit it here."
            disabled={!selectedResume}
          />
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={saveResume} disabled={!selectedResume || resumeState !== "idle"}>
              {resumeState === "saving" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
              Save edits
            </PrimaryButton>
            {(["markdown", "docx", "pdf"] as const).map((format) => (
              <SecondaryButton
                key={format}
                type="button"
                onClick={() => exportResume(format)}
                disabled={!selectedResume || resumeState !== "idle"}
              >
                {resumeState === "exporting" ? (
                  <Loader2 className="mr-2 animate-spin" size={15} />
                ) : (
                  <Download className="mr-2" size={15} />
                )}
                {format.toUpperCase()}
              </SecondaryButton>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200">
        <div className="border-b border-slate-200 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Cover letter</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Keep the letter specific, short, and reviewed before sending or pasting anywhere.
              </p>
            </div>
            <select
              value={selectedCoverId}
              onChange={(event) => chooseCover(event.target.value)}
              className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 lg:w-72"
              disabled={!coverLetters.length}
            >
              {coverLetters.length ? (
                coverLetters.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))
              ) : (
                <option value="">No cover letters yet</option>
              )}
            </select>
          </div>
          {selectedCover ? <p className="mt-3 text-xs text-slate-500">Created {formatDate(selectedCover.createdAt)}</p> : null}
        </div>
        <div className="space-y-3 p-4">
          <textarea
            value={coverText}
            onChange={(event) => setCoverText(event.target.value)}
            rows={12}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-700"
            placeholder="Generate a cover letter to preview and edit it here."
            disabled={!selectedCover}
          />
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={saveCoverLetter} disabled={!selectedCover || coverState !== "idle"}>
              {coverState === "saving" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
              Save edits
            </PrimaryButton>
            {(["markdown", "docx", "pdf"] as const).map((format) => (
              <SecondaryButton
                key={format}
                type="button"
                onClick={() => exportCoverLetter(format)}
                disabled={!selectedCover || coverState !== "idle"}
              >
                {coverState === "exporting" ? (
                  <Loader2 className="mr-2 animate-spin" size={15} />
                ) : (
                  <Download className="mr-2" size={15} />
                )}
                {format.toUpperCase()}
              </SecondaryButton>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
