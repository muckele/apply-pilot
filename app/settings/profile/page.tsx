import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function ProfileSettingsPage() {
  const userId = await requirePageUserId();
  const [user, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.userProfile.findUnique({ where: { userId } })
  ]);

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
              <input readOnly value={user?.name ?? ""} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Location
              <input readOnly value={profile?.location ?? ""} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Career goals
              <textarea readOnly rows={5} value={profile?.careerGoals ?? ""} className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" />
            </label>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Preferences" />
          <div className="space-y-5 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-950">Preferred roles</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(profile?.preferredRoles ?? []).map((role) => <StatusBadge key={role} status={role} />)}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">Skills to emphasize</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(profile?.skillsToEmphasize ?? []).map((skill) => <StatusBadge key={skill} status={skill} />)}
              </div>
            </div>
            <label className="block text-sm font-medium text-slate-700">
              Skills not to exaggerate
              <textarea
                readOnly
                rows={4}
                value={(profile?.skillsNotToExaggerate ?? []).join(", ")}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              />
            </label>
          </div>
        </Panel>
      </div>
    </>
  );
}
