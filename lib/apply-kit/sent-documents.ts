import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  documentContentHash,
  documentReadinessError,
  resolveDocumentReadiness
} from "@/lib/documents/document-review";

// "What I sent" ledger (MVP Bible §5). When an application enters APPLIED, the exact bytes of the
// selected résumé and cover letter are frozen into the APPLIED timeline event's metadata. Events
// are append-only, so later edits, regenerations or deletions of a document never change what the
// tracker says was sent. The hash is the D031 content hash (sha256 of the exact text), so it can
// be compared with the document's current review hash.

export const SENT_DOCUMENTS_SCHEMA = "apply-pilot/sent-documents/v1" as const;
export const SENT_DOCUMENTS_METADATA_KEY = "sentDocuments" as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const isoTimestamp = z.string().datetime({ offset: true });

const resumeFormatSchema = z.object({
  template: z.string().max(40),
  pageSize: z.string().max(40),
  fontFamily: z.string().max(40),
  accentColor: z.string().max(20),
  fontSize: z.number().int(),
  lineSpacing: z.number().int()
}).strict();

const sentDocumentSchema = z.object({
  kind: z.enum(["RESUME", "COVER_LETTER"]),
  documentId: z.string().min(1).max(191),
  title: z.string().max(500),
  versionNumber: z.number().int().min(1),
  contentHash: sha256,
  content: z.string().max(200_000),
  // Only export-ready states are ever recorded (D031).
  readinessState: z.enum(["EVIDENCE_CURRENT", "EDITED_READY", "LEGACY_CONFIRMED"]),
  evidenceSnapshotId: z.string().max(191).nullable(),
  documentCreatedAt: isoTimestamp,
  resumeFormat: resumeFormatSchema.nullable()
}).strict().refine((document) => documentContentHash(document.content) === document.contentHash, {
  message: "Sent document content does not match its recorded hash."
});

const sentDocumentsSnapshotSchema = z.object({
  schema: z.literal(SENT_DOCUMENTS_SCHEMA),
  recordedAt: isoTimestamp,
  resume: sentDocumentSchema.nullable(),
  coverLetter: sentDocumentSchema.nullable()
}).strict();

export type SentDocument = z.infer<typeof sentDocumentSchema>;
export type SentDocumentsSnapshot = z.infer<typeof sentDocumentsSnapshotSchema>;

export type SentResumeRow = {
  id: string;
  title: string;
  fullText: string;
  evidenceSnapshotId: string | null;
  metadata: unknown;
  createdAt: Date;
  template: string;
  pageSize: string;
  fontFamily: string;
  accentColor: string;
  fontSize: number;
  lineSpacing: number;
};

export type SentCoverLetterRow = {
  id: string;
  title: string;
  content: string;
  evidenceSnapshotId: string | null;
  metadata: unknown;
  createdAt: Date;
};

type CurrentEvidence = {
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
};

function frozenDocument(
  kind: SentDocument["kind"],
  input: CurrentEvidence & {
    id: string;
    title: string;
    content: string;
    evidenceSnapshotId: string | null;
    metadata: unknown;
    createdAt: Date;
    versionNumber: number;
    resumeFormat: SentDocument["resumeFormat"];
  }
): SentDocument {
  // The applications API already refuses documents that are not export-ready; this keeps the
  // ledger from ever recording one even if a caller forgets that gate.
  const readiness = resolveDocumentReadiness({
    jobBound: true,
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid,
    artifact: { evidenceSnapshotId: input.evidenceSnapshotId, content: input.content, metadata: input.metadata }
  });
  if (
    !readiness.exportReady ||
    (readiness.state !== "EVIDENCE_CURRENT" && readiness.state !== "EDITED_READY" && readiness.state !== "LEGACY_CONFIRMED")
  ) {
    throw documentReadinessError(readiness.state, "packet");
  }
  return {
    kind,
    documentId: input.id,
    title: input.title,
    versionNumber: input.versionNumber,
    contentHash: documentContentHash(input.content),
    content: input.content,
    readinessState: readiness.state,
    evidenceSnapshotId: input.evidenceSnapshotId,
    documentCreatedAt: input.createdAt.toISOString(),
    resumeFormat: input.resumeFormat
  };
}

export function buildSentDocumentsSnapshot(input: CurrentEvidence & {
  recordedAt: Date;
  resume: { row: SentResumeRow; versionNumber: number } | null;
  coverLetter: { row: SentCoverLetterRow; versionNumber: number } | null;
}): SentDocumentsSnapshot {
  const evidence = {
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid
  };
  const resume = input.resume
    ? frozenDocument("RESUME", {
        ...evidence,
        id: input.resume.row.id,
        title: input.resume.row.title,
        content: input.resume.row.fullText,
        evidenceSnapshotId: input.resume.row.evidenceSnapshotId,
        metadata: input.resume.row.metadata,
        createdAt: input.resume.row.createdAt,
        versionNumber: input.resume.versionNumber,
        resumeFormat: {
          template: input.resume.row.template,
          pageSize: input.resume.row.pageSize,
          fontFamily: input.resume.row.fontFamily,
          accentColor: input.resume.row.accentColor,
          fontSize: input.resume.row.fontSize,
          lineSpacing: input.resume.row.lineSpacing
        }
      })
    : null;
  const coverLetter = input.coverLetter
    ? frozenDocument("COVER_LETTER", {
        ...evidence,
        id: input.coverLetter.row.id,
        title: input.coverLetter.row.title,
        content: input.coverLetter.row.content,
        evidenceSnapshotId: input.coverLetter.row.evidenceSnapshotId,
        metadata: input.coverLetter.row.metadata,
        createdAt: input.coverLetter.row.createdAt,
        versionNumber: input.coverLetter.versionNumber,
        resumeFormat: null
      })
    : null;
  return {
    schema: SENT_DOCUMENTS_SCHEMA,
    recordedAt: input.recordedAt.toISOString(),
    resume,
    coverLetter
  };
}

