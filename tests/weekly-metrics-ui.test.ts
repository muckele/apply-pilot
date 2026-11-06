import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { resolveActiveProductNavHref } from "@/components/product-nav";
import {
  INSIGHTS_WEEK_OPTIONS,
  WeeklyMetricsReportView,
  formatMetricResult,
  resolveInsightsWeekCount
} from "@/components/weekly-metrics-report";
import { SELF_REPORTED_EFFORT_METADATA_KEY, buildSelfReportedEffort } from "@/lib/applications/self-reported-effort";
import { SENT_DOCUMENTS_METADATA_KEY, SENT_DOCUMENTS_SCHEMA } from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import { WEEKLY_METRIC_DEFINITIONS, computeWeeklyMetrics, type WeeklyMetricsRows } from "@/lib/metrics/weekly-metrics";
import { METRICS_TIME_ZONE, buildMetricWeeks } from "@/lib/metrics/weeks";

const USER = "user-a";
const NOW = new Date("2026-11-04T20:00:00Z");

function emptyRows(createdAt: string): WeeklyMetricsRows {
  return {
    account: { userId: USER, createdAt: new Date(createdAt) },
    jobs: [],
    applications: [],
    statusEvents: [],
    appliedEvents: [],
    tailoredDocuments: [],
    interviews: [],
    aiUsage: []
  };
}

function render(rows: WeeklyMetricsRows, weekCount = 3) {
  const report = computeWeeklyMetrics({ userId: USER, weeks: buildMetricWeeks({ now: NOW, count: weekCount }), now: NOW, rows });
  const markup = renderToStaticMarkup(createElement(WeeklyMetricsReportView, {
    report: { ...report, timeZone: METRICS_TIME_ZONE },
    weekCount
  }));
  return new JSDOM(`<body>${markup}</body>`).window.document;
}

function sentResume() {
  const content = "Tailored resume";
  return {
    [SENT_DOCUMENTS_METADATA_KEY]: {
      schema: SENT_DOCUMENTS_SCHEMA,
      recordedAt: "2026-10-27T18:00:00.000Z",
      resume: {
        kind: "RESUME",
        documentId: "resume-1",
        title: "Resume",
        versionNumber: 1,
        contentHash: documentContentHash(content),
        content,
        readinessState: "EVIDENCE_CURRENT",
        evidenceSnapshotId: null,
        documentCreatedAt: "2026-10-27T17:00:00.000Z",
        resumeFormat: { template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 }
      },
      coverLetter: null
    }
  };
}

function busyRows(): WeeklyMetricsRows {
  const rows = emptyRows("2026-10-01T00:00:00Z");
  rows.jobs = [
    { id: "job-1", userId: USER, firstDiscoveredAt: new Date("2026-10-27T10:00:00Z") },
    { id: "job-2", userId: USER, firstDiscoveredAt: new Date("2026-10-27T11:00:00Z") },
    { id: "job-3", userId: USER, firstDiscoveredAt: new Date("2026-11-03T11:00:00Z") }
  ];
  rows.applications = [
    { id: "app-1", userId: USER, jobPostingId: "job-1", status: "APPLIED", createdAt: new Date("2026-10-27T12:00:00Z"), dateApplied: new Date("2026-10-27T18:00:00Z") },
    { id: "app-2", userId: USER, jobPostingId: "job-2", status: "RECRUITER_SCREEN", createdAt: new Date("2026-10-27T12:00:00Z"), dateApplied: new Date("2026-10-28T18:00:00Z") }
  ];
  rows.statusEvents = [
    { id: "event-1", userId: USER, applicationId: "app-2", type: "STATUS_CHANGED", title: "Status changed to Recruiter screen", occurredAt: new Date("2026-11-03T18:00:00Z") }
  ];
  const minutes = (value: number, at: string) => ({
    [SELF_REPORTED_EFFORT_METADATA_KEY]: buildSelfReportedEffort({ minutes: value, recordedAt: new Date(at) })
  });
  rows.appliedEvents = [
    { id: "sent-1", userId: USER, applicationId: "app-1", occurredAt: new Date("2026-10-27T18:00:00Z"), metadata: { ...sentResume(), ...minutes(45, "2026-10-27T18:00:00Z") } },
    { id: "effort-2", userId: USER, applicationId: "app-2", occurredAt: new Date("2026-10-28T18:00:00Z"), metadata: minutes(75, "2026-10-28T18:00:00Z") }
  ];
  rows.aiUsage = [{ userId: USER, createdAt: new Date("2026-10-27T10:00:00Z"), estimatedCostMicros: 45_000 }];
  return rows;
}

