import { notFound } from "next/navigation";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { ButtonLink, PageHeader } from "@/components/ui";
import { loadApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { isDocumentGenerationAvailable } from "@/lib/apply-kit/generation-availability";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Apply Kit (WP1.5): documents, ready-to-paste answers, the employer link and "I applied" for one
// job, with no browser companion. The page is owner-scoped; another user's job is a 404.
export default async function ApplyKitPage({ params, searchParams }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  // "Yes, I applied" on the job page's "Did you apply?" card lands here with the confirmation open.
  const answeredYes = (await searchParams).didYouApply === "yes";
  const view = await loadApplyKitView(prisma, {
    userId,
    jobId: id,
    aiGenerationAvailable: isDocumentGenerationAvailable()
  });

  if (!view) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={`Apply Kit: ${view.job.title}`}
        description={`${view.job.company}${view.job.location ? ` · ${view.job.location}` : ""} · Prepare, apply on the employer's site, then record what you sent.`}
        action={<ButtonLink href={`/jobs/${view.job.id}`} variant="secondary">Back to job</ButtonLink>}
      />
      <ApplyKit view={view} answeredYes={answeredYes} />
    </>
  );
}
