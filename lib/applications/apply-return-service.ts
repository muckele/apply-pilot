import type { ApplicationStatus, Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  APPLY_RETURN_METADATA_KEY,
  buildApplicationOpenedRecord,
  buildNotApplyingRecord,
  buildNotApplyingUndoneRecord,
  resolveApplyReturn,
  type ApplyReturnEvent,
  type ApplyReturnState
} from "@/lib/applications/apply-return";
import {
  defaultFollowUpDueAt,
  formatApplicationStatus,
  resolvePostingStatusForApplicationStatus,
  suggestApplicationNextAction
} from "@/lib/applications/pipeline";
import { parseApplyLink } from "@/lib/apply-kit/apply-link";

// Server side of "Did you apply?". Every read and write is scoped to the signed-in user, and the
// job row is locked first, like the "I applied" route, so concurrent answers cannot interleave.
// "Yes" is not handled here: it goes through the unchanged POST /api/applications confirmation.

export type ApplyReturnAction = "OPENED" | "NOT_APPLYING" | "UNDO_NOT_APPLYING";

type EventReader = Pick<Prisma.TransactionClient, "applicationEvent">;
type ApplyReturnTx = Pick<Prisma.TransactionClient, "$queryRaw" | "jobPosting" | "application" | "applicationEvent" | "auditLog">;

const EVENT_SELECT = { id: true, userId: true, type: true, occurredAt: true, metadata: true } as const;
const NEWEST_FIRST = [{ occurredAt: "desc" }, { id: "desc" }] as const satisfies Prisma.ApplicationEventOrderByWithRelationInput[];

// Reads exactly the two events the question depends on: the newest opened moment and the newest
// status change.
export async function loadApplyReturnState(db: EventReader, input: {
  userId: string;
  application: { id: string; status: ApplicationStatus } | null;
}): Promise<ApplyReturnState> {
  const { userId, application } = input;
  if (!application) return { pending: null, declined: null };
  const [opened, statusEvent] = await Promise.all([
    db.applicationEvent.findFirst({
      where: { userId, applicationId: application.id, metadata: { path: [APPLY_RETURN_METADATA_KEY, "kind"], equals: "OPENED" } },
      orderBy: [...NEWEST_FIRST],
      select: EVENT_SELECT
    }),
    db.applicationEvent.findFirst({
      where: { userId, applicationId: application.id, type: { in: ["CREATED", "STATUS_CHANGED"] } },
      orderBy: [...NEWEST_FIRST],
      select: EVENT_SELECT
    })
  ]);
  const events: ApplyReturnEvent[] = [];
  for (const event of [opened, statusEvent]) if (event) events.push(event);
  return resolveApplyReturn({ userId, status: application.status, events });
}

export type ApplyReturnResult =
  | { opened: { eventId: string; openedAt: string } | null }
  | { application: { id: string; status: ApplicationStatus } };

