import { ExternalLink } from "lucide-react";
import Link from "next/link";

import { JobCrmActions } from "@/components/job-crm-actions";
import { ScoreBadge, StatusBadge, type UiTone } from "@/components/ui";

type JobCardProps = {
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    remoteStatus: string;
    salary: string;
    datePosted: string;
    fitScore: number | null;
    status: string;
    sourceType?: string;
    keyReason: string;
  };
};

export function JobCard({ job, tone = "default" }: JobCardProps & { tone?: UiTone }) {
  const cardClass = tone === "branded"
    ? "product-surface-raised rounded-xl p-5"
    : "rounded-lg border-slate-200 bg-white p-4 shadow-soft";

  return (
    <article className={`border ${cardClass}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/jobs/${job.id}`} className={`text-base font-semibold ${tone === "branded" ? "text-[#f3f6f2] transition-colors hover:text-brand-300" : "text-slate-950 hover:text-brand-700"}`}>
              {job.title}
            </Link>
            <ScoreBadge score={job.fitScore} tone={tone} />
            <StatusBadge status={job.status} tone={tone} />
            {job.sourceType ? <StatusBadge status={job.sourceType} tone={tone} /> : null}
          </div>
          <p className={`mt-1 text-sm ${tone === "branded" ? "text-[#aeb9b5]" : "text-slate-600"}`}>
            {job.company} · {job.location} · {job.remoteStatus} · {job.salary}
          </p>
        </div>
        <p className={`text-xs ${tone === "branded" ? "text-[#aeb9b5]" : "text-slate-500"}`}>Posted {job.datePosted}</p>
      </div>
      <p className={`mt-3 text-sm leading-6 ${tone === "branded" ? "text-[#d6dfdb]" : "text-slate-700"}`}>{job.keyReason}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/jobs/${job.id}`}
          className={tone === "branded"
            ? "inline-flex min-h-11 items-center gap-2 rounded-lg border border-brand-300 bg-gradient-to-br from-[#62dc9a] to-[#4ccf88] px-3 py-2 text-sm font-semibold text-[#03110b] shadow-[0_12px_34px_rgba(43,202,122,0.12)] transition-colors hover:border-[#73e3a6] hover:from-[#73e3a6] hover:to-[#59d793]"
            : "inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"}
        >
          <ExternalLink size={15} aria-hidden="true" />
          Review
        </Link>
        <JobCrmActions jobId={job.id} compact tone={tone} />
      </div>
    </article>
  );
}
