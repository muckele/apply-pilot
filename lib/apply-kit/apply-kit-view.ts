import type { ApplicationStatus, PostingStatus, PrismaClient } from "@prisma/client";

import { buildApplyKitAnswers, type ApplyKitAnswers } from "@/lib/apply-kit/answers";
import {
  SENT_DOCUMENTS_METADATA_KEY,
  SENT_DOCUMENTS_SCHEMA,
  documentVersionNumbers,
  latestSentDocumentsEvent,
  shortContentHash,
  type SentDocument
} from "@/lib/apply-kit/sent-documents";
import { formatApplicationStatus } from "@/lib/applications/pipeline";
import {
  buildDocumentReviewView,
  type DocumentKind,
  type DocumentReadinessState,
  type DocumentReviewView
} from "@/lib/documents/document-review";
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";

// Server-side loader for the Apply Kit (WP1.5). Every query is scoped to the signed-in user; a job
// owned by someone else is "not found". The result is serializable and contains no sensitive
// Answer Vault values (see lib/apply-kit/answers.ts).

export type ApplyKitDb = Pick<
  PrismaClient,
  "jobPosting" | "resume" | "resumeVersion" | "generatedDocument" | "application" | "applicationAnswer"
>;

export type ApplyKitDocumentStatus =
  | "AI_GROUNDED"
  | "EDITED_CONFIRMED"
  | "LEGACY_CONFIRMED"
  | "NEEDS_REVIEW"
  | "NEEDS_REGENERATION";

export type ApplyKitDocument = {
  kind: DocumentKind;
  id: string;
  title: string;
  versionNumber: number;
  createdAt: string;
  contentHash: string;
  status: ApplyKitDocumentStatus;
  readinessState: DocumentReadinessState;
  statusLabel: string;
  statusDetail: string;
  exportReady: boolean;
  review: DocumentReviewView;
  editorHref: string;
};

type SentSummary = Pick<SentDocument, "versionNumber" | "title" | "readinessState"> & { shortHash: string };

export type ApplyKitView = {
  job: {
    id: string;
    title: string;
    company: string;
    location: string | null;
    postingStatus: PostingStatus;
    notice: { tone: "warning" | "info"; text: string } | null;
  };
  applyLink: { href: string; hostname: string; secure: boolean } | null;
  application: { id: string; status: ApplicationStatus; statusLabel: string; dateApplied: string | null } | null;
  canRecordApplied: boolean;
  resumes: ApplyKitDocument[];
  coverLetters: ApplyKitDocument[];
  selectedResumeId: string | null;
  selectedCoverLetterId: string | null;
  generation: { available: boolean; reason: string | null; hasMasterResume: boolean };
  answers: ApplyKitAnswers;
  sent: { eventId: string; recordedAt: string; href: string; resume: SentSummary | null; coverLetter: SentSummary | null } | null;
};

const STATUS_COPY: Record<DocumentReadinessState, { status: ApplyKitDocumentStatus; label: string; detail: string }> = {
  EVIDENCE_CURRENT: {
    status: "AI_GROUNDED",
    label: "AI-grounded",
    detail: "Written from facts in your master résumé and current reviewed evidence."
  },
  EDITED_READY: {
    status: "EDITED_CONFIRMED",
    label: "Edited and confirmed",
    detail: "Includes your edits. You confirmed every changed factual detail."
  },
  LEGACY_CONFIRMED: {
    status: "LEGACY_CONFIRMED",
    label: "Legacy, confirmed by you",
    detail: "Created before fact citations. You confirmed it is accurate."
  },
  EDITED_NEEDS_REVIEW: {
    status: "NEEDS_REVIEW",
    label: "Needs review",
    detail: "Your edits changed factual details. Confirm each one before you use this document."
  },
  LEGACY_REVIEW_REQUIRED: {
    status: "NEEDS_REVIEW",
    label: "Needs review",
    detail: "Created before fact citations. Read it and confirm it is accurate before you use it."
  },
  REVIEW_OUTDATED: {
    status: "NEEDS_REVIEW",
    label: "Needs review",
    detail: "It changed after its review. Open the editor and save it again to refresh the review."
  },
  EVIDENCE_STALE: {
    status: "NEEDS_REGENERATION",
    label: "Out of date",
    detail: "Your master résumé or reviewed evidence changed after this was written. Generate a new version."
  },
  NOT_JOB_BOUND: {
    status: "NEEDS_REVIEW",
    label: "Needs review",
    detail: "This document is not linked to this job."
  }
};

// Only plain http(s) links without embedded credentials are offered, and the hostname is shown so
// the user knows where they are going before they leave Apply Pilot.
export function parseApplyLink(applyUrl: string | null | undefined, sourceUrl: string | null | undefined) {
  const candidate = applyUrl?.trim() || sourceUrl?.trim() || "";
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  return { href: url.toString(), hostname: url.hostname, secure: url.protocol === "https:" };
}

function postingNotice(status: PostingStatus): ApplyKitView["job"]["notice"] {
  if (status === "EXPIRED") {
    return {
      tone: "warning",
      text: "This posting is marked as expired. The employer may have closed it, so check the link before you spend time on the application."
    };
  }
  if (status === "ARCHIVED") return { tone: "info", text: "You archived this job. You can still apply if the posting is open." };
  return null;
}

function pickSelected(documents: readonly ApplyKitDocument[], preferredId: string | null | undefined) {
  if (preferredId && documents.some((document) => document.id === preferredId)) return preferredId;
  return documents.find((document) => document.exportReady)?.id ?? documents[0]?.id ?? null;
}

const RECORDABLE_STATUSES = new Set<ApplicationStatus>(["SAVED", "INTERESTED"]);

