import { notFound } from "next/navigation";

import { CopyButton } from "@/components/apply-kit/copy-button";
import { ButtonLink, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { SENT_READINESS_LABELS, type SentDocument } from "@/lib/apply-kit/sent-documents";
import { loadSentDocumentsView } from "@/lib/apply-kit/sent-documents-view";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string; eventId: string }>;
};

function SentDocumentPanel({ anchor, noun, document }: { anchor: string; noun: string; document: SentDocument | null }) {
  return (
    <section id={anchor} className="scroll-mt-24" data-sent-document={anchor}>
      <Panel>
        <PanelHeader
          title={document ? `${noun} v${document.versionNumber}` : noun}
          description={document
            ? `${document.title} · ${SENT_READINESS_LABELS[document.readinessState]} · sha256 ${document.contentHash}`
            : `No ${noun.toLowerCase()} from Apply Pilot was recorded for this application.`}
          action={document ? <CopyButton value={document.content} label={`${noun.toLowerCase()} text`} /> : undefined}
        />
        {document ? (
          <div className="space-y-1 p-5 text-sm leading-6 text-slate-800" data-sent-content>
            {document.content.split(/\r?\n/u).map((line, index) => (line.trim() ? <p key={index}>{line}</p> : null))}
          </div>
        ) : null}
      </Panel>
    </section>
  );
}

// Read-only, frozen copy of what the user recorded as sent. Later edits to the live documents never
// change it. Owner-scoped: another user's application or event is a 404.
export default async function SentDocumentsPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id, eventId } = await params;
  const view = await loadSentDocumentsView(prisma, { userId, applicationId: id, eventId });

  if (!view) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title="What you sent"
        description={`${view.company} · ${view.jobTitle} · recorded ${view.snapshot.recordedAt.slice(0, 10)}`}
        action={<ButtonLink href={`/applications/${view.applicationId}`} variant="secondary">Back to application</ButtonLink>}
      />
      <p className="mb-6 max-w-3xl rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
        A frozen, read-only copy saved when you recorded this application as applied. Editing or regenerating your
        documents later does not change it. The hash identifies the exact text.
      </p>
      <div className="space-y-6">
        <SentDocumentPanel anchor="resume" noun="Résumé" document={view.snapshot.resume} />
        <SentDocumentPanel anchor="cover-letter" noun="Cover letter" document={view.snapshot.coverLetter} />
      </div>
    </>
  );
}
