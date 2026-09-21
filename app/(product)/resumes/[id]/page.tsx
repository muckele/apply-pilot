import { notFound } from "next/navigation";

import { ResumeVersionEditor } from "@/components/resume-version-editor";
import { PageHeader } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ResumeVersionPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  const version = await prisma.resumeVersion.findFirst({
    where: { id, userId },
    include: { jobPosting: { select: { company: true, title: true } } }
  });

  if (!version) notFound();

  return (
    <>
      <PageHeader
        title="Resume editor"
        description={version.jobPosting ? `${version.jobPosting.company} - ${version.jobPosting.title}` : "Review and export this resume version."}
      />
      <ResumeVersionEditor
        version={{
          id: version.id,
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
