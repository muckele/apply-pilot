import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";

import { JobActions } from "@/components/job-actions";
import { JobCrmActions } from "@/components/job-crm-actions";
import { ButtonLink, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { demoJobs } from "@/lib/demo-data";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const job = demoJobs.find((item) => item.id === id) ?? demoJobs[0];

  if (!job) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={job.title}
        description={`${job.company} · ${job.location} · ${job.remoteStatus} · ${job.salary}`}
        action={
          <ButtonLink href={job.id === id ? "/applications" : "/jobs"} variant="secondary">
            <ExternalLink className="mr-2" size={16} aria-hidden="true" />
            Open apply link
          </ButtonLink>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_380px]">
        <section className="space-y-6">
          <Panel>
            <PanelHeader title="Fit analysis" />
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <ScoreBadge score={job.fitScore} />
                <StatusBadge status={job.recommendation} />
                <StatusBadge status={job.sourceType} />
              </div>
              <p className="text-sm leading-6 text-slate-700">{job.keyReason}</p>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <CheckCircle2 size={17} className="text-emerald-600" aria-hidden="true" />
                    Supported keywords
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.supportedKeywords.map((keyword) => (
                      <span key={keyword} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <AlertTriangle size={17} className="text-amber-600" aria-hidden="true" />
                    Missing or risky keywords
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.missingKeywords.map((keyword) => (
                      <span key={keyword} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Resume optimization suggestions" />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              <p>{job.suggestedResumeAngle}</p>
              <p className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                Keep the tailored resume single-column, concise, measurable, and honest. Do not add unsupported keywords.
              </p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Full posting" />
            <div className="p-5 text-sm leading-7 text-slate-700">{job.description}</div>
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="divide-y divide-slate-100">
              {["Job imported", "AI match scored", "Application record created"].map((event) => (
                <div key={event} className="px-5 py-4 text-sm text-slate-700">
                  {event}
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader
              title="CRM actions"
              description="Save means not applied yet. Mark applied records the application in your CRM."
            />
            <div className="p-5">
              <JobCrmActions jobId={job.id} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="AI actions" description="Drafts are saved for review. Nothing is sent or submitted automatically." />
            <div className="p-5">
              <JobActions jobId={job.id} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Cover letter angle" />
            <p className="p-5 text-sm leading-6 text-slate-700">{job.suggestedCoverLetterAngle}</p>
          </Panel>

          <Panel>
            <PanelHeader title="Contacts and notes" />
            <div className="space-y-3 p-5">
              <input placeholder="Recruiter or hiring manager" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <textarea placeholder="Notes" rows={5} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
