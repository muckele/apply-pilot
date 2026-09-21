import { Filter, Inbox, Search } from "lucide-react";
import type { Prisma } from "@prisma/client";
import Link from "next/link";

import { JobReviewActions } from "@/components/job-review-actions";
import { PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { reviewCategoryInfo, reviewCategoryOrder, mapJobForReviewQueue } from "@/lib/jobs/review-queue";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type SearchParams = Record<string, string | string[] | undefined>;

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
const crmStatuses = ["Not saved", "Saved", "Interested"];
const reviewableApplicationStatuses = ["SAVED", "INTERESTED"] as const;

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
    datePosted: Number(firstParam(params, "datePosted") ?? 30),
    company: firstParam(params, "company")?.trim() ?? "",
    roleType: firstParam(params, "roleType")?.trim() ?? "",
    crmStatus: firstParam(params, "crmStatus") ?? ""
  };
}

function applicationStatusLabel(status?: string) {
  if (!status) return "Not saved";
  return status.replaceAll("_", " ");
}

async function getReviewQueue(params: SearchParams) {
  const userId = await requirePageUserId();
  const filters = parseFilters(params);
  const where: Prisma.JobPostingWhereInput = {
    userId,
    status: { notIn: ["ARCHIVED", "APPLIED"] }
  };
  const andConditions: Prisma.JobPostingWhereInput[] = [
    {
      OR: [
        { applications: { none: { userId } } },
        { applications: { some: { userId, status: { in: [...reviewableApplicationStatuses] } } } }
      ]
    }
  ];

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

  if (Number.isInteger(filters.minFitScore) && filters.minFitScore > 0) {
    where.overallFitScore = { gte: filters.minFitScore };
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

  const jobs = await prisma.jobPosting.findMany({
    where,
    include: {
      applications: {
        where: { userId },
        select: { status: true },
        take: 1
      }
    },
    orderBy: [{ overallFitScore: "desc" }, { firstDiscoveredAt: "desc" }, { datePosted: "desc" }],
    take: 100
  });

  const queueJobs = jobs
    .map((job) =>
      mapJobForReviewQueue(
        job,
        jobs,
        job.applications[0]?.status
      )
    )
    .filter((job) => {
      if (!filters.crmStatus) return true;
      return applicationStatusLabel(job.applicationStatus).toLowerCase() === filters.crmStatus.toLowerCase();
    });

  const counts = Object.fromEntries(reviewCategoryOrder.map((category) => [category, 0])) as Record<
    (typeof reviewCategoryOrder)[number],
    number
  >;
  queueJobs.forEach((job) => {
    counts[job.category] += 1;
  });

  return { filters, queueJobs, counts };
}

type JobsReviewPageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function JobsReviewPage({ searchParams }: JobsReviewPageProps) {
  const params = (await searchParams) ?? {};
  const { filters, queueJobs, counts } = await getReviewQueue(params);

  return (
    <>
      <PageHeader
        title="Job review queue"
        description="Triage newly discovered jobs before they become CRM clutter. Save, archive, score, or move high-fit jobs into the apply-packet workflow."
        action={
          <Link
            href="/jobs"
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            All jobs
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          <form className="rounded-lg border border-slate-200 bg-white p-3 shadow-soft">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={17} aria-hidden="true" />
              <input
                name="q"
                defaultValue={filters.q}
                placeholder="Search title, company, keyword, or location"
                className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3 xl:grid-cols-4">
              <select name="source" defaultValue={filters.source} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">All sources</option>
                {sourceTypes.map((source) => (
                  <option key={source} value={source}>
                    {source.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <select name="workStyle" defaultValue={filters.workStyle} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Any work style</option>
                {workStyles.map((workStyle) => (
                  <option key={workStyle} value={workStyle}>
                    {workStyle}
                  </option>
                ))}
              </select>
              <select name="datePosted" defaultValue={filters.datePosted || ""} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Any date</option>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
                <option value="60">Last 60 days</option>
              </select>
              <select name="crmStatus" defaultValue={filters.crmStatus} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Any CRM state</option>
                {crmStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <input
                name="company"
                defaultValue={filters.company}
                placeholder="Company"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <input
                name="roleType"
                defaultValue={filters.roleType}
                placeholder="Role type"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <input
                name="minFitScore"
                type="number"
                min={0}
                max={100}
                defaultValue={filters.minFitScore || ""}
                placeholder="Minimum fit score"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                <Filter size={16} aria-hidden="true" />
                Apply filters
              </button>
            </div>
          </form>

          {queueJobs.length ? (
            reviewCategoryOrder.map((category) => {
              const jobs = queueJobs.filter((job) => job.category === category);
              if (!jobs.length) return null;
              const info = reviewCategoryInfo[category];

              return (
                <Panel key={category}>
                  <PanelHeader title={info.label} description={info.description} action={<StatusBadge status={`${jobs.length} job${jobs.length === 1 ? "" : "s"}`} />} />
                  <div className="divide-y divide-slate-100">
                    {jobs.map((job) => (
                      <article key={job.id} className="space-y-4 px-5 py-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={`/jobs/${job.id}`} className="text-base font-semibold text-slate-950 hover:text-brand-700">
                                {job.title}
                              </Link>
                              {job.fitScore !== null ? <ScoreBadge score={job.fitScore} /> : <StatusBadge status="Unscored" />}
                              <StatusBadge status={applicationStatusLabel(job.applicationStatus)} />
                              <StatusBadge status={job.sourceType} />
                            </div>
                            <p className="mt-1 text-sm text-slate-600">
                              {job.company} · {job.location} · {job.remoteStatus} · {job.salary}
                            </p>
                            <p className="mt-2 text-xs text-slate-500">
                              Posted {job.datePosted} · Discovered {job.discoveredAt}
                            </p>
                          </div>
                          <StatusBadge status={job.recommendation} />
                        </div>

                        <p className="text-sm leading-6 text-slate-700">{job.keyReason}</p>

                        {job.flags.length ? (
                          <div className="flex flex-wrap gap-2">
                            {job.flags.map((flag) => (
                              <span key={flag} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                                {flag}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                          <summary className="cursor-pointer font-semibold text-slate-900">Why this is in the queue</summary>
                          <div className="mt-3 grid gap-4 md:grid-cols-2">
                            <div>
                              <p className="text-xs font-semibold uppercase text-slate-500">Why it matched</p>
                              <ul className="mt-2 space-y-1 leading-6">
                                {job.whyMatched.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <p className="text-xs font-semibold uppercase text-slate-500">Review notes</p>
                              <ul className="mt-2 space-y-1 leading-6">
                                {job.whyReviewNeeded.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </details>

                        <JobReviewActions jobId={job.id} applyUrl={job.applyUrl} />
                      </article>
                    ))}
                  </div>
                </Panel>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
              <Inbox className="mx-auto text-slate-400" size={28} aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-slate-950">No jobs in the review queue</p>
              <p className="mt-1 text-sm text-slate-600">Run job discovery or adjust the filters to review more jobs.</p>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Queue summary" />
            <div className="space-y-3 p-5">
              {reviewCategoryOrder.map((category) => {
                const info = reviewCategoryInfo[category];

                return (
                  <div key={category} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm font-medium text-slate-700">{info.label}</span>
                    <StatusBadge status={String(counts[category])} />
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Review rules" />
            <div className="space-y-3 p-5 text-sm leading-6 text-slate-700">
              <p>Save jobs you may apply to later. Mark interested when the job deserves packet work.</p>
              <p>Archive weak or stale jobs so the main Jobs page stays usable.</p>
              <p>Opening an apply link never submits an application. You still apply manually.</p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
