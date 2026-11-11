import Link from "next/link";

import { ApplicationDetailsForm } from "@/components/application-details-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { loadApplicationDetails } from "@/lib/application-details-store";
import { requirePageUserId } from "@/lib/page-context";

export default async function ApplicationDetailsPage() {
  const userId = await requirePageUserId();
  const details = await loadApplicationDetails(userId);

  return (
    <>
      <PageHeader
        title="Your application details"
        description="The name, email, phone and links most application forms ask for. Confirm them once and Fill types them into matching fields for you to review. Nothing is ever submitted for you."
        action={<StatusBadge status={`${details.confirmedCount} confirmed`} />}
      />
      <Panel>
        <PanelHeader
          title="Contact details and links"
          description="Prefilled from your résumé where we found them. Check each one, fix anything wrong, then save."
        />
        <ApplicationDetailsForm initialDetails={details} />
      </Panel>
      <p className="mt-4 text-sm text-slate-600">
        Other recurring answers live in your{" "}
        <Link href="/settings/application-answers" className="font-medium text-brand-700 underline">
          Answer Vault
        </Link>
        .
      </p>
    </>
  );
}
