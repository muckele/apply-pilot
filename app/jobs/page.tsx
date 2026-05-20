import { Filter, Search } from "lucide-react";
import type { Prisma } from "@prisma/client";

import { AutomatedJobDiscoveryPanel } from "@/components/automated-job-discovery-panel";
import { JobCard } from "@/components/job-card";
import { ManualJobImportForm } from "@/components/manual-job-import-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { auth } from "@/lib/auth";
import { demoJobs } from "@/lib/demo-data";
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

async function getJobsForPage(params: SearchParams) {
  const session = await auth();
  const userId =
    session?.user?.id ??
    (process.env.ALLOW_DEMO_USER === "true" ? (process.env.DEFAULT_DEMO_USER_ID ?? "demo-user") : null);

  if (!userId) {
    return demoJobs;
  }

  const filters = parseFilters(params);
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
    orderBy: [{ overallFitScore: "desc" }, { datePosted: "desc" }, { firstDiscoveredAt: "desc" }],
    take: 40
  });

  return jobs.map((job) => ({
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
    keyReason:
      job.keyMatchReason ??
      "Imported from an allowed source. Run fit scoring to generate a targeted match summary."
  }));
}

type JobsPageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const params = (await searchParams) ?? {};
  const filters = parseFilters(params);
  const jobs = await getJobsForPage(params);

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Discover, import, deduplicate, and score recent jobs from compliant APIs, ATS feeds, RSS feeds, and permitted company career pages."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <form className="rounded-lg border border-slate-200 bg-white p-3 shadow-soft">
            <div className="relative flex-1">
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
              <select name="status" defaultValue={filters.status} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">All statuses</option>
                {postingStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status.replaceAll("_", " ")}
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
                <StatusBadge key={String(filter)} status={String(filter)} />
              ))}
          </div>

          {jobs.length ? (
            jobs.map((job) => <JobCard key={job.id} job={job} />)
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
              <p className="text-sm font-semibold text-slate-950">No jobs imported yet</p>
              <p className="mt-1 text-sm text-slate-600">Run automated discovery to populate your CRM.</p>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <Panel className="h-fit">
            <PanelHeader
              title="Automated discovery"
              description="Search allowed sources and import matches without auto-applying."
            />
            <div className="p-5">
              <AutomatedJobDiscoveryPanel />
            </div>
          </Panel>

          <Panel className="h-fit">
            <PanelHeader
              title="Manual job import"
              description="Paste job details from a permitted source or a job board you reviewed manually."
            />
            <div className="p-5">
              <ManualJobImportForm />
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
