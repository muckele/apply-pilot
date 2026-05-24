"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Save,
  Sparkles
} from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, ScoreBadge, SecondaryButton, StatusBadge } from "@/components/ui";

type PacketResumeOption = {
  id: string;
  title: string;
  atsCompatibility: number | null;
  jobFitScore: number | null;
  createdAt: string;
};

type PacketCoverLetterOption = {
  id: string;
  title: string;
  createdAt: string;
};

type PacketApplication = {
  id: string;
  status: string;
  resumeVersionId: string | null;
  coverLetterVersionId: string | null;
  dateApplied: string | null;
} | null;

type ApplyPacketBuilderProps = {
  job: {
    id: string;
    title: string;
    company: string;
    applyUrl: string;
    fitScore: number;
    recommendation: string;
    keyReason: string;
    hasFitAnalysis: boolean;
  };
  resumeVersions: PacketResumeOption[];
  coverLetters: PacketCoverLetterOption[];
  application: PacketApplication;
};

type ExportFormat = "docx" | "pdf";
type PendingAction = "match" | "resume" | "cover" | "packet" | "save" | "applied" | "export" | null;

function formatDate(value: string | null) {
  if (!value) return "Not recorded";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

async function parseJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string; [key: string]: unknown } | null;
}

async function runJsonPost(url: string, body?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await parseJson(response);

  if (!response.ok) {
    throw new Error(json?.error ?? "Action failed.");
  }

  return json;
}

