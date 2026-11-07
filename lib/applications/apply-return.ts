import type { ApplicationStatus, PostingStatus } from "@prisma/client";
import { z } from "zod";

import { MAX_EFFORT_MINUTES } from "@/lib/applications/self-reported-effort";

// "Did you apply?" (WP1.5 follow-up). Opening the employer's application from the Apply Kit
// records an "opened" moment; when the user comes back, Apply Pilot asks whether they submitted it.
// Opening a link is not applying (D027): only the user's own "I applied" confirmation records
// APPLIED. Every record lives in an append-only timeline event's metadata under one versioned key,
// like the self-reported minutes, so there is no schema change.

export const APPLY_RETURN_SCHEMA = "apply-pilot/apply-return/v1" as const;
export const APPLY_RETURN_METADATA_KEY = "applyReturn" as const;

// The statuses from which "I applied" can still be recorded; past them the question is settled.
export const APPLY_RETURN_OPEN_STATUSES = new Set<ApplicationStatus>(["SAVED", "INTERESTED"]);

const isoDate = z.string().datetime({ offset: true });
const postingStatus = z.enum(["ACTIVE", "EXPIRED", "APPLIED", "REJECTED", "INTERVIEW", "OFFER", "ARCHIVED"]);

const openedSchema = z.object({
  schema: z.literal(APPLY_RETURN_SCHEMA),
  kind: z.literal("OPENED"),
  openedAt: isoDate,
  applyHost: z.string().max(253).nullable()
}).strict();

const notApplyingSchema = z.object({
  schema: z.literal(APPLY_RETURN_SCHEMA),
  kind: z.literal("NOT_APPLYING"),
  answeredAt: isoDate,
  openedEventId: z.string().min(1),
  // Only an application that could still be recorded as applied is asked, so undo restores one of these.
  previousStatus: z.enum(["SAVED", "INTERESTED"]),
  previousPostingStatus: postingStatus
}).strict();

const notApplyingUndoneSchema = z.object({
  schema: z.literal(APPLY_RETURN_SCHEMA),
  kind: z.literal("NOT_APPLYING_UNDONE"),
  answeredAt: isoDate,
  declineEventId: z.string().min(1)
}).strict();

const recordSchema = z.discriminatedUnion("kind", [openedSchema, notApplyingSchema, notApplyingUndoneSchema]);

export type ApplicationOpenedRecord = z.infer<typeof openedSchema>;
export type NotApplyingRecord = z.infer<typeof notApplyingSchema>;
export type NotApplyingUndoneRecord = z.infer<typeof notApplyingUndoneSchema>;
export type ApplyReturnRecord = z.infer<typeof recordSchema>;

export function buildApplicationOpenedRecord(input: { openedAt: Date; applyHost: string | null }): ApplicationOpenedRecord {
  return openedSchema.parse({ schema: APPLY_RETURN_SCHEMA, kind: "OPENED", openedAt: input.openedAt.toISOString(), applyHost: input.applyHost });
}

export function buildNotApplyingRecord(input: {
  answeredAt: Date;
  openedEventId: string;
  previousStatus: NotApplyingRecord["previousStatus"];
  previousPostingStatus: PostingStatus;
}): NotApplyingRecord {
  return notApplyingSchema.parse({
    schema: APPLY_RETURN_SCHEMA,
    kind: "NOT_APPLYING",
    answeredAt: input.answeredAt.toISOString(),
    openedEventId: input.openedEventId,
    previousStatus: input.previousStatus,
    previousPostingStatus: input.previousPostingStatus
  });
}

export function buildNotApplyingUndoneRecord(input: { answeredAt: Date; declineEventId: string }): NotApplyingUndoneRecord {
  return notApplyingUndoneSchema.parse({
    schema: APPLY_RETURN_SCHEMA,
    kind: "NOT_APPLYING_UNDONE",
    answeredAt: input.answeredAt.toISOString(),
    declineEventId: input.declineEventId
  });
}

export function readApplyReturnRecord(metadata: unknown): ApplyReturnRecord | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = recordSchema.safeParse((metadata as Record<string, unknown>)[APPLY_RETURN_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

export type ApplyReturnEvent = { id: string; userId: string; type: string; occurredAt: Date; metadata: unknown };

export type ApplyReturnState = {
  pending: { openedEventId: string; openedAt: string } | null;
  declined: {
    eventId: string;
    answeredAt: string;
    previousStatus: NotApplyingRecord["previousStatus"];
    previousPostingStatus: PostingStatus;
  } | null;
};

const STATUS_EVENT_TYPES = new Set(["CREATED", "STATUS_CHANGED"]);

function newestFirst(left: ApplyReturnEvent, right: ApplyReturnEvent) {
  return right.occurredAt.getTime() - left.occurredAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);
}

// Pure: reads only the owner's events. The question is pending while the application can still be
// recorded as applied and the owner has opened its employer application at least once: "Not yet"
// is never stored, "Yes" moves the application to APPLIED and "Not applying" archives it. Undoing
// "Not applying" restores the earlier status, so the original question is open again.
export function resolveApplyReturn(input: {
  userId: string;
  status: ApplicationStatus | null;
  events: readonly ApplyReturnEvent[];
}): ApplyReturnState {
  const owned = input.events.filter((event) => event.userId === input.userId).sort(newestFirst);
  let pending: ApplyReturnState["pending"] = null;
  if (input.status && APPLY_RETURN_OPEN_STATUSES.has(input.status)) {
    for (const event of owned) {
      const record = readApplyReturnRecord(event.metadata);
      if (record?.kind === "OPENED") {
        pending = { openedEventId: event.id, openedAt: record.openedAt };
        break;
      }
    }
  }

  let declined: ApplyReturnState["declined"] = null;
  if (input.status === "ARCHIVED") {
    const latestStatusEvent = owned.find((event) => STATUS_EVENT_TYPES.has(event.type));
    const record = latestStatusEvent ? readApplyReturnRecord(latestStatusEvent.metadata) : null;
    if (latestStatusEvent && record?.kind === "NOT_APPLYING") {
      declined = {
        eventId: latestStatusEvent.id,
        answeredAt: record.answeredAt,
        previousStatus: record.previousStatus,
        previousPostingStatus: record.previousPostingStatus
      };
    }
  }
  return { pending, declined };
}

// The optional minutes box after "Yes, I applied": the whole minutes between opening the employer's
// application and coming back, at least 1. A gap longer than the box allows (left overnight, say)
// is not how long the application took, so nothing is pre-filled and the user gives their own
// estimate instead of a made-up 600.
export function prefillEffortMinutes(openedAt: Date, returnedAt: Date): number | null {
  const elapsed = returnedAt.getTime() - openedAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  return minutes > MAX_EFFORT_MINUTES ? null : minutes;
}
