import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const createApplicationSchema = z.object({
  jobPostingId: z.string(),
  status: z
    .enum([
      "SAVED",
      "INTERESTED",
      "APPLIED",
      "RECRUITER_SCREEN",
      "HIRING_MANAGER_SCREEN",
      "TECHNICAL_INTERVIEW",
      "FINAL_INTERVIEW",
      "OFFER",
      "REJECTED",
      "GHOSTED",
      "ARCHIVED"
    ])
    .default("SAVED"),
  dateApplied: z.coerce.date().optional(),
  resumeVersionId: z.string().optional(),
  coverLetterVersionId: z.string().optional(),
  nextAction: z.string().optional(),
  notes: z.string().optional()
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const input = createApplicationSchema.parse(await request.json());
    await prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId } });
    const [resumeVersion, coverLetterVersion] = await Promise.all([
      input.resumeVersionId
        ? prisma.resumeVersion.findFirstOrThrow({
            where: { id: input.resumeVersionId, userId, jobPostingId: input.jobPostingId }
          })
        : null,
      input.coverLetterVersionId
        ? prisma.generatedDocument.findFirstOrThrow({
            where: {
              id: input.coverLetterVersionId,
              userId,
              jobPostingId: input.jobPostingId,
              type: "COVER_LETTER"
            }
          })
        : null
    ]);
    const existing = await prisma.application.findUnique({
      where: { userId_jobPostingId: { userId, jobPostingId: input.jobPostingId } }
    });
    const nextStatus =
      input.status === "SAVED" && existing?.status === "APPLIED" ? existing.status : input.status;
    const dateApplied =
      nextStatus === "APPLIED" ? (existing?.dateApplied ?? input.dateApplied ?? new Date()) : undefined;
    const nextAction =
      input.nextAction ??
      (nextStatus === "APPLIED"
        ? "Track recruiter response and schedule follow-up."
        : "Review fit analysis and decide whether to apply.");

    const application = await prisma.application.upsert({
      where: { userId_jobPostingId: { userId, jobPostingId: input.jobPostingId } },
      create: {
        userId,
        jobPostingId: input.jobPostingId,
        status: nextStatus,
        dateApplied,
        resumeVersionId: resumeVersion?.id,
        coverLetterVersionId: coverLetterVersion?.id,
        nextAction,
        notes: input.notes
      },
      update: {
        status: nextStatus,
        dateApplied,
        resumeVersionId: resumeVersion?.id ?? existing?.resumeVersionId,
        coverLetterVersionId: coverLetterVersion?.id ?? existing?.coverLetterVersionId,
        nextAction,
        notes: input.notes
      }
    });

    if (nextStatus === "APPLIED") {
      await prisma.jobPosting.update({
        where: { id: input.jobPostingId },
        data: { status: "APPLIED" }
      });
    }

    const eventType =
      !existing ? "CREATED" : existing.status !== nextStatus ? "STATUS_CHANGED" : "NOTE_ADDED";
    const eventTitle =
      nextStatus === "APPLIED"
        ? "Marked as applied"
        : !existing
          ? "Saved to CRM"
          : "Application record updated";

    await prisma.applicationEvent.create({
      data: {
        userId,
        applicationId: application.id,
        type: eventType,
        title: eventTitle,
        body: input.notes,
        metadata: {
          resumeVersionId: resumeVersion?.id ?? existing?.resumeVersionId ?? null,
          coverLetterVersionId: coverLetterVersion?.id ?? existing?.coverLetterVersionId ?? null
        }
      }
    });

    await writeAuditLog({
      userId,
      action: nextStatus === "APPLIED" ? "application.mark_applied" : "application.save",
      resource: "Application",
      resourceId: application.id
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