async function downloadGeneratedFile(payload: {
  resumeVersionId?: string;
  documentId?: string;
  format: ExportFormat;
}) {
  const response = await fetch("/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const json = await parseJson(response);
    throw new Error(json?.error ?? "Export failed.");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `jobmatch-packet.${payload.format}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function StepPill({ label, complete }: { label: string; complete: boolean }) {
  return (
    <div
      className={`flex min-h-12 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        complete
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-slate-200 bg-slate-50 text-slate-600"
      }`}
    >
      <CheckCircle2 size={16} className={complete ? "text-emerald-600" : "text-slate-300"} aria-hidden="true" />
      <span className="font-medium">{label}</span>
    </div>
  );
}

export function ApplyPacketBuilder({
  job,
  resumeVersions,
  coverLetters,
  application
}: ApplyPacketBuilderProps) {
  const router = useRouter();
  const [selectedResumeId, setSelectedResumeId] = useState(application?.resumeVersionId ?? resumeVersions[0]?.id ?? "");
  const [selectedCoverId, setSelectedCoverId] = useState(application?.coverLetterVersionId ?? coverLetters[0]?.id ?? "");
  const [includeCoverLetter, setIncludeCoverLetter] = useState(
    Boolean(application?.coverLetterVersionId || coverLetters.length)
  );
  const [pending, setPending] = useState<PendingAction>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedResume = useMemo(
    () => resumeVersions.find((version) => version.id === selectedResumeId) ?? null,
    [resumeVersions, selectedResumeId]
  );
  const selectedCover = useMemo(
    () => coverLetters.find((document) => document.id === selectedCoverId) ?? null,
    [coverLetters, selectedCoverId]
  );
  const applied = application?.status === "APPLIED";
  const selectedResumeSaved = Boolean(
    application?.id && selectedResumeId && application.resumeVersionId === selectedResumeId
  );
  const selectedCoverSaved = !includeCoverLetter || Boolean(
    selectedCoverId && application?.coverLetterVersionId === selectedCoverId
  );
  const packetSaved = selectedResumeSaved && selectedCoverSaved;

  useEffect(() => {
    if (!resumeVersions.length) {
      setSelectedResumeId("");
      return;
    }

    if (!resumeVersions.some((version) => version.id === selectedResumeId)) {
      const applicationResumeExists = resumeVersions.some((version) => version.id === application?.resumeVersionId);
      setSelectedResumeId(applicationResumeExists ? application?.resumeVersionId ?? resumeVersions[0].id : resumeVersions[0].id);
    }
  }, [application?.resumeVersionId, resumeVersions, selectedResumeId]);

  useEffect(() => {
    if (!coverLetters.length) {
      setSelectedCoverId("");
      setIncludeCoverLetter(false);
      return;
    }

    if (!coverLetters.some((document) => document.id === selectedCoverId)) {
      const applicationCoverExists = coverLetters.some((document) => document.id === application?.coverLetterVersionId);
      setSelectedCoverId(applicationCoverExists ? application?.coverLetterVersionId ?? coverLetters[0].id : coverLetters[0].id);
    }
  }, [application?.coverLetterVersionId, coverLetters, selectedCoverId]);

  async function runJobAction(action: "match" | "resume" | "cover") {
    setPending(action);
    setMessage(null);
    if (action === "cover") {
      setIncludeCoverLetter(true);
    }

    const endpoint =
      action === "match"
        ? `/api/jobs/${job.id}/match`
        : action === "resume"
          ? `/api/jobs/${job.id}/tailored-resume`
          : `/api/jobs/${job.id}/cover-letter`;

    try {
      await runJsonPost(endpoint);
      setMessage(
        action === "match"
          ? "Match analysis updated."
          : action === "resume"
            ? "Tailored resume saved."
            : "Cover letter draft saved."
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  async function buildMissingDocuments() {
    setPending("packet");
    setMessage(null);

    try {
      if (!selectedResume) {
        await runJsonPost(`/api/jobs/${job.id}/tailored-resume`);
      }

      if (includeCoverLetter && !selectedCover) {
        await runJsonPost(`/api/jobs/${job.id}/cover-letter`);
      }

      setMessage(
        selectedResume && (!includeCoverLetter || selectedCover)
          ? "Packet documents are already available."
          : "Packet documents saved."
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not build packet.");
    } finally {
      setPending(null);
    }
  }

  async function updateApplication(status: "SAVED" | "APPLIED") {
    if (!selectedResumeId) {
      setMessage(
        status === "APPLIED"
          ? "Select a tailored resume before marking this job as applied."
          : "Select a tailored resume before saving this packet."
      );
      return;
    }

    if (includeCoverLetter && !selectedCoverId) {
      setMessage("Draft or select a cover letter before saving this packet with a cover letter.");
      return;
    }

    setPending(status === "APPLIED" ? "applied" : "save");
    setMessage(null);

    try {
      await runJsonPost("/api/applications", {
        jobPostingId: job.id,
        status,
        resumeVersionId: selectedResumeId || undefined,
        coverLetterVersionId: includeCoverLetter ? selectedCoverId || undefined : null,
        nextAction:
          status === "APPLIED"
            ? "Track recruiter response and schedule follow-up."
            : "Review the packet, apply manually, then mark applied."
      });
      setMessage(status === "APPLIED" ? "Applied status saved in CRM." : "Packet saved to CRM.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update CRM.");
    } finally {
      setPending(null);
    }
  }

  async function exportFile(kind: "resume" | "cover", format: ExportFormat) {
    const resumeVersionId = kind === "resume" ? selectedResumeId : undefined;
    const documentId = kind === "cover" ? selectedCoverId : undefined;

    if (!resumeVersionId && !documentId) {
      setMessage("Select a document before exporting.");
      return;
    }

    setPending("export");
    setMessage(null);

    try {
      await downloadGeneratedFile({ resumeVersionId, documentId, format });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 md:grid-cols-5">
        <StepPill label="Match" complete={job.hasFitAnalysis} />
        <StepPill label="Resume" complete={Boolean(selectedResume)} />
        <StepPill label={includeCoverLetter ? "Cover" : "Cover optional"} complete={!includeCoverLetter || Boolean(selectedCover)} />
        <StepPill label="CRM" complete={packetSaved} />
        <StepPill label="Applied" complete={applied} />
      </div>

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ScoreBadge score={job.fitScore} />
            <StatusBadge status={job.recommendation} />
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-700">{job.keyReason}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <SecondaryButton type="button" onClick={() => runJobAction("match")} disabled={Boolean(pending)}>
              {pending === "match" ? (
                <Loader2 className="mr-2 animate-spin" size={15} />
              ) : (
                <Sparkles className="mr-2" size={15} />
              )}
              Score match
            </SecondaryButton>
            <SecondaryButton type="button" onClick={buildMissingDocuments} disabled={Boolean(pending)}>
              {pending === "packet" ? (
                <Loader2 className="mr-2 animate-spin" size={15} />
              ) : (
                <FileText className="mr-2" size={15} />
              )}
              Build packet
            </SecondaryButton>
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-slate-200 p-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block text-xs font-medium text-slate-600">
              Resume
              <select
                value={selectedResumeId}
                onChange={(event) => setSelectedResumeId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                disabled={!resumeVersions.length}
              >
                {resumeVersions.length ? (
                  resumeVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.title}
                    </option>
                  ))
                ) : (
                  <option value="">No tailored resumes</option>
                )}
              </select>
              {selectedResume ? (
                <span className="mt-1 block text-xs text-slate-500">
                  {selectedResume.atsCompatibility ?? "-"}% ATS · {selectedResume.jobFitScore ?? "-"}% fit
                </span>
              ) : null}
            </label>

            <label className="block text-xs font-medium text-slate-600">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeCoverLetter}
                  onChange={(event) => setIncludeCoverLetter(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Include cover letter
              </span>
              <select
                value={selectedCoverId}
                onChange={(event) => setSelectedCoverId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                disabled={!includeCoverLetter || !coverLetters.length}
              >
                {coverLetters.length ? (
                  coverLetters.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.title}
                    </option>
                  ))
                ) : (
                  <option value="">No cover letters</option>
                )}
              </select>
              {selectedCover ? (
                <span className="mt-1 block text-xs text-slate-500">Created {formatDate(selectedCover.createdAt)}</span>
              ) : includeCoverLetter ? (
                <span className="mt-1 block text-xs text-slate-500">Build packet or draft cover will create one.</span>
              ) : null}
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <SecondaryButton type="button" onClick={() => runJobAction("resume")} disabled={Boolean(pending)}>
              {pending === "resume" ? (
                <Loader2 className="mr-2 animate-spin" size={15} />
              ) : (
                <FileText className="mr-2" size={15} />
              )}
              Tailor resume
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => runJobAction("cover")} disabled={Boolean(pending)}>
              {pending === "cover" ? (
                <Loader2 className="mr-2 animate-spin" size={15} />
              ) : (
                <Mail className="mr-2" size={15} />
              )}
              Draft cover
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => exportFile("resume", "docx")} disabled={!selectedResume || Boolean(pending)}>
              {pending === "export" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Download className="mr-2" size={15} />}
              Resume DOCX
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => exportFile("resume", "pdf")} disabled={!selectedResume || Boolean(pending)}>
              <Download className="mr-2" size={15} />
              Resume PDF
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => exportFile("cover", "docx")} disabled={!selectedCover || Boolean(pending)}>
              <Download className="mr-2" size={15} />
              Cover DOCX
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => exportFile("cover", "pdf")} disabled={!selectedCover || Boolean(pending)}>
              <Download className="mr-2" size={15} />
              Cover PDF
            </SecondaryButton>
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
        <div className="text-sm text-slate-700">
          <p className="font-semibold text-slate-950">{application?.status?.replaceAll("_", " ") ?? "Not saved"}</p>
          <p className="mt-1 text-xs text-slate-500">Applied date: {formatDate(application?.dateApplied ?? null)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton type="button" onClick={() => updateApplication("SAVED")} disabled={Boolean(pending)}>
            {pending === "save" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
            Save packet
          </SecondaryButton>
          <a
            href={job.applyUrl}
            target={job.applyUrl.startsWith("http") ? "_blank" : undefined}
            rel={job.applyUrl.startsWith("http") ? "noreferrer" : undefined}
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <ExternalLink className="mr-2" size={15} aria-hidden="true" />
            Open apply link
          </a>
          <PrimaryButton type="button" onClick={() => updateApplication("APPLIED")} disabled={Boolean(pending)}>
            {pending === "applied" ? (
              <Loader2 className="mr-2 animate-spin" size={15} />
            ) : (
              <CheckCircle2 className="mr-2" size={15} />
            )}
            I applied
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
