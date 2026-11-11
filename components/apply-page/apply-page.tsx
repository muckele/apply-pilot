"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { JobDocumentWorkspace } from "@/components/job-document-workspace";
import { MatchCard } from "@/components/job-workspace/match-card";
import { TailorFlow, documentsCreatedKey, tailorReviewIdentity, type TailorFlowMessage } from "@/components/job-workspace/tailor-flow";
import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import { ExperienceStep } from "@/components/apply-page/experience-step";
import { NowCard } from "@/components/apply-page/now-card";
import type { ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import type { ApplyProgress } from "@/lib/apply-page/apply-progress";
import type { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
import { experienceDraftKey } from "@/lib/jobs/experience-drafts";
import { gradeLetter } from "@/lib/jobs/grade";
import type { JobDetail } from "@/lib/jobs/job-detail";

export type ApplyPageProps = {
  detail: JobDetail;
  kit: ApplyKitView;
  automationAvailable: boolean;
  progress: ApplyProgress;
  /** Server-computed values for TailorFlow (they read server env). */
  tailorServer: { quote: ReturnType<typeof buildDocumentCreationQuote>; generationAvailable: boolean };
  answeredYes?: boolean;
};

export function matchResultLine(fit: number, confidence: number | null): string | null {
  const letter = gradeLetter(fit);
  if (!letter) return null;
  const head = `${letter} · fit ${fit}${confidence === null ? "" : `, confidence ${confidence}`}.`;
  return fit >= 85 && confidence !== null && confidence >= 85 ? head : `${head} Assisted Fill needs an A, with confidence of 85 or more.`;
}

export function ApplyPage({ detail, kit, progress, tailorServer, answeredYes = false }: ApplyPageProps) {
  const [pendingFactChanges, setPendingFactChanges] = useState(false);
  const scoreConfirm = useInPageConfirm();
  const documentsConfirm = useInPageConfirm();
  const [tailorMessage, setTailorMessage] = useState<TailorFlowMessage | null>(null);
  const hasDocuments = detail.resumeVersions.length > 0 || detail.coverLetters.length > 0;
  const hasCurrentResume = detail.resumeVersions.some((version) => version.evidenceCurrent);
  const jobId = detail.view.id;
  const result = detail.estimate ? matchResultLine(detail.estimate.score, detail.currentConfidenceScore) : null;

  useEffect(() => {
    if (!hasDocuments) return;
    let created: string | null = null;
    try {
      created = window.sessionStorage.getItem(documentsCreatedKey(jobId));
      window.sessionStorage.removeItem(documentsCreatedKey(jobId));
    } catch {}
    // One-time handoff from TailorFlow: bring the new documents into view after the refresh.
    if (created) requestAnimationFrame(() => document.getElementById("apply-documents")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [hasDocuments, jobId]);

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
            matchBoundToReview={detail.estimate?.basis === "REVIEWED_EVIDENCE"}
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
          <TailorFlow
            key={tailorReviewIdentity(detail.evidenceReview, detail.hasValidCurrentSnapshot)}
            documentsOnly
            confirm={documentsConfirm.confirmFn}
            jobId={jobId}
            hasDocuments={hasDocuments}
            hasCurrentResume={hasCurrentResume}
            message={tailorMessage}
            onMessage={setTailorMessage}
            review={detail.evidenceReview}
            hasValidCurrentSnapshot={detail.hasValidCurrentSnapshot}
            readOnlyGaps={detail.readOnlyGaps}
            quote={tailorServer.quote}
            generationAvailable={tailorServer.generationAvailable}
          />
          {documentsConfirm.dialog}
        </div>
        {hasDocuments ? (
          <div id="apply-documents" className="job-card job-section">
            <h2 id="documents-heading" tabIndex={-1} className="job-section-title">Review and edit</h2>
            <p className="job-card-copy">Read each document, edit anything you like, and download it. Your own edits are marked as yours; changed facts are flagged for you to confirm before export.</p>
            {pendingFactChanges ? (
              <p role="status" className="job-message job-message-info">You&apos;ve written lines in step 2 that these documents don&apos;t include yet. Update your score, then create new versions to use them; export waits until then.</p>
            ) : null}
            <div className="application-review-workspace job-documents">
              <JobDocumentWorkspace resumeVersions={detail.resumeVersions} coverLetters={detail.coverLetters} evidenceInvalidated={pendingFactChanges} />
            </div>
          </div>
        ) : null}
      </section>

      <section id="step-4" className="job-card job-section" aria-label="Prepare">
        {detail.application ? (
          <p className="job-card-copy">
            Prepare this application on its <Link href={`/applications/${detail.application.id}`}>application page</Link> for now.
          </p>
        ) : null}
      </section>

      <details className="job-card job-disclosure" open={answeredYes || undefined}>
        <summary>Apply on my own</summary>
        <ApplyKit view={kit} answeredYes={answeredYes} />
      </details>
    </div>
  );
}
