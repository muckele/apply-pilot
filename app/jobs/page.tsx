import { Filter, Search } from "lucide-react";

import { JobCard } from "@/components/job-card";
import { ManualJobImportForm } from "@/components/manual-job-import-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoJobs } from "@/lib/demo-data";

export default function JobsPage() {
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Discover, import, deduplicate, and score recent jobs from compliant sources only."
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

          {demoJobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </section>

        <Panel className="h-fit">
          <PanelHeader
            title="Manual job import"
            description="Paste job details from a permitted source or a job board you reviewed manually."
          />
          <div className="p-5">
            <ManualJobImportForm />
          </div>
        </Panel>
      </div>
    </>
  );
}
