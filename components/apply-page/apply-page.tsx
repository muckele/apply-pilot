"use client";

import { useState } from "react";
import Link from "next/link";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { JobDocumentWorkspace } from "@/components/job-document-workspace";
import { MatchCard } from "@/components/job-workspace/match-card";
import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import { BrowserStep } from "@/components/apply-page/browser-step";
import { DocumentsStep } from "@/components/apply-page/documents-step";
import { ExperienceStep } from "@/components/apply-page/experience-step";
import { NowCard } from "@/components/apply-page/now-card";
import { PrepareStep } from "@/components/apply-page/prepare-step";
import type { ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { useRunProgress } from "@/components/apply-page/use-run-progress";
import { deriveApplyProgress, type ApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import type { PrepareStepState } from "@/lib/apply-page/load-apply-progress";
import type { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
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
  tailorServer: { quote: ReturnType<typeof buildDocumentCreationQuote>; generationAvailable: boolean };
  /** The canonical origin for the companion's --app-origin (null when the server can't determine one). */
  appOrigin: string | null;
  answeredYes?: boolean;
};

// A run the Apply Pilot browser works on: prepared and not finished. Step 5 keeps its start command
// and sign-in code through all of these, so a closed window can always be reopened.
const BROWSER_RUN_STATES: ReadonlySet<string> = new Set(["READY", "REVIEW_REQUIRED", "FILLING", "READY_FOR_USER_SUBMISSION"]);

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
  const scoreConfirm = useInPageConfirm();
  const hasDocuments = detail.resumeVersions.length > 0 || detail.coverLetters.length > 0;
  const jobId = detail.view.id;
  const result = detail.estimate ? matchResultLine(detail.estimate.score, detail.currentConfidenceScore) : null;
  const matchBoundToReview = detail.estimate?.basis === "REVIEWED_EVIDENCE";
  // Step 3 writes documents only from a finished step 2: the saved review in force and the shown
  // match scored on it, with no unsaved lines. So step 3 never saves a review itself.
  const documentsBlockedReason = !detail.evidenceReview
    ? "Add your master résumé first, so Apply Pilot has facts to work from."
    : pendingFactChanges
      ? "Update my score in step 2 first, so your documents include your new lines."
      : !matchBoundToReview || !detail.hasValidCurrentSnapshot
        ? "Update my score in step 2 first, so your documents use your reviewed lines."
        : null;

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
              <ScoreJobButton
                jobId={jobId}
                label="Check my match"
                confirm={scoreConfirm.confirmFn}
                maximumMicros={tailorServer.quote?.jobMatchMicros}
              />
              {scoreConfirm.dialog}
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
            quote={tailorServer.quote}
            draftKey={experienceDraftKey(detail.draftUserKey, jobId)}
            generationAvailable={tailorServer.generationAvailable}
            onPendingChanges={setPendingFactChanges}
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
          <DocumentsStep
            jobId={jobId}
            applicationId={detail.application?.id ?? null}
            quote={tailorServer.quote}
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
            jobId={jobId}
            applicationId={detail.application?.id ?? null}
            applyHost={prepare.applyHost}
            readyList={prepare.readyList}
            fillMode={prepare.fillMode}
            run={prepare.run}
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

      <details className="job-card job-disclosure" open={answeredYes || undefined}>
        <summary>Apply on my own</summary>
        <ApplyKit view={kit} answeredYes={answeredYes} />
      </details>
    </div>
  );
}
