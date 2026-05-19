import { CalendarClock, Mail, Plus, TrendingUp } from "lucide-react";

import { JobCard } from "@/components/job-card";
import { ButtonLink, MetricCard, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { demoApplications, demoInterviews, demoJobs, demoTasks, weeklyMetrics } from "@/lib/demo-data";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Best matches, follow-ups, interviews, and weekly job-search activity in one place."
        action={
          <ButtonLink href="/jobs">
            <Plus className="mr-2" size={16} aria-hidden="true" />
            Import job
          </ButtonLink>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="Saved" value={weeklyMetrics.saved} detail="This week" />
        <MetricCard label="Applied" value={weeklyMetrics.applied} detail="This week" />
        <MetricCard label="Interviews" value={weeklyMetrics.interviews} detail="Upcoming" />
        <MetricCard label="Follow-ups" value={weeklyMetrics.followUpsDue} detail="Need action" />
        <MetricCard label="Resume versions" value={weeklyMetrics.resumeVersions} detail="Created" />
        <MetricCard label="Avg. fit" value={`${weeklyMetrics.averageFitScore}%`} detail="High-fit jobs" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-950">Best new matches</h2>
            <ButtonLink href="/jobs" variant="secondary">View jobs</ButtonLink>
          </div>
          {demoJobs.slice(0, 2).map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </section>

        <div className="space-y-6">
          <Panel>
            <PanelHeader
              title="Applications needing follow-up"
              action={<TrendingUp size={17} className="text-brand-600" aria-hidden="true" />}
            />
            <div className="divide-y divide-slate-100">
              {demoApplications.map((application) => (
                <div key={application.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{application.company}</p>
                      <p className="text-xs text-slate-500">{application.title}</p>
                    </div>
                    <ScoreBadge score={application.score} />
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{application.nextAction}</p>
                  <p className="mt-1 text-xs text-slate-500">Due {application.followUpDue}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Recruiter emails"
              description="Gmail snippets are shown only after connecting Gmail with readonly access."
              action={<Mail size={17} className="text-brand-600" aria-hidden="true" />}
            />
            <div className="px-5 py-4 text-sm text-slate-700">
              3 likely recruiter messages found in the last 90 days after Gmail is connected.
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Upcoming interviews" action={<CalendarClock size={17} className="text-brand-600" />} />
            <div className="divide-y divide-slate-100">
              {demoInterviews.map((interview) => (
                <div key={interview.id} className="px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{interview.company}</p>
                      <p className="text-xs text-slate-500">{interview.scheduledAt}</p>
                    </div>
                    <StatusBadge status={interview.type} />
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{interview.prepStatus}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Open tasks" />
            <div className="divide-y divide-slate-100">
              {demoTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{task.title}</p>
                    <p className="text-xs text-slate-500">Due {task.due}</p>
                  </div>
                  <StatusBadge status={task.priority} />
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
