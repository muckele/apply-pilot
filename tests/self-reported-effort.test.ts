import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EFFORT_MINUTES,
  SELF_REPORTED_EFFORT_METADATA_KEY,
  SELF_REPORTED_EFFORT_SCHEMA,
  buildSelfReportedEffort,
  effortMinutesSchema,
  latestSelfReportedEffort,
  parseEffortMinutesInput,
  readSelfReportedEffort
} from "@/lib/applications/self-reported-effort";

const recordedAt = new Date("2026-11-03T18:30:00.000Z");

test("a built record round-trips through event metadata", () => {
  const record = buildSelfReportedEffort({ minutes: 45, recordedAt });
  assert.deepEqual(record, { schema: SELF_REPORTED_EFFORT_SCHEMA, minutes: 45, recordedAt: "2026-11-03T18:30:00.000Z" });
  assert.deepEqual(readSelfReportedEffort({ other: true, [SELF_REPORTED_EFFORT_METADATA_KEY]: record }), record);
});

test("the minutes input accepts whole minutes from 1 to the maximum only", () => {
  for (const ok of [1, 45, MAX_EFFORT_MINUTES]) assert.equal(effortMinutesSchema.safeParse(ok).success, true, String(ok));
  for (const bad of [0, -5, 12.5, MAX_EFFORT_MINUTES + 1, "45", null, Number.NaN]) {
    assert.equal(effortMinutesSchema.safeParse(bad).success, false, String(bad));
  }
});

test("a missing, malformed or out-of-range record reads as no record", () => {
  const valid = buildSelfReportedEffort({ minutes: 30, recordedAt });
  for (const metadata of [
    null,
    undefined,
    "text",
    [],
    {},
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, schema: "apply-pilot/self-reported-effort/v0" } },
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, minutes: 0 } },
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, minutes: MAX_EFFORT_MINUTES + 1 } },
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, minutes: 7.5 } },
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, recordedAt: "yesterday" } },
    { [SELF_REPORTED_EFFORT_METADATA_KEY]: { ...valid, extra: "field" } }
  ]) {
    assert.equal(readSelfReportedEffort(metadata), null, JSON.stringify(metadata));
  }
});

test("the latest record wins when an application entered Applied more than once", () => {
  const event = (id: string, at: string, minutes: number | null) => ({
    id,
    occurredAt: new Date(at),
    metadata: minutes === null ? {} : { [SELF_REPORTED_EFFORT_METADATA_KEY]: buildSelfReportedEffort({ minutes, recordedAt: new Date(at) }) }
  });
  assert.equal(latestSelfReportedEffort([]), null);
  assert.equal(latestSelfReportedEffort([event("a", "2026-11-01T00:00:00Z", null)]), null);
  const latest = latestSelfReportedEffort([
    event("b", "2026-11-03T00:00:00Z", 50),
    event("a", "2026-11-01T00:00:00Z", 20),
    event("c", "2026-11-04T00:00:00Z", null)
  ]);
  assert.equal(latest?.minutes, 50);
});

test("the Apply Kit's minutes box: blank means not reported, otherwise whole minutes in range", () => {
  assert.deepEqual(parseEffortMinutesInput(""), { ok: true, minutes: null });
  assert.deepEqual(parseEffortMinutesInput("   "), { ok: true, minutes: null });
  assert.deepEqual(parseEffortMinutesInput(" 45 "), { ok: true, minutes: 45 });
  assert.deepEqual(parseEffortMinutesInput(String(MAX_EFFORT_MINUTES)), { ok: true, minutes: MAX_EFFORT_MINUTES });
  for (const bad of ["0", "-5", "12.5", "1e2", "abc", String(MAX_EFFORT_MINUTES + 1)]) {
    assert.deepEqual(parseEffortMinutesInput(bad), { ok: false }, bad);
  }
});
