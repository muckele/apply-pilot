import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { interviewScheduleQuery } from "@/lib/interviews/schedule";

const NOW = new Date("2026-11-04T15:00:00.000Z");

test("upcoming interviews are the ones at or after now, plus any not yet scheduled, soonest first", () => {
  assert.deepEqual(interviewScheduleQuery("demo-user", "upcoming", NOW), {
    where: { userId: "demo-user", OR: [{ scheduledAt: { gte: NOW } }, { scheduledAt: null }] },
    orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]
  });
});

test("past interviews are the ones before now, most recent first", () => {
  assert.deepEqual(interviewScheduleQuery("demo-user", "past", NOW), {
    where: { userId: "demo-user", scheduledAt: { lt: NOW } },
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }]
  });
});

test("the interviews page lists past interviews apart from upcoming ones", () => {
  const page = readFileSync("app/(product)/interviews/page.tsx", "utf8");
  assert.match(page, /interviewScheduleQuery\(userId, "upcoming", now\)/);
  assert.match(page, /interviewScheduleQuery\(userId, "past", now\)/);
  assert.match(page, /title="Upcoming interviews"/);
  assert.match(page, /title="Past interviews"/);
  // One query for every interview would let 50 past interviews crowd out the upcoming ones.
  assert.doesNotMatch(page, /orderBy: \[\{ scheduledAt: "asc" \}/);
});