export function readSentDocumentsSnapshot(metadata: unknown): SentDocumentsSnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = sentDocumentsSnapshotSchema.safeParse((metadata as Record<string, unknown>)[SENT_DOCUMENTS_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

export function latestSentDocumentsEvent(events: ReadonlyArray<{ id: string; occurredAt: Date; metadata: unknown }>) {
  let latest: { eventId: string; occurredAt: Date; snapshot: SentDocumentsSnapshot } | null = null;
  for (const event of events) {
    const snapshot = readSentDocumentsSnapshot(event.metadata);
    if (!snapshot) continue;
    if (!latest || event.occurredAt.getTime() > latest.occurredAt.getTime()) {
      latest = { eventId: event.id, occurredAt: event.occurredAt, snapshot };
    }
  }
  return latest;
}

// The Apply Kit sends the hashes of the documents the user saw. If either document changed after
// the page loaded, the user must look again before attesting what they sent.
export function assertSentDocumentsUnchanged(input: {
  expectedResumeContentHash?: string;
  expectedCoverLetterContentHash?: string;
  resume: { content: string } | null;
  coverLetter: { content: string } | null;
}) {
  const mismatched = (expected: string | undefined, document: { content: string } | null) =>
    expected !== undefined && (!document || documentContentHash(document.content) !== expected);
  if (
    mismatched(input.expectedResumeContentHash, input.resume) ||
    mismatched(input.expectedCoverLetterContentHash, input.coverLetter)
  ) {
    throw new PublicApiError(
      "A document changed after you opened the Apply Kit. Check the current version, then confirm again.",
      409,
      { code: "APPLICATION_SENT_DOCUMENT_CHANGED" }
    );
  }
}

// Version numbers are 1-based positions among one user's versions for one job, oldest first,
// with the row id breaking createdAt ties. The Apply Kit list and the transaction count agree.
export function documentVersionNumbers(rows: ReadonlyArray<{ id: string; createdAt: Date }>) {
  const ordered = [...rows].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return new Map(ordered.map((row, index) => [row.id, index + 1] as const));
}

export function versionOrdinalWhere(input: { userId: string; jobPostingId: string; row: { id: string; createdAt: Date } }) {
  return {
    userId: input.userId,
    jobPostingId: input.jobPostingId,
    OR: [
      { createdAt: { lt: input.row.createdAt } },
      { createdAt: input.row.createdAt, id: { lte: input.row.id } }
    ]
  };
}

export type SentDocumentsTransaction = {
  resumeVersion: { count(args: { where: ReturnType<typeof versionOrdinalWhere> }): Promise<number> };
  generatedDocument: { count(args: { where: ReturnType<typeof versionOrdinalWhere> & { type: "COVER_LETTER" } }): Promise<number> };
};

export async function captureSentDocumentsInTransaction(tx: SentDocumentsTransaction, input: CurrentEvidence & {
  userId: string;
  jobPostingId: string;
  recordedAt: Date;
  resumeVersion: SentResumeRow | null;
  coverLetterVersion: SentCoverLetterRow | null;
  expectedResumeContentHash?: string;
  expectedCoverLetterContentHash?: string;
}): Promise<SentDocumentsSnapshot> {
  assertSentDocumentsUnchanged({
    expectedResumeContentHash: input.expectedResumeContentHash,
    expectedCoverLetterContentHash: input.expectedCoverLetterContentHash,
    resume: input.resumeVersion ? { content: input.resumeVersion.fullText } : null,
    coverLetter: input.coverLetterVersion
  });
  const [resumeNumber, coverNumber] = await Promise.all([
    input.resumeVersion
      ? tx.resumeVersion.count({ where: versionOrdinalWhere({ userId: input.userId, jobPostingId: input.jobPostingId, row: input.resumeVersion }) })
      : null,
    input.coverLetterVersion
      ? tx.generatedDocument.count({
          where: {
            ...versionOrdinalWhere({ userId: input.userId, jobPostingId: input.jobPostingId, row: input.coverLetterVersion }),
            type: "COVER_LETTER"
          }
        })
      : null
  ]);
  return buildSentDocumentsSnapshot({
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid,
    recordedAt: input.recordedAt,
    resume: input.resumeVersion ? { row: input.resumeVersion, versionNumber: Math.max(1, resumeNumber ?? 1) } : null,
    coverLetter: input.coverLetterVersion ? { row: input.coverLetterVersion, versionNumber: Math.max(1, coverNumber ?? 1) } : null
  });
}

export function shortContentHash(hash: string) {
  return hash.slice(0, 12);
}

export const SENT_READINESS_LABELS: Record<SentDocument["readinessState"], string> = {
  EVIDENCE_CURRENT: "AI-grounded",
  EDITED_READY: "Edited and confirmed",
  LEGACY_CONFIRMED: "Legacy, confirmed by you"
};

// "résumé v3 (a1b2c3d4e5f6…)" or "no résumé".
export function describeSentDocument(document: SentDocument | null, noun: string) {
  return document ? `${noun} v${document.versionNumber} (${shortContentHash(document.contentHash)}…)` : `no ${noun}`;
}
