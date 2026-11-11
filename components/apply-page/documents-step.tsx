"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, FileText, Loader2, Sparkles, XCircle } from "lucide-react";

import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import { fetchWithAiCostConfirmation, fetchWithApprovedAiCost } from "@/lib/ai/browser-request";
import { attachDocuments, ensureApplication } from "@/lib/applications/client";
import type { ApplyKitDocument } from "@/lib/apply-kit/apply-kit-view";
import { chooseAutoAttach, isReadyDocument } from "@/lib/apply-page/auto-attach";
import {
  documentCreationMaximumMicros,
  formatCentsCeiling,
  formatUsdMicros,
  stepMaximumMicros,
  type DocumentCreationQuote
} from "@/lib/jobs/document-creation-plan";
import type { GradeLetter } from "@/lib/jobs/grade";

// Step 3 of the Apply page: write the résumé (and cover letter) for this job, with the cost asked
// in the page, then attach the ready versions to the job's application. It never saves lines or
// re-scores; step 2 does that. Attaching sends no status, so the application's status and dates stay.

export type DocumentsStepProps = {
  jobId: string;
  // The job's application, if it has one. Without one, attaching first saves the job (SAVED).
  applicationId: string | null;
  quote: DocumentCreationQuote | null;
  generationAvailable: boolean;
  coverByDefault: boolean;
  // Newest first, as the Apply Kit loads them.
  resumes: ApplyKitDocument[];
  coverLetters: ApplyKitDocument[];
  // What the application actually has attached (not the Apply Kit's local picks).
  attached: { resumeId: string | null; coverId: string | null };
  letter: GradeLetter | null;
  // Set by the page while step 2 isn't done; both Write buttons stay off and this is shown.
  blockedReason?: string | null;
  // False once the application is past applying: what's attached then stays as it is.
  attachable?: boolean;
};

type WriteStep = "resume" | "cover";
type StepState = "pending" | "running" | "done" | "failed";
type Message = { tone: "success" | "error" | "info"; text: string };
type ErrorPayload = { error?: unknown; billingStatus?: unknown; actualCostMicros?: unknown } | null;

const BELOW_A = "Assisted Fill needs an A. You can still apply on your own with these documents.";
const WRITING_OFF = "Document writing is switched off on this server (no AI provider is configured).";
const CANCELED = "Canceled. Nothing was sent and nothing was charged.";

const ENDPOINTS: Record<WriteStep, string> = { resume: "tailored-resume", cover: "cover-letter" };
const STEP_LABELS: Record<WriteStep, string> = { resume: "Writing your tailored résumé", cover: "Writing your cover letter" };
const DONE_PHRASES: Record<WriteStep, string> = { resume: "Your résumé was created.", cover: "Your cover letter was created." };
const READY_MESSAGES = {
  both: "Your résumé and cover letter are ready to review below.",
  resume: "Your résumé is ready to review below.",
  cover: "Your cover letter is ready to review below."
} as const;

function errorText(json: ErrorPayload, fallback: string) {
  const parts = [typeof json?.error === "string" ? json.error : fallback];
  if (json?.billingStatus === "not_charged") parts.push("You weren't charged for this step.");
  if (json?.billingStatus === "uncertain") parts.push("The charge for this step is uncertain; check AI usage before trying again.");
  if (json?.billingStatus === "known" && typeof json.actualCostMicros === "number" && json.actualCostMicros >= 0) {
    parts.push(`Recorded cost: ${formatUsdMicros(json.actualCostMicros)}.`);
  }
  return parts.join(" ");
}

function writeLabel(base: string, steps: WriteStep[], quote: DocumentCreationQuote | null) {
  return quote ? `${base} · up to ${formatCentsCeiling(documentCreationMaximumMicros(steps, quote))}` : base;
}

// The newest version and the attached one stay in view; the rest fold under "Older versions".
function splitVersions(documents: ApplyKitDocument[], attachedId: string | null) {
  const newest = documents.reduce<ApplyKitDocument | null>(
    (best, document) => (!best || document.versionNumber > best.versionNumber ? document : best),
    null
  );
  const inView = (document: ApplyKitDocument) => document.id === newest?.id || document.id === attachedId;
  return { shown: documents.filter(inView), older: documents.filter((document) => !inView(document)) };
}

