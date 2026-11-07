import { notFound } from "next/navigation";

import { ResumeVersionEditor } from "@/components/resume-version-editor";
import { PageHeader } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";
import { buildDocumentReviewView } from "@/lib/documents/document-review";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT, resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";

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
  // D031: export readiness covers exactly generated text and the owner's reviewed edits.
  const review = buildDocumentReviewView({
    kind: "RESUME",
    jobBound: Boolean(version.jobPosting),
    currentEvidenceSnapshotId: version.jobPosting?.currentEvidenceSnapshotId ?? null,
    currentEvidenceSourceValid: currentEvidence?.currentEvidenceSourceValid ?? false,
    artifact: { evidenceSnapshotId: version.evidenceSnapshotId, content: version.fullText, metadata: version.metadata }
  });
  const evidenceCurrent = review.exportReady;

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
          review: version.jobPosting ? review : undefined,
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
