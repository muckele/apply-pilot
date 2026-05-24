import { CalendarPlus } from "lucide-react";
import Link from "next/link";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatDate(value: Date | null) {
  return value ? value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled";
}

export default async function InterviewsPage() {
  const userId = await requirePageUserId();
  const interviews = await prisma.interview.findMany({
    where: { userId },
    include: { jobPosting: true, application: { include: { jobPosting: true } } },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    take: 50
  });

  return (
    <>
      <PageHeader
        title="Interviews"
        description="Prepare, take notes, upload consented audio, generate feedback, and draft thank-you emails for review."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel>
          <PanelHeader title="Upcoming interviews" />
          <div className="divide-y divide-slate-100">
            {interviews.length ? (
              interviews.map((interview) => {
                const job = interview.jobPosting ?? interview.application?.jobPosting;

                return (
                  <Link key={interview.id} href={`/interviews/${interview.id}`} className="block px-5 py-4 hover:bg-slate-50">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{job?.company ?? "Company not linked"}</p>
                        <p className="text-xs text-slate-500">{job?.title ?? "Interview"} · {formatDate(interview.scheduledAt)}</p>
                      </div>
                      <div className="flex gap-2">
                        <StatusBadge status={interview.type} />
                        <StatusBadge status={interview.prepBrief ? "Prep ready" : "Prep needed"} />
                      </div>
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="px-5 py-8 text-center text-sm text-slate-600">No interviews scheduled yet.</div>
            )}
          </div>
        </Panel>

        <Panel className="h-fit">
          <PanelHeader title="Add interview" />
          <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
            <p>Add interviews from an application or job record so prep can use the correct context.</p>
            <button disabled className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-500">
              <CalendarPlus size={16} aria-hidden="true" />
              Save interview
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}
