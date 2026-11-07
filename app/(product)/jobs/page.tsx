import Link from "next/link";
import { Plus } from "lucide-react";

import { AutomatedJobDiscoveryPanel } from "@/components/automated-job-discovery-panel";
import { FeedCard } from "@/components/job-feed/feed-card";
import { FeedFilterBar } from "@/components/job-feed/feed-filter-bar";
import { FeedPreview } from "@/components/job-feed/feed-preview";
import { JobMatchOmissionNotice, summarizeBoundedJobResults } from "@/components/job-match-omission-notice";
import { ManualJobImportForm } from "@/components/manual-job-import-form";
import { Panel, PanelHeader } from "@/components/ui";
import { formatApplicationStatus } from "@/lib/applications/pipeline";
import { resolveInitialJobDiscoveryPreferences } from "@/lib/job-sources/discovery-preferences";
import {
  CURRENT_JOB_MATCH_ANALYSES,
  JOB_MATCH_LIST_CANDIDATE_LIMIT,
  readCurrentJobMatchSources
} from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { feedHref, feedOrderBy, feedWhere, parseFeedFilters, sortFeedItems, type FeedFilters } from "@/lib/jobs/feed-query";
import { resolveFitEstimate } from "@/lib/jobs/fit-estimate";
import { buildEstimateView, buildJobDetailView } from "@/lib/jobs/job-page-view";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type SearchParams = Record<string, string | string[] | undefined>;

const VISIBLE_JOBS = 40;

function feedJobInclude(userId: string) {
  return {
    aiAnalyses: {
      ...CURRENT_JOB_MATCH_ANALYSES,
      select: { ...CURRENT_JOB_MATCH_ANALYSES.select, output: true, createdAt: true }
    },
    currentEvidenceSnapshot: { select: { ...CURRENT_EVIDENCE_SNAPSHOT_SELECT, reviewedAnalysisId: true } },
    applications: { where: { userId }, select: { status: true }, take: 1 }
  } as const;
}

async function getFeed(userId: string, filters: FeedFilters) {
  const sources = await readCurrentJobMatchSources(userId);
  const where = feedWhere(userId, filters);
  const include = feedJobInclude(userId);
  const [jobs, candidateCount] = await Promise.all([
    prisma.jobPosting.findMany({
      where,
      include,
      orderBy: feedOrderBy(filters.sort),
      take: filters.minFitScore ? JOB_MATCH_LIST_CANDIDATE_LIMIT : VISIBLE_JOBS
    }),
    prisma.jobPosting.count({ where })
  ]);
  type Row = (typeof jobs)[number];
  const toItem = (job: Row) => {
    // Display-only estimate (lib/jobs/fit-estimate.ts); never used to authorise anything.
    const estimate = resolveFitEstimate({
      job,
      resume: sources.resume,
      profile: sources.profile,
      latestAnalysis: job.aiAnalyses[0] ?? null,
      currentSnapshotReviewedAnalysisId: job.currentEvidenceSnapshot?.reviewedAnalysisId ?? null
    });
    return {
      job,
      estimate,
      score: estimate?.score ?? null,
      posted: job.datePosted ?? job.firstDiscoveredAt,
      salaryTop: job.salaryMax ?? job.salaryMin
    };
  };
  const matching = jobs.map(toItem).filter((item) => !filters.minFitScore || (item.score !== null && item.score >= filters.minFitScore));
  const visible = sortFeedItems(matching, filters.sort).slice(0, VISIBLE_JOBS);
  let selected = filters.job ? visible.find((item) => item.job.id === filters.job) ?? null : visible[0] ?? null;
  if (filters.job && !selected) {
    const job = await prisma.jobPosting.findFirst({ where: { id: filters.job, userId }, include });
    selected = job ? toItem(job) : null;
  }
  return {
    visible,
    selected,
    explicitSelection: Boolean(filters.job && selected),
    scoredCount: visible.filter((item) => item.score !== null).length,
    profile: sources.profile,
    evaluatedCandidateCount: jobs.length,
    ...summarizeBoundedJobResults({
      evaluatedCandidateCount: jobs.length,
      evaluatedMatchingCount: matching.length,
      totalCandidateCount: candidateCount,
      visibleCount: visible.length
    })
  };
}

type JobsPageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const params = (await searchParams) ?? {};
  const userId = await requirePageUserId();
  const filters = parseFeedFilters(params);
  const [feed, savedPreference, profile] = await Promise.all([
    getFeed(userId, filters),
    prisma.jobDiscoveryPreference.findUnique({
      where: { userId },
      select: { targetSearches: true, location: true, limitPerQuery: true, remoteOnly: true, scoreImported: true }
    }),
    prisma.userProfile.findUnique({ where: { userId }, select: { preferredRoles: true, preferredLocations: true, location: true } })
  ]);
  const initialDiscoveryPreferences = resolveInitialJobDiscoveryPreferences({ savedPreference, profile });
  const filtered = feedHref(filters) !== "/jobs";
  const selected = feed.selected;
  const summary = `${feed.visible.length} ${feed.visible.length === 1 ? "job" : "jobs"} · ${feed.scoredCount} scored`;

  return (
    <div className="product-page product-page-themed job-feed" data-job-feed>
      <div className="feed-top">
        <div>
          <h1 className="job-title">Jobs for you</h1>
          <p className="job-card-copy">Openings from employers&apos; own job boards. Fit percentages are Apply Pilot&apos;s estimates from your résumé, not employer scores.</p>
        </div>
        <details className="feed-add" open={!feed.visible.length && !filtered ? true : undefined}>
          <summary className="job-button"><Plus size={16} aria-hidden="true" />Add jobs</summary>
          <div className="feed-add-panels">
            <Panel tone="branded">
              <PanelHeader title="Find jobs automatically" description="Search allowed sources and import matches. Nothing is applied for you." tone="branded" />
              <div className="p-5">
                <AutomatedJobDiscoveryPanel key={userId} initialPreferences={initialDiscoveryPreferences} tone="branded" />
              </div>
            </Panel>
            <Panel tone="branded">
              <PanelHeader title="Paste a job" description="Add a job you found on a permitted site." tone="branded" />
              <div className="p-5">
                <ManualJobImportForm tone="branded" />
              </div>
            </Panel>
          </div>
        </details>
      </div>

      {feed.omittedCandidateCount > 0 || feed.unevaluatedCandidateCount > 0 ? (
        <div className="mb-4">
          <JobMatchOmissionNotice
            evaluatedCandidateCount={feed.evaluatedCandidateCount}
            omittedCandidateCount={feed.omittedCandidateCount}
            unevaluatedCandidateCount={feed.unevaluatedCandidateCount}
            viewLabel="jobs view"
          />
        </div>
      ) : null}

      <FeedFilterBar filters={filters} resultSummary={summary} />

      <div className="feed-layout" data-explicit-selection={feed.explicitSelection}>
        <section className="feed-list" aria-label="Jobs">
          {feed.visible.length ? (
            <ol className="feed-list-items">
              {feed.visible.map(({ job, score }) => {
                const view = buildJobDetailView(job);
                return (
                  <li key={job.id}>
                    <FeedCard job={{
                      id: view.id, title: view.title, company: view.company, location: view.location, workStyle: view.workStyle,
                      salary: view.salary, postedAge: view.postedAge, source: view.source, score,
                      href: feedHref(filters, { job: job.id }, { keepJob: true }),
                      selected: selected?.job.id === job.id,
                      trackerStatus: job.applications[0] ? formatApplicationStatus(job.applications[0].status) : null
                    }} />
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="job-card feed-empty">
              <p className="job-card-title">{filtered ? "No jobs match these filters" : "No jobs yet"}</p>
              <p className="job-card-copy">
                {filtered
                  ? "Try fewer filters or a broader search."
                  : "Use Add jobs to find openings on employers' job boards, or paste in a job you found."}
              </p>
              {filtered ? <Link href="/jobs" className="job-button">Clear filters</Link> : null}
            </div>
          )}
        </section>
        {selected ? (
          <FeedPreview
            key={selected.job.id}
            job={buildJobDetailView(selected.job)}
            estimate={selected.estimate ? buildEstimateView(selected.estimate) : null}
            checklist={(() => {
              const checklist = buildRequirementChecklist(selected.job.requirements, selected.estimate?.analysis.output ?? null);
              return { items: checklist.items, counts: checklist.counts };
            })()}
            salaryTarget={feed.profile ? { min: feed.profile.salaryTargetMin, max: feed.profile.salaryTargetMax } : null}
            application={selected.job.applications[0] ? { statusLabel: formatApplicationStatus(selected.job.applications[0].status) } : null}
            backHref={feedHref(filters)}
          />
        ) : null}
      </div>
    </div>
  );
}
