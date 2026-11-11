"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Wand2 } from "lucide-react";

import { JobDetailTabs } from "@/components/job-workspace/job-detail-tabs";
import { JobHeader } from "@/components/job-workspace/job-header";
import { MatchCard } from "@/components/job-workspace/match-card";
import { SaveJobButton } from "@/components/job-workspace/save-job-button";
import type { ChecklistView, EstimateView, JobDetailView, JobTab, SalaryTargetView } from "@/lib/jobs/job-view-types";

// The selected job beside the feed list: the same header, match card and tabs as the job page,
// with links into the job page's tailoring flow and the Apply Kit.
export function FeedPreview({
  job,
  estimate,
  checklist,
  salaryTarget,
  application,
  backHref
}: {
  job: JobDetailView;
  estimate: EstimateView | null;
  checklist: ChecklistView;
  salaryTarget: SalaryTargetView;
  application: { statusLabel: string } | null;
  backHref: string;
}) {
  const [tab, setTab] = useState<JobTab>("overview");
  return (
    <section className="feed-preview" aria-label={`${job.title} at ${job.company}`} data-feed-preview={job.id}>
      <Link href={backHref} scroll={false} className="feed-back"><ArrowLeft size={16} aria-hidden="true" />All jobs</Link>
      <div className="job-card feed-preview-head">
        <JobHeader job={job} headingLevel={2} />
        <div className="feed-preview-actions">
          <Link href={`/jobs/${job.id}/apply`} className="job-button">Go to Apply Kit</Link>
          {application ? (
            <Link href="/applications" className="job-button">In your tracker: {application.statusLabel}</Link>
          ) : (
            <SaveJobButton jobId={job.id} />
          )}
        </div>
        <div className="feed-tailor-prompt">
          <p className="job-card-title"><Wand2 size={16} aria-hidden="true" /> Tailor your résumé first</p>
          <p className="job-card-copy">See what this job asks for, line by line, then get a résumé and cover letter written for it.</p>
          <Link href={`/jobs/${job.id}/apply`} className="job-button job-button-primary">Tailor your résumé for this job</Link>
        </div>
      </div>
      <MatchCard jobId={job.id} estimate={estimate} checklist={checklist} onSeeBreakdown={estimate ? () => setTab("match") : undefined} />
      <JobDetailTabs job={job} estimate={estimate} checklist={checklist} salaryTarget={salaryTarget} tab={tab} onTabChange={setTab} />
      <Link href={`/jobs/${job.id}`} className="job-inline-link feed-open-full">Open the full job page</Link>
    </section>
  );
}
