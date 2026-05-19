import { ExternalLink } from "lucide-react";
import Link from "next/link";

import { JobCrmActions } from "@/components/job-crm-actions";
import { ScoreBadge, StatusBadge } from "@/components/ui";

type JobCardProps = {
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    remoteStatus: string;
    salary: string;
    datePosted: string;
    fitScore: number;
    status: string;
    keyReason: string;
  };
};

export function JobCard({ job }: JobCardProps) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/jobs/${job.id}`} className="text-base font-semibold text-slate-950 hover:text-brand-700">
              {job.title}
            </Link>
            <ScoreBadge score={job.fitScore} />
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {job.company} · {job.location} · {job.remoteStatus} · {job.salary}
          </p>
        </div>
        <p className="text-xs text-slate-500">Posted {job.datePosted}</p>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-700">{job.keyReason}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/jobs/${job.id}`}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <ExternalLink size={15} aria-hidden="true" />
          Review
        </Link>
        <JobCrmActions jobId={job.id} compact />
      </div>
    </article>
  );
}
