import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkStyleQuotes, normalizeWorkStyle, postedAgeLabel, salaryLabel } from "@/lib/jobs/listing-labels";

const now = new Date("2026-11-05T18:00:00.000Z");

test("posted age reads like a person would say it", () => {
  assert.equal(postedAgeLabel(new Date("2026-11-05T09:00:00.000Z"), now), "Today");
  assert.equal(postedAgeLabel(new Date("2026-11-04T09:00:00.000Z"), now), "1 day ago");
  assert.equal(postedAgeLabel(new Date("2026-11-01T09:00:00.000Z"), now), "4 days ago");
  assert.equal(postedAgeLabel(new Date("2026-10-20T09:00:00.000Z"), now), "2 weeks ago");
  assert.equal(postedAgeLabel(new Date("2026-08-01T09:00:00.000Z"), now), "3 months ago");
  assert.equal(postedAgeLabel(new Date("2026-11-07T09:00:00.000Z"), now), "Today");
});

test("salary shows only what the employer listed", () => {
  assert.equal(salaryLabel(165_000, 195_000), "$165k–$195k");
  assert.equal(salaryLabel(130_000, null), "From $130k");
  assert.equal(salaryLabel(null, 90_000), "Up to $90k");
  assert.equal(salaryLabel(null, null), null);
  assert.equal(salaryLabel(45, 60), "$45–$60 an hour");
});

test("work style is normalised from the listing's own field or location", () => {
  assert.equal(normalizeWorkStyle("REMOTE", "Remote — US"), "Remote");
  assert.equal(normalizeWorkStyle("Hybrid", "Seattle, WA"), "Hybrid");
  assert.equal(normalizeWorkStyle("On-site", "Chicago"), "On-site");
  assert.equal(normalizeWorkStyle("onsite", null), "On-site");
  assert.equal(normalizeWorkStyle(null, "Remote, United States"), "Remote");
  assert.equal(normalizeWorkStyle(null, "Denver, CO"), null);
});

test("the remote check quotes the posting's own work-style sentences verbatim", () => {
  const description = "Lead service delivery across teams. This is a fully remote role open to candidates anywhere in the United States.\n\nOccasional travel (up to 10%) for quarterly planning. You will coach leaders.";
  assert.deepEqual(extractWorkStyleQuotes(description), [
    "This is a fully remote role open to candidates anywhere in the United States.",
    "Occasional travel (up to 10%) for quarterly planning."
  ]);
  assert.deepEqual(extractWorkStyleQuotes("Hybrid: three days a week in our Seattle office."), ["Hybrid: three days a week in our Seattle office."]);
  assert.deepEqual(extractWorkStyleQuotes("Build great dashboards. Remotely interesting? No."), []);
  assert.deepEqual(extractWorkStyleQuotes("Lead the team."), []);
});

test("the remote check caps the number of quotes", () => {
  const description = Array.from({ length: 6 }, (_, index) => `Remote sentence ${index}.`).join(" ");
  assert.equal(extractWorkStyleQuotes(description).length, 3);
});
