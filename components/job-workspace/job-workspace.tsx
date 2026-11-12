"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { JobApplyReturnPrompt } from "@/components/job-workspace/job-apply-return-prompt";
import { JobDetailTabs } from "@/components/job-workspace/job-detail-tabs";
import { JobHeader } from "@/components/job-workspace/job-header";
import { MatchCard } from "@/components/job-workspace/match-card";
import { SaveJobButton } from "@/components/job-workspace/save-job-button";
import type { ApplyProgress } from "@/lib/apply-page/apply-progress";
import type { ApplyReturnState } from "@/lib/applications/apply-return";
import type { ChecklistView, EstimateView, JobDetailView, JobTab, SalaryTargetView } from "@/lib/jobs/job-view-types";
import { ThemePreferenceControl } from "@/components/theme-preference-control";

export type JobWorkspaceProps = {
  job: JobDetailView;
  estimate: EstimateView | null;
  checklist: ChecklistView;
  salaryTarget: SalaryTargetView;
  progress: ApplyProgress;
  application: { id: string; statusLabel: string } | null;
  // "Did you apply?": an opened employer application with no answer yet, or a "Not applying" to undo.
  applyReturn: ApplyReturnState;
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

export function JobWorkspace({
  job,
  estimate,
  checklist,
  salaryTarget,
  progress,
  application,
  applyReturn,
  masterResumeText,
  notes
}: JobWorkspaceProps) {
  const [tab, setTab] = useState<JobTab>("overview");
  const tabsRef = useRef<HTMLDivElement>(null);
  const applyHref = `/jobs/${job.id}/apply`;
  // Every step done: applied (or the run was completed), so there is nothing to continue.
  const applied = progress.steps.every((step) => step.state === "done");

  const seeBreakdown = useCallback(() => {
    setTab("match");
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, []);

  return (
    <div className="product-page product-page-themed job-workspace" data-job-workspace>
      <div className="job-workspace-top">
        <JobHeader job={job} />
        <details className="job-appearance">
          <summary>Appearance</summary>
          <ThemePreferenceControl />
        </details>
      </div>

      <JobApplyReturnPrompt jobId={job.id} company={job.company} pending={applyReturn.pending} declined={applyReturn.declined} />

      <div className="job-layout">
        <aside className="job-rail" aria-label="Apply and match">
          <div className="job-card job-rail-actions">
            <Link href={applyHref} className="job-button job-button-primary">
              {applied ? (
                <>View application <ArrowRight size={16} aria-hidden="true" /></>
              ) : progress.current === 1 ? (
                "Apply →"
              ) : (
                <>Continue: step {progress.current} <ArrowRight size={16} aria-hidden="true" /></>
              )}
            </Link>
            {application ? (
              <Link href="/applications" className="job-button">In your tracker: {application.statusLabel}</Link>
            ) : (
              <SaveJobButton jobId={job.id} />
            )}
          </div>
          <MatchCard jobId={job.id} estimate={estimate} checklist={checklist} onSeeBreakdown={estimate ? seeBreakdown : undefined} showScoreButton={false} />
        </aside>

        <div className="job-main">
          <div ref={tabsRef} className="job-anchor">
            <JobDetailTabs job={job} estimate={estimate} checklist={checklist} salaryTarget={salaryTarget} tab={tab} onTabChange={setTab} />
          </div>

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
