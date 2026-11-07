import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationStatus } from "@prisma/client";

import {
  APPLY_RETURN_METADATA_KEY,
  APPLY_RETURN_SCHEMA,
  buildApplicationOpenedRecord,
  buildNotApplyingRecord,
  buildNotApplyingUndoneRecord,
  prefillEffortMinutes,
  resolveApplyReturn
} from "@/lib/applications/apply-return";

// "Did you apply?" (WP1.5 follow-up): opening the employer's application records an "opened"
// moment; the question stays open until the user answers Yes (through "I applied") or "Not applying".

const OWNER = "user-owner";
const OTHER = "user-other";
const at = (iso: string) => new Date(iso);

type Event = { id: string; userId: string; type: string; occurredAt: Date; metadata: unknown };

function opened(id: string, iso: string, userId = OWNER): Event {
  return {
    id,
    userId,
    type: "NOTE_ADDED",
    occurredAt: at(iso),
    metadata: { [APPLY_RETURN_METADATA_KEY]: buildApplicationOpenedRecord({ openedAt: at(iso), applyHost: "jobs.example.test" }) }
  };
}

function declined(id: string, iso: string, previousStatus: "SAVED" | "INTERESTED" = "SAVED"): Event {
  return {
    id,
    userId: OWNER,
    type: "STATUS_CHANGED",
    occurredAt: at(iso),
    metadata: {
      [APPLY_RETURN_METADATA_KEY]: buildNotApplyingRecord({ answeredAt: at(iso), openedEventId: "opened-1", previousStatus, previousPostingStatus: "ACTIVE" })
    }
  };
}

function undone(id: string, iso: string, declineEventId: string): Event {
  return {
    id,
    userId: OWNER,
    type: "STATUS_CHANGED",
    occurredAt: at(iso),
    metadata: { [APPLY_RETURN_METADATA_KEY]: buildNotApplyingUndoneRecord({ answeredAt: at(iso), declineEventId }) }
  };
}

test("an opened moment with no answer after it is a pending question", () => {
  const state = resolveApplyReturn({ userId: OWNER, status: "SAVED", events: [opened("opened-1", "2026-11-06T10:00:00.000Z")] });
  assert.deepEqual(state.pending, { openedEventId: "opened-1", openedAt: "2026-11-06T10:00:00.000Z" });
  assert.equal(state.declined, null);
});

test("without an opened moment there is no question", () => {
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "SAVED", events: [] }).pending, null);
  assert.equal(resolveApplyReturn({ userId: OWNER, status: null, events: [] }).pending, null);
});

test("the most recent opened moment is the one asked about, whatever order the events arrive in", () => {
  const state = resolveApplyReturn({
    userId: OWNER,
    status: "INTERESTED",
    events: [opened("opened-2", "2026-11-06T12:00:00.000Z"), opened("opened-1", "2026-11-05T09:00:00.000Z")]
  });
  assert.equal(state.pending?.openedEventId, "opened-2");
});

test("once the application is recorded as applied, or has moved on, the question is closed", () => {
  const events = [opened("opened-1", "2026-11-06T10:00:00.000Z")];
  const closed: ApplicationStatus[] = [
    "APPLIED", "RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW", "OFFER", "REJECTED", "GHOSTED", "ARCHIVED"
  ];
  for (const status of closed) {
    assert.equal(resolveApplyReturn({ userId: OWNER, status, events }).pending, null, status);
  }
  for (const status of ["SAVED", "INTERESTED"] as const) {
    assert.ok(resolveApplyReturn({ userId: OWNER, status, events }).pending, status);
  }
});

test("another user's events and malformed records are never read as the owner's opened moment", () => {
  const malformed: Event[] = [
    opened("foreign", "2026-11-06T10:00:00.000Z", OTHER),
    { id: "bad-schema", userId: OWNER, type: "NOTE_ADDED", occurredAt: at("2026-11-06T11:00:00.000Z"), metadata: { [APPLY_RETURN_METADATA_KEY]: { schema: "apply-pilot/apply-return/v0", kind: "OPENED", openedAt: "2026-11-06T11:00:00.000Z" } } },
    { id: "no-date", userId: OWNER, type: "NOTE_ADDED", occurredAt: at("2026-11-06T11:00:00.000Z"), metadata: { [APPLY_RETURN_METADATA_KEY]: { schema: APPLY_RETURN_SCHEMA, kind: "OPENED", applyHost: null } } },
    { id: "array", userId: OWNER, type: "NOTE_ADDED", occurredAt: at("2026-11-06T11:00:00.000Z"), metadata: [] },
    { id: "null", userId: OWNER, type: "NOTE_ADDED", occurredAt: at("2026-11-06T11:00:00.000Z"), metadata: null }
  ];
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "SAVED", events: malformed }).pending, null);
});

