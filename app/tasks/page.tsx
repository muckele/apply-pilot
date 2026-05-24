import { CheckCircle2 } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "No due date";
}

export default async function TasksPage() {
  const userId = await requirePageUserId();
  const tasks = await prisma.task.findMany({
    where: { userId, status: { not: "ARCHIVED" } },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    take: 100
  });

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Follow-ups, resume tailoring, recruiter replies, interview prep, and application next steps."
      />

      <Panel>
        <PanelHeader title="Open tasks" />
        <div className="divide-y divide-slate-100">
          {tasks.length ? (
            tasks.map((task) => (
              <div key={task.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={18} className={task.status === "DONE" ? "text-emerald-600" : "text-slate-400"} />
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{task.title}</p>
                    <p className="text-xs text-slate-500">Due {formatDate(task.dueAt)}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <StatusBadge status={task.priority} />
                  <StatusBadge status={task.status} />
                </div>
              </div>
            ))
          ) : (
            <div className="px-5 py-8 text-center text-sm text-slate-600">No tasks yet.</div>
          )}
        </div>
      </Panel>
    </>
  );
}
