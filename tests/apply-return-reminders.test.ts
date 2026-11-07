import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApplyReturnReminder } from "@/components/apply-kit/apply-return-reminder";
import { APPLY_RETURN_METADATA_KEY, buildApplicationOpenedRecord } from "@/lib/applications/apply-return";
import { loadApplyReturnReminders, type ApplyReturnReminderDb } from "@/lib/applications/apply-return-reminders";

// The dashboard reminder: "You opened N applications. Did you apply?", one link per open question.

const OWNER = "user-owner";
const OTHER = "user-other";

type Row = Record<string, unknown>;

function opened(id: string, iso: string, userId = OWNER) {
  return {
    id,
    userId,
    type: "NOTE_ADDED",
    occurredAt: new Date(iso),
    metadata: { [APPLY_RETURN_METADATA_KEY]: buildApplicationOpenedRecord({ openedAt: new Date(iso), applyHost: "jobs.example.test" }) }
  };
}

function application(id: string, status: string, events: Row[], userId = OWNER, company = `Company ${id}`) {
  return { id, userId, status, jobPosting: { id: `job-${id}`, userId, title: `Role ${id}`, company }, events };
}

function readPath(value: unknown, path: readonly string[]) {
  return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Row)[key] : undefined), value);
}

function eventMatches(event: Row, where: Row) {
  const metadata = where.metadata as { path: string[]; equals: unknown } | undefined;
  return event.userId === where.userId && (!metadata || readPath(event.metadata, metadata.path) === metadata.equals);
}

// Evaluates the filters the loader sends (owner, status, "has an opened event"), recording them.
function fakeDb(rows: Row[], options: { ignoreFilters?: boolean } = {}) {
  const wheres: Row[] = [];
  const keep = (where: Row) => (row: Row) => {
    if (options.ignoreFilters) return true;
    const status = where.status as { in: string[] };
    const some = (where.events as { some: Row }).some;
    return row.userId === where.userId && status.in.includes(String(row.status)) && (row.events as Row[]).some((event) => eventMatches(event, some));
  };
  const db = {
    application: {
      async count({ where }: { where: Row }) {
        wheres.push(where);
        return rows.filter(keep(where)).length;
      },
      async findMany({ where, select }: { where: Row; select: { events: { where: Row } } }) {
        wheres.push(where);
        return structuredClone(rows.filter(keep(where)).map((row) => ({
          ...row,
          events: options.ignoreFilters ? row.events : (row.events as Row[]).filter((event) => eventMatches(event, select.events.where))
        })));
      }
    }
  };
  return { db: db as unknown as ApplyReturnReminderDb, wheres };
}

test("lists the owner's open questions, most recently opened first, each linking to its Apply Kit", async () => {
  const { db, wheres } = fakeDb([
    application("a", "SAVED", [opened("a-1", "2026-11-04T10:00:00.000Z")]),
    application("b", "INTERESTED", [opened("b-1", "2026-11-06T09:00:00.000Z")]),
    application("c", "SAVED", [opened("c-1", "2026-11-05T09:00:00.000Z"), opened("c-2", "2026-11-03T09:00:00.000Z")]),
    application("applied", "APPLIED", [opened("applied-1", "2026-11-06T11:00:00.000Z")]),
    application("archived", "ARCHIVED", [opened("archived-1", "2026-11-06T11:00:00.000Z")]),
    application("never-opened", "SAVED", []),
    application("foreign", "SAVED", [opened("foreign-1", "2026-11-06T12:00:00.000Z", OTHER)], OTHER)
  ]);
  const reminders = await loadApplyReturnReminders(db, { userId: OWNER });
  assert.equal(reminders.count, 3);
  assert.deepEqual(reminders.items.map((item) => [item.jobId, item.company, item.title, item.openedAt, item.href]), [
    ["job-b", "Company b", "Role b", "2026-11-06T09:00:00.000Z", "/jobs/job-b/apply"],
    ["job-c", "Company c", "Role c", "2026-11-05T09:00:00.000Z", "/jobs/job-c/apply"],
    ["job-a", "Company a", "Role a", "2026-11-04T10:00:00.000Z", "/jobs/job-a/apply"]
  ]);
  for (const where of wheres) {
    assert.equal(where.userId, OWNER);
    assert.equal(((where.events as { some: Row }).some).userId, OWNER, "the opened event must be the owner's too");
  }
});

test("rows that are not the owner's, or not an open question, are dropped even if a query returned them", async () => {
  const { db } = fakeDb([
    application("foreign", "SAVED", [opened("foreign-1", "2026-11-06T12:00:00.000Z", OTHER)], OTHER),
    application("mixed", "SAVED", [opened("mixed-1", "2026-11-06T12:00:00.000Z", OTHER)]),
    application("applied", "APPLIED", [opened("applied-1", "2026-11-06T11:00:00.000Z")]),
    application("ok", "SAVED", [opened("ok-1", "2026-11-06T08:00:00.000Z")])
  ], { ignoreFilters: true });
  const reminders = await loadApplyReturnReminders(db, { userId: OWNER });
  assert.deepEqual(reminders.items.map((item) => item.jobId), ["job-ok"]);
});

test("shows at most the limit while the count says how many are open", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => application(`r${index}`, "SAVED", [opened(`r${index}-1`, `2026-11-0${index + 1}T10:00:00.000Z`)]));
  const reminders = await loadApplyReturnReminders(fakeDb(rows).db, { userId: OWNER, limit: 5 });
  assert.equal(reminders.count, 7);
  assert.equal(reminders.items.length, 5);
  assert.equal(reminders.items[0]!.jobId, "job-r6");
});

test("the dashboard reminder asks 'You opened N applications. Did you apply?' and links to each", () => {
  const items = [
    { applicationId: "a", jobId: "job-a", title: "Role a", company: "Company a", openedAt: "2026-11-06T09:00:00.000Z", href: "/jobs/job-a/apply" },
    { applicationId: "b", jobId: "job-b", title: "Role b", company: "Company b", openedAt: "2026-11-05T09:00:00.000Z", href: "/jobs/job-b/apply" }
  ];
  const html = renderToStaticMarkup(createElement(ApplyReturnReminder, { reminders: { count: 3, items } }));
  assert.match(html, /You opened 3 applications\. Did you apply\?/u);
  assert.match(html, /href="\/jobs\/job-a\/apply"[^>]*>[\s\S]*Company a/u);
  assert.match(html, /href="\/jobs\/job-b\/apply"/u);
  assert.match(html, /and 1 more/u);

  const one = renderToStaticMarkup(createElement(ApplyReturnReminder, { reminders: { count: 1, items: items.slice(0, 1) } }));
  assert.match(one, /You opened 1 application\. Did you apply\?/u);
  assert.doesNotMatch(one, /more/u);

  assert.equal(renderToStaticMarkup(createElement(ApplyReturnReminder, { reminders: { count: 0, items: [] } })), "");
});
