import type { ApplicationStatus } from "@prisma/client";

import { formatApplicationStatus } from "@/lib/applications/pipeline";
import { validFitScore } from "@/lib/jobs/fit-presentation";

export const APPLICATION_EXPORT_HEADERS = [
  "Company",
  "Title",
  "Status",
  "Created",
  "Applied date",
  "Source URL",
  "Apply URL",
  "Fit score",
  "Resume version",
  "Resume version ID",
  "Cover letter",
  "Cover letter ID",
  "Last event",
  "Last event date",
  "Next follow-up"
] as const;

type OwnedDocument = { id: string; title: string; userId: string } | null;

export type ApplicationExportRecord = {
  id: string;
  userId: string;
  status: ApplicationStatus;
  createdAt: Date;
  dateApplied: Date | null;
  followUpDueAt: Date | null;
  jobPosting: { company: string; title: string; sourceUrl: string; applyUrl: string | null };
  resumeVersion: OwnedDocument;
  coverLetterVersion: OwnedDocument;
  events: Array<{ title: string; occurredAt: Date }>;
};

export type ApplicationExportRow = {
  company: string;
  title: string;
  status: string;
  created: string;
  appliedDate: string;
  sourceUrl: string;
  applyUrl: string;
  fitScore: number | null;
  resumeVersionName: string;
  resumeVersionId: string;
  coverLetterTitle: string;
  coverLetterId: string;
  lastEvent: string;
  lastEventDate: string;
  nextFollowUp: string;
};

type CsvValue = string | number | null | undefined;

// ASCII triggers from OWASP CSV-injection guidance plus their full-width forms, which some spreadsheet locales also evaluate.
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]);

/** Prefixes an apostrophe so spreadsheet apps show the text instead of evaluating it as a formula. */
export function neutralizeSpreadsheetFormula(value: string) {
  return value.length > 0 && FORMULA_TRIGGERS.has(value[0]) ? `'${value}` : value;
}

/** Formula-guards a cell, then applies RFC 4180 quoting. Numbers come from our own data and are not guarded. */
export function escapeCsvCell(value: CsvValue) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : neutralizeSpreadsheetFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function isoDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "";
}

function ownedBy(document: OwnedDocument, userId: string) {
  return document && document.userId === userId ? document : null;
}

export function toApplicationExportRow(
  record: ApplicationExportRecord,
  context: { userId: string; fitScore: number | null | undefined }
): ApplicationExportRow {
  // The write paths already pin documents to the owner; this keeps a bad foreign key from leaking another user's titles.
  const resume = ownedBy(record.resumeVersion, context.userId);
  const coverLetter = ownedBy(record.coverLetterVersion, context.userId);
  const lastEvent = record.events[0] ?? null;

  return {
    company: record.jobPosting.company,
    title: record.jobPosting.title,
    status: formatApplicationStatus(record.status),
    created: isoDate(record.createdAt),
    appliedDate: isoDate(record.dateApplied),
    sourceUrl: record.jobPosting.sourceUrl,
    applyUrl: record.jobPosting.applyUrl ?? "",
    fitScore: validFitScore(context.fitScore),
    resumeVersionName: resume?.title ?? "",
    resumeVersionId: resume?.id ?? "",
    coverLetterTitle: coverLetter?.title ?? "",
    coverLetterId: coverLetter?.id ?? "",
    lastEvent: lastEvent?.title ?? "",
    lastEventDate: isoDate(lastEvent?.occurredAt),
    nextFollowUp: isoDate(record.followUpDueAt)
  };
}

function rowCells(row: ApplicationExportRow): CsvValue[] {
  return [
    row.company,
    row.title,
    row.status,
    row.created,
    row.appliedDate,
    row.sourceUrl,
    row.applyUrl,
    row.fitScore,
    row.resumeVersionName,
    row.resumeVersionId,
    row.coverLetterTitle,
    row.coverLetterId,
    row.lastEvent,
    row.lastEventDate,
    row.nextFollowUp
  ];
}

/** UTF-8 BOM (so Excel reads non-ASCII names correctly), a header row, and CRLF-terminated records. */
export function buildApplicationsCsv(rows: readonly ApplicationExportRow[]) {
  const lines = [[...APPLICATION_EXPORT_HEADERS], ...rows.map(rowCells)]
    .map((cells) => cells.map(escapeCsvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
