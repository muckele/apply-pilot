import { JobSourcesSettings } from "@/components/job-sources-settings";
import { PageHeader } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

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

  return (
    <>
      <PageHeader
        title="Job sources"
        description="Configure compliant job sources, test connectivity, enable scheduled sync, and run manual imports into the CRM."
      />
      <JobSourcesSettings initialSources={JSON.parse(JSON.stringify(sources))} />
    </>
  );
}
