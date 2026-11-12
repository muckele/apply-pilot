import Link from "next/link";

import { ApplicationAnswerVault } from "@/components/application-answer-vault";
import { AssistedFillSettingsCard } from "@/components/assisted-fill-settings-card";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { readAutomationPolicy } from "@/lib/application-runs/service";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function ApplicationAnswersPage() {
  const userId = await requirePageUserId();
  const [answers, automationPolicy] = await Promise.all([
    prisma.applicationAnswer.findMany({
      where: { userId },
      orderBy: [{ category: "asc" }, { question: "asc" }]
    }),
    readAutomationPolicy(userId)
  ]);

  return (
    <>
      <PageHeader
        title="Application answer vault"
        description="Keep accurate answers to recurring application questions. Answers are copied only after your explicit action and are never submitted automatically."
        action={<StatusBadge status={`${answers.filter((answer) => answer.isActive).length} active`} />}
      />
      <p className="mb-4 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-slate-700">
        Your name, email, phone and profile links now live in{" "}
        <Link href="/settings/application-details" className="font-medium text-brand-700 underline">
          Your application details
        </Link>
        , where Fill can use them.
      </p>
      <div className="mb-4">
        <AssistedFillSettingsCard initialMode={automationPolicy.mode} />
      </div>
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
