import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { aiInvocationFromRequest } from "@/lib/ai/http";
import { generateMockInterviewQuestions } from "@/lib/ai/mock-interview";
import { mockSessionTitle, serializeMockSession } from "@/lib/ai/mock-interview-records";
import { parseMockQuestions } from "@/lib/ai/mock-interview-session";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const recordId = z.string().trim().min(1).max(64);

// A session starts from exactly one owned record: an interview, or an application or
// saved job that has no interview yet.
const createSchema = z.object({
  interviewId: recordId.optional(),
  applicationId: recordId.optional(),
  jobPostingId: recordId.optional()
}).strict().refine(
  (input) => [input.interviewId, input.applicationId, input.jobPostingId].filter(Boolean).length === 1,
  { message: "Choose exactly one interview, application, or job to practise for." }
);

type CreateInput = z.infer<typeof createSchema>;

async function loadSource(userId: string, input: CreateInput) {
  if (input.interviewId) {
    const interview = await prisma.interview.findFirst({
      where: { id: input.interviewId, userId },
      include: { jobPosting: true, application: { include: { jobPosting: true } } }
    });
    if (!interview) throw new PublicApiError("Interview not found.", 404);
    const job = interview.jobPosting ?? interview.application?.jobPosting ?? null;
    return {
      kind: "interview" as const,
      interviewId: interview.id,
      applicationId: interview.applicationId ?? null,
      job,
      interviewType: interview.type as string,
      prepQuestions: interview.likelyQuestions
    };
  }
  if (input.applicationId) {
    const application = await prisma.application.findFirst({
      where: { id: input.applicationId, userId },
      include: { jobPosting: true }
    });
    if (!application) throw new PublicApiError("Application not found.", 404);
    return {
      kind: "application" as const,
      interviewId: null,
      applicationId: application.id,
      job: application.jobPosting,
      interviewType: null,
      prepQuestions: [] as string[]
    };
  }
  const job = await prisma.jobPosting.findFirst({ where: { id: input.jobPostingId, userId } });
  if (!job) throw new PublicApiError("Job not found.", 404);
  return {
    kind: "job" as const,
    interviewId: null,
    applicationId: null,
    job,
    interviewType: null,
    prepQuestions: [] as string[]
  };
}

// Lists the signed-in user's sessions. Answer text is never selected here.
export async function GET(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const interviewId = new URL(request.url).searchParams.get("interviewId")?.trim();
    const sessions = await prisma.mockInterviewSession.findMany({
      where: interviewId ? { userId, interviewId } : { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        interviewId: true,
        applicationId: true,
        jobPostingId: true,
        questions: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true
      }
    });
    return NextResponse.json({
      sessions: sessions.map(({ questions, ...session }) => ({
        ...session,
        questionCount: parseMockQuestions(questions).length
      }))
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// Generates 6-10 practice questions on Gemini from the posting's own lines and the
// user's master-resume facts, then saves the session. Every read is owner-scoped.
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`mock-interview:create:${userId}`, 6, 60_000);
    const input = createSchema.parse(await request.json().catch(() => ({})));
    const source = await loadSource(userId, input);
    const resume = await prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" }
    });

    const generated = await generateMockInterviewQuestions(
      {
        interviewType: source.interviewType,
        job: source.job,
        resume,
        prepQuestions: source.prepQuestions
      },
      userId,
      aiInvocationFromRequest(request)
    );

    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.mockInterviewSession.create({
        data: {
          userId,
          interviewId: source.interviewId,
          applicationId: source.applicationId,
          jobPostingId: source.job?.id ?? null,
          title: mockSessionTitle(source.job),
          questions: generated.questions as unknown as Prisma.InputJsonValue,
          model: generated.model,
          promptVersion: generated.promptVersion,
          requestHash: generated.inputHash
        }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.mock.create",
          resource: "MockInterviewSession",
          resourceId: created.id,
          metadata: { source: source.kind, questionCount: generated.questions.length, model: generated.model }
        }
      });
      return created;
    });

    return NextResponse.json({ session: serializeMockSession(session) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
