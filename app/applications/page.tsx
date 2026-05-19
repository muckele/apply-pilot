import { CalendarDays, Filter } from "lucide-react";
import Link from "next/link";

import { PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { demoApplications } from "@/lib/demo-data";

const pipeline = [
  "Saved",
  "Interested",
  "Applied",
  "Recruiter screen",
  "Hiring manager",
  "Technical",
  "Final",
  "Offer"
];

export default function ApplicationsPage() {
  return (
    <>
      <PageHeader
        title="Applications"
        description="Track the full pipeline from saved jobs through interviews, offers, rejections, and lessons learned."
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {["Status", "Company", "Role type", "Location", "Remote", "Score", "Date applied", "Follow-up needed"].map(
          (filter) => (
            <button
              key={filter}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter size={14} aria-hidden="true" />
              {filter}
            </button>
          )
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        {pipeline.slice(0, 4).map((stage) => (
          <Panel key={stage} className="min-h-64">
            <PanelHeader title={stage} />
            <div className="space-y-3 p-3">
              {demoApplications
                .filter((application) => application.status === stage || (stage === "Saved" && application.status === "Interested"))
                .map((application) => (
                  <Link
                    key={application.id}
                    href={`/applications/${application.id}`}
                    className="block rounded-lg border border-slate-200 bg-white p-3 hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{application.company}</p>
                        <p className="text-xs leading-5 text-slate-500">{application.title}</p>
                      </div>
                      <ScoreBadge score={application.score} />
                    </div>
                    <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                      <CalendarDays size={14} aria-hidden="true" />
                      {application.followUpDue}
                    </p>
                  </Link>
                ))}
            </div>
          </Panel>
        ))}
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Application table" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3">Company</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Applied</th>
                <th className="px-5 py-3">Follow-up</th>
                <th className="px-5 py-3">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {demoApplications.map((application) => (
                <tr key={application.id}>
                  <td className="px-5 py-4 font-medium text-slate-950">{application.company}</td>
                  <td className="px-5 py-4 text-slate-700">{application.title}</td>
                  <td className="px-5 py-4"><StatusBadge status={application.status} /></td>
                  <td className="px-5 py-4 text-slate-600">{application.dateApplied || "Not applied"}</td>
                  <td className="px-5 py-4 text-slate-600">{application.followUpDue}</td>
                  <td className="px-5 py-4"><ScoreBadge score={application.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
