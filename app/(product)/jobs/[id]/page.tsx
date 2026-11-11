import { notFound } from "next/navigation";

import { JobContactNotesForm } from "@/components/job-contact-notes-form";
import { JobWorkspace } from "@/components/job-workspace/job-workspace";
import { isDocumentGenerationAvailable } from "@/lib/apply-kit/generation-availability";
import { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
import { loadJobDetail } from "@/lib/jobs/job-detail";
import { requirePageUserId } from "@/lib/page-context";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const data = await loadJobDetail(await requirePageUserId(), id);

  if (!data) {
    notFound();
  }

  return (
    <JobWorkspace
      job={data.view}
      estimate={data.estimate}
      checklist={data.checklist}
      salaryTarget={data.salaryTarget}
      tailor={{
        review: data.evidenceReview,
        hasValidCurrentSnapshot: data.hasValidCurrentSnapshot,
        readOnlyGaps: data.readOnlyGaps,
        quote: buildDocumentCreationQuote(),
        generationAvailable: isDocumentGenerationAvailable()
      }}
      documents={{ resumeVersions: data.resumeVersions, coverLetters: data.coverLetters }}
      application={data.application}
      applyReturn={data.applyReturn}
      masterResumeText={data.sourceText}
      notes={<JobContactNotesForm key="contact-notes" jobPostingId={data.view.id} applicationId={data.application?.id} contacts={data.contacts} />}
    />
  );
}
