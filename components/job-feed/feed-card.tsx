import Link from "next/link";
import { CalendarDays, DollarSign, MapPin } from "lucide-react";

import { WorkStyleBadge } from "@/components/job-workspace/job-header";
import { FitBadge } from "@/components/job-workspace/match-card";
import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import type { JobHeaderView } from "@/lib/jobs/job-view-types";

export type FeedCardView = JobHeaderView & {
  score: number | null;
  href: string;
  selected: boolean;
  trackerStatus: string | null;
};

// One job in the feed list. The title link covers the whole card (selecting it shows the job in
// the preview pane); the Score button sits above that link so it stays separately clickable.
export function FeedCard({ job }: { job: FeedCardView }) {
  return (
    <article className="feed-card" data-selected={job.selected} data-feed-card={job.id}>
      <div className="feed-card-body">
        <p className="feed-card-company">{job.company}</p>
        <h3 className="feed-card-title">
          <Link href={job.href} scroll={false} className="feed-card-link" aria-current={job.selected ? "true" : undefined}>
            {job.title}
          </Link>
        </h3>
        <ul className="feed-card-meta">
          {job.location ? <li><MapPin size={14} aria-hidden="true" />{job.location}</li> : null}
          <li><DollarSign size={14} aria-hidden="true" />{job.salary ?? "Salary not listed"}</li>
          <li><CalendarDays size={14} aria-hidden="true" />{job.postedAge}</li>
        </ul>
        <div className="feed-card-badges">
          <WorkStyleBadge workStyle={job.workStyle} />
          {job.trackerStatus ? <span className="job-badge">{job.trackerStatus}</span> : null}
        </div>
      </div>
      <div className="feed-card-fit">
        <FitBadge score={job.score} />
        {job.score === null ? (
          <div className="feed-card-score">
            <ScoreJobButton jobId={job.id} label="Score" variant="secondary" />
          </div>
        ) : null}
      </div>
    </article>
  );
}
