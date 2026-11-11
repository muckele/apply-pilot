import { notFound } from "next/navigation";

import { ApplyPage } from "@/components/apply-page/apply-page";
import { ButtonLink, PageHeader } from "@/components/ui";
import { loadApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { isDocumentGenerationAvailable } from "@/lib/apply-kit/generation-availability";
import { isApplicationAutomationEnabled } from "@/lib/application-runs/policy";
import { loadApplyProgress } from "@/lib/apply-page/load-apply-progress";
import { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
import { loadJobDetail } from "@/lib/jobs/job-detail";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// One Apply page per job (D036): the match, tailoring, documents and, under "Apply on my own", the
// Apply Kit. The page is owner-scoped; another user's job is a 404.
export default async function ApplyJobPage({ params, searchParams }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  // "Yes, I applied" on the job page's "Did you apply?" card lands here with the confirmation open.
  const answeredYes = (await searchParams).didYouApply === "yes";
  const [detail, kit] = await Promise.all([
    loadJobDetail(userId, id),
    loadApplyKitView(prisma, { userId, jobId: id, aiGenerationAvailable: isDocumentGenerationAvailable() })
  ]);

  if (!detail || !kit) {
    notFound();
  }

  const progress = await loadApplyProgress(userId, detail);

  return (
    <>
      <PageHeader
        tone="branded"
        title={`Apply: ${kit.job.title}`}
        description={`${kit.job.company}${kit.job.location ? ` · ${kit.job.location}` : ""} · Check your match, write your documents, then apply.`}
        action={<ButtonLink href={`/jobs/${kit.job.id}`} variant="secondary" tone="branded">Back to job</ButtonLink>}
      />
      <ApplyPage
        detail={detail}
        kit={kit}
        automationAvailable={isApplicationAutomationEnabled()}
        progress={progress}
        tailorServer={{ quote: buildDocumentCreationQuote(), generationAvailable: isDocumentGenerationAvailable() }}
        answeredYes={answeredYes}
      />
    </>
  );
}
