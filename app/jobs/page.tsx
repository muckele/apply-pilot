import { Filter, Search } from "lucide-react";

import { AutomatedJobDiscoveryPanel } from "@/components/automated-job-discovery-panel";
import { JobCard } from "@/components/job-card";
import { ManualJobImportForm } from "@/components/manual-job-import-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { auth } from "@/lib/auth";
import { demoJobs } from "@/lib/demo-data";
import { prisma } from "@/lib/prisma";

async function getJobsForPage() {
  const session = await auth();
  const userId =
    session?.user?.id ??
    (process.env.ALLOW_DEMO_USER === "true" ? (process.env.DEFAULT_DEMO_USER_ID ?? "demo-user") : null);

  if (!userId) {
    return demoJobs;
  }

  const jobs = await prisma.jobPosting.findMany({
    where: { userId },
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
    keyReason:
      job.keyMatchReason ??
      "Imported from an allowed source. Run fit scoring to generate a targeted match summary."
  }));
}

export default async function JobsPage() {
  const jobs = await getJobsForPage();

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Discover, import, deduplicate, and score recent jobs from compliant APIs, ATS feeds, RSS feeds, and permitted company career pages."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-soft md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={17} aria-hidden="true" />
              <input
                placeholder="Search title, company, keyword, or location"
                className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Filter size={16} aria-hidden="true" />
              Filters
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {["Status", "Company", "Role type", "Location", "Remote", "Score", "Date posted"].map((filter) => (
              <StatusBadge key={filter} status={filter} />
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