test("ratios show a whole percentage with their sample, and flag small samples", () => {
  assert.deepEqual(formatMetricResult({ kind: "ratio", numerator: 2, denominator: 3, value: 2 / 3, smallSample: true }), {
    value: "67%",
    detail: "2 of 3 · small sample"
  });
  assert.deepEqual(formatMetricResult({ kind: "ratio", numerator: 5, denominator: 8, value: 5 / 8, smallSample: false }), {
    value: "63%",
    detail: "5 of 8"
  });
});

test("money per application uses the AI Controls currency format and names its divisor", () => {
  assert.deepEqual(formatMetricResult({ kind: "money_per_item", totalMicros: 45_000, items: 2, valueMicros: 22_500, smallSample: true }), {
    value: "$0.0225",
    detail: "$0.0450 over 2 applications · small sample"
  });
});

test("effort minutes round to whole minutes and say how many applications reported them", () => {
  assert.deepEqual(formatMetricResult({ kind: "minutes_per_item", totalMinutes: 85, reported: 2, applications: 3, valueMinutes: 42.5, smallSample: true }), {
    value: "43 min",
    detail: "85 min over 2 of 3 applications · small sample"
  });
  assert.deepEqual(formatMetricResult({ kind: "minutes_per_item", totalMinutes: 300, reported: 6, applications: 6, valueMinutes: 50, smallSample: false }), {
    value: "50 min",
    detail: "300 min over 6 applications"
  });
});

test("interviews per applicant-hour shows two decimals with the interviews and hours behind it", () => {
  assert.deepEqual(formatMetricResult({ kind: "interviews_per_hour", interviews: 1, totalMinutes: 120, reported: 2, applications: 3, value: 0.5, smallSample: true }), {
    value: "0.50 per hour",
    detail: "1 interview in 2 hours, over 2 of 3 applications · small sample"
  });
  assert.deepEqual(formatMetricResult({ kind: "interviews_per_hour", interviews: 0, totalMinutes: 330, reported: 5, applications: 5, value: 0, smallSample: false }), {
    value: "0.00 per hour",
    detail: "0 interviews in 5.5 hours, over 5 applications"
  });
});

test("missing data says so instead of showing a number", () => {
  assert.deepEqual(formatMetricResult({ kind: "not_enough_data", reason: "No applications recorded as applied in this period." }), {
    value: "Not enough data",
    detail: "No applications recorded as applied in this period."
  });
});

test("the primary metric shows interviews per applicant-hour from reported minutes", () => {
  const primary = render(busyRows()).querySelector("[data-metric='interviewsPerApplicantHour']");

  assert.match(primary?.textContent ?? "", /0\.50 per hour/);
  assert.match(primary?.textContent ?? "", /1 interview in 2 hours, over 2 applications · small sample/);
});

test("an empty account sees no misleading numbers, the primary metric included", () => {
  const document = render(emptyRows("2026-11-03T18:00:00Z"));

  const primary = document.querySelector("[data-metric='interviewsPerApplicantHour']");
  assert.ok(primary);
  assert.match(primary.textContent ?? "", /Interviews per applicant-hour/);
  assert.match(primary.textContent ?? "", /Not enough data/);
  for (const key of ["effortMinutesPerApplication", "tailoredShare", "completeTracking", "interviewRate", "feedSaveRate", "aiCostPerApplication"]) {
    const card = document.querySelector(`[data-metric='${key}']`);
    assert.ok(card, key);
    assert.match(card.textContent ?? "", /Not enough data/, key);
    assert.doesNotMatch(card.textContent ?? "", /\b0%/, key);
  }
  assert.match(document.body.textContent ?? "", /2 earlier weeks are not shown/);
});

test("every metric on the page states how it is computed", () => {
  const text = render(busyRows()).body.textContent ?? "";

  for (const definition of Object.values(WEEKLY_METRIC_DEFINITIONS)) {
    assert.ok(text.includes(definition.howComputed), definition.label);
  }
  assert.match(text, /Monday to Sunday, Pacific time/);
});

