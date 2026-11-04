import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPLICATION_EXPORT_HEADERS,
  buildApplicationsCsv,
  escapeCsvCell,
  neutralizeSpreadsheetFormula,
  toApplicationExportRow,
  type ApplicationExportRecord
} from "@/lib/applications/csv-export";

const BOM = String.fromCharCode(0xfeff);
const FULL_WIDTH_EQUALS = String.fromCharCode(0xff1d);

/** Minimal RFC 4180 parser used only to prove round-tripping. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { cell += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\r" && text[index + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; index += 1; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function record(overrides: Partial<ApplicationExportRecord> = {}): ApplicationExportRecord {
  return {
    id: "app-1",
    userId: "owner-1",
    status: "APPLIED",
    createdAt: new Date("2026-10-01T15:00:00.000Z"),
    dateApplied: new Date("2026-10-03T18:30:00.000Z"),
    followUpDueAt: new Date("2026-10-10T00:00:00.000Z"),
    jobPosting: {
      company: "Acme, Inc.",
      title: "Solutions \"Lead\" Engineer",
      sourceUrl: "https://boards.example.test/acme/jobs/1",
      applyUrl: "https://boards.example.test/acme/jobs/1/apply"
    },
    resumeVersion: { id: "resume-v1", title: "Acme tailored resume", userId: "owner-1" },
    coverLetterVersion: { id: "letter-v1", title: "Acme cover letter", userId: "owner-1" },
    events: [{ title: "Status changed to APPLIED", occurredAt: new Date("2026-10-03T18:30:00.000Z") }],
    ...overrides
  };
}

test("RFC 4180 escaping quotes commas, quotes, and line breaks and leaves plain cells alone", () => {
  assert.equal(escapeCsvCell("plain"), "plain");
  assert.equal(escapeCsvCell("Acme, Inc."), "\"Acme, Inc.\"");
  assert.equal(escapeCsvCell("Say \"hi\""), "\"Say \"\"hi\"\"\"");
  assert.equal(escapeCsvCell("line one\nline two"), "\"line one\nline two\"");
  assert.equal(escapeCsvCell("line one\r\nline two"), "\"line one\r\nline two\"");
  assert.equal(escapeCsvCell(null), "");
  assert.equal(escapeCsvCell(undefined), "");
  assert.equal(escapeCsvCell(0), "0");
  assert.equal(escapeCsvCell(84), "84");
});

test("spreadsheet formula injection is neutralized with a leading apostrophe", () => {
  for (const dangerous of ["=HYPERLINK(\"https://evil.test\",\"x\")", "+1+1", "-2+3", "@SUM(A1:A2)", "\t=1", "\r=1", `${FULL_WIDTH_EQUALS}1+1`]) {
    const neutral = neutralizeSpreadsheetFormula(dangerous);
    assert.equal(neutral, `'${dangerous}`, JSON.stringify(dangerous));
    const [[parsed]] = parseCsv(escapeCsvCell(dangerous));
    assert.equal(parsed, `'${dangerous}`);
  }
  assert.equal(escapeCsvCell("=1,2"), "\"'=1,2\"");
  assert.equal(neutralizeSpreadsheetFormula("Acme = good"), "Acme = good");
  assert.equal(neutralizeSpreadsheetFormula("C++ Engineer"), "C++ Engineer");
  assert.equal(neutralizeSpreadsheetFormula(""), "");
});

test("export rows carry the requested columns, document versions, last event, and validated fit score", () => {
  const row = toApplicationExportRow(record(), { userId: "owner-1", fitScore: 84 });
  assert.deepEqual(row, {
    company: "Acme, Inc.",
    title: "Solutions \"Lead\" Engineer",
    status: "Applied",
    created: "2026-10-01",
    appliedDate: "2026-10-03",
    sourceUrl: "https://boards.example.test/acme/jobs/1",
    applyUrl: "https://boards.example.test/acme/jobs/1/apply",
    fitScore: 84,
    resumeVersionName: "Acme tailored resume",
    resumeVersionId: "resume-v1",
    coverLetterTitle: "Acme cover letter",
    coverLetterId: "letter-v1",
    lastEvent: "Status changed to APPLIED",
    lastEventDate: "2026-10-03",
    nextFollowUp: "2026-10-10"
  });

  const sparse = toApplicationExportRow(record({
    status: "SAVED",
    dateApplied: null,
    followUpDueAt: null,
    resumeVersion: null,
    coverLetterVersion: null,
    events: [],
    jobPosting: { company: "Initech", title: "Analyst", sourceUrl: "https://initech.example.test/careers/2", applyUrl: null }
  }), { userId: "owner-1", fitScore: Number.NaN });
  assert.equal(sparse.status, "Saved");
  assert.equal(sparse.appliedDate, "");
  assert.equal(sparse.nextFollowUp, "");
  assert.equal(sparse.applyUrl, "");
  assert.equal(sparse.fitScore, null);
  assert.equal(sparse.resumeVersionId, "");
  assert.equal(sparse.coverLetterId, "");
  assert.equal(sparse.lastEvent, "");
});

test("export rows never print documents owned by another user even if a foreign key points at them", () => {
  const row = toApplicationExportRow(record({
    resumeVersion: { id: "foreign-resume", title: "Someone else's resume", userId: "intruder-2" },
    coverLetterVersion: { id: "foreign-letter", title: "Someone else's letter", userId: "intruder-2" }
  }), { userId: "owner-1", fitScore: null });
  assert.equal(row.resumeVersionId, "");
  assert.equal(row.resumeVersionName, "");
  assert.equal(row.coverLetterId, "");
  assert.equal(row.coverLetterTitle, "");
});

test("CSV document has a BOM, a header row, CRLF records, and round-trips hostile values", () => {
  const csv = buildApplicationsCsv([
    toApplicationExportRow(record(), { userId: "owner-1", fitScore: 84 }),
    toApplicationExportRow(record({
      id: "app-2",
      jobPosting: { company: "=cmd|' /C calc'!A0", title: "Line\nbreak", sourceUrl: "https://x.test/2", applyUrl: null },
      events: [{ title: "@risk", occurredAt: new Date("2026-10-05T00:00:00.000Z") }]
    }), { userId: "owner-1", fitScore: 0 })
  ]);

  assert.ok(csv.startsWith(BOM));
  assert.ok(csv.endsWith("\r\n"));
  const rows = parseCsv(csv.slice(BOM.length));
  assert.deepEqual(rows[0], [...APPLICATION_EXPORT_HEADERS]);
  assert.deepEqual(APPLICATION_EXPORT_HEADERS, [
    "Company", "Title", "Status", "Created", "Applied date", "Source URL", "Apply URL", "Fit score",
    "Resume version", "Resume version ID", "Cover letter", "Cover letter ID", "Last event", "Last event date", "Next follow-up"
  ]);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.length, APPLICATION_EXPORT_HEADERS.length);
  assert.equal(rows[1][0], "Acme, Inc.");
  assert.equal(rows[1][1], "Solutions \"Lead\" Engineer");
  assert.equal(rows[1][7], "84");
  assert.equal(rows[2][0], "'=cmd|' /C calc'!A0");
  assert.equal(rows[2][1], "Line\nbreak");
  assert.equal(rows[2][7], "0", "a genuine zero fit score is kept");
  assert.equal(rows[2][12], "'@risk");

  assert.equal(parseCsv(buildApplicationsCsv([]).slice(BOM.length)).length, 1, "empty export still has headers");
});