export async function loadApplyKitView(db: ApplyKitDb, input: {
  userId: string;
  jobId: string;
  aiGenerationAvailable: boolean;
}): Promise<ApplyKitView | null> {
  const { userId, jobId } = input;
  const job = await db.jobPosting.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      status: true,
      applyUrl: true,
      sourceUrl: true,
      currentEvidenceSnapshotId: true,
      evidenceSnapshotGeneration: true,
      currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT }
    }
  });
  if (!job) return null;

  const [masterResume, resumeRows, coverRows, application, vaultRows] = await Promise.all([
    db.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true }
    }),
    db.resumeVersion.findMany({
      where: { userId, jobPostingId: job.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true, fullText: true, evidenceSnapshotId: true, metadata: true, createdAt: true }
    }),
    db.generatedDocument.findMany({
      where: { userId, jobPostingId: job.id, type: "COVER_LETTER" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true, content: true, evidenceSnapshotId: true, metadata: true, createdAt: true }
    }),
    db.application.findUnique({
      where: { userId_jobPostingId: { userId, jobPostingId: job.id } },
      select: {
        id: true,
        userId: true,
        status: true,
        dateApplied: true,
        resumeVersionId: true,
        coverLetterVersionId: true,
        events: {
          where: { userId, metadata: { path: [SENT_DOCUMENTS_METADATA_KEY, "schema"], equals: SENT_DOCUMENTS_SCHEMA } },
          orderBy: { occurredAt: "desc" },
          take: 5,
          select: { id: true, occurredAt: true, metadata: true }
        }
      }
    }),
    db.applicationAnswer.findMany({
      where: { userId, isActive: true },
      orderBy: [{ category: "asc" }, { question: "asc" }],
      select: { id: true, category: true, question: true, answer: true, sensitive: true, isActive: true }
    })
  ]);

  const evidence = resolveCurrentReviewedEvidence(job, masterResume);
  const evidenceInput = {
    jobBound: true,
    currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: evidence.currentEvidenceSourceValid
  };
  const toDocument = (
    kind: DocumentKind,
    numbers: Map<string, number>,
    row: { id: string; title: string; content: string; evidenceSnapshotId: string | null; metadata: unknown; createdAt: Date }
  ): ApplyKitDocument => {
    const review = buildDocumentReviewView({
      ...evidenceInput,
      kind,
      artifact: { evidenceSnapshotId: row.evidenceSnapshotId, content: row.content, metadata: row.metadata }
    });
    const copy = STATUS_COPY[review.state];
    return {
      kind,
      id: row.id,
      title: row.title,
      versionNumber: numbers.get(row.id) ?? 1,
      createdAt: row.createdAt.toISOString(),
      contentHash: review.contentHash,
      status: copy.status,
      readinessState: review.state,
      statusLabel: copy.label,
      statusDetail: copy.detail,
      exportReady: review.exportReady,
      review,
      editorHref: kind === "RESUME" ? `/resumes/${row.id}` : `/jobs/${job.id}`
    };
  };
  const resumeNumbers = documentVersionNumbers(resumeRows);
  const coverNumbers = documentVersionNumbers(coverRows);
  // Newest version first, by the same ordering that assigns version numbers.
  const newestFirst = (numbers: Map<string, number>) => (left: { id: string }, right: { id: string }) =>
    (numbers.get(right.id) ?? 0) - (numbers.get(left.id) ?? 0);
  const resumes = [...resumeRows].sort(newestFirst(resumeNumbers))
    .map((row) => toDocument("RESUME", resumeNumbers, { ...row, content: row.fullText }));
  const coverLetters = [...coverRows].sort(newestFirst(coverNumbers)).map((row) => toDocument("COVER_LETTER", coverNumbers, row));
  const ownedApplication = application && application.userId === userId ? application : null;

  const sentEvent = ownedApplication ? latestSentDocumentsEvent(ownedApplication.events) : null;
  const summarize = (document: SentDocument | null): SentSummary | null => document
    ? { versionNumber: document.versionNumber, title: document.title, readinessState: document.readinessState, shortHash: shortContentHash(document.contentHash) }
    : null;

  const hasMasterResume = Boolean(masterResume);
  const generationReason = !hasMasterResume
    ? "Upload your master résumé before generating tailored documents."
    : !input.aiGenerationAvailable
      ? "AI document generation is unavailable right now. You can still download documents you already have, copy your answers and apply."
      : null;

  return {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      postingStatus: job.status,
      notice: postingNotice(job.status)
    },
    applyLink: parseApplyLink(job.applyUrl, job.sourceUrl),
    application: ownedApplication
      ? {
          id: ownedApplication.id,
          status: ownedApplication.status,
          statusLabel: formatApplicationStatus(ownedApplication.status),
          dateApplied: ownedApplication.dateApplied?.toISOString() ?? null
        }
      : null,
    canRecordApplied: !ownedApplication || RECORDABLE_STATUSES.has(ownedApplication.status),
    resumes,
    coverLetters,
    selectedResumeId: pickSelected(resumes, ownedApplication?.resumeVersionId),
    selectedCoverLetterId: ownedApplication && ownedApplication.coverLetterVersionId === null && ownedApplication.resumeVersionId !== null
      ? null
      : pickSelected(coverLetters, ownedApplication?.coverLetterVersionId),
    generation: { available: generationReason === null, reason: generationReason, hasMasterResume },
    answers: buildApplyKitAnswers(vaultRows),
    sent: sentEvent && ownedApplication
      ? {
          eventId: sentEvent.eventId,
          recordedAt: sentEvent.snapshot.recordedAt,
          href: `/applications/${ownedApplication.id}/sent/${sentEvent.eventId}`,
          resume: summarize(sentEvent.snapshot.resume),
          coverLetter: summarize(sentEvent.snapshot.coverLetter)
        }
      : null
  };
}
