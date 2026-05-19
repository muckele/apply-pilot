import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoProfile } from "@/lib/demo-data";

export default function ProfileSettingsPage() {
  return (
    <>
      <PageHeader
        title="Profile settings"
        description="Career goals, role preferences, salary targets, deal-breakers, and resume tone used by job matching."
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Target profile" />
          <div className="space-y-4 p-5">
            <label className="block text-sm font-medium text-slate-700">
              Name
              <input defaultValue={demoProfile.name} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Location
              <input defaultValue={demoProfile.location} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Career goals
              <textarea rows={5} defaultValue="Find high-fit customer-facing technical roles that combine software, SaaS operations, implementation, and sales engineering." className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Preferences" />
          <div className="space-y-5 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-950">Preferred roles</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {demoProfile.targetRoles.map((role) => <StatusBadge key={role} status={role} />)}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">Skills to emphasize</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {demoProfile.skills.map((skill) => <StatusBadge key={skill} status={skill} />)}
              </div>
            </div>
            <label className="block text-sm font-medium text-slate-700">
              Skills not to exaggerate
              <textarea rows={4} defaultValue="Enterprise-scale production ownership, deep DevOps ownership, tools only mentioned in job descriptions but not supported by experience." className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
          </div>
        </Panel>
      </div>
    </>
  );
}
