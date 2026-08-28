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

  try {
    await getApplicationRun(userId, parsed.data.id);
  } catch (error) {
    if (error instanceof PublicApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Local application browser"
        description="Control the bounded B1 browser workflow from this authenticated, run-owned page."
      />
      <Panel>
        <PanelHeader
          title="Browser companion"
          description="The companion independently reads the run's frozen target through the authenticated session."
        />
        <ApplicationBrowserControl runId={parsed.data.id} />
      </Panel>
    </>
  );
}
