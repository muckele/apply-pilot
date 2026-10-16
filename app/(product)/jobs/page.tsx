import { Filter, Search } from "lucide-react";
import type { Prisma } from "@prisma/client";

import { AutomatedJobDiscoveryPanel } from "@/components/automated-job-discovery-panel";
import { JobCard } from "@/components/job-card";
import { ManualJobImportForm } from "@/components/manual-job-import-form";
import {
  JobMatchOmissionNotice,
  summarizeBoundedJobResults
} from "@/components/job-match-omission-notice";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { resolveInitialJobDiscoveryPreferences } from "@/lib/job-sources/discovery-preferences";
import {
  CURRENT_JOB_MATCH_ANALYSES,
  JOB_MATCH_LIST_CANDIDATE_LIMIT,
  buildCurrentJobMatchContext,
  currentJobMatchFields,
  hasCurrentJobMatchAnalysis,
  readCurrentJobMatchSources
} from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type SearchParams = Record<string, string | string[] | undefined>;

const postingStatuses = ["ACTIVE", "EXPIRED", "APPLIED", "REJECTED", "INTERVIEW", "OFFER", "ARCHIVED"];
const sourceTypes = [
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "WORKABLE",
  "USAJOBS",
  "REMOTIVE",
  "ADZUNA",
  "THEIRSTACK",
  "SERPAPI",
  "RSS",
  "COMPANY_CAREERS",
  "MANUAL"
];
const workStyles = ["Remote", "Hybrid", "On-site"];

function firstParam(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(params: SearchParams = {}) {
  return {
    q: firstParam(params, "q")?.trim() ?? "",
    source: firstParam(params, "source") ?? "",
    minFitScore: Number(firstParam(params, "minFitScore") ?? ""),
    workStyle: firstParam(params, "workStyle") ?? "",
    datePosted: Number(firstParam(params, "datePosted") ?? ""),
    status: firstParam(params, "status") ?? "",
    company: firstParam(params, "company")?.trim() ?? "",
    roleType: firstParam(params, "roleType")?.trim() ?? ""
  };
}

async function getJobsForPage(params: SearchParams, userId: string) {
  const filters = parseFilters(params);
  const hasMinFitScore = Number.isInteger(filters.minFitScore) && filters.minFitScore > 0;
  const sources = await readCurrentJobMatchSources(userId);
  const where: Prisma.JobPostingWhereInput = { userId };
  const andConditions: Prisma.JobPostingWhereInput[] = [];

  if (filters.q) {
    andConditions.push({
      OR: [
        { title: { contains: filters.q, mode: "insensitive" } },
        { company: { contains: filters.q, mode: "insensitive" } },
        { location: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } }
      ]
    });
  }

  if (filters.source && sourceTypes.includes(filters.source)) {
    where.sourceType = filters.source as Prisma.JobPostingWhereInput["sourceType"];
  }

  if (filters.status && postingStatuses.includes(filters.status)) {
    where.status = filters.status as Prisma.JobPostingWhereInput["status"];
  }

  if (filters.company) {
    where.company = { contains: filters.company, mode: "insensitive" };
  }

  if (filters.roleType) {
    where.title = { contains: filters.roleType, mode: "insensitive" };
  }

  if (filters.workStyle) {
    andConditions.push({
      OR: [
        { remoteStatus: { contains: filters.workStyle, mode: "insensitive" } },
        { location: { contains: filters.workStyle, mode: "insensitive" } }
      ]
    });
  }

  if (Number.isInteger(filters.datePosted) && filters.datePosted > 0) {
    const since = new Date(Date.now() - filters.datePosted * 86_400_000);
    andConditions.push({
      OR: [{ datePosted: { gte: since } }, { firstDiscoveredAt: { gte: since } }]
    });
  }

  if (andConditions.length) {
    where.AND = andConditions;
  }

  const [jobs, candidateCount] = await Promise.all([
    prisma.jobPosting.findMany({
      where,
      include: { aiAnalyses: CURRENT_JOB_MATCH_ANALYSES, currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } },
      orderBy: [{ overallFitScore: "desc" }, { datePosted: "desc" }, { firstDiscoveredAt: "desc" }],
      take: hasMinFitScore ? JOB_MATCH_LIST_CANDIDATE_LIMIT : 40
    }),
    prisma.jobPosting.count({ where })
  ]);

  const matchingJobs = jobs.map((job) => {
    const context = buildCurrentJobMatchContext({ job, ...sources });
    const currentJob = currentJobMatchFields(job, hasCurrentJobMatchAnalysis({
      ...job,
      currentEvidenceSourceValid: context.currentEvidenceSourceValid
    }, context.matchInput));
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
      fitScore: currentJob.overallFitScore,
      status: job.status,
      sourceType: job.sourceType,
      keyReason:
        currentJob.keyMatchReason ??
        "Imported from an allowed source. Run fit scoring to generate a targeted match summary."
    };
  }).filter((job) => !hasMinFitScore ||
    (job.fitScore !== null && job.fitScore >= filters.minFitScore));
  const visibleJobs = matchingJobs.slice(0, 40);
  return {
    jobs: visibleJobs,
    evaluatedCandidateCount: jobs.length,
    ...summarizeBoundedJobResults({
      evaluatedCandidateCount: jobs.length,
      evaluatedMatchingCount: matchingJobs.length,
      totalCandidateCount: candidateCount,
      visibleCount: visibleJobs.length
    })
  };
}

type JobsPageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const params = (await searchParams) ?? {};
  const userId = await requirePageUserId();
  const filters = parseFilters(params);
  const [jobResult, savedPreference, profile] = await Promise.all([
    getJobsForPage(params, userId),
    prisma.jobDiscoveryPreference.findUnique({
      where: { userId },
      select: {
        targetSearches: true,
        location: true,
        limitPerQuery: true,
        remoteOnly: true,
        scoreImported: true
      }
    }),
    prisma.userProfile.findUnique({
      where: { userId },
      select: {
        preferredRoles: true,
        preferredLocations: true,
        location: true
      }
    })
  ]);
  const { jobs, evaluatedCandidateCount, omittedCandidateCount, unevaluatedCandidateCount } = jobResult;
  const initialDiscoveryPreferences = resolveInitialJobDiscoveryPreferences({
    savedPreference,
    profile
  });

  return (
    <div className="product-page product-page-themed">
      <PageHeader
        title="Jobs"
        description="Discover, import, deduplicate, and score recent jobs from compliant APIs, ATS feeds, RSS feeds, and permitted company career pages."
        tone="branded"
      />
      {omittedCandidateCount > 0 || unevaluatedCandidateCount > 0 ? (
        <div className="mb-4">
          <JobMatchOmissionNotice
            evaluatedCandidateCount={evaluatedCandidateCount}
            omittedCandidateCount={omittedCandidateCount}
            unevaluatedCandidateCount={unevaluatedCandidateCount}
            viewLabel="jobs view"
          />
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <form className="product-surface rounded-xl border p-4" aria-label="Filter jobs">
            <div className="relative flex-1">
              <label className="sr-only" htmlFor="job-search">Search jobs</label>
              <Search className="product-themed-accent absolute left-3 top-3.5" size={17} aria-hidden="true" />
              <input
                id="job-search"
                name="q"
                defaultValue={filters.q}
                placeholder="Search title, company, keyword, or location"
                className="product-filter-control w-full rounded-lg border py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <div className="product-filter-grid mt-3">
              <label className="sr-only" htmlFor="job-source">Source</label>
              <select id="job-source" name="source" defaultValue={filters.source} className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm">
                <option value="">All sources</option>
                {sourceTypes.map((source) => (
                  <option key={source} value={source}>
                    {source.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="job-status">Status</label>
              <select id="job-status" name="status" defaultValue={filters.status} className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm">
                <option value="">All statuses</option>
                {postingStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="job-work-style">Work style</label>
              <select id="job-work-style" name="workStyle" defaultValue={filters.workStyle} className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm">
                <option value="">Any work style</option>
                {workStyles.map((workStyle) => (
                  <option key={workStyle} value={workStyle}>
                    {workStyle}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="job-date-posted">Date posted</label>
              <select id="job-date-posted" name="datePosted" defaultValue={filters.datePosted || ""} className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm">
                <option value="">Any date</option>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
              <input
                id="job-company"
                name="company"
                defaultValue={filters.company}
                placeholder="Company"
                aria-label="Company"
                className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm"
              />
              <input
                id="job-role-type"
                name="roleType"
                defaultValue={filters.roleType}
                placeholder="Role type"
                aria-label="Role type"
                className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm"
              />
              <input
                id="job-min-fit-score"
                name="minFitScore"
                type="number"
                min={0}
                max={100}
                defaultValue={filters.minFitScore || ""}
                placeholder="Minimum fit score"
                aria-label="Minimum fit score"
                className="product-filter-control min-w-0 rounded-lg border px-3 py-2 text-sm"
              />
              <button className="product-primary-action inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold">
                <Filter size={16} aria-hidden="true" />
                Apply filters
              </button>
            </div>
          </form>

          <div className="flex flex-wrap gap-2">
            {[
              filters.source && `Source: ${filters.source}`,
              filters.minFitScore && `Score: ${filters.minFitScore}+`,
              filters.workStyle && `Work style: ${filters.workStyle}`,
              filters.datePosted && `Posted: ${filters.datePosted} days`,
              filters.status && `Status: ${filters.status}`,
              filters.company && `Company: ${filters.company}`,
              filters.roleType && `Role: ${filters.roleType}`
            ]
              .filter(Boolean)
              .map((filter) => (
                <StatusBadge key={String(filter)} status={String(filter)} tone="branded" />
              ))}
          </div>

          {jobs.length ? (
            jobs.map((job) => <JobCard key={job.id} job={job} tone="branded" />)
          ) : (
            <div className="product-surface rounded-xl border border-dashed p-8 text-center">
              <p className="product-themed-title text-sm font-semibold">No jobs imported yet</p>
              <p className="product-themed-muted mt-1 text-sm">Run automated discovery to populate your CRM.</p>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <Panel className="h-fit" tone="branded">
            <PanelHeader
              title="Automated discovery"
              description="Search allowed sources and import matches without auto-applying."
              tone="branded"
            />
            <div className="p-5">
              <AutomatedJobDiscoveryPanel
                key={userId}
                initialPreferences={initialDiscoveryPreferences}
                tone="branded"
              />
            </div>
          </Panel>

          <Panel className="h-fit" tone="branded">
            <PanelHeader
              title="Manual job import"
              description="Paste job details from a permitted source or a job board you reviewed manually."
              tone="branded"
            />
            <div className="p-5">
              <ManualJobImportForm tone="branded" />
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
