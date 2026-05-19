import { NextRequest, NextResponse } from "next/server";

import { tailorResume } from "@/lib/ai/resume";
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
    checkRateLimit(`tailor-resume:${userId}`, 12, 60_000);
    const { id } = await params;
    const [job, resume, profile] = await Promise.all([
      prisma.jobPosting.findFirstOrThrow({ where: { id, userId } }),
      prisma.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: "desc" } }),
      prisma.userProfile.findUnique({ where: { userId } })
    ]);

    const tailored = await tailorResume({ job, resume, profile }, resume?.rawText ?? "");
    const version = await prisma.resumeVersion.create({
      data: {
        userId,
        resumeId: resume?.id,
        jobPostingId: job.id,
        title: `${job.company} - ${job.title} tailored resume`,
        summary: tailored.professionalSummary,
        skills: tailored.skillsSection,
        bullets: tailored.bulletRewrites,
        fullText: tailored.resumeText,
        changeNotes: tailored.rolesOrProjectsToEmphasize.join("; "),
        atsCompatibility: tailored.atsCompatibilityScore,
        jobFitScore: tailored.jobFitScore
      }
    });

    await prisma.aIAnalysis.create({
      data: {
        userId,
        jobPostingId: job.id,
        type: "RESUME_TAILOR",
        model: tailored.model,
        promptName: "resumeTailorPrompt",
        input: { jobId: job.id, resumeId: resume?.id },
        output: tailored,
        confidence: tailored.jobFitScore
      }
    });

    await writeAuditLog({
      userId,
      action: "resume.tailor",
      resource: "ResumeVersion",
      resourceId: version.id
    });

    return NextResponse.json({ version, tailored });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
