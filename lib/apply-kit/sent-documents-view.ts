import type { PrismaClient } from "@prisma/client";

import { readSentDocumentsSnapshot, type SentDocumentsSnapshot } from "@/lib/apply-kit/sent-documents";

// Read-only view of one frozen "what I sent" snapshot. The event, its application and the
// signed-in user must all match; anything else is "not found".

export type SentDocumentsDb = Pick<PrismaClient, "applicationEvent">;

export type SentDocumentsView = {
  eventId: string;
  applicationId: string;
  jobPostingId: string;
  jobTitle: string;
  company: string;
  occurredAt: string;
  snapshot: SentDocumentsSnapshot;
};

export async function loadSentDocumentsView(db: SentDocumentsDb, input: {
  userId: string;
  applicationId: string;
  eventId: string;
}): Promise<SentDocumentsView | null> {
  const event = await db.applicationEvent.findFirst({
    where: {
      id: input.eventId,
      userId: input.userId,
      applicationId: input.applicationId,
      application: { userId: input.userId }
    },
    select: {
      id: true,
      occurredAt: true,
      metadata: true,
      application: {
        select: { id: true, userId: true, jobPostingId: true, jobPosting: { select: { title: true, company: true } } }
      }
    }
  });
  if (!event || event.application.userId !== input.userId || event.application.id !== input.applicationId) return null;
  const snapshot = readSentDocumentsSnapshot(event.metadata);
  if (!snapshot) return null;
  return {
    eventId: event.id,
    applicationId: event.application.id,
    jobPostingId: event.application.jobPostingId,
    jobTitle: event.application.jobPosting.title,
    company: event.application.jobPosting.company,
    occurredAt: event.occurredAt.toISOString(),
    snapshot
  };
}
