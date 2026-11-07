import { Briefcase, CalendarDays, DollarSign, MapPin } from "lucide-react";

import type { JobHeaderView } from "@/lib/jobs/job-view-types";

export function WorkStyleBadge({ workStyle }: { workStyle: JobHeaderView["workStyle"] }) {
  if (!workStyle) return null;
  return <span className={`job-badge job-badge-${workStyle === "On-site" ? "onsite" : workStyle.toLowerCase()}`}>{workStyle}</span>;
}

export function JobHeader({ job, headingLevel = 1 }: { job: JobHeaderView; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <header className="job-header">
      <p className="job-company">{job.company}</p>
      <Heading className="job-title">{job.title}</Heading>
      <ul className="job-meta" aria-label="Job details">
        {job.location ? <li><MapPin size={15} aria-hidden="true" />{job.location}</li> : null}
        {job.workStyle ? <li><WorkStyleBadge workStyle={job.workStyle} /></li> : null}
        <li><DollarSign size={15} aria-hidden="true" />{job.salary ?? "Salary not listed"}</li>
        <li><CalendarDays size={15} aria-hidden="true" />Posted {job.postedAge.toLowerCase() === "today" ? "today" : job.postedAge}</li>
        <li><Briefcase size={15} aria-hidden="true" />{job.source}</li>
      </ul>
    </header>
  );
}
