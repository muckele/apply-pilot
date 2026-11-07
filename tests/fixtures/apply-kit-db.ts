import type { ApplyKitDb } from "@/lib/apply-kit/apply-kit-view";
import {
  CURRENT_SNAPSHOT,
  editedCoverText,
  editedUnconfirmed,
  generatedCoverMetadata,
  generatedCoverText,
  generatedResumeMetadata,
  generatedResumeText,
  legacyConfirmed
} from "@/tests/fixtures/apply-kit-documents";

// In-memory, owner-checking stand-in for the Prisma delegates the Apply Kit loader reads.

export const OWNER = "user-owner";
export const OTHER = "user-other";
export const JOB = "job-owner";
export const OTHER_JOB = "job-other";
const MASTER_UPDATED = new Date("2026-11-01T00:00:00.000Z");

export type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === "userId_jobPostingId") {
      const compound = value as { userId: string; jobPostingId: string };
      return row.userId === compound.userId && row.jobPostingId === compound.jobPostingId;
    }
    if (key === "metadata" || key === "application") return true;
    return row[key] === value;
  });
}

export function fixtures() {
  const job = (id: string, userId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    userId,
    title: "Platform Engineer",
    company: "Example Co",
    location: "Remote",
    status: "ACTIVE",
    applyUrl: "https://boards.greenhouse.io/exampleco/jobs/123",
    sourceUrl: "https://boards.greenhouse.io/exampleco/jobs/123",
    currentEvidenceSnapshotId: CURRENT_SNAPSHOT,
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: {
      id: CURRENT_SNAPSHOT,
      resumeId: `master-${userId}`,
      sourceResumeUpdatedAt: MASTER_UPDATED,
      snapshotHash: "a".repeat(64),
      reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
    },
    ...overrides
  });
  const format = { template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 };
  const edited = editedUnconfirmed("COVER_LETTER", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText);
  const legacy = legacyConfirmed("Legacy letter body.");
  return {
    jobPosting: [job(JOB, OWNER), job(OTHER_JOB, OTHER)],
    resume: [
      { id: `master-${OWNER}`, userId: OWNER, isMaster: true, updatedAt: MASTER_UPDATED },
      { id: `master-${OTHER}`, userId: OTHER, isMaster: true, updatedAt: MASTER_UPDATED }
    ],
    resumeVersion: [
      { id: "resume-v1", userId: OWNER, jobPostingId: JOB, title: "Resume one", fullText: generatedResumeText, evidenceSnapshotId: "snapshot-old", metadata: generatedResumeMetadata, createdAt: new Date("2026-11-01T01:00:00.000Z"), ...format },
      { id: "resume-v2", userId: OWNER, jobPostingId: JOB, title: "Resume two", fullText: generatedResumeText, evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: generatedResumeMetadata, createdAt: new Date("2026-11-02T01:00:00.000Z"), ...format },
      // A crafted row owned by another user but pointing at the owner's job must never appear.
      { id: "resume-foreign", userId: OTHER, jobPostingId: JOB, title: "Foreign resume", fullText: "OTHER USER PRIVATE RESUME", evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: null, createdAt: new Date("2026-11-03T01:00:00.000Z"), ...format }
    ],
    generatedDocument: [
      { id: "cover-edited", userId: OWNER, jobPostingId: JOB, type: "COVER_LETTER", title: "Cover edited", content: edited.content, evidenceSnapshotId: null, metadata: edited.metadata, createdAt: new Date("2026-11-02T02:00:00.000Z") },
      { id: "cover-legacy", userId: OWNER, jobPostingId: JOB, type: "COVER_LETTER", title: "Cover legacy", content: legacy.content, evidenceSnapshotId: null, metadata: legacy.metadata, createdAt: new Date("2026-11-01T02:00:00.000Z") },
      { id: "cover-foreign", userId: OTHER, jobPostingId: JOB, type: "COVER_LETTER", title: "Foreign", content: "OTHER USER PRIVATE LETTER", evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: null, createdAt: new Date("2026-11-03T02:00:00.000Z") }
    ],
    application: [] as Array<Record<string, unknown>>,
    applicationEvent: [] as Array<Record<string, unknown>>,
    applicationAnswer: [
      { id: "vault-linkedin", userId: OWNER, category: "LINKS", question: "LinkedIn URL", answer: "https://www.linkedin.com/in/owner", sensitive: false, isActive: true },
      { id: "vault-foreign", userId: OTHER, category: "LINKS", question: "LinkedIn URL", answer: "https://www.linkedin.com/in/OTHER-PRIVATE", sensitive: false, isActive: true }
    ]
  };
}

export function fakeDb(data: ReturnType<typeof fixtures>) {
  const calls: Array<{ model: string; where: Where }> = [];
  const delegate = (model: keyof ReturnType<typeof fixtures>) => {
    const rows = () => data[model] as Array<Record<string, unknown>>;
    return {
      async findFirst(args: { where: Where }) {
        calls.push({ model, where: args.where });
        return structuredClone(rows().find((row) => matches(row, args.where)) ?? null);
      },
      async findUnique(args: { where: Where }) {
        calls.push({ model, where: args.where });
        return structuredClone(rows().find((row) => matches(row, args.where)) ?? null);
      },
      async findMany(args: { where: Where }) {
        calls.push({ model, where: args.where });
        return structuredClone(rows().filter((row) => matches(row, args.where)));
      }
    };
  };
  // Timeline events: evaluates the JSON-path and "in" filters the "Did you apply?" reads use, newest first.
  const readPath = (value: unknown, path: readonly string[]) =>
    path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
  const eventMatches = (row: Record<string, unknown>, where: Where) => Object.entries(where).every(([key, value]) => {
    if (key === "metadata") {
      const filter = value as { path: string[]; equals: unknown };
      return readPath(row.metadata, filter.path) === filter.equals;
    }
    if (value && typeof value === "object" && "in" in value) return (value as { in: unknown[] }).in.includes(row[key]);
    return row[key] === value;
  });
  const applicationEvent = {
    async findFirst(args: { where: Where }) {
      calls.push({ model: "applicationEvent", where: args.where });
      const rows = data.applicationEvent.filter((row) => eventMatches(row, args.where));
      rows.sort((left, right) => (right.occurredAt as Date).getTime() - (left.occurredAt as Date).getTime() || String(right.id).localeCompare(String(left.id)));
      return structuredClone(rows[0] ?? null);
    }
  };
  const db = {
    applicationEvent,
    jobPosting: delegate("jobPosting"),
    resume: delegate("resume"),
    resumeVersion: delegate("resumeVersion"),
    generatedDocument: delegate("generatedDocument"),
    application: delegate("application"),
    applicationAnswer: delegate("applicationAnswer")
  };
  return { db: db as unknown as ApplyKitDb, calls };
}

