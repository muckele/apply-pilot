import { notFound } from "next/navigation";

import { ResumeVersionEditor } from "@/components/resume-version-editor";
import { PageHeader } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT, isEvidenceBindingCurrent, resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ResumeVersionPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  const version = await prisma.resumeVersion.findFirst({
    where: { id, userId },
    include: { jobPosting: { select: {
      company: true, title: true, currentEvidenceSnapshotId: true, evidenceSnapshotGeneration: true,
      currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
      user: { select: { resumes: { where: { isMaster: true }, orderBy: { updatedAt: "desc" }, take: 1, select: { id: true, updatedAt: true } } } }
    } } }
  });

  if (!version) notFound();

  const currentEvidence = version.jobPosting
    ? resolveCurrentReviewedEvidence(version.jobPosting, version.jobPosting.user.resumes[0] ?? null)
    : null;
  const evidenceCurrent = !version.jobPosting || isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: version.jobPosting.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: currentEvidence?.currentEvidenceSourceValid ?? false,
    artifactEvidenceSnapshotId: version.evidenceSnapshotId
  });

  return (
    <>
      <PageHeader
        title="Resume editor"
        description={version.jobPosting ? `${version.jobPosting.company} - ${version.jobPosting.title}` : "Review and export this resume version."}
      />
      <ResumeVersionEditor
        version={{
          id: version.id,
          evidenceCurrent,
          title: version.title,
          fullText: version.fullText,
          jobLabel: version.jobPosting ? `${version.jobPosting.company} - ${version.jobPosting.title}` : null,
          template: version.template as "CLASSIC" | "MODERN" | "COMPACT",
          pageSize: version.pageSize as "LETTER" | "A4",
          fontFamily: version.fontFamily as "ARIAL" | "CALIBRI" | "GEORGIA",
          accentColor: version.accentColor,
          fontSize: version.fontSize,
          lineSpacing: version.lineSpacing
        }}
      />
    </>
  );
}