export function DocumentsStep({
  jobId,
  applicationId,
  quote,
  generationAvailable,
  coverByDefault,
  resumes,
  coverLetters,
  attached,
  letter,
  blockedReason = null,
  attachable = true
}: DocumentsStepProps) {
  const router = useRouter();
  const { confirm, confirmFn, dialog } = useInPageConfirm();
  const idPrefix = useId();
  const [includeCover, setIncludeCover] = useState(coverByDefault);
  const [running, setRunning] = useState<"write" | "coverOnly" | null>(null);
  const [progress, setProgress] = useState<Array<{ step: WriteStep; state: StepState }>>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);
  const writing = useRef(false);
  const attaching = useRef(false);
  // An application this step saved, until the refreshed page brings its id.
  const savedApplicationId = useRef<string | null>(null);
  // Ready documents already seen, so attaching runs on mount and whenever a document becomes ready
  // (a new version was written, or its review was confirmed), not on every refresh.
  const seenReady = useRef<Set<string> | null>(null);

  const steps: WriteStep[] = includeCover ? ["resume", "cover"] : ["resume"];
  const label = writeLabel(includeCover ? "Write my résumé and cover letter" : "Write my résumé", steps, quote);
  const coverOnlyLabel = writeLabel("Write my cover letter", ["cover"], quote);
  // A tailored résumé ready to use: then the cover letter can be written on its own, so a good
  // résumé isn't rewritten (or paid for) again.
  const hasCurrentResume = resumes.some((document) => document.exportReady);
  const reason = !generationAvailable ? WRITING_OFF : blockedReason;
  const canWrite = !reason && running === null;

  const resumePick = attachable ? chooseAutoAttach(resumes, attached.resumeId) : null;
  const coverPick = attachable ? chooseAutoAttach(coverLetters, attached.coverId) : null;
  const readyKey = JSON.stringify([...resumes, ...coverLetters].filter(isReadyDocument).map((document) => document.id).sort());

  const attach = useCallback(async (picks: { resumeVersionId?: string; coverLetterVersionId?: string }) => {
    if (attaching.current) return;
    attaching.current = true;
    try {
      let id = applicationId ?? savedApplicationId.current;
      if (!id) {
        id = (await ensureApplication(jobId)).id;
        savedApplicationId.current = id;
      }
      await attachDocuments(id, picks);
      setAttachMessage(null);
      router.refresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Something went wrong.";
      setAttachMessage(`Apply Pilot couldn't attach your documents to this application. ${detail}`);
    } finally {
      attaching.current = false;
    }
  }, [applicationId, jobId, router]);

  useEffect(() => {
    const ready = new Set<string>(JSON.parse(readyKey) as string[]);
    const previous = seenReady.current;
    const newlyReady = previous === null || [...ready].some((id) => !previous.has(id));
    // While an attach is running, keep this change unseen so the refresh after it tries again.
    if (newlyReady && attaching.current) return;
    seenReady.current = ready;
    if (!newlyReady || (!resumePick && !coverPick)) return;
    void attach({
      ...(resumePick ? { resumeVersionId: resumePick } : {}),
      ...(coverPick ? { coverLetterVersionId: coverPick } : {})
    });
  }, [readyKey, resumePick, coverPick, attach]);

  async function write(action: "write" | "coverOnly") {
    if (writing.current || !canWrite) return;
    const runSteps: WriteStep[] = action === "coverOnly" ? ["cover"] : steps;
    writing.current = true;
    setMessage(null);
    const completed: WriteStep[] = [];
    try {
      if (quote) {
        const approved = await confirm({
          title: action === "coverOnly" ? "Write my cover letter?" : includeCover ? "Write my résumé and cover letter?" : "Write my résumé?",
          body: `Sends your résumé facts and the lines you added to Google Gemini. Most it can cost: ${formatCentsCeiling(documentCreationMaximumMicros(runSteps, quote))}.`
        });
        if (!approved) {
          setMessage({ tone: "info", text: CANCELED });
          return;
        }
      }
      setRunning(action);
      setProgress(runSteps.map((step) => ({ step, state: "pending" })));
      const mark = (index: number, state: StepState) =>
        setProgress((current) => current.map((item, position) => (position === index ? { ...item, state } : item)));
      for (const [index, step] of runSteps.entries()) {
        mark(index, "running");
        const url = `/api/jobs/${jobId}/${ENDPOINTS[step]}`;
        // Each request still states its own maximum; a higher one is asked again, in the page.
        const response = quote
          ? await fetchWithApprovedAiCost(url, { method: "POST" }, stepMaximumMicros(step, quote), { confirm: confirmFn })
          : await fetchWithAiCostConfirmation(url, { method: "POST" }, { confirm: confirmFn });
        if (!response.ok) {
          const json = (await response.json().catch(() => null)) as ErrorPayload;
          throw new Error(errorText(json, `${STEP_LABELS[step]} failed.`));
        }
        completed.push(step);
        mark(index, "done");
      }
      const written = !runSteps.includes("resume") ? "cover" : runSteps.includes("cover") ? "both" : "resume";
      setMessage({ tone: "success", text: READY_MESSAGES[written] });
      router.refresh();
    } catch (error) {
      setProgress((current) => current.map((item) => (item.state === "running" ? { ...item, state: "failed" } : item)));
      const done = completed.map((step) => DONE_PHRASES[step]).join(" ");
      setMessage({ tone: "error", text: [done, error instanceof Error ? error.message : "Something went wrong."].filter(Boolean).join(" ") });
      if (completed.length) router.refresh();
    } finally {
      writing.current = false;
      setRunning(null);
    }
  }

  function chooseVersion(kind: "resume" | "cover", id: string) {
    void attach(kind === "resume" ? { resumeVersionId: id } : { coverLetterVersionId: id });
  }

  function versionRow(kind: "resume" | "cover", document: ApplyKitDocument, attachedId: string | null) {
    const titleId = `${idPrefix}-${document.id}`;
    return (
      <li key={document.id} className="job-version" data-version={document.id}>
        <span id={titleId} className="job-version-title">{document.title} · v{document.versionNumber}</span>
        <span className="job-hint">{document.statusLabel}</span>
        {document.id === attachedId ? (
          <span className="job-version-used" data-attached>Used for this application</span>
        ) : attachable && isReadyDocument(document) ? (
          <button type="button" className="job-link-button" aria-describedby={titleId} onClick={() => chooseVersion(kind, document.id)}>
            Use this version
          </button>
        ) : null}
      </li>
    );
  }

  function versions(kind: "resume" | "cover", documents: ApplyKitDocument[], attachedId: string | null) {
    if (!documents.length) return null;
    const { shown, older } = splitVersions(documents, attachedId);
    return (
      <section className="job-step" data-versions={kind} aria-labelledby={`${idPrefix}-${kind}-versions`}>
        <h3 id={`${idPrefix}-${kind}-versions`} className="job-step-title">{kind === "resume" ? "Your résumé" : "Your cover letter"}</h3>
        <ul className="job-versions">{shown.map((document) => versionRow(kind, document, attachedId))}</ul>
        {older.length ? (
          <details className="job-disclosure">
            <summary>Older versions ({older.length})</summary>
            <ul className="job-versions">{older.map((document) => versionRow(kind, document, attachedId))}</ul>
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <div className="job-tailor" data-documents-step>
      {letter !== "A" ? <p className="job-note" data-below-a>{BELOW_A}</p> : null}

      <section className="job-step">
        <p className="job-step-copy">
          Apply Pilot writes a résumé{includeCover ? " and cover letter" : ""} for this job using only facts from your résumé and
          the lines you saved in step 2. You review and edit them below. Nothing is sent to the employer.
        </p>
        <label className="job-check">
          <input type="checkbox" checked={includeCover} disabled={running !== null} onChange={(event) => { setMessage(null); setIncludeCover(event.target.checked); }} />
          Include a cover letter
        </label>
        <div className="job-create-row">
          <button type="button" className="job-button job-button-primary job-button-large" onClick={() => write("write")} disabled={!canWrite}>
            {running === "write" ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
            {label}
          </button>
        </div>
        {reason ? <p className="job-hint" data-blocked-reason>{reason}</p> : null}
        {hasCurrentResume ? (
          <div className="job-create-row" data-cover-only>
            <button type="button" className="job-button" onClick={() => write("coverOnly")} disabled={!canWrite}>
              {running === "coverOnly" ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
              {coverOnlyLabel}
            </button>
            <p className="job-hint">Keeps your current résumé.</p>
          </div>
        ) : null}
        {progress.length ? (
          <ol className="job-progress" aria-label="Progress">
            {progress.map(({ step, state }) => (
              <li key={step} data-state={state}>
                {state === "done" ? <CheckCircle2 size={16} aria-hidden="true" /> : state === "running" ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : state === "failed" ? <XCircle size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                <span>{STEP_LABELS[step]}</span>
                <span className="sr-only">{state === "done" ? " — done" : state === "running" ? " — in progress" : state === "failed" ? " — failed" : ""}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {dialog}
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`job-message job-message-${message.tone}`} data-documents-message>{message.text}</p>
      ) : null}

      {versions("resume", resumes, attached.resumeId)}
      {versions("cover", coverLetters, attached.coverId)}
      {attachMessage ? <p role="alert" className="job-message job-message-error" data-attach-message>{attachMessage}</p> : null}
    </div>
  );
}
