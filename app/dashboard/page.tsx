import { CalendarClock, Mail, Plus, TrendingUp } from "lucide-react";

import { JobCard } from "@/components/job-card";
import { ButtonLink, MetricCard, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not scheduled";
}

export default async function DashboardPage() {
  const userId = await requirePageUserId();
  const weekStart = new Date(Date.now() - 7 * 86_400_000);
  const now = new Date();
  const [
    savedThisWeek,
    appliedThisWeek,
    upcomingInterviews,
    followUpsDue,
    resumeVersions,
    avgFit,
    bestJobs,
    applicationsNeedingFollowUp,
    recruiterEmails,
    openTasks
  ] = await Promise.all([
    prisma.application.count({ where: { userId, dateSaved: { gte: weekStart } } }),
    prisma.application.count({ where: { userId, dateApplied: { gte: weekStart } } }),
    prisma.interview.count({ where: { userId, scheduledAt: { gte: now } } }),
    prisma.followUpReminder.count({ where: { userId, completedAt: null, dueAt: { lte: new Date(Date.now() + 3 * 86_400_000) } } }),
    prisma.resumeVersion.count({ where: { userId, createdAt: { gte: weekStart } } }),
    prisma.jobPosting.aggregate({ where: { userId, overallFitScore: { not: null } }, _avg: { overallFitScore: true } }),
    prisma.jobPosting.findMany({
      where: { userId, status: { in: ["ACTIVE", "APPLIED", "INTERVIEW", "OFFER"] } },
      orderBy: [{ overallFitScore: "desc" }, { datePosted: "desc" }, { firstDiscoveredAt: "desc" }],
      take: 2
    }),
    prisma.application.findMany({
      where: {
        userId,
        status: { in: ["SAVED", "INTERESTED", "APPLIED", "RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN"] }
      },
      include: { jobPosting: true },
      orderBy: [{ followUpDueAt: "asc" }, { updatedAt: "desc" }],
      take: 4
    }),
    prisma.emailMessage.findMany({
      where: { userId },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      take: 3
    }),
    prisma.task.findMany({
      where: { userId, status: "OPEN" },
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
      take: 5
    })
  ]);

  const jobCards = bestJobs.map((job) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location || "Location not listed",
    remoteStatus: job.remoteStatus || "Work style not listed",
    salary:
      job.salaryMin && job.salaryMax
        ? `$${Math.round(job.salaryMin / 1000)}k - $${Math.round(job.salaryMax / 1000)}k`
        : "Salary not listed",
    datePosted: (job.datePosted ?? job.firstDiscoveredAt).toISOString().slice(0, 10),
    fitScore: job.overallFitScore ?? 50,
    status: job.status,
    sourceType: job.sourceType,
    keyReason: job.keyMatchReason ?? "Run fit scoring to generate a targeted match summary."
  }));

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
        <MetricCard label="Saved" value={savedThisWeek} detail="This week" />
        <MetricCard label="Applied" value={appliedThisWeek} detail="This week" />
        <MetricCard label="Interviews" value={upcomingInterviews} detail="Upcoming" />
        <MetricCard label="Follow-ups" value={followUpsDue} detail="Need action" />
        <MetricCard label="Resume versions" value={resumeVersions} detail="Created" />
        <MetricCard label="Avg. fit" value={`${Math.round(avgFit._avg.overallFitScore ?? 0)}%`} detail="Scored jobs" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-950">Best new matches</h2>
            <ButtonLink href="/jobs" variant="secondary">View jobs</ButtonLink>
          </div>
          {jobCards.length ? (
            jobCards.map((job) => <JobCard key={job.id} job={job} />)
          ) : (
            <Panel>
              <div className="p-5 text-sm text-slate-600">No scored jobs yet. Run discovery or import a job to begin.</div>
            </Panel>
          )}
        </section>

        <div className="space-y-6">
          <Panel>
            <PanelHeader
              title="Applications needing follow-up"
              action={<TrendingUp size={17} className="text-brand-600" aria-hidden="true" />}
            />
            <div className="divide-y divide-slate-100">
              {applicationsNeedingFollowUp.length ? (
                applicationsNeedingFollowUp.map((application) => (
                  <div key={application.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{application.jobPosting.company}</p>
                        <p className="text-xs text-slate-500">{application.jobPosting.title}</p>
                      </div>
                      <ScoreBadge score={application.jobPosting.overallFitScore ?? 50} />
                    </div>
                    <p className="mt-2 text-sm text-slate-700">{application.nextAction ?? "Review next step."}</p>
                    <p className="mt-1 text-xs text-slate-500">Due {formatDate(application.followUpDueAt)}</p>
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-600">No follow-ups need attention.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Recruiter emails"
              description="Gmail snippets are shown only after connecting Gmail with readonly access."
              action={<Mail size={17} className="text-brand-600" aria-hidden="true" />}
            />
            <div className="divide-y divide-slate-100">
              {recruiterEmails.length ? (
                recruiterEmails.map((email) => (
                  <div key={email.id} className="px-5 py-4 text-sm text-slate-700">
                    <p className="font-semibold text-slate-950">{email.subject}</p>
                    <p className="mt-1 text-xs text-slate-500">{email.fromEmail ?? "Unknown sender"}</p>
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-700">No saved recruiter messages yet.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Upcoming interviews" action={<CalendarClock size={17} className="text-brand-600" />} />
            <div className="divide-y divide-slate-100">
              {upcomingInterviews ? (
                <div className="px-5 py-4 text-sm text-slate-700">{upcomingInterviews} interview(s) scheduled.</div>
              ) : (
                <div className="px-5 py-4 text-sm text-slate-700">No upcoming interviews.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Open tasks" />
            <div className="divide-y divide-slate-100">
              {openTasks.length ? (
                openTasks.map((task) => (
                  <div key={task.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{task.title}</p>
                      <p className="text-xs text-slate-500">Due {formatDate(task.dueAt)}</p>
                    </div>
                    <StatusBadge status={task.priority} />
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-600">No open tasks.</div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