test("the weekly funnel is a captioned table, newest week first, with the current week marked and a total row", () => {
  const document = render(busyRows());
  const table = document.querySelector("table[data-table='funnel']");
  assert.ok(table);
  assert.match(table.querySelector("caption")?.textContent ?? "", /funnel/i);
  const headers = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim());
  assert.deepEqual(headers, ["Week of", "Jobs added to your feed", "Saved to tracker", "Apply Kits prepared", "Applied", "Interviews"]);
  for (const header of table.querySelectorAll("thead th")) assert.equal(header.getAttribute("scope"), "col");

  const bodyRows = [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim()));
  assert.deepEqual(bodyRows, [
    ["Nov 2 (so far)", "1", "0", "0", "0", "1"],
    ["Oct 26", "2", "2", "0", "2", "0"],
    ["Oct 19", "0", "0", "0", "0", "0"]
  ]);
  const footer = [...table.querySelectorAll("tfoot tr th, tfoot tr td")].map((cell) => cell.textContent?.trim());
  assert.deepEqual(footer, ["Last 3 weeks", "3", "2", "0", "2", "1"]);
});

test("supporting metrics show the window value with its sample, and a per-week table", () => {
  const document = render(busyRows());

  const tailored = document.querySelector("[data-metric='tailoredShare']");
  assert.match(tailored?.textContent ?? "", /100%/);
  assert.match(tailored?.textContent ?? "", /1 of 1 · small sample/);
  const cost = document.querySelector("[data-metric='aiCostPerApplication']");
  assert.match(cost?.textContent ?? "", /\$0\.0225/);
  const table = document.querySelector("table[data-table='supporting']");
  assert.ok(table);
  const lastWeek = [...table.querySelectorAll("tbody tr")][1];
  const cells = [...lastWeek.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim());
  assert.equal(cells[0], "Oct 26");
  assert.ok(cells.includes("50% (1 of 2)"), cells.join(" | "));
  assert.ok(cells.includes("$0.0450"), cells.join(" | "));
  assert.ok(cells.includes("0.50 (1 in 2 h)"), cells.join(" | "));
  assert.ok(cells.includes("60 min (2 reported)"), cells.join(" | "));
  const effort = document.querySelector("[data-metric='effortMinutesPerApplication']");
  assert.match(effort?.textContent ?? "", /60 min/);
  assert.match(effort?.textContent ?? "", /Apply Kit/);
});

test("data notes and the list of unmeasured numbers are shown", () => {
  const rows = busyRows();
  rows.applications.push({ id: "app-3", userId: USER, jobPostingId: "job-3", status: "GHOSTED", createdAt: new Date("2026-11-03T12:00:00Z"), dateApplied: null });
  const document = render(rows);

  const notes = document.querySelector("[data-section='data-notes']");
  assert.match(notes?.textContent ?? "", /1 application is past Applied but has no applied date/);
  const gaps = document.querySelector("[data-section='not-measured']")?.textContent ?? "";
  assert.doesNotMatch(gaps, /time you spend applying/i, "time is now self-reported");
  assert.match(gaps, /which feed jobs you opened/i);
  assert.match(gaps, /factual-error rate/i);
});

test("the range picker offers 4, 8 and 13 weeks and marks the current choice", () => {
  assert.deepEqual([...INSIGHTS_WEEK_OPTIONS], [4, 8, 13]);
  const document = render(busyRows(), 8);
  const links = [...document.querySelectorAll("nav[aria-label='Weeks shown'] a")];

  assert.deepEqual(links.map((link) => link.getAttribute("href")), ["/insights?weeks=4", "/insights?weeks=8", "/insights?weeks=13"]);
  assert.deepEqual(links.map((link) => link.getAttribute("aria-current")), [null, "page", null]);
});

test("the weeks parameter only accepts the offered ranges", () => {
  assert.equal(resolveInsightsWeekCount(undefined), 8);
  assert.equal(resolveInsightsWeekCount("4"), 4);
  assert.equal(resolveInsightsWeekCount("13"), 13);
  assert.equal(resolveInsightsWeekCount(["13", "4"]), 13);
  for (const value of ["5", "53", "-4", "8.5", "abc", ""]) assert.equal(resolveInsightsWeekCount(value), 8, value);
});

test("Insights is in the product navigation", () => {
  assert.equal(resolveActiveProductNavHref("/insights"), "/insights");
});
