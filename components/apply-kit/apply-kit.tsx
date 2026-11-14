"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  ShieldAlert,
  Sparkles
} from "lucide-react";

import {
  ApplyRecordedNotice,
  ApplyReturnDeclinedNotice,
  ApplyReturnWindow,
  appliedErrorMessage,
  recordApplicationOpened,
  useApplyReturnAnswer
} from "@/components/apply-kit/apply-return-card";
import { CopyButton } from "@/components/apply-kit/copy-button";
import { DocumentReviewPanel } from "@/components/document-review-panel";
import { Panel, PanelHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { fetchWithAiConsent } from "@/lib/ai/browser-request";
import { aiErrorText } from "@/lib/apply-page/ai-error-text";
import { prefillEffortMinutes } from "@/lib/applications/apply-return";
import { MAX_EFFORT_MINUTES, parseEffortMinutesInput } from "@/lib/applications/self-reported-effort";
import type { ApplyKitDocument, ApplyKitView } from "@/lib/apply-kit/apply-kit-view";

// Apply Kit (WP1.5): everything needed to apply to this job by hand, with no browser companion.
// Apply Pilot never fills or submits the employer's form here; the user opens it in a new tab,
// submits it, then records "I applied", which freezes exactly which document versions were sent.
// When they come back from that tab, "Did you apply?" asks whether they submitted it; only their
// own "Yes" plus the confirmation below records it as applied (D027).

const ANSWER_VAULT_HREF = "/settings/application-answers";

type ExportFormat = "docx" | "pdf";
type Busy = { action: "export" | "generate" | "applied"; key: string } | null;

function shortHash(hash: string) {
  return hash.slice(0, 12);
}

function isoDate(value: string | null) {
  return value ? value.slice(0, 10) : "not recorded";
}

function statusTone(document: ApplyKitDocument) {
  if (document.exportReady) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-amber-300 bg-amber-50 text-amber-900";
}

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
}

async function downloadDocument(document: ApplyKitDocument, format: ExportFormat) {
  const response = await fetch("/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(document.kind === "RESUME" ? { resumeVersionId: document.id } : { documentId: document.id }),
      format
    })
  });
  if (!response.ok) {
    const json = await readJson(response);
    throw new Error(json?.error ?? "Download failed.");
  }
  const blob = await response.blob();
  const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/u)?.[1] ?? `document.${format}`;
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ReadableLines({ document }: { document: ApplyKitDocument }) {
  return (
    <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-800" data-kit-document-text>
      {document.review.segments.map((segment) => (
        <p key={segment.lineIndex} data-line-origin={segment.origin}>
          {segment.text}
          {segment.origin === "USER_EDIT" ? (
            <span data-edit-marker className="ml-2 inline-block rounded border border-dashed border-slate-400 px-1.5 align-middle text-xs text-slate-600">your edit</span>
          ) : null}
        </p>
      ))}
    </div>
  );
}