test("'Not applying' is in effect, and can be undone, while it is the latest status change of an archived application", () => {
  const events = [opened("opened-1", "2026-11-06T10:00:00.000Z"), declined("decline-1", "2026-11-06T10:20:00.000Z", "INTERESTED")];
  const state = resolveApplyReturn({ userId: OWNER, status: "ARCHIVED", events });
  assert.deepEqual(state.declined, {
    eventId: "decline-1",
    answeredAt: "2026-11-06T10:20:00.000Z",
    previousStatus: "INTERESTED",
    previousPostingStatus: "ACTIVE"
  });
  assert.equal(state.pending, null);

  // Undone: no longer in effect.
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "SAVED", events: [...events, undone("undo-1", "2026-11-06T10:21:00.000Z", "decline-1")] }).declined, null);
  // A later status change from the tracker (archived again by hand, say) takes over.
  const later: Event = { id: "later", userId: OWNER, type: "STATUS_CHANGED", occurredAt: at("2026-11-06T11:00:00.000Z"), metadata: null };
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "ARCHIVED", events: [...events, later] }).declined, null);
  // The application is no longer archived.
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "APPLIED", events }).declined, null);
});

test("after 'Not applying' is undone the original question is open again", () => {
  const events = [
    opened("opened-1", "2026-11-06T10:00:00.000Z"),
    declined("decline-1", "2026-11-06T10:20:00.000Z"),
    undone("undo-1", "2026-11-06T10:21:00.000Z", "decline-1")
  ];
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "SAVED", events }).pending?.openedEventId, "opened-1");
});

test("the minutes box is pre-filled with the whole minutes between opening and coming back", () => {
  const openedAt = at("2026-11-06T10:00:00.000Z");
  const after = (seconds: number) => new Date(openedAt.getTime() + seconds * 1000);
  assert.equal(prefillEffortMinutes(openedAt, after(12 * 60 + 29)), 12);
  assert.equal(prefillEffortMinutes(openedAt, after(12 * 60 + 30)), 13);
  assert.equal(prefillEffortMinutes(openedAt, after(45 * 60)), 45);
});

test("a very short visit pre-fills the 1-minute floor", () => {
  const openedAt = at("2026-11-06T10:00:00.000Z");
  assert.equal(prefillEffortMinutes(openedAt, openedAt), 1);
  assert.equal(prefillEffortMinutes(openedAt, new Date(openedAt.getTime() + 20_000)), 1);
});

test("the pre-fill reaches the 600-minute ceiling but never guesses beyond it", () => {
  const openedAt = at("2026-11-06T10:00:00.000Z");
  const minutes = (value: number) => new Date(openedAt.getTime() + value * 60_000);
  assert.equal(prefillEffortMinutes(openedAt, minutes(600)), 600);
  assert.equal(prefillEffortMinutes(openedAt, minutes(600.4)), 600);
  // Away longer than the box allows (overnight, say): that gap is not how long the application
  // took, so the box is left blank for the user's own estimate instead of claiming 600.
  assert.equal(prefillEffortMinutes(openedAt, minutes(600.6)), null);
  assert.equal(prefillEffortMinutes(openedAt, minutes(60 * 24)), null);
});

test("an impossible gap (coming back before opening, or unreadable times) pre-fills nothing", () => {
  const openedAt = at("2026-11-06T10:00:00.000Z");
  assert.equal(prefillEffortMinutes(openedAt, new Date(openedAt.getTime() - 60_000)), null);
  assert.equal(prefillEffortMinutes(new Date(Number.NaN), openedAt), null);
  assert.equal(prefillEffortMinutes(openedAt, new Date(Number.NaN)), null);
});