export async function recordApplyReturnAction(tx: ApplyReturnTx, input: {
  userId: string;
  jobId: string;
  action: ApplyReturnAction;
  now: Date;
}): Promise<ApplyReturnResult> {
  const { userId, jobId, action, now } = input;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "JobPosting"
    WHERE "id" = ${jobId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new PublicApiError("Job posting not found.", 404);
  const job = await tx.jobPosting.findFirst({
    where: { id: jobId, userId },
    select: { id: true, status: true, applyUrl: true, sourceUrl: true }
  });
  if (!job) throw new PublicApiError("Job posting not found.", 404);
  const found = await tx.application.findUnique({
    where: { userId_jobPostingId: { userId, jobPostingId: job.id } },
    select: { id: true, userId: true, status: true }
  });
  const application = found && found.userId === userId ? found : null;
  const state = await loadApplyReturnState(tx, { userId, application });

  const audit = (applicationId: string, auditAction: string) => tx.auditLog.create({
    data: { userId, action: auditAction, resource: "Application", resourceId: applicationId, metadata: {} }
  });

  if (action === "OPENED") {
    // Opening is recorded only while "I applied" can still be recorded; afterwards there is nothing to ask.
    if (application && !["SAVED", "INTERESTED"].includes(application.status)) return { opened: null };
    const record = buildApplicationOpenedRecord({ openedAt: now, applyHost: parseApplyLink(job.applyUrl, job.sourceUrl)?.hostname ?? null });
    // A job not yet in the tracker is saved there as Saved, the same status the Save button gives
    // it. It is never shown as applied until the user confirms "I applied".
    const target = application ?? await tx.application.create({
      data: {
        userId,
        jobPostingId: job.id,
        status: "SAVED",
        followUpDueAt: defaultFollowUpDueAt("SAVED", now),
        nextAction: suggestApplicationNextAction("SAVED")
      },
      select: { id: true }
    });
    const event = await tx.applicationEvent.create({
      data: {
        userId,
        applicationId: target.id,
        type: application ? "NOTE_ADDED" : "CREATED",
        title: application ? "Opened the employer's application" : "Saved when you opened the employer's application",
        metadata: { [APPLY_RETURN_METADATA_KEY]: record }
      },
      select: { id: true }
    });
    await audit(target.id, "application.opened");
    return { opened: { eventId: event.id, openedAt: record.openedAt } };
  }

  if (action === "NOT_APPLYING") {
    if (!application || !state.pending || (application.status !== "SAVED" && application.status !== "INTERESTED")) {
      throw new PublicApiError(
        "There is no open \"Did you apply?\" question for this job. It may have been answered on another device.",
        409,
        { code: "APPLY_RETURN_NOT_PENDING" }
      );
    }
    const record = buildNotApplyingRecord({
      answeredAt: now,
      openedEventId: state.pending.openedEventId,
      previousStatus: application.status,
      previousPostingStatus: job.status
    });
    await tx.application.update({
      where: { id: application.id },
      data: { status: "ARCHIVED", followUpDueAt: defaultFollowUpDueAt("ARCHIVED", now), nextAction: suggestApplicationNextAction("ARCHIVED") }
    });
    const postingStatus = resolvePostingStatusForApplicationStatus("ARCHIVED");
    if (postingStatus) await tx.jobPosting.update({ where: { id: job.id }, data: { status: postingStatus } });
    await tx.applicationEvent.create({
      data: {
        userId,
        applicationId: application.id,
        type: "STATUS_CHANGED",
        title: `Status changed to ${formatApplicationStatus("ARCHIVED")}`,
        body: "You said you are not applying for this job.",
        metadata: { [APPLY_RETURN_METADATA_KEY]: record }
      }
    });
    await audit(application.id, "application.not_applying");
    return { application: { id: application.id, status: "ARCHIVED" } };
  }

  if (!application || !state.declined) {
    throw new PublicApiError("\"Not applying\" is not in effect for this job, so there is nothing to undo.", 409, {
      code: "APPLY_RETURN_NOT_DECLINED"
    });
  }
  const restored = state.declined.previousStatus;
  await tx.application.update({
    where: { id: application.id },
    data: { status: restored, followUpDueAt: defaultFollowUpDueAt(restored, now), nextAction: suggestApplicationNextAction(restored) }
  });
  // Restore the posting only if nothing else (a source refresh marking it expired, say) changed it since.
  if (job.status === "ARCHIVED") {
    await tx.jobPosting.update({ where: { id: job.id }, data: { status: state.declined.previousPostingStatus } });
  }
  await tx.applicationEvent.create({
    data: {
      userId,
      applicationId: application.id,
      type: "STATUS_CHANGED",
      title: `Status changed to ${formatApplicationStatus(restored)}`,
      body: "You undid \"Not applying\".",
      metadata: { [APPLY_RETURN_METADATA_KEY]: buildNotApplyingUndoneRecord({ answeredAt: now, declineEventId: state.declined.eventId }) }
    }
  });
  await audit(application.id, "application.not_applying_undone");
  return { application: { id: application.id, status: restored } };
}
