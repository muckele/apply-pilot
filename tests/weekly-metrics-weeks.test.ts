import assert from "node:assert/strict";
import test from "node:test";

import { METRICS_TIME_ZONE, buildMetricWeeks, startOfMetricWeek } from "@/lib/metrics/weeks";

const iso = (value: Date) => value.toISOString();

test("metric weeks run Monday to Monday in Pacific time", () => {
  assert.equal(METRICS_TIME_ZONE, "America/Los_Angeles");
  // Wednesday 2026-11-04 12:00 PST.
  const [week] = buildMetricWeeks({ now: new Date("2026-11-04T20:00:00Z"), count: 1 });

  assert.equal(iso(week.start), "2026-11-02T08:00:00.000Z");
  assert.equal(iso(week.end), "2026-11-09T08:00:00.000Z");
  assert.equal(week.label, "2026-11-02");
  assert.equal(week.isCurrent, true);
});

test("Sunday 23:59 Pacific belongs to the week that started the previous Monday", () => {
  assert.equal(iso(startOfMetricWeek(new Date("2026-11-09T07:59:59Z"))), "2026-11-02T08:00:00.000Z");
  assert.equal(iso(startOfMetricWeek(new Date("2026-11-09T08:00:00Z"))), "2026-11-09T08:00:00.000Z");
});

test("an instant that is already Monday in UTC but still Sunday in Pacific stays in the earlier week", () => {
  // 2026-11-02T03:00Z is Sunday 2026-11-01 19:00 PST.
  assert.equal(iso(startOfMetricWeek(new Date("2026-11-02T03:00:00Z"))), "2026-10-26T07:00:00.000Z");
});

test("weeks are contiguous, oldest first, and the week holding the autumn clock change is 169 hours", () => {
  const weeks = buildMetricWeeks({ now: new Date("2026-11-04T20:00:00Z"), count: 3 });

  assert.deepEqual(weeks.map((week) => week.label), ["2026-10-19", "2026-10-26", "2026-11-02"]);
  assert.deepEqual(weeks.map((week) => week.isCurrent), [false, false, true]);
  for (let index = 1; index < weeks.length; index += 1) {
    assert.equal(iso(weeks[index - 1].end), iso(weeks[index].start));
  }
  assert.equal(iso(weeks[1].start), "2026-10-26T07:00:00.000Z");
  assert.equal(iso(weeks[1].end), "2026-11-02T08:00:00.000Z");
  assert.equal((weeks[1].end.getTime() - weeks[1].start.getTime()) / 3_600_000, 169);
});

test("the week holding the spring clock change is 167 hours", () => {
  const [week] = buildMetricWeeks({ now: new Date("2027-03-10T20:00:00Z"), count: 1 });

  assert.equal(iso(week.start), "2027-03-08T08:00:00.000Z");
  assert.equal(iso(week.end), "2027-03-15T07:00:00.000Z");
  assert.equal((week.end.getTime() - week.start.getTime()) / 3_600_000, 167);
});

test("the week count must be a whole number from 1 to 53", () => {
  const now = new Date("2026-11-04T20:00:00Z");
  for (const count of [0, -1, 1.5, 54, Number.NaN]) {
    assert.throws(() => buildMetricWeeks({ now, count }), RangeError, String(count));
  }
  assert.equal(buildMetricWeeks({ now, count: 53 }).length, 53);
});
