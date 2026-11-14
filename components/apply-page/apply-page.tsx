"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { JobDocumentWorkspace } from "@/components/job-document-workspace";
import { MatchCard } from "@/components/job-workspace/match-card";
import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { BrowserStep } from "@/components/apply-page/browser-step";
import { DocumentsStep } from "@/components/apply-page/documents-step";
import { ExperienceStep } from "@/components/apply-page/experience-step";
import { NowCard } from "@/components/apply-page/now-card";
import { PrepareStep } from "@/components/apply-page/prepare-step";
import { ResultWindow } from "@/components/apply-page/result-window";
import { useGeminiNotice } from "@/components/apply-page/use-gemini-notice";
import type { ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { useRunProgress } from "@/components/apply-page/use-run-progress";
import { deriveApplyProgress, type ApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import type { PrepareStepState } from "@/lib/apply-page/load-apply-progress";
import { saveNothingToAdd } from "@/lib/apply-page/nothing-to-add";
import { resultWindowView } from "@/lib/apply-page/result-window";
import { writeDocument, type WriteStep } from "@/lib/apply-page/write-documents";
import { estimateIsCurrent } from "@/lib/jobs/estimate-basis";
import { experienceDraftKey } from "@/lib/jobs/experience-drafts";
import { gradeLetter } from "@/lib/jobs/grade";
import type { JobDetail } from "@/lib/jobs/job-detail";

export type ApplyPageProps = {
  detail: JobDetail;
  kit: ApplyKitView;
  automationAvailable: boolean;
  progress: ApplyProgress;
  /** The inputs behind `progress`; with them the page re-derives progress as the run moves on. */
  progressInput?: ApplyProgressInput;
  /** The account's policy needs a cover letter (Prepare blocks without one): step 3 ticks it by default. */
  coverLetterRequired: boolean;
  /** Step 4's ready list, host, Fill mode and current run, from the server. */
  prepare: PrepareStepState;
  /** Server-computed values for steps 2 and 3 (they read server env). */
  tailorServer: { generationAvailable: boolean };
  /** The canonical origin for the companion's --app-origin (null when the server can't determine one). */
  appOrigin: string | null;
  answeredYes?: boolean;
};

// A run the Apply Pilot browser works on: prepared and not finished. Step 5 keeps its start command
// and sign-in code through all of these, so a closed window can always be reopened.
const BROWSER_RUN_STATES: ReadonlySet<string> = new Set(["READY", "REVIEW_REQUIRED", "FILLING", "READY_FOR_USER_SUBMISSION"]);

type Status = { tone: "info" | "success" | "error"; text: string };

const WRITING_OFF = "Document writing is switched off on this server (no AI provider is configured).";
const CREATE_STEPS: ReadonlyArray<[WriteStep, string, string]> = [
  ["resume", "Writing your résumé…", "Your résumé was created."],
  ["cover", "Writing your cover letter…", "Your cover letter was created."]
];

// Focus a heading once the result window has closed (closing hands focus back to where it was).
function focusLater(id: string) {
  setTimeout(() => {
    const target = document.getElementById(id);
    target?.scrollIntoView?.({ block: "start" });
    target?.focus();
  }, 0);
}

export function matchResultLine(fit: number, confidence: number | null): string | null {
  const letter = gradeLetter(fit);
  if (!letter) return null;
  const head = `${letter} · fit ${fit}${confidence === null ? "" : `, confidence ${confidence}`}.`;
  return fit >= 85 && confidence !== null && confidence >= 85 ? head : `${head} Assisted Fill needs an A, with confidence of 85 or more.`;
}

export function ApplyPage({ detail, kit, automationAvailable, progress: serverProgress, progressInput, prepare, coverLetterRequired, tailorServer, appOrigin, answeredYes = false }: ApplyPageProps) {
  const [pendingFactChanges, setPendingFactChanges] = useState(false);
  const liveRun = useRunProgress(prepare.run?.id ?? null, progressInput?.run ?? null);
  const progress = progressInput && prepare.run ? deriveApplyProgress({ ...progressInput, run: liveRun }) : serverProgress;
  // The run's state as last read (the tab may have been away while the run moved on).
  const runState = liveRun?.state ?? prepare.run?.state ?? null;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  // The one-time "this goes to Google Gemini" notice (D037), shared by every paid step on the page.
  const notice = useGeminiNotice(detail.draftUserKey);
  // The result window (G-6): asked for after a score, shown once the refreshed page has the result.
  const [resultRequested, setResultRequested] = useState(false);
  const [awaitingScore, setAwaitingScore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<Status | null>(null);
  const [createdMessage, setCreatedMessage] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const creatingNow = useRef(false);
  const hasDocuments = detail.resumeVersions.length > 0 || detail.coverLetters.length > 0;
  const jobId = detail.view.id;
  const result = detail.estimate ? matchResultLine(detail.estimate.score, detail.currentConfidenceScore) : null;
  // Current for documents and Prepare: bound to the saved review, or reviewed with nothing to add.
  const matchBoundToReview = estimateIsCurrent(detail.estimate?.basis);
  // Step 3 writes documents only from a finished step 2: the saved review in force and the shown
  // match current for it, with no unsaved lines. So step 3 never saves a review itself.
  const documentsBlockedReason = !detail.evidenceReview
    ? "Add your master résumé first, so Apply Pilot has facts to work from."
    : pendingFactChanges
      ? "Update your match in step 2 first, so your documents include your new lines."
      : !matchBoundToReview || !detail.hasValidCurrentSnapshot
        ? "Update your match in step 2 first, so your documents use your reviewed lines."
        : null;
  // A master-résumé match with no review yet: Create saves "nothing to add" first (no second score).
  const createSavesReview = detail.estimate?.basis === "MASTER_RESUME";
  const createBlockedReason = !tailorServer.generationAvailable
    ? WRITING_OFF
    : pendingFactChanges
      ? "You've written lines in step 2 that aren't saved yet. Update your match there first."
      : !detail.evidenceReview || (createSavesReview ? !detail.evidenceReview.analysisId : documentsBlockedReason !== null)
        ? "Update your match in step 2 first."
        : null;
  const view = detail.estimate ? resultWindowView({ score: detail.estimate.score, checklist: detail.checklist }) : null;
  const showResult = resultRequested && view !== null && !(awaitingScore && refreshing);

  function refresh() {
    startRefresh(() => router.refresh());
  }

  // After any score (step 1, step 2) or a "nothing to add" save: refresh, then show the window.
  function scored() {
    setCreateStatus(null);
    setCreatedMessage(null);
    setResultRequested(true);
    setAwaitingScore(true);
    refresh();
  }

  function closeResult() {
    if (creatingNow.current) return;
    setResultRequested(false);
    setAwaitingScore(false);
    setCreateStatus(null);
  }

  async function createFromWindow() {
    if (creatingNow.current || createBlockedReason || !detail.evidenceReview) return;
    creatingNow.current = true;
    setCreating(true);
    setAwaitingScore(false);
    setCreateStatus(null);
    const written: string[] = [];
    let changed = false;
    try {
      if (!(await notice.ensure())) {
        setCreateStatus({ tone: "info", text: "Nothing was sent." });
        return;
      }
      if (createSavesReview) {
        setCreateStatus({ tone: "info", text: "Saving your review…" });
        await saveNothingToAdd(jobId, detail.evidenceReview, crypto.randomUUID());
        changed = true;
      }
      for (const [step, progressText, doneText] of CREATE_STEPS) {
        setCreateStatus({ tone: "info", text: progressText });
        await writeDocument(jobId, step);
        changed = true;
        written.push(doneText);
      }
      setResultRequested(false);
      setCreateStatus(null);
      setCreatedMessage("Your résumé and cover letter are ready to review below.");
      focusLater("documents-step-heading");
    } catch (error) {
      setCreateStatus({ tone: "error", text: [...written, error instanceof Error ? error.message : "Something went wrong."].join(" ") });
    } finally {
      creatingNow.current = false;
      setCreating(false);
      if (changed) refresh();
    }
  }

  return (
    <div className="product-page product-page-themed job-workspace apply-page" data-apply-page>
      <NowCard progress={progress} />

      <section id="step-1" className="job-section" aria-label="Your match">
        <MatchCard
          jobId={jobId}
          estimate={detail.estimate}
          checklist={detail.checklist}
          scoreButton={
            <>
              <ScoreJobButton jobId={jobId} label="Check my match" beforeRun={notice.ensure} onScored={scored} />
            </>
          }
        />
        {result ? <p className="job-card-copy" data-match-result>{result}</p> : null}
      </section>

      <section id="step-2" className="job-card job-section" aria-labelledby="experience-heading">
        <h2 id="experience-heading" tabIndex={-1} className="job-section-title">Your experience</h2>
        {detail.evidenceReview ? (
          <ExperienceStep
            jobId={jobId}
            review={detail.evidenceReview}
            hasValidCurrentSnapshot={detail.hasValidCurrentSnapshot}
            matchBoundToReview={matchBoundToReview}
            draftKey={experienceDraftKey(detail.draftUserKey, jobId)}
            generationAvailable={tailorServer.generationAvailable}
            onPendingChanges={setPendingFactChanges}
            beforeRun={notice.ensure}
            onScored={scored}
          />
        ) : (
          <p className="job-note">
            Apply Pilot needs your master résumé before it can compare it with this job.{" "}
            <Link className="job-inline-link" href="/resumes">Add your résumé</Link>
          </p>
        )}
      </section>

      <section id="step-3" aria-labelledby="documents-step-heading">
        <div className="job-card job-section">
          <h2 id="documents-step-heading" tabIndex={-1} className="job-section-title">Your documents</h2>
          {createdMessage ? <p role="status" className="job-message job-message-success" data-created-message>{createdMessage}</p> : null}
          <DocumentsStep
            jobId={jobId}
            applicationId={detail.application?.id ?? null}
            beforeRun={notice.ensure}
            generationAvailable={tailorServer.generationAvailable}
            coverByDefault={coverLetterRequired}
            resumes={kit.resumes}
            coverLetters={kit.coverLetters}
            attached={{ resumeId: detail.application?.resumeVersionId ?? null, coverId: detail.application?.coverLetterVersionId ?? null }}
            letter={gradeLetter(detail.estimate?.score)}
            blockedReason={documentsBlockedReason}
            // Once applied (or archived), what's attached is the record and stays as it is.
            attachable={kit.canRecordApplied}
          />
        </div>
        {hasDocuments ? (
          <div id="apply-documents" className="job-card job-section">
            <h2 id="documents-heading" tabIndex={-1} className="job-section-title">Review and edit</h2>
            <p className="job-card-copy">Read each document, edit anything you like, and download it. Your own edits are marked as yours; changed facts are flagged for you to confirm before export.</p>
            {pendingFactChanges ? (
              <p role="status" className="job-message job-message-info">You&apos;ve written lines in step 2 that these documents don&apos;t include yet. Update your score, then write new versions to use them; export waits until then.</p>
            ) : null}
            <div className="application-review-workspace job-documents">
              <JobDocumentWorkspace resumeVersions={detail.resumeVersions} coverLetters={detail.coverLetters} evidenceInvalidated={pendingFactChanges} />
            </div>
          </div>
        ) : null}
      </section>

      <section id="step-4" className="job-card job-section" aria-labelledby="prepare-heading">
        <h2 id="prepare-heading" tabIndex={-1} className="job-section-title">Prepare</h2>
        {!automationAvailable ? (
          <p className="job-note">Assisted apply isn&apos;t switched on for this server, so there&apos;s nothing to prepare here. You can still apply on your own below.</p>
        ) : !kit.canRecordApplied ? (
          <p className="job-note">This application is already recorded, so there&apos;s nothing to prepare.</p>
        ) : (
          <PrepareStep
            applicationId={detail.application?.id ?? null}
            applyHost={prepare.applyHost}
            readyList={prepare.readyList}
            fillMode={prepare.fillMode}
            run={prepare.run}
            beforeRun={notice.ensure}
          />
        )}
      </section>

      <section id="step-5" className="job-card job-section" aria-labelledby="browser-heading">
        <h2 id="browser-heading" tabIndex={-1} className="job-section-title">Open the Apply Pilot browser</h2>
        {prepare.run && runState !== null && BROWSER_RUN_STATES.has(runState) ? (
          <BrowserStep appOrigin={appOrigin} runId={prepare.run.id} />
        ) : (
          <p className="job-note">After Prepare, start the Apply Pilot browser here.</p>
        )}
      </section>

      {/* Open when it's the way to apply: after "Yes, I applied", or without application automation. */}
      <details className="job-card job-disclosure" open={answeredYes || progress.applyOnYourOwn || ownOpen || undefined}>
        <summary id="apply-on-my-own">Apply on my own</summary>
        <ApplyKit view={kit} answeredYes={answeredYes} beforeAiRun={notice.ensure} />
      </details>

      {showResult && view ? (
        <ResultWindow
          view={view}
          onCreate={() => { void createFromWindow(); }}
          onClose={closeResult}
          onAddExperience={() => {
            closeResult();
            focusLater("experience-heading");
          }}
          onApplyOnMyOwn={() => {
            closeResult();
            setOwnOpen(true);
            focusLater("apply-on-my-own");
          }}
          creating={creating}
          status={createStatus}
          createBlockedReason={createBlockedReason}
          // Credits (D037) plug in here once a real credit source exists; until then nothing shows.
          credit={null}
          upgradeHref={null}
        />
      ) : null}
      {notice.window}
    </div>
  );
}
