import { CalendarClock, Mail, Plus, TrendingUp } from "lucide-react";

import { JobCard } from "@/components/job-card";
import { JobMatchOmissionNotice } from "@/components/job-match-omission-notice";
import { ButtonLink, MetricCard, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import {
  CURRENT_JOB_MATCH_ANALYSES,
  CURRENT_JOB_MATCH_ANALYSIS_WHERE,
  JOB_MATCH_LIST_CANDIDATE_LIMIT,
  buildCurrentJobMatchContext,
  currentJobMatchFields,
  hasCurrentJobMatchAnalysis,
  readCurrentJobMatchSources
} from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { formatAverageFit } from "@/lib/jobs/fit-presentation";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not scheduled";
}

export default async function DashboardPage() {
  const userId = await requirePageUserId();
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const followUpWindowEnd = new Date(now.getTime() + 3 * 86_400_000);
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
    openTasks,
    matchSources
  ] = await Promise.all([
    prisma.application.count({ where: { userId, dateSaved: { gte: weekStart } } }),
    prisma.application.count({ where: { userId, dateApplied: { gte: weekStart } } }),
    prisma.interview.count({ where: { userId, scheduledAt: { gte: now } } }),
    prisma.followUpReminder.count({ where: { userId, completedAt: null, dueAt: { lte: followUpWindowEnd } } }),
    prisma.resumeVersion.count({ where: { userId, createdAt: { gte: weekStart } } }),
    prisma.jobPosting.findMany({
      where: {
        userId,
        overallFitScore: { not: null },
        aiAnalyses: { some: CURRENT_JOB_MATCH_ANALYSIS_WHERE }
      },
      include: { aiAnalyses: CURRENT_JOB_MATCH_ANALYSES, currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } },
      take: JOB_MATCH_LIST_CANDIDATE_LIMIT + 1
    }),
    prisma.jobPosting.findMany({
      where: {
        userId,
        status: { in: ["ACTIVE", "APPLIED", "INTERVIEW", "OFFER"] },
        overallFitScore: { not: null },
        aiAnalyses: { some: CURRENT_JOB_MATCH_ANALYSIS_WHERE }
      },
      include: { aiAnalyses: CURRENT_JOB_MATCH_ANALYSES, currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } },
      orderBy: [{ overallFitScore: "desc" }, { datePosted: "desc" }, { firstDiscoveredAt: "desc" }],
      take: JOB_MATCH_LIST_CANDIDATE_LIMIT + 1
    }),
    prisma.application.findMany({
      where: {
        userId,
        status: { in: ["SAVED", "INTERESTED", "APPLIED", "RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN"] }
      },
      include: { jobPosting: { include: { aiAnalyses: CURRENT_JOB_MATCH_ANALYSES, currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } } } },
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
    }),
    readCurrentJobMatchSources(userId)
  ]);

  const currentJob = <T extends (typeof avgFit)[number]>(job: T) => {
    const context = buildCurrentJobMatchContext({ job, ...matchSources });
    return currentJobMatchFields(job, hasCurrentJobMatchAnalysis({
      ...job,
      currentEvidenceSourceValid: context.currentEvidenceSourceValid
    }, context.matchInput));
  };
  const candidateLimitReached = avgFit.length > JOB_MATCH_LIST_CANDIDATE_LIMIT ||
    bestJobs.length > JOB_MATCH_LIST_CANDIDATE_LIMIT;
  const currentFitScores = avgFit.slice(0, JOB_MATCH_LIST_CANDIDATE_LIMIT).flatMap((job) => {
    const score = currentJob(job).overallFitScore;
    return score === null ? [] : [score];
  });
  const averageFit = currentFitScores.length
    ? currentFitScores.reduce((total, score) => total + score, 0) / currentFitScores.length
    : null;

  const jobCards = bestJobs.slice(0, JOB_MATCH_LIST_CANDIDATE_LIMIT).map((job) => {
    const presentedJob = currentJob(job);
    return {
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
    fitScore: presentedJob.overallFitScore,
    status: job.status,
    sourceType: job.sourceType,
    keyReason: presentedJob.keyMatchReason ?? "Run fit scoring to generate a targeted match summary."
    };
  }).filter((job) => job.fitScore !== null).slice(0, 2);

  return (
    <div className="product-page product-page-themed">
      <PageHeader
        title="Dashboard"
        description="Best matches, follow-ups, interviews, and weekly job-search activity in one place."
        tone="branded"
        action={
          <ButtonLink href="/jobs" tone="branded">
            <Plus className="mr-2" size={16} aria-hidden="true" />
            Import job
          </ButtonLink>
        }
      />

      <div className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Saved" value={savedThisWeek} detail="This week" tone="branded" />
        <MetricCard label="Applied" value={appliedThisWeek} detail="This week" tone="branded" />
        <MetricCard label="Interviews" value={upcomingInterviews} detail="Upcoming" tone="branded" />
        <MetricCard label="Follow-ups" value={followUpsDue} detail="Need action" tone="branded" />
        <MetricCard label="Resume versions" value={resumeVersions} detail="Created" tone="branded" />
        <MetricCard
          label="Avg. fit"
          value={formatAverageFit(averageFit)}
          detail={candidateLimitReached ? `Bounded to ${JOB_MATCH_LIST_CANDIDATE_LIMIT} candidates` : "Scored jobs"}
          tone="branded"
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="product-themed-title text-sm font-semibold tracking-[-0.01em]">Best scored matches</h2>
            <ButtonLink href="/jobs" variant="secondary" tone="branded">View jobs</ButtonLink>
          </div>
          <JobMatchOmissionNotice
            evaluatedCandidateCount={JOB_MATCH_LIST_CANDIDATE_LIMIT}
            omittedCandidateCount={candidateLimitReached ? 1 : 0}
            omittedCountIsLowerBound
            viewLabel="dashboard view"
          />
          {jobCards.length ? (
            jobCards.map((job) => <JobCard key={job.id} job={job} tone="branded" />)
          ) : (
            <Panel tone="branded">
              <div className="product-themed-muted p-5 text-sm">No scored jobs yet. Review a job and run fit scoring when available.</div>
            </Panel>
          )}
        </section>

        <div className="space-y-6">
          <Panel tone="branded">
            <PanelHeader
              title="Applications needing follow-up"
              action={<TrendingUp size={17} className="product-themed-accent" aria-hidden="true" />}
              tone="branded"
            />
            <div className="product-divider divide-y">
              {applicationsNeedingFollowUp.length ? (
                applicationsNeedingFollowUp.map((application) => (
                  <div key={application.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="product-themed-title text-sm font-semibold">{application.jobPosting.company}</p>
                        <p className="product-themed-muted text-xs">{application.jobPosting.title}</p>
                      </div>
                      <ScoreBadge
                        score={currentJob(application.jobPosting).overallFitScore}
                        tone="branded"
                      />
                    </div>
                    <p className="product-themed-copy mt-2 text-sm">{application.nextAction ?? "Review next step."}</p>
                    <p className="product-themed-muted mt-1 text-xs">Due {formatDate(application.followUpDueAt)}</p>
                  </div>
                ))
              ) : (
                <div className="product-themed-muted px-5 py-4 text-sm">No follow-ups need attention.</div>
              )}
            </div>
          </Panel>

          <Panel tone="branded">
            <PanelHeader
              title="Recruiter emails"
              description="Gmail snippets are shown only after connecting Gmail with readonly access."
              action={<Mail size={17} className="product-themed-accent" aria-hidden="true" />}
              tone="branded"
            />
            <div className="product-divider divide-y">
              {recruiterEmails.length ? (
                recruiterEmails.map((email) => (
                  <div key={email.id} className="product-themed-copy px-5 py-4 text-sm">
                    <p className="product-themed-title font-semibold">{email.subject}</p>
                    <p className="product-themed-muted mt-1 text-xs">{email.fromEmail ?? "Unknown sender"}</p>
                  </div>
                ))
              ) : (
                <div className="product-themed-muted px-5 py-4 text-sm">No saved recruiter messages yet.</div>
              )}
            </div>
          </Panel>

          <Panel tone="branded">
            <PanelHeader title="Upcoming interviews" action={<CalendarClock size={17} className="product-themed-accent" />} tone="branded" />
            <div className="product-divider divide-y">
              {upcomingInterviews ? (
                <div className="product-themed-copy px-5 py-4 text-sm">{upcomingInterviews} interview(s) scheduled.</div>
              ) : (
                <div className="product-themed-muted px-5 py-4 text-sm">No upcoming interviews.</div>
              )}
            </div>
          </Panel>

          <Panel tone="branded">
            <PanelHeader title="Open tasks" tone="branded" />
            <div className="product-divider divide-y">
              {openTasks.length ? (
                openTasks.map((task) => (
                  <div key={task.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div>
                      <p className="product-themed-copy text-sm font-medium">{task.title}</p>
                      <p className="product-themed-muted text-xs">Due {formatDate(task.dueAt)}</p>
                    </div>
                    <StatusBadge status={task.priority} tone="branded" />
                  </div>
                ))
              ) : (
                <div className="product-themed-muted px-5 py-4 text-sm">No open tasks.</div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
