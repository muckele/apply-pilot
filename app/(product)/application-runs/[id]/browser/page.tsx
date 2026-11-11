import { notFound } from "next/navigation";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import { PageHeader, Panel, PanelHeader } from "@/components/ui";
import { PublicApiError } from "@/lib/api-errors";
import { applicationRunPathSchema } from "@/lib/application-runs/contracts";
import { getApplicationRun } from "@/lib/application-runs/service";
import { requirePageUserId } from "@/lib/page-context";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ApplicationBrowserPage({ params }: Props) {
  const userId = await requirePageUserId();
  const parsed = applicationRunPathSchema.safeParse(await params);
  if (!parsed.success) notFound();

  let applicationId: string;
  try {
    const run = await getApplicationRun(userId, parsed.data.id);
    applicationId = run.applicationId;
  } catch (error) {
    if (error instanceof PublicApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Apply Pilot browser"
        description="Open the employer's form, check Apply Pilot's proposed answers, and fill the ones you approve. You press the employer's Submit yourself."
      />
      <Panel>
        <PanelHeader
          title="This application"
          description="Works only inside the Apply Pilot browser window."
        />
        <ApplicationBrowserControl
          runId={parsed.data.id}
          authenticatedOwnerPage
          detectCompanionWindow
          applicationHref={`/applications/${applicationId}`}
        />
      </Panel>
    </>
  );
}
