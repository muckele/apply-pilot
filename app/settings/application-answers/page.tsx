import { ApplicationAnswerVault } from "@/components/application-answer-vault";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function ApplicationAnswersPage() {
  const userId = await requirePageUserId();
  const answers = await prisma.applicationAnswer.findMany({
    where: { userId },
    orderBy: [{ category: "asc" }, { question: "asc" }]
  });

  return (
    <>
      <PageHeader
        title="Application answer vault"
        description="Keep accurate answers to recurring application questions. Answers are copied only after your explicit action and are never submitted automatically."
        action={<StatusBadge status={`${answers.filter((answer) => answer.isActive).length} active`} />}
      />
      <Panel>
        <PanelHeader
          title="Reviewed answers"
          description="Sensitive answers are masked by default. Browser access requires a separately scoped token."
        />
        <ApplicationAnswerVault
          initialAnswers={answers.map((answer) => ({
            id: answer.id,
            category: answer.category,
            question: answer.question,
            answer: answer.answer,
            sensitive: answer.sensitive,
            isActive: answer.isActive
          }))}
        />
      </Panel>
    </>
  );
}
