import type { ApplicationStatus, Prisma } from "@prisma/client";
import { AlertCircle, CalendarDays, Filter, Search, TrendingUp } from "lucide-react";
import Link from "next/link";

import { ApplicationStatusActions } from "@/components/application-status-actions";
import { ButtonLink, MetricCard, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import {
  activeApplicationStatuses,
  applicationPipelineLanes,
  applicationStatusOptions,
  formatApplicationStatus,
  getApplicationAttention
} from "@/lib/applications/pipeline";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type SearchParams = Record<string, string | string[] | undefined>;

type ApplicationsPageProps = {
  searchParams?: Promise<SearchParams>;
};

type ApplicationFilters = {
  q: string;
  status: ApplicationStatus | "";
  attention: boolean;
};

function firstParam(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(params: SearchParams = {}): ApplicationFilters {
  const status = firstParam(params, "status") ?? "";

  return {
    q: firstParam(params, "q")?.trim() ?? "",
    status: applicationStatusOptions.some((option) => option.value === status) ? (status as ApplicationStatus) : "",
    attention: firstParam(params, "attention") === "needs_attention"
  };
}

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not set";
}

function attentionTone(level: "high" | "medium" | "low") {
  if (level === "high") return "border-rose-200 bg-rose-50 text-rose-700";
  if (level === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default async function ApplicationsPage({ searchParams }: ApplicationsPageProps) {
  const userId = await requirePageUserId();
  const params = (await searchParams) ?? {};
  const filters = parseFilters(params);
  const where: Prisma.ApplicationWhereInput = filters.status ? { userId, status: filters.status } : { userId };
  const andConditions: Prisma.ApplicationWhereInput[] = [];
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);

  if (filters.q) {
    andConditions.push({
      OR: [
        { nextAction: { contains: filters.q, mode: "insensitive" } },
        { notes: { contains: filters.q, mode: "insensitive" } },
        { jobPosting: { is: { company: { contains: filters.q, mode: "insensitive" } } } },
        { jobPosting: { is: { title: { contains: filters.q, mode: "insensitive" } } } },
        { jobPosting: { is: { location: { contains: filters.q, mode: "insensitive" } } } },
        { jobPosting: { is: { remoteStatus: { contains: filters.q, mode: "insensitive" } } } }
      ]
    });
  }

  if (andConditions.length) {
    where.AND = andConditions;
  }

  const applicationInclude = {
    jobPosting: true,
    emails: { orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }], take: 5 },
    interviews: { orderBy: { scheduledAt: "asc" } },
    tasks: { where: { status: "OPEN" }, orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }] }
  } satisfies Prisma.ApplicationInclude;

  const [applications, metricApplications] = await Promise.all([
    prisma.application.findMany({
      where,
      include: applicationInclude,
      orderBy: [{ updatedAt: "desc" }],
      take: 200
    }),
    prisma.application.findMany({
      where: { userId },
      include: applicationInclude,
      orderBy: [{ updatedAt: "desc" }],
      take: 500
    })
  ]);

  const commandCenterApplications = applications
    .map((application) => ({
      application,
      attention: getApplicationAttention(application, now)
    }))
    .filter((item) => (filters.attention ? Boolean(item.attention) : true));

  const metricItems = metricApplications.map((application) => ({
    application,
    attention: getApplicationAttention(application, now)
  }));
  const attentionItems = commandCenterApplications.filter((item) => item.attention);
  const globalAttentionCount = metricItems.filter((item) => item.attention).length;
  const activeCount = metricItems.filter((item) =>
    activeApplicationStatuses.includes(item.application.status)
  ).length;
  const appliedThisWeek = metricItems.filter(
    (item) => item.application.dateApplied && item.application.dateApplied >= weekStart
  ).length;
  const openInterviewCount = metricItems.filter((item) =>
    ["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW"].includes(
      item.application.status
    )
  ).length;

  return (
    <>
      <PageHeader
        title="Applications"
        description="Work the application pipeline, update statuses, and focus on the records that need follow-up."
        action={<ButtonLink href="/jobs/review">Review jobs</ButtonLink>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Active records" value={activeCount} detail="Open pipeline" />
        <MetricCard label="Needs attention" value={globalAttentionCount} detail="Follow-up, email, prep, or offer" />
        <MetricCard label="Applied" value={appliedThisWeek} detail="This week" />
        <MetricCard label="Interview stages" value={openInterviewCount} detail="Screens and interviews" />
      </div>

      <form className="mt-5 rounded-lg border border-slate-200 bg-white p-3 shadow-soft">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px_160px]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={17} aria-hidden="true" />
            <input
              name="q"
              defaultValue={filters.q}
              placeholder="Search company, role, location, or next action"
              className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            name="status"
            defaultValue={filters.status}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
          >
            <option value="">All statuses</option>
            {applicationStatusOptions.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
          <select
            name="attention"
            defaultValue={filters.attention ? "needs_attention" : ""}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
          >
            <option value="">All records</option>
            <option value="needs_attention">Needs attention</option>
          </select>
          <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Filter size={16} aria-hidden="true" />
            Apply filters
          </button>
        </div>
      </form>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_360px]">
        <section className="space-y-4">
          <Panel>
            <PanelHeader
              title="Pipeline command center"
              description="Use status controls on each card to keep the CRM current."
              action={<StatusBadge status={`${commandCenterApplications.length} records`} />}
            />
            <div className="grid gap-4 p-4 md:grid-cols-2 2xl:grid-cols-3">
              {applicationPipelineLanes.map((lane) => {
                const laneItems = commandCenterApplications.filter((item) =>
                  lane.statuses.includes(item.application.status)
                );

                return (
                  <section key={lane.key} className="rounded-lg border border-slate-200 bg-slate-50">
                    <div className="border-b border-slate-200 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold text-slate-950">{lane.label}</h2>
                        <StatusBadge status={String(laneItems.length)} />
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{lane.description}</p>
                    </div>
                    <div className="space-y-3 p-3">
                      {laneItems.length ? (
                        laneItems.map(({ application, attention }) => (
                          <article key={application.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <Link
                                  href={`/applications/${application.id}`}
                                  className="text-sm font-semibold text-slate-950 hover:text-brand-700"
                                >
                                  {application.jobPosting.company}
                                </Link>
                                <p className="mt-0.5 text-xs leading-5 text-slate-500">{application.jobPosting.title}</p>
                              </div>
                              <ScoreBadge score={application.jobPosting.overallFitScore ?? 50} />
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                              <StatusBadge status={formatApplicationStatus(application.status)} />
                              {attention ? (
                                <span
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold ${attentionTone(attention.level)}`}
                                >
                                  <AlertCircle size={13} aria-hidden="true" />
                                  {attention.label}
                                </span>
                              ) : null}
                            </div>

                            <p className="mt-3 text-xs leading-5 text-slate-600">
                              {application.nextAction ?? "Review next step."}
                            </p>
                            <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                              <CalendarDays size={14} aria-hidden="true" />
                              Follow-up {formatDate(application.followUpDueAt)}
                            </p>
                            {attention ? <p className="mt-2 text-xs leading-5 text-slate-500">{attention.detail}</p> : null}

                            <div className="mt-3">
                              <ApplicationStatusActions
                                applicationId={application.id}
                                currentStatus={application.status}
                              />
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500">
                          No records in this stage.
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader
              title="Needs attention"
              description="Prioritized follow-up, emails, interview prep, and offer work."
              action={<TrendingUp size={17} className="text-brand-600" aria-hidden="true" />}
            />
            <div className="divide-y divide-slate-100">
              {attentionItems.length ? (
                attentionItems.slice(0, 8).map(({ application, attention }) => (
                  <Link
                    key={application.id}
                    href={`/applications/${application.id}`}
                    className="block px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">{application.jobPosting.company}</p>
                        <p className="text-xs text-slate-500">{application.jobPosting.title}</p>
                      </div>
                      <StatusBadge status={formatApplicationStatus(application.status)} />
                    </div>
                    <p className="mt-2 text-sm font-medium text-slate-800">{attention?.label}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{attention?.detail}</p>
                  </Link>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-600">No records need attention right now.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Operating rules" />
            <div className="space-y-3 p-5 text-sm leading-6 text-slate-700">
              <p>Move records forward only after you actually complete the external step.</p>
              <p>Status changes update the next action and follow-up date, but they do not submit applications or send emails.</p>
              <p>Use rejected, ghosted, and archived to keep closed records visible without cluttering active work.</p>
            </div>
          </Panel>
        </aside>
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Application table" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3">Company</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Applied</th>
                <th className="px-5 py-3">Follow-up</th>
                <th className="px-5 py-3">Attention</th>
                <th className="px-5 py-3">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {commandCenterApplications.length ? (
                commandCenterApplications.map(({ application, attention }) => (
                  <tr key={application.id}>
                    <td className="px-5 py-4 font-medium text-slate-950">{application.jobPosting.company}</td>
                    <td className="px-5 py-4 text-slate-700">
                      <Link href={`/applications/${application.id}`} className="hover:text-brand-700">
                        {application.jobPosting.title}
                      </Link>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={formatApplicationStatus(application.status)} /></td>
                    <td className="px-5 py-4 text-slate-600">{formatDate(application.dateApplied)}</td>
                    <td className="px-5 py-4 text-slate-600">{formatDate(application.followUpDueAt)}</td>
                    <td className="px-5 py-4 text-slate-600">{attention?.label ?? "Clear"}</td>
                    <td className="px-5 py-4"><ScoreBadge score={application.jobPosting.overallFitScore ?? 50} /></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-600">
                    No applications match the current filters.
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
