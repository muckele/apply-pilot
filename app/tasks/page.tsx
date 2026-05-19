import { CheckCircle2 } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoTasks } from "@/lib/demo-data";

export default function TasksPage() {
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Follow-ups, resume tailoring, recruiter replies, interview prep, and application next steps."
      />

      <Panel>
        <PanelHeader title="Open tasks" />
        <div className="divide-y divide-slate-100">
          {demoTasks.map((task) => (
            <div key={task.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <button className="mt-0.5 text-slate-400 hover:text-brand-600" aria-label={`Mark ${task.title} complete`}>
                  <CheckCircle2 size={18} />
                </button>
                <div>
                  <p className="text-sm font-semibold text-slate-950">{task.title}</p>
                  <p className="text-xs text-slate-500">Due {task.due}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <StatusBadge status={task.priority} />
                <StatusBadge status={task.status} />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