function DocumentSlot({
  kind,
  documents,
  selectedId,
  onSelect,
  jobId,
  generation,
  busy,
  onDownload,
  onGenerate,
  includeControl
}: {
  kind: "RESUME" | "COVER_LETTER";
  documents: ApplyKitDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  jobId: string;
  generation: ApplyKitView["generation"];
  busy: Busy;
  onDownload: (document: ApplyKitDocument, format: ExportFormat) => void;
  onGenerate: (kind: "RESUME" | "COVER_LETTER") => void;
  includeControl?: React.ReactNode;
}) {
  const label = kind === "RESUME" ? "Résumé" : "Cover letter";
  const slug = kind === "RESUME" ? "resume" : "cover-letter";
  const document = documents.find((item) => item.id === selectedId) ?? null;
  const generating = busy?.action === "generate" && busy.key === kind;
  const generateButton = (text: string) => (
    <SecondaryButton type="button" onClick={() => onGenerate(kind)} disabled={!generation.available || Boolean(busy)} data-generate={slug}>
      {generating ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : <Sparkles className="mr-2" size={15} aria-hidden="true" />}
      {text}
    </SecondaryButton>
  );

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4" data-kit-document={slug} aria-labelledby={`kit-${slug}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`kit-${slug}-title`} className="text-sm font-semibold text-slate-950">{label}</h3>
        {document ? (
          <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusTone(document)}`} data-document-status={document.status}>
            {document.statusLabel}
          </span>
        ) : null}
      </div>

      {!document ? (
        <div className="space-y-2 text-sm text-slate-700" data-empty-document={slug}>
          <p>No tailored {kind === "RESUME" ? "résumé" : "cover letter"} for this job yet.</p>
          {generateButton(kind === "RESUME" ? "Generate tailored résumé" : "Generate cover letter")}
          {generation.reason ? <p className="text-xs leading-5 text-slate-500" data-generation-reason>{generation.reason}</p> : null}
          {!generation.hasMasterResume ? <Link href="/resumes" className="text-xs font-semibold text-brand-700 underline">Upload your master résumé</Link> : null}
          {kind === "COVER_LETTER" ? <p className="text-xs text-slate-500">A cover letter is optional for many applications.</p> : null}
        </div>
      ) : (
        <>
          {documents.length > 1 ? (
            <label className="block text-xs font-medium text-slate-600">
              Version
              <select
                value={document.id}
                onChange={(event) => onSelect(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              >
                {documents.map((item) => (
                  <option key={item.id} value={item.id}>v{item.versionNumber} · {item.statusLabel} · {isoDate(item.createdAt)}</option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="text-sm text-slate-800">
            <span className="font-semibold">v{document.versionNumber}</span> · {document.title}
          </p>
          <p className="text-xs leading-5 text-slate-600">{document.statusDetail}</p>
          <p className="font-mono text-xs text-slate-500">hash {shortHash(document.contentHash)}…</p>

          <div className="flex flex-wrap gap-2">
            {(["docx", "pdf"] as const).map((format) => (
              <SecondaryButton
                key={format}
                type="button"
                onClick={() => onDownload(document, format)}
                disabled={!document.exportReady || Boolean(busy)}
                data-download={`${slug}-${format}`}
              >
                {busy?.action === "export" && busy.key === `${document.id}:${format}`
                  ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" />
                  : <Download className="mr-2" size={15} aria-hidden="true" />}
                Download {format.toUpperCase()}
              </SecondaryButton>
            ))}
            <Link href={document.editorHref} className="inline-flex items-center rounded-lg px-2 py-2 text-sm font-semibold text-brand-700 underline">
              Open in editor
            </Link>
          </div>

          {document.readinessState === "EDITED_NEEDS_REVIEW" || document.readinessState === "LEGACY_REVIEW_REQUIRED" ? (
            <details open id={`review-${slug}`} className="rounded-lg border border-amber-200 bg-amber-50 p-3 [&_button]:mt-2 [&_button]:rounded-lg [&_button]:border [&_button]:border-amber-300 [&_button]:bg-white [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm [&_button]:font-semibold" data-inline-review={slug}>
              <summary className="cursor-pointer text-sm font-semibold text-amber-900">Review now</summary>
              <div className="mt-3 space-y-3">
                {document.readinessState === "LEGACY_REVIEW_REQUIRED" ? <ReadableLines document={document} /> : null}
                <DocumentReviewPanel kind={kind === "RESUME" ? "resume" : "cover"} documentId={document.id} review={document.review} disabled={Boolean(busy)} />
              </div>
            </details>
          ) : null}
          {document.readinessState === "REVIEW_OUTDATED" ? (
            <p className="text-sm text-amber-900" id={`review-${slug}`}>
              <Link href={document.editorHref} className="font-semibold underline">Open the editor and save it again</Link> to refresh its review.
            </p>
          ) : null}
          {document.status === "NEEDS_REGENERATION" ? (
            <div className="space-y-2" id={`review-${slug}`}>
              {generateButton("Generate a new version")}
              {generation.reason ? <p className="text-xs leading-5 text-slate-500" data-generation-reason>{generation.reason}</p> : null}
              <p className="text-xs text-slate-500">
                Or <Link href={`/jobs/${jobId}`} className="underline">review the evidence on the job page</Link> first.
              </p>
            </div>
          ) : null}
          {includeControl}
        </>
      )}
    </section>
  );
}

type ReturnMoment = { openedAt: number; returnedAt: number };

export function ApplyKit({
  view,
  answeredYes = false,
  beforeAiRun
}: {
  view: ApplyKitView;
  answeredYes?: boolean;
  // The Apply page's one-time Gemini notice; false means the user declined, and nothing is sent.
  beforeAiRun: () => Promise<boolean>;
}) {
  const router = useRouter();
  const [resumeId, setResumeId] = useState(view.selectedResumeId);
  const [coverId, setCoverId] = useState(view.selectedCoverLetterId ?? view.coverLetters[0]?.id ?? null);
  const [includeCover, setIncludeCover] = useState(view.selectedCoverLetterId !== null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [attested, setAttested] = useState(false);
  const [appliedError, setAppliedError] = useState<{ text: string; fixHref: string | null } | null>(null);
  const [effortInput, setEffortInput] = useState("");
  const [effortPrefilled, setEffortPrefilled] = useState<number | null>(null);
  // "Did you apply?": an unanswered opened moment from the server (after a reload, the next day or
  // another device), or a live return to this tab after the user opened the application here.
  const pending = view.canRecordApplied ? view.applyReturn.pending : null;
  // Arriving from the job page's "Choose what I sent", the window is skipped for the confirmation.
  const [dismissedOpenedEventId, setDismissedOpenedEventId] = useState<string | null>(answeredYes && pending ? pending.openedEventId : null);
  const [awaitingReturn, setAwaitingReturn] = useState(false);
  const [liveReturn, setLiveReturn] = useState<ReturnMoment | null>(null);
  const awaitingRef = useRef<{ openedAt: number; away: boolean } | null>(null);
  const shownAtRef = useRef<number | null>(null);
  const applyReturn = useApplyReturnAnswer(view.job.id);

  const resume = view.resumes.find((item) => item.id === resumeId) ?? null;
  const cover = includeCover ? view.coverLetters.find((item) => item.id === coverId) ?? null : null;
  const blockers = [
    resume && !resume.exportReady ? { text: `Résumé v${resume.versionNumber} needs attention before it can be recorded as sent.`, href: "#review-resume" } : null,
    cover && !cover.exportReady ? { text: `Cover letter v${cover.versionNumber} needs attention. Review it, or untick "Include this cover letter".`, href: "#review-cover-letter" } : null
  ].filter((item): item is { text: string; href: string } => item !== null);
  const effort = parseEffortMinutesInput(effortInput);
  const resumedPrompt = pending && pending.openedEventId !== dismissedOpenedEventId && !awaitingReturn ? pending : null;
  const showReturnCard = !confirming && (liveReturn !== null || resumedPrompt !== null);

  // The return trigger: after an open from this tab, the page must first be left (hidden or
  // blurred) and then come back into view before the question is asked.
  useEffect(() => {
    const markAway = () => {
      if (awaitingRef.current) awaitingRef.current.away = true;
    };
    const maybeReturn = () => {
      const awaiting = awaitingRef.current;
      if (!awaiting || !awaiting.away || document.visibilityState === "hidden") return;
      awaitingRef.current = null;
      setAwaitingReturn(false);
      setLiveReturn({ openedAt: awaiting.openedAt, returnedAt: Date.now() });
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? markAway() : maybeReturn());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", markAway);
    window.addEventListener("focus", maybeReturn);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", markAway);
      window.removeEventListener("focus", maybeReturn);
    };
  }, []);

  // An unanswered question shown on load counts as "coming back" when it first appears.
  useEffect(() => {
    if (resumedPrompt && shownAtRef.current === null) shownAtRef.current = Date.now();
  }, [resumedPrompt]);

  // Arriving from the job page's "Choose what I sent" (its one-click Yes was refused): go straight
  // to the full confirmation.
  const answeredYesHandled = useRef(false);
  useEffect(() => {
    if (!answeredYes || answeredYesHandled.current || !pending) return;
    answeredYesHandled.current = true;
    setDismissedOpenedEventId(pending.openedEventId);
    startConfirming(prefillEffortMinutes(new Date(pending.openedAt), new Date()));
  }, [answeredYes, pending]);

  function startConfirming(prefill: number | null) {
    setConfirming(true);
    setAttested(false);
    setAppliedError(null);
    setEffortInput(prefill === null ? "" : String(prefill));
    setEffortPrefilled(prefill);
  }

  function handleOpenApplication() {
    if (!view.canRecordApplied) return;
    awaitingRef.current = { openedAt: Date.now(), away: false };
    setAwaitingReturn(true);
    setLiveReturn(null);
    applyReturn.clearError();
    const openedAt = awaitingRef.current.openedAt;
    void recordApplicationOpened(view.job.id).then((result) => {
      if (result === "failed") {
        setMessage("Apply Pilot could not save that you opened this application, so it may not ask about it on your other devices.");
      } else if (result === "nothing-to-ask") {
        // Already recorded past "I applied" elsewhere: drop this open's question, live or awaited.
        if (awaitingRef.current?.openedAt === openedAt) {
          awaitingRef.current = null;
          setAwaitingReturn(false);
        }
        setLiveReturn((current) => (current?.openedAt === openedAt ? null : current));
        router.refresh();
      }
    });
  }

  function returnMoment(): ReturnMoment | null {
    if (liveReturn) return liveReturn;
    if (!resumedPrompt) return null;
    return { openedAt: new Date(resumedPrompt.openedAt).getTime(), returnedAt: shownAtRef.current ?? Date.now() };
  }

  function closeReturnCard() {
    setLiveReturn(null);
    shownAtRef.current = null;
    if (pending) setDismissedOpenedEventId(pending.openedEventId);
    applyReturn.clearError();
  }

  // One click: "Yes, I applied" records Applied with the documents attached to the application.
  async function answerYes() {
    if (await applyReturn.recordApplied()) {
      closeReturnCard();
      setRecorded(true);
    }
  }

  // After a refused "Yes": the full confirmation, to choose the documents (and minutes) by hand.
  function chooseWhatISent() {
    const moment = returnMoment();
    closeReturnCard();
    startConfirming(moment ? prefillEffortMinutes(new Date(moment.openedAt), new Date(moment.returnedAt)) : null);
    requestAnimationFrame(() => window.document.getElementById("record-applied")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  async function answerNotApplying() {
    if (await applyReturn.send("NOT_APPLYING")) {
      closeReturnCard();
      setMessage("Moved out of your active applications.");
    }
  }

  async function undoNotApplying() {
    if (await applyReturn.send("UNDO_NOT_APPLYING")) {
      setDismissedOpenedEventId(null);
      setMessage("Undone. The job is back in your active applications.");
    }
  }

  async function handleDownload(document: ApplyKitDocument, format: ExportFormat) {
    setBusy({ action: "export", key: `${document.id}:${format}` });
    setMessage(null);
    try {
      await downloadDocument(document, format);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerate(kind: "RESUME" | "COVER_LETTER") {
    setBusy({ action: "generate", key: kind });
    setMessage(null);
    try {
      if (!(await beforeAiRun())) {
        setMessage("Nothing was sent.");
        return;
      }
      // One click, no price or cost question (D037): the user agreed once to what goes to Gemini.
      const response = await fetchWithAiConsent(
        `/api/jobs/${view.job.id}/${kind === "RESUME" ? "tailored-resume" : "cover-letter"}`,
        { method: "POST" }
      );
      if (!response.ok) {
        const json = await readJson(response);
        throw new Error(aiErrorText(json, "Generation failed. Nothing was saved."));
      }
      setMessage(kind === "RESUME" ? "Tailored résumé saved. Review it before you use it." : "Cover letter saved. Review it before you use it.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Generation failed. Nothing was saved.");
    } finally {
      setBusy(null);
    }
  }

  async function recordApplied() {
    if (!attested || blockers.length || busy || !effort.ok) return;
    setBusy({ action: "applied", key: "applied" });
    setAppliedError(null);
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobPostingId: view.job.id,
          status: "APPLIED",
          ...(resume ? { resumeVersionId: resume.id, expectedResumeContentHash: resume.contentHash } : {}),
          coverLetterVersionId: cover ? cover.id : null,
          ...(cover ? { expectedCoverLetterContentHash: cover.contentHash } : {}),
          ...(effort.minutes !== null ? { effortMinutes: effort.minutes } : {})
        })
      });
      if (!response.ok) {
        const json = await readJson(response);
        const text = appliedErrorMessage(json?.code, json?.error ?? "Could not record this application.");
        setAppliedError({ text, fixHref: response.status === 409 ? "#step-3" : null });
        if (response.status === 409) router.refresh();
        return;
      }
      setConfirming(false);
      setMessage("Recorded as applied. Your tracker now shows exactly which documents you sent.");
      router.refresh();
    } catch {
      setAppliedError({ text: "Could not reach Apply Pilot. Nothing was recorded; try again.", fixHref: null });
    } finally {
      setBusy(null);
    }
  }

  const sentLine = (summary: NonNullable<ApplyKitView["sent"]>["resume"], noun: string) =>
    summary ? `${noun} v${summary.versionNumber} (${summary.shortHash}…)` : `no ${noun}`;

  return (
    <div className="space-y-6" data-apply-kit>
      {showReturnCard ? (
        <ApplyReturnWindow
          company={view.job.company}
          onYes={() => { void answerYes(); }}
          onNotYet={closeReturnCard}
          onNotApplying={answerNotApplying}
          busy={applyReturn.busy}
          error={applyReturn.error}
          choose={applyReturn.yesRefused ? { onClick: chooseWhatISent } : null}
        />
      ) : null}
      {recorded ? <ApplyRecordedNotice variant="kit" /> : null}
      {view.applyReturn.declined ? (
        <ApplyReturnDeclinedNotice variant="kit" onUndo={undoNotApplying} busy={applyReturn.busy !== null} error={applyReturn.error} />
      ) : null}
      {view.job.notice && !view.applyReturn.declined ? (
        <p
          role="status"
          className={`flex gap-2 rounded-lg border px-3 py-2 text-sm ${view.job.notice.tone === "warning" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}
          data-job-notice
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {view.job.notice.text}
        </p>
      ) : null}
      {message ? <p role="status" className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700" data-kit-message>{message}</p> : null}

      <Panel>
        <PanelHeader title="1. Documents" description="Download the exact files you will upload. Edited documents are used only after you confirm their changed facts." />
        <div id="documents" className="grid gap-4 p-5 lg:grid-cols-2">
          <DocumentSlot
            kind="RESUME"
            documents={view.resumes}
            selectedId={resumeId}
            onSelect={setResumeId}
            jobId={view.job.id}
            generation={view.generation}
            busy={busy}
            onDownload={handleDownload}
            onGenerate={handleGenerate}
          />
          <DocumentSlot
            kind="COVER_LETTER"
            documents={view.coverLetters}
            selectedId={coverId}
            onSelect={(id) => { setCoverId(id); setIncludeCover(true); }}
            jobId={view.job.id}
            generation={view.generation}
            busy={busy}
            onDownload={handleDownload}
            onGenerate={handleGenerate}
            includeControl={
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <input type="checkbox" checked={includeCover} onChange={(event) => setIncludeCover(event.target.checked)} className="h-4 w-4 rounded border-slate-300" data-include-cover />
                Include this cover letter in my application
              </label>
            }
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="2. Answers" description="Copy your saved answers into the employer's form. Edit them in your Answer Vault." />
        <div className="space-y-5 p-5" data-kit-answers>
          <p className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
            <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            Apply Pilot never answers work authorization, sponsorship, salary, demographic, disability, veteran, criminal history or legal questions for you, and never sends them to an AI model.
          </p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {view.answers.common.map((question) => (
              <li key={question.id} className="space-y-2 px-4 py-3" data-common-question={question.id} data-answer-status={question.status}>
                <p className="text-sm font-medium text-slate-950">{question.question}</p>
                {question.status === "SAVED" ? question.answers.map((answer) => (
                  <div key={answer.id} className="flex items-start justify-between gap-3">
                    <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-slate-700">{answer.answer}</p>
                    <CopyButton value={answer.answer} label={question.question} />
                  </div>
                )) : null}
                {question.status === "NOT_SAVED" ? (
                  <p className="text-xs text-slate-500">
                    Not in your Answer Vault. <Link href={ANSWER_VAULT_HREF} className="font-semibold text-brand-700 underline">Add it</Link> to reuse it next time.
                  </p>
                ) : null}
                {question.status === "ANSWER_YOURSELF" ? (
                  <p className="text-xs leading-5 text-slate-600">
                    <span className="mr-1 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 font-semibold text-slate-800">Answer this yourself</span>
                    {question.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {view.answers.otherSaved.length ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Other saved answers</h3>
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {view.answers.otherSaved.map((answer) => (
                  <li key={answer.id} className="space-y-1 px-4 py-3" data-saved-answer={answer.id}>
                    <p className="text-xs text-slate-500">{answer.categoryLabel} · {answer.question}</p>
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-slate-700">{answer.answer}</p>
                      <CopyButton value={answer.answer} label={answer.question} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {view.answers.answerYourself.length ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Saved sensitive questions</h3>
              <ul className="mt-2 space-y-2">
                {view.answers.answerYourself.map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-700" data-answer-yourself={entry.id}>
                    <p className="font-medium text-slate-950">{entry.question}</p>
                    <p className="mt-1 text-xs text-slate-600"><span className="font-semibold">Answer this yourself.</span> {entry.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Link href={ANSWER_VAULT_HREF} className="text-sm font-semibold text-brand-700 underline">Manage your Answer Vault</Link>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="3. Open the application" description="You fill in and submit the employer's form yourself." />
        <div className="space-y-3 p-5 text-sm text-slate-700" data-open-application>
          {view.applyLink ? (
            <>
              <a
                href={view.applyLink.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOpenApplication}
                className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                data-apply-link
              >
                <ExternalLink className="mr-2" size={16} aria-hidden="true" />
                Open application
              </a>
              <p>
                Opens <strong data-apply-host>{view.applyLink.hostname}</strong> in a new tab.
                {view.canRecordApplied ? " When you come back to this tab, Apply Pilot asks whether you submitted it." : null}
              </p>
              {!view.applyLink.secure ? <p className="text-amber-900">This link does not use HTTPS. Check the address before you enter personal details.</p> : null}
            </>
          ) : (
            <p data-no-apply-link>
              No application link is saved for this job. Find the posting on {view.job.company}&apos;s careers site, apply there, then come back to record it.
            </p>
          )}
          <p className="text-xs leading-5 text-slate-500">
            Apply Pilot never clicks the employer&apos;s Submit button. Some employers flag or block applications they believe are AI-assisted, so read every answer before you submit.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="4. I applied" description="Record the application once you have submitted it on the employer's site." />
        <div id="record-applied" className="space-y-3 p-5 text-sm text-slate-700" data-record-applied>
          {view.sent ? (
            <p data-sent-summary>
              Sent: {sentLine(view.sent.resume, "résumé")}, {sentLine(view.sent.coverLetter, "cover letter")}.{" "}
              <Link href={view.sent.href} className="font-semibold text-brand-700 underline">View what you sent</Link>
            </p>
          ) : null}
          {!view.canRecordApplied && view.application ? (
            <p>
              Recorded as <strong>{view.application.statusLabel}</strong>
              {view.application.dateApplied ? ` · applied ${isoDate(view.application.dateApplied)}` : ""}.{" "}
              <Link href={`/applications/${view.application.id}`} className="font-semibold text-brand-700 underline">Open in tracker</Link>
            </p>
          ) : !confirming ? (
            <PrimaryButton type="button" onClick={() => startConfirming(null)} data-start-applied>
              <CheckCircle2 className="mr-2" size={15} aria-hidden="true" />
              I applied
            </PrimaryButton>
          ) : (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" data-applied-confirmation>
              <p className="font-semibold text-slate-950">Record this application as submitted</p>
              <ul className="space-y-1 text-sm">
                <li data-confirm-resume>
                  {resume
                    ? <>Résumé: <strong>v{resume.versionNumber}</strong> · {resume.statusLabel} · <span className="font-mono text-xs">hash {shortHash(resume.contentHash)}…</span></>
                    : "Résumé: none from Apply Pilot will be recorded."}
                </li>
                <li data-confirm-cover>
                  {cover
                    ? <>Cover letter: <strong>v{cover.versionNumber}</strong> · {cover.statusLabel} · <span className="font-mono text-xs">hash {shortHash(cover.contentHash)}…</span></>
                    : "Cover letter: none."}
                </li>
              </ul>
              {blockers.map((blocker) => (
                <p key={blocker.href} className="text-sm text-amber-900" data-applied-blocker>
                  {blocker.text} <a href={blocker.href} className="font-semibold underline">Fix it</a>
                </p>
              ))}
              <div className="space-y-1">
                <label htmlFor="effort-minutes" className="block text-sm font-medium text-slate-800">Minutes this application took (optional)</label>
                <input
                  id="effort-minutes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_EFFORT_MINUTES}
                  step={1}
                  value={effortInput}
                  onChange={(event) => setEffortInput(event.target.value)}
                  aria-describedby="effort-minutes-help"
                  aria-invalid={effort.ok ? undefined : true}
                  className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  data-effort-minutes
                />
                <p id="effort-minutes-help" className="text-xs text-slate-500">
                  Your own estimate, from reading the posting to submitting the employer&apos;s form. It is used only for your Insights page.
                </p>
                {effortPrefilled !== null && effortInput === String(effortPrefilled) ? (
                  <p className="text-xs text-slate-600" data-effort-prefilled>
                    Pre-filled with the {effortPrefilled} {effortPrefilled === 1 ? "minute" : "minutes"} between opening the application and coming back. Change it or clear it if that is not right.
                  </p>
                ) : null}
                {!effort.ok ? (
                  <p className="text-xs text-amber-900" data-effort-error>Enter whole minutes from 1 to {MAX_EFFORT_MINUTES}, or leave it blank.</p>
                ) : null}
              </div>
              <label className="flex items-start gap-2 text-sm text-slate-800">
                <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" data-attest />
                I submitted this application on the employer&apos;s site.
              </label>
              {appliedError ? (
                <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-applied-error>
                  {appliedError.text}{" "}
                  {appliedError.fixHref ? <a href={appliedError.fixHref} className="font-semibold underline">Fix it</a> : null}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton type="button" onClick={recordApplied} disabled={!attested || blockers.length > 0 || Boolean(busy) || !effort.ok} data-confirm-applied>
                  {busy?.action === "applied" ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : <FileText className="mr-2" size={15} aria-hidden="true" />}
                  Record as applied
                </PrimaryButton>
                <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={Boolean(busy)}>Cancel</SecondaryButton>
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
