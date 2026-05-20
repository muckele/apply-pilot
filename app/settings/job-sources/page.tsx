import { JobSourcesSettings } from "@/components/job-sources-settings";
import { PageHeader } from "@/components/ui";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getUserIdForPage() {
  const session = await auth();

  if (session?.user?.id) {
    return session.user.id;
  }

  if (process.env.ALLOW_DEMO_USER === "true") {
    return process.env.DEFAULT_DEMO_USER_ID ?? "demo-user";
  }

  return null;
}

export default async function JobSourcesPage() {
  const userId = await getUserIdForPage();
  const sources = userId
    ? await prisma.jobSource.findMany({
        where: { userId },
        include: {
          _count: {
            select: { jobPostings: true }
          }
        },
        orderBy: [{ syncEnabled: "desc" }, { type: "asc" }, { name: "asc" }]
      })
    : [];

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
