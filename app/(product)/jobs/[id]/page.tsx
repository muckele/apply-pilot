import { notFound } from "next/navigation";

import { JobContactNotesForm } from "@/components/job-contact-notes-form";
import { JobWorkspace } from "@/components/job-workspace/job-workspace";
import { loadApplyProgress } from "@/lib/apply-page/load-apply-progress";
import { loadJobDetail } from "@/lib/jobs/job-detail";
import { requirePageUserId } from "@/lib/page-context";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const userId = await requirePageUserId();
  const data = await loadJobDetail(userId, id);

  if (!data) {
    notFound();
  }

  return (
    <JobWorkspace
      job={data.view}
      estimate={data.estimate}
      checklist={data.checklist}
      salaryTarget={data.salaryTarget}
      progress={await loadApplyProgress(userId, data)}
      application={data.application}
      applyReturn={data.applyReturn}
      masterResumeText={data.sourceText}
      notes={<JobContactNotesForm key="contact-notes" jobPostingId={data.view.id} applicationId={data.application?.id} contacts={data.contacts} />}
    />
  );
}
