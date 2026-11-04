import type { ApplicationStatus } from "@prisma/client";

import { applicationStatusOptions, formatApplicationStatus } from "@/lib/applications/pipeline";
import { resolveApplicationPostStatus } from "@/lib/applications/status";
import { validFitScore } from "@/lib/jobs/fit-presentation";

export type ApplicationBoardColumn = {
  key: string;
  label: string;
  description: string;
  /** Terminal columns group several closed statuses and start collapsed. */
  terminal: boolean;
  /** Each status is its own drop target, so a drop is never ambiguous. */
  statuses: ApplicationStatus[];
};

/** Client-safe, display-only card data. No notes, contacts or document content. */
export type ApplicationBoardCard = {
  id: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  fitScore: number | null;
  followUpDueAt: string | null;
  hasResume: boolean;
  hasCoverLetter: boolean;
};

export type ApplicationBoardGroup<T> = {
  status: ApplicationStatus;
  label: string;
  cards: T[];
};

export type ApplicationBoardColumnView<T> = {
  column: ApplicationBoardColumn;
  count: number;
  groups: ApplicationBoardGroup<T>[];
};

export const applicationBoardColumns: ApplicationBoardColumn[] = [
  { key: "SAVED", label: "Saved", description: "Parked for later review.", terminal: false, statuses: ["SAVED"] },
  { key: "INTERESTED", label: "Interested", description: "Worth packet work before applying.", terminal: false, statuses: ["INTERESTED"] },
  { key: "APPLIED", label: "Applied", description: "Submitted and waiting for a response.", terminal: false, statuses: ["APPLIED"] },
  { key: "RECRUITER_SCREEN", label: "Recruiter screen", description: "First call with a recruiter.", terminal: false, statuses: ["RECRUITER_SCREEN"] },
  { key: "HIRING_MANAGER_SCREEN", label: "Hiring manager", description: "Conversation with the hiring manager.", terminal: false, statuses: ["HIRING_MANAGER_SCREEN"] },
  { key: "TECHNICAL_INTERVIEW", label: "Technical interview", description: "Technical or skills rounds.", terminal: false, statuses: ["TECHNICAL_INTERVIEW"] },
  { key: "FINAL_INTERVIEW", label: "Final interview", description: "Final or onsite rounds.", terminal: false, statuses: ["FINAL_INTERVIEW"] },
  { key: "OFFER", label: "Offer", description: "Offer review and negotiation.", terminal: false, statuses: ["OFFER"] },
  { key: "CLOSED", label: "Closed", description: "Rejected, ghosted, or archived.", terminal: true, statuses: ["REJECTED", "GHOSTED", "ARCHIVED"] }
];

type BoardCardSource = {
  id: string;
  status: ApplicationStatus;
  followUpDueAt: Date | null;
  resumeVersionId: string | null;
  coverLetterVersionId: string | null;
  jobPosting: { company: string; title: string };
};

export function toApplicationBoardCard<T extends BoardCardSource>(
  application: T,
  fitScore: number | null | undefined
): ApplicationBoardCard {
  return {
    id: application.id,
    company: application.jobPosting.company,
    title: application.jobPosting.title,
    status: application.status,
    fitScore: validFitScore(fitScore),
    followUpDueAt: application.followUpDueAt ? application.followUpDueAt.toISOString() : null,
    hasResume: Boolean(application.resumeVersionId),
    hasCoverLetter: Boolean(application.coverLetterVersionId)
  };
}

export function groupApplicationBoard<T extends { status: ApplicationStatus }>(cards: readonly T[]): ApplicationBoardColumnView<T>[] {
  return applicationBoardColumns.map((column) => {
    const groups = column.statuses.map((status) => ({
      status,
      label: formatApplicationStatus(status),
      cards: cards.filter((card) => card.status === status)
    }));
    return { column, groups, count: groups.reduce((total, group) => total + group.cards.length, 0) };
  });
}

/**
 * A board move is valid only when the PATCH route would actually apply it.
 * The server keeps a record that has moved past SAVED/INTERESTED from falling back to them,
 * so the board refuses those moves instead of showing a change the server ignores.
 */
export function canMoveOnBoard(from: ApplicationStatus, to: ApplicationStatus) {
  return from !== to && resolveApplicationPostStatus(to, { status: from }) === to;
}

export function boardMoveTargets(from: ApplicationStatus) {
  return applicationStatusOptions
    .filter((option) => canMoveOnBoard(from, option.value))
    .map((option) => ({ status: option.value, label: option.label }));
}

export function describeBoardDocuments(card: Pick<ApplicationBoardCard, "hasResume" | "hasCoverLetter">) {
  if (card.hasResume && card.hasCoverLetter) return "Resume and cover letter attached";
  if (card.hasResume) return "Resume attached";
  if (card.hasCoverLetter) return "Cover letter attached";
  return "No documents attached";
}

export function applyBoardMove<T extends ApplicationBoardCard>(
  cards: readonly T[],
  id: string,
  patch: Partial<Pick<ApplicationBoardCard, "status" | "followUpDueAt">>
): T[] {
  if (!cards.some((card) => card.id === id)) return cards as T[];
  return cards.map((card) => (card.id === id ? { ...card, ...patch } : card));
}

const knownStatuses = new Set<string>(applicationStatusOptions.map((option) => option.value));

/** Reads only status and follow-up from the PATCH response; anything malformed falls back safely. */
export function readBoardMoveResult(
  body: unknown,
  requested: ApplicationStatus
): { status: ApplicationStatus; followUpDueAt?: string | null } {
  const application = body && typeof body === "object" ? (body as { application?: unknown }).application : null;
  if (!application || typeof application !== "object") return { status: requested };
  const { status, followUpDueAt } = application as { status?: unknown; followUpDueAt?: unknown };
  const nextStatus = typeof status === "string" && knownStatuses.has(status) ? (status as ApplicationStatus) : requested;
  const parsed = typeof followUpDueAt === "string" ? new Date(followUpDueAt) : null;
  return {
    status: nextStatus,
    followUpDueAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
  };
}
