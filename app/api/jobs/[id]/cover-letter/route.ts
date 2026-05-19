import { NextRequest, NextResponse } from "next/server";

import { draftCoverLetter } from "@/lib/ai/documents";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`cover-letter:${userId}`, 12, 60_000);
    const { id } = await params;
    const [job, resume, profile] = await Promise.all([
      prisma.jobPosting.findFirstOrThrow({ where: { id, userId } }),
      prisma.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: "desc" } }),
      prisma.userProfile.findUnique({ where: { userId } })
    ]);
    const drafted = await draftCoverLetter({ job, resume, profile });
    const document = await prisma.generatedDocument.create({
      data: {
        userId,
        jobPostingId: job.id,
        type: "COVER_LETTER",
        title: drafted.title,
        content: drafted.coverLetter,
        metadata: { angle: drafted.angle, claimsUsed: drafted.claimsUsed }
      }
    });

    await prisma.aIAnalysis.create({
      data: {
        userId,
        jobPostingId: job.id,
        type: "COVER_LETTER",
        model: drafted.model,
        promptName: "coverLetterPrompt",
        input: { jobId: job.id, resumeId: resume?.id },
        output: drafted,
        confidence: 78
      }
    });

    await writeAuditLog({
      userId,
      action: "cover-letter.generate",
      resource: "GeneratedDocument",
      resourceId: document.id
    });

    return NextResponse.json({ document, drafted });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
