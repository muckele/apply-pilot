"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, FileText, Wand2 } from "lucide-react";

import { JobDetailTabs } from "@/components/job-workspace/job-detail-tabs";
import { JobHeader } from "@/components/job-workspace/job-header";
import { MatchCard } from "@/components/job-workspace/match-card";
import { SaveJobButton } from "@/components/job-workspace/save-job-button";
import { TailorFlow, documentsCreatedKey, tailorReviewIdentity, type TailorFlowMessage, type TailorFlowProps } from "@/components/job-workspace/tailor-flow";
import type { ChecklistView, EstimateView, JobDetailView, JobTab, SalaryTargetView } from "@/lib/jobs/job-view-types";
import {
  JobDocumentWorkspace,
  type JobCoverLetterOption,
  type JobResumeVersionOption
} from "@/components/job-document-workspace";
import { ThemePreferenceControl } from "@/components/theme-preference-control";

export type JobWorkspaceProps = {
  job: JobDetailView;
  estimate: EstimateView | null;
  checklist: ChecklistView;
  salaryTarget: SalaryTargetView;
  tailor: Omit<TailorFlowProps, "jobId" | "hasDocuments" | "onPendingFactChanges">;
  documents: { resumeVersions: JobResumeVersionOption[]; coverLetters: JobCoverLetterOption[] };
  application: { id: string; statusLabel: string } | null;
  masterResumeText: string;
  notes: ReactNode;
};

export function MasterResumeText({ text }: { text: string }) {
  return (
    <div className="application-source-copy" data-product-source>
      {text.split(/\r?\n/u).map((line, index) => {
        if (!line.trim()) return null;
        const heading = /^(SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION):?$/iu.test(line.trim());
        return heading ? <h3 key={index}>{line}</h3> : <p key={index}>{line}</p>;
      })}
    </div>
  );
}

const STEPS = ["Check your fit", "Fill gaps (optional)", "Create documents", "Review and apply"] as const;

export function JobWorkspace({
  job,
  estimate,
  checklist,
  salaryTarget,
  tailor,
  documents,
  application,
  masterResumeText,
  notes
}: JobWorkspaceProps) {
  const [tab, setTab] = useState<JobTab>("overview");
  const [pendingFactChanges, setPendingFactChanges] = useState(false);
  const [tailorMessage, setTailorMessage] = useState<TailorFlowMessage | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const hasDocuments = documents.resumeVersions.length > 0 || documents.coverLetters.length > 0;
  const applyKitHref = `/jobs/${job.id}/apply`;
  const scored = Boolean(estimate) || tailor.hasValidCurrentSnapshot;
  const currentStep = hasDocuments ? 3 : scored ? 1 : 0;

  useEffect(() => {
    if (!hasDocuments) return;
    let created: string | null = null;
    try {
      created = window.sessionStorage.getItem(documentsCreatedKey(job.id));
      window.sessionStorage.removeItem(documentsCreatedKey(job.id));
    } catch {}
    // One-time handoff from TailorFlow: bring the new documents into view after the refresh.
    if (created) requestAnimationFrame(() => document.getElementById("documents")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [hasDocuments, job.id]);

  const seeBreakdown = useCallback(() => {
    setTab("match");
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, []);

  function goTo(id: string) {
    const target = document.getElementById(id);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }

  return (
    <div className="product-page product-page-themed job-workspace" data-job-workspace>
      <div className="job-workspace-top">
        <JobHeader job={job} />
        <details className="job-appearance">
          <summary>Appearance</summary>
          <ThemePreferenceControl />
        </details>
      </div>

      <div className="job-layout">
        <aside className="job-rail" aria-label="Apply and match">
          <div className="job-card job-rail-actions">
            <Link href={applyKitHref} className="job-button job-button-primary">
              Go to Apply Kit <ArrowRight size={16} aria-hidden="true" />
            </Link>
            {application ? (
              <Link href="/applications" className="job-button">In your tracker: {application.statusLabel}</Link>
            ) : (
              <SaveJobButton jobId={job.id} />
            )}
          </div>
          <div className="job-card job-tailor-prompt">
            {hasDocuments ? (
              <>
                <p className="job-card-title"><FileText size={16} aria-hidden="true" /> Your tailored documents are ready</p>
                <p className="job-card-copy">Review and edit them, then take them to the Apply Kit.</p>
                <button type="button" className="job-button" onClick={() => goTo("documents")}>Review documents</button>
              </>
            ) : (
              <>
                <p className="job-card-title"><Wand2 size={16} aria-hidden="true" /> Tailor your résumé first</p>
                <p className="job-card-copy">See what this job asks for, line by line, then get a résumé and cover letter written for it.</p>
                <button type="button" className="job-button" onClick={() => goTo("tailor")}>Start tailoring</button>
              </>
            )}
          </div>
          <MatchCard jobId={job.id} estimate={estimate} checklist={checklist} onSeeBreakdown={estimate ? seeBreakdown : undefined} />
        </aside>

        <div className="job-main">
          <div ref={tabsRef} className="job-anchor">
            <JobDetailTabs job={job} estimate={estimate} checklist={checklist} salaryTarget={salaryTarget} tab={tab} onTabChange={setTab} />
          </div>

          <section id="tailor" className="job-card job-section" aria-labelledby="tailor-heading">
            <h2 id="tailor-heading" tabIndex={-1} className="job-section-title">Tailor your application</h2>
            <ol className="job-steps" aria-label="Steps">
              {STEPS.map((label, index) => (
                <li key={label} data-state={index < currentStep ? "done" : index === currentStep ? "current" : "todo"} aria-current={index === currentStep ? "step" : undefined}>
                  <span className="job-step-number">{index + 1}</span>{label}
                </li>
              ))}
            </ol>
            <TailorFlow
              key={tailorReviewIdentity(tailor.review, tailor.hasValidCurrentSnapshot)}
              jobId={job.id}
              hasDocuments={hasDocuments}
              onPendingFactChanges={setPendingFactChanges}
              message={tailorMessage}
              onMessage={setTailorMessage}
              {...tailor}
            />
          </section>

          {hasDocuments ? (
            <section id="documents" className="job-card job-section" aria-labelledby="documents-heading">
              <h2 id="documents-heading" tabIndex={-1} className="job-section-title">Review and edit</h2>
              <p className="job-card-copy">Read each document, edit anything you like, and download it. Your own edits are marked as yours; changed facts are flagged for you to confirm before export.</p>
              {pendingFactChanges ? (
                <p role="status" className="job-message job-message-info">You&apos;ve changed lines above that these documents don&apos;t include yet. Create new versions to use them; export waits until then.</p>
              ) : null}
              <div className="application-review-workspace job-documents">
                <JobDocumentWorkspace resumeVersions={documents.resumeVersions} coverLetters={documents.coverLetters} evidenceInvalidated={pendingFactChanges} />
              </div>
              <div className="job-next">
                <p className="job-card-copy">When they look right, the Apply Kit has your files, your saved answers and the employer&apos;s form. You submit the application yourself.</p>
                <Link href={applyKitHref} className="job-button job-button-primary">
                  Go to Apply Kit <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </section>
          ) : null}

          <details className="job-card job-disclosure">
            <summary>Your master résumé</summary>
            {masterResumeText ? <MasterResumeText text={masterResumeText} /> : <p className="job-card-copy">No master résumé yet.</p>}
          </details>
          {notes ? (
            <details className="job-card job-disclosure">
              <summary>Contacts and notes</summary>
              {notes}
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
