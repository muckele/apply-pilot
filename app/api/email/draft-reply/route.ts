import { NextRequest, NextResponse } from "next/server";

import { draftEmailReply } from "@/lib/ai/documents";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { emailDraftSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`email-draft:${userId}`, 20, 60_000);
    const input = emailDraftSchema.parse(await request.json());
    const [emailMessage, job] = await Promise.all([
      input.emailMessageId
        ? prisma.emailMessage.findFirst({ where: { id: input.emailMessageId, userId } })
        : null,
      input.jobPostingId ? prisma.jobPosting.findFirst({ where: { id: input.jobPostingId, userId } }) : null
    ]);
    const drafted = await draftEmailReply({
      emailText: emailMessage?.body ?? emailMessage?.snippet ?? input.emailText,
      tone: input.tone,
      job
    });

    if (emailMessage) {
      await prisma.emailMessage.update({
        where: { id: emailMessage.id },
        data: {
          aiSummary: drafted.summary,
          requestedAction: drafted.requestedAction,
          draftResponse: drafted.draftResponse
        }
      });
    }

    await prisma.generatedDocument.create({
      data: {
        userId,
        jobPostingId: job?.id,
        applicationId: emailMessage?.applicationId,
        type: "EMAIL_DRAFT",
        title: `Recruiter email draft - ${input.tone}`,
        content: drafted.draftResponse,
        metadata: {
          summary: drafted.summary,
          requestedAction: drafted.requestedAction,
          suggestedFollowUpTask: drafted.suggestedFollowUpTask
        }
      }
    });

    await writeAuditLog({
      userId,
      action: "email.reply.draft",
      resource: "EmailMessage",
      resourceId: emailMessage?.id
    });

    return NextResponse.json({ drafted, requiresApprovalBeforeSending: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
