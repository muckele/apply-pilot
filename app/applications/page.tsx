import { CalendarDays, Filter } from "lucide-react";
import Link from "next/link";

import { PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

const pipeline = [
  { key: "SAVED", label: "Saved" },
  { key: "INTERESTED", label: "Interested" },
  { key: "APPLIED", label: "Applied" },
  { key: "RECRUITER_SCREEN", label: "Recruiter screen" }
];

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not set";
}

export default async function ApplicationsPage() {
  const userId = await requirePageUserId();
  const applications = await prisma.application.findMany({
    where: { userId },
    include: { jobPosting: true },
    orderBy: [{ updatedAt: "desc" }],
    take: 100
  });

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
        {pipeline.map((stage) => (
          <Panel key={stage.key} className="min-h-64">
            <PanelHeader title={stage.label} />
            <div className="space-y-3 p-3">
              {applications
                .filter((application) => application.status === stage.key)
                .map((application) => (
                  <Link
                    key={application.id}
                    href={`/applications/${application.id}`}
                    className="block rounded-lg border border-slate-200 bg-white p-3 hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{application.jobPosting.company}</p>
                        <p className="text-xs leading-5 text-slate-500">{application.jobPosting.title}</p>
                      </div>
                      <ScoreBadge score={application.jobPosting.overallFitScore ?? 50} />
                    </div>
                    <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                      <CalendarDays size={14} aria-hidden="true" />
                      {formatDate(application.followUpDueAt)}
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
              {applications.length ? (
                applications.map((application) => (
                  <tr key={application.id}>
                    <td className="px-5 py-4 font-medium text-slate-950">{application.jobPosting.company}</td>
                    <td className="px-5 py-4 text-slate-700">
                      <Link href={`/applications/${application.id}`} className="hover:text-brand-700">
                        {application.jobPosting.title}
                      </Link>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={application.status} /></td>
                    <td className="px-5 py-4 text-slate-600">{formatDate(application.dateApplied)}</td>
                    <td className="px-5 py-4 text-slate-600">{formatDate(application.followUpDueAt)}</td>
                    <td className="px-5 py-4"><ScoreBadge score={application.jobPosting.overallFitScore ?? 50} /></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-600">
                    No applications yet. Save or mark a job as applied from a job detail page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
