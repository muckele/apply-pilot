import { NextRequest, NextResponse } from "next/server";

import { draftEmailReply } from "@/lib/ai/email-reply";
import { aiInvocationFromRequest } from "@/lib/ai/http";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { emailDraftSchema } from "@/lib/validators";

// Drafts a reply for the user to review. Apply Pilot never sends it.
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`email-draft:${userId}`, 20, 60_000);
    const input = emailDraftSchema.parse(await request.json());
    const [emailMessage, job] = await Promise.all([
      input.emailMessageId
        ? prisma.emailMessage.findFirst({ where: { id: input.emailMessageId, userId } })
        : null,
      input.jobPostingId ? prisma.jobPosting.findFirst({ where: { id: input.jobPostingId, userId } }) : null
    ]);
    if (input.emailMessageId && !emailMessage) throw new PublicApiError("Email not found.", 404);
    if (input.jobPostingId && !job) throw new PublicApiError("Job not found.", 404);

    const drafted = await draftEmailReply(
      {
        emailText: emailMessage?.body ?? emailMessage?.snippet ?? input.emailText,
        tone: input.tone,
        job: job ? { title: job.title, company: job.company } : null
      },
      userId,
      aiInvocationFromRequest(request)
    );

    await prisma.$transaction(async (tx) => {
      if (emailMessage) {
        await tx.emailMessage.update({
          where: { id: emailMessage.id },
          data: {
            aiSummary: drafted.summary,
            requestedAction: drafted.requestedAction,
            draftResponse: drafted.draftResponse
          }
        });
      }
      await tx.generatedDocument.create({
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
            deadline: drafted.deadline,
            suggestedFollowUpTask: drafted.suggestedFollowUpTask,
            placeholders: drafted.placeholders,
            provider: drafted.provider,
            model: drafted.model,
            promptVersion: drafted.promptVersion
          }
        }
      });
    });

    await writeAuditLog({
      userId,
      action: "email.reply.draft",
      resource: "EmailMessage",
      resourceId: emailMessage?.id,
      metadata: { provider: drafted.provider, model: drafted.model }
    });

    return NextResponse.json({ drafted, requiresApprovalBeforeSending: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
