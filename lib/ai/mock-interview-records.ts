import type { Prisma } from "@prisma/client";

import {
  parseMockAnswers,
  parseMockQuestions,
  type MockAnswerMap,
  type MockAnswerRecord
} from "@/lib/ai/mock-interview-session";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

// Database helpers for mock-interview sessions. Every query is scoped to the signed-in
// user; answer writes are guarded by the session revision so concurrent saves merge
// instead of overwriting each other.

const UNAVAILABLE_MESSAGES = {
  disabled: "AI is turned off on this server.",
  not_configured: "Gemini is not configured on this server.",
  unsupported_provider: "The server selects a retired AI provider; Gemini is the only supported provider."
} as const;

export function aiUnavailableMessage(availability: { available: true } | { available: false; reason: keyof typeof UNAVAILABLE_MESSAGES }) {
  return availability.available ? "" : UNAVAILABLE_MESSAGES[availability.reason];
}

type ListableSession = {
  id: string;
  title: string;
  questions: unknown;
  answers: unknown;
  completedAt: Date | null;
  createdAt: Date;
};

// Counts only: list views never pass answer text to the client.
export function mockSessionListItem(session: ListableSession) {
  const questions = parseMockQuestions(session.questions);
  const answers = parseMockAnswers(session.answers);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    questionCount: questions.length,
    answeredCount: questions.filter((question) => answers[question.questionId]).length
  };
}

export function mockSessionTitle(job: { company?: string | null; title?: string | null } | null | undefined) {
  const company = job?.company?.trim();
  const title = job?.title?.trim();
  if (company && title) return `${company} - ${title}`.slice(0, 200);
  return (company || title || "Mock interview").slice(0, 200);
}

type SessionRow = {
  id: string;
  title: string;
  interviewId: string | null;
  applicationId: string | null;
  jobPostingId: string | null;
  questions: unknown;
  answers: unknown;
  revision: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function serializeMockSession(session: SessionRow) {
  return {
    id: session.id,
    title: session.title,
    interviewId: session.interviewId,
    applicationId: session.applicationId,
    jobPostingId: session.jobPostingId,
    questions: parseMockQuestions(session.questions),
    answers: parseMockAnswers(session.answers),
    revision: session.revision,
    completedAt: session.completedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

type SessionJobSource = {
  jobPosting?: unknown;
  application?: { jobPosting?: unknown } | null;
  interview?: { jobPosting?: unknown; application?: { jobPosting?: unknown } | null } | null;
};

export function mockSessionJob<T>(session: SessionJobSource): T | null {
  return (session.jobPosting ??
    session.application?.jobPosting ??
    session.interview?.jobPosting ??
    session.interview?.application?.jobPosting ??
    null) as T | null;
}

type AnswerWriter = Pick<typeof prisma, "mockInterviewSession">;

const MAX_SAVE_ATTEMPTS = 3;

// Re-reads the latest revision before each write so an answer saved from another tab is
// merged, never dropped. Only the target question's entry changes.
export async function writeMockAnswer(
  userId: string,
  sessionId: string,
  questionId: string,
  build: (current: MockAnswerRecord | undefined, answers: MockAnswerMap) => MockAnswerRecord,
  client: AnswerWriter = prisma
) {
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
    const current = await client.mockInterviewSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true, revision: true, answers: true }
    });
    if (!current) throw new PublicApiError("Practice session not found.", 404);
    const answers = parseMockAnswers(current.answers);
    const record = build(answers[questionId], answers);
    const result = await client.mockInterviewSession.updateMany({
      where: { id: sessionId, userId, revision: current.revision },
      data: {
        answers: { ...answers, [questionId]: record } as unknown as Prisma.InputJsonValue,
        revision: { increment: 1 }
      }
    });
    if (result.count === 1) return { record, revision: current.revision + 1 };
  }
  throw new PublicApiError("This practice session changed while saving. Refresh and try again.", 409, {
    code: "MOCK_INTERVIEW_SESSION_CONFLICT",
    retryable: true
  });
}
