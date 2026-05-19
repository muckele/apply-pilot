import { NextRequest, NextResponse } from "next/server";

import { generateInterviewFeedback } from "@/lib/ai/documents";
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
    checkRateLimit(`interview-feedback:${userId}`, 12, 60_000);
    const { id } = await params;
    const interview = await prisma.interview.findFirstOrThrow({
      where: { id, userId },
      include: {
        jobPosting: true,
        notesList: true,
        recordings: true
      }
    });
    const feedback = await generateInterviewFeedback({ interview });

    await prisma.interview.update({
      where: { id: interview.id },
      data: {
        followUpEmailDraft: feedback.thankYouEmailDraft
      }
    });

    await prisma.aIAnalysis.create({
      data: {
        userId,
        jobPostingId: interview.jobPostingId,
        interviewId: interview.id,
        type: "INTERVIEW_FEEDBACK",
        model: feedback.model,
        promptName: "interviewFeedbackPrompt",
        input: { interviewId: interview.id },
        output: feedback,
        confidence: 76
      }
    });

    await writeAuditLog({
      userId,
      action: "interview.feedback.generate",
      resource: "Interview",
      resourceId: interview.id
    });

    return NextResponse.json({ feedback, requiresApprovalBeforeSending: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
