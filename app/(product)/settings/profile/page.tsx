import { AccountDataControls } from "@/components/account-data-controls";
import { ProfileSettingsForm, type ProfileSettingsData } from "@/components/profile-settings-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function ProfileSettingsPage() {
  const userId = await requirePageUserId();
  const [user, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.userProfile.findUnique({ where: { userId } })
  ]);
  const initialProfile: ProfileSettingsData = {
    name: user?.name ?? "",
    email: user?.email ?? "",
    location: profile?.location ?? "",
    careerGoals: profile?.careerGoals ?? "",
    preferredRoles: profile?.preferredRoles ?? [],
    preferredLocations: profile?.preferredLocations ?? [],
    remotePreference: profile?.remotePreference ?? "FLEXIBLE",
    salaryTargetMin: profile?.salaryTargetMin ?? null,
    salaryTargetMax: profile?.salaryTargetMax ?? null,
    industriesOfInterest: profile?.industriesOfInterest ?? [],
    dealBreakers: profile?.dealBreakers ?? [],
    skillsToEmphasize: profile?.skillsToEmphasize ?? [],
    skillsNotToExaggerate: profile?.skillsNotToExaggerate ?? [],
    workAuthorizationNotes: profile?.workAuthorizationNotes ?? "",
    availabilityNotes: profile?.availabilityNotes ?? "",
    preferredResumeTone: profile?.preferredResumeTone ?? "clear, honest, concise, role-specific"
  };

  return (
    <>
      <PageHeader
        title="Profile settings"
        description="Career goals, role preferences, salary targets, deal-breakers, and resume tone used by job matching."
        action={<StatusBadge status="Private account" />}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <PanelHeader
            title="Target profile"
            description="These fields are scoped to your signed-in account and drive discovery filters, AI matching, and apply packet drafts."
          />
          <ProfileSettingsForm initialProfile={initialProfile} />
        </Panel>

        <Panel>
          <PanelHeader
            title="Account data"
            description="Export your private CRM data or permanently delete your account records."
          />
          <AccountDataControls />
        </Panel>
      </div>
    </>
  );
}
