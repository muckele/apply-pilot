import { InterviewLibrary } from "@/components/interview-library";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function InterviewLibraryPage() {
  const userId = await requirePageUserId();
  const [questions, stories] = await Promise.all([
    prisma.interviewQuestion.findMany({
      where: { userId },
      orderBy: [{ lastAskedAt: "desc" }, { updatedAt: "desc" }]
    }),
    prisma.starStory.findMany({
      where: { userId },
      orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }]
    })
  ]);

  return (
    <>
      <PageHeader
        title="Interview library"
        description="Refine recurring answers and keep honest STAR stories ready for recruiter, hiring-manager, and technical interviews."
        action={<StatusBadge status={`${questions.length} questions - ${stories.length} stories`} />}
      />
      <Panel>
        <PanelHeader
          title="Practice material"
          description="Generated interview prep is added here automatically; your edits remain reusable across future interviews."
        />
        <InterviewLibrary
          initialQuestions={questions.map((item) => ({
            id: item.id,
            question: item.question,
            category: item.category,
            answer: item.answer,
            improvedAnswer: item.improvedAnswer,
            tags: item.tags,
            timesAsked: item.timesAsked,
            lastAskedAt: item.lastAskedAt?.toISOString() ?? null
          }))}
          initialStories={stories.map((story) => ({
            id: story.id,
            title: story.title,
            situation: story.situation,
            task: story.task,
            action: story.action,
            result: story.result,
            skills: story.skills,
            roleContext: story.roleContext,
            isFavorite: story.isFavorite
          }))}
        />
      </Panel>
    </>
  );
}
