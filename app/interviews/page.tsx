import Link from "next/link";

import { InterviewCreateForm } from "@/components/interview-create-form";
import { ButtonLink, PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatDate(value: Date | null) {
  return value ? value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled";
}

export default async function InterviewsPage() {
  const userId = await requirePageUserId();
  const [interviews, applications, jobs] = await Promise.all([
    prisma.interview.findMany({
      where: { userId },
      include: { jobPosting: true, application: { include: { jobPosting: true } } },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
      take: 50
    }),
    prisma.application.findMany({
      where: { userId, status: { notIn: ["ARCHIVED", "REJECTED", "GHOSTED"] } },
      include: { jobPosting: true },
      orderBy: { updatedAt: "desc" },
      take: 50
    }),
    prisma.jobPosting.findMany({
      where: { userId, status: { in: ["ACTIVE", "APPLIED", "INTERVIEW"] } },
      orderBy: [{ overallFitScore: "desc" }, { firstDiscoveredAt: "desc" }],
      take: 50,
      select: { id: true, title: true, company: true }
    })
  ]);

  return (
    <>
      <PageHeader
        title="Interviews"
        description="Prepare, take notes, upload consented audio, generate feedback, and draft thank-you emails for review."
        action={<ButtonLink href="/interviews/library" variant="secondary">Question and STAR library</ButtonLink>}
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
          <InterviewCreateForm
            applications={applications.map((application) => ({
              id: application.id,
              jobPostingId: application.jobPostingId,
              label: `${application.jobPosting.company} - ${application.jobPosting.title}`
            }))}
            jobs={jobs.map((job) => ({
              id: job.id,
              label: `${job.company} - ${job.title}`
            }))}
          />
        </Panel>
      </div>
    </>
  );
}
