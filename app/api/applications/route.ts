import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  defaultFollowUpDueAt,
  formatApplicationStatus,
  resolvePostingStatusForApplicationStatus,
  suggestApplicationNextAction
} from "@/lib/applications/pipeline";
import { resolveApplicationPostStatus } from "@/lib/applications/status";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
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
  coverLetterVersionId: z.string().nullable().optional(),
  followUpDueAt: z.coerce.date().optional(),
  nextAction: z.string().optional(),
  notes: z.string().optional()
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`applications:create:${userId}`, 40, 60_000);
    const input = createApplicationSchema.parse(await request.json());
    await prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId } });
    const [resumeVersion, coverLetterVersion] = await Promise.all([
      input.resumeVersionId
        ? prisma.resumeVersion.findFirstOrThrow({
            where: { id: input.resumeVersionId, userId, jobPostingId: input.jobPostingId }
          })
        : null,
      typeof input.coverLetterVersionId === "string"
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
    const coverLetterWasProvided = Object.hasOwn(input, "coverLetterVersionId");
    const nextStatus = resolveApplicationPostStatus(input.status, existing);
    const statusChanged = !existing || existing.status !== nextStatus;
    const passiveStatusGuarded = Boolean(existing && input.status !== nextStatus);
    const dateApplied =
      nextStatus === "APPLIED" ? (existing?.dateApplied ?? input.dateApplied ?? new Date()) : undefined;
    const requestedNextAction = passiveStatusGuarded ? undefined : input.nextAction;
    const requestedFollowUpDueAt = passiveStatusGuarded ? undefined : input.followUpDueAt;
    const nextAction =
      requestedNextAction ?? (statusChanged ? suggestApplicationNextAction(nextStatus) : existing?.nextAction);
    const followUpDueAt =
      requestedFollowUpDueAt ??
      (statusChanged ? defaultFollowUpDueAt(nextStatus) : existing?.followUpDueAt);

    const postingStatus = resolvePostingStatusForApplicationStatus(nextStatus);
    const eventType =
      !existing ? "CREATED" : existing.status !== nextStatus ? "STATUS_CHANGED" : "NOTE_ADDED";
    const eventTitle =
      !existing
        ? nextStatus === "SAVED"
          ? "Saved to CRM"
          : `Created as ${formatApplicationStatus(nextStatus)}`
        : existing.status !== nextStatus
          ? `Status changed to ${formatApplicationStatus(nextStatus)}`
          : "Application record updated";

    const application = await prisma.$transaction(async (tx) => {
      const savedApplication = await tx.application.upsert({
        where: { userId_jobPostingId: { userId, jobPostingId: input.jobPostingId } },
        create: {
          userId,
          jobPostingId: input.jobPostingId,
          status: nextStatus,
          dateApplied,
          resumeVersionId: resumeVersion?.id,
          coverLetterVersionId: coverLetterVersion?.id ?? null,
          followUpDueAt,
          nextAction,
          notes: input.notes
        },
        update: {
          status: nextStatus,
          dateApplied,
          resumeVersionId: resumeVersion?.id ?? existing?.resumeVersionId,
          coverLetterVersionId: coverLetterWasProvided
            ? (coverLetterVersion?.id ?? null)
            : existing?.coverLetterVersionId,
          followUpDueAt,
          nextAction,
          notes: input.notes
        }
      });

      if (postingStatus) {
        await tx.jobPosting.update({
          where: { id: input.jobPostingId },
          data: { status: postingStatus }
        });
      }

      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: savedApplication.id,
          type: eventType,
          title: eventTitle,
          body: input.notes,
          metadata: {
            resumeVersionId: resumeVersion?.id ?? existing?.resumeVersionId ?? null,
            coverLetterVersionId: coverLetterWasProvided
              ? (coverLetterVersion?.id ?? null)
              : (existing?.coverLetterVersionId ?? null)
          }
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: nextStatus === "APPLIED" ? "application.mark_applied" : "application.save",
          resource: "Application",
          resourceId: savedApplication.id,
          metadata: {}
        }
      });

      return savedApplication;
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
