import { notFound } from "next/navigation";

import { MockInterviewPracticeNotice, MockInterviewSessionRunner } from "@/components/mock-interview";
import { ButtonLink, PageHeader } from "@/components/ui";
import { getAiAvailability } from "@/lib/ai/config";
import { aiUnavailableMessage } from "@/lib/ai/mock-interview-records";
import { parseMockAnswers, parseMockQuestions } from "@/lib/ai/mock-interview-session";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ sessionId: string }>;
};

export default async function MockInterviewSessionPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { sessionId } = await params;
  const [session, stories] = await Promise.all([
    prisma.mockInterviewSession.findFirst({ where: { id: sessionId, userId } }),
    prisma.starStory.findMany({
      where: { userId },
      orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
      take: 200,
      select: { id: true, title: true, situation: true, task: true, action: true, result: true, skills: true }
    })
  ]);
  if (!session) notFound();

  const availability = getAiAvailability();
  const questions = parseMockQuestions(session.questions);
  const backHref = session.interviewId ? `/interviews/${session.interviewId}` : "/interviews";

  return (
    <>
      <PageHeader
        title={`Mock interview: ${session.title}`}
        description={`${questions.length} practice questions from the job post and your master resume · started ${session.createdAt.toLocaleDateString("en-US", { dateStyle: "medium" })}`}
        action={<ButtonLink href={backHref} variant="secondary">{session.interviewId ? "Back to interview" : "Back to interviews"}</ButtonLink>}
      />
      <div className="mb-6">
        <MockInterviewPracticeNotice />
      </div>
      <MockInterviewSessionRunner
        session={{
          id: session.id,
          title: session.title,
          questions,
          answers: parseMockAnswers(session.answers),
          completedAt: session.completedAt?.toISOString() ?? null
        }}
        stories={stories}
        aiAvailable={availability.available}
        unavailableMessage={aiUnavailableMessage(availability)}
        backHref={backHref}
      />
    </>
  );
}
