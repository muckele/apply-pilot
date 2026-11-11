"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { JobDocumentWorkspace } from "@/components/job-document-workspace";
import { MatchCard } from "@/components/job-workspace/match-card";
import { TailorFlow, documentsCreatedKey, tailorReviewIdentity, type TailorFlowMessage } from "@/components/job-workspace/tailor-flow";
import { NowCard } from "@/components/apply-page/now-card";
import type { ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import type { ApplyProgress } from "@/lib/apply-page/apply-progress";
import type { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
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
        <MatchCard jobId={jobId} estimate={detail.estimate} checklist={detail.checklist} />
        {result ? <p className="job-card-copy" data-match-result>{result}</p> : null}
      </section>

      <section id="step-2" className="job-card job-section" aria-labelledby="tailor-heading">
        <h2 id="tailor-heading" tabIndex={-1} className="job-section-title">Tailor your application</h2>
        <TailorFlow
          key={tailorReviewIdentity(detail.evidenceReview, detail.hasValidCurrentSnapshot)}
          jobId={jobId}
          hasDocuments={hasDocuments}
          hasCurrentResume={hasCurrentResume}
          onPendingFactChanges={setPendingFactChanges}
          message={tailorMessage}
          onMessage={setTailorMessage}
          review={detail.evidenceReview}
          hasValidCurrentSnapshot={detail.hasValidCurrentSnapshot}
          readOnlyGaps={detail.readOnlyGaps}
          quote={tailorServer.quote}
          generationAvailable={tailorServer.generationAvailable}
        />
      </section>

      <section id="step-3" aria-label="Your documents">
        {hasDocuments ? (
          <div id="apply-documents" className="job-card job-section">
            <h2 id="documents-heading" tabIndex={-1} className="job-section-title">Review and edit</h2>
            <p className="job-card-copy">Read each document, edit anything you like, and download it. Your own edits are marked as yours; changed facts are flagged for you to confirm before export.</p>
            {pendingFactChanges ? (
              <p role="status" className="job-message job-message-info">You&apos;ve changed lines above that these documents don&apos;t include yet. Create new versions to use them; export waits until then.</p>
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
