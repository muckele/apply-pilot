import { JobSourcesSettings } from "@/components/job-sources-settings";
import { PageHeader } from "@/components/ui";
import { loadJobBoardDirectory } from "@/lib/job-sources/board-directory";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

import { FollowCompanyForm } from "./follow-company-form";

export default async function JobSourcesPage() {
  const userId = await requirePageUserId();
  const sources = await prisma.jobSource.findMany({
    where: { userId },
    include: {
      _count: {
        select: { jobPostings: true }
      }
    },
    orderBy: [{ syncEnabled: "desc" }, { type: "asc" }, { name: "asc" }]
  });
  // Remount the list when sources change (for example after following a company) so it
  // picks up the refreshed server data.
  const sourcesKey = sources.map((source) => `${source.id}:${source.updatedAt.getTime()}`).join("|");

  return (
    <>
      <PageHeader
        title="Job sources"
        description="Follow company job boards, configure compliant job sources, test connectivity, enable scheduled sync, and run manual imports into the CRM."
      />
      <FollowCompanyForm directorySize={loadJobBoardDirectory().length} />
      <JobSourcesSettings key={sourcesKey} initialSources={JSON.parse(JSON.stringify(sources))} />
    </>
  );
}
