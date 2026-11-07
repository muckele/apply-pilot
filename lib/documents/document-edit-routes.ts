import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  buildDocumentReview,
  confirmDocumentReviewFlag,
  confirmLegacyDocumentReview,
  documentContentHash,
  readStoredDocumentReview,
  resolveReviewBaseline,
  withDocumentReview,
  type DocumentKind,
  type StoredDocumentReview
} from "@/lib/documents/document-review";
import { resumeFontFamilies, resumePageSizes, resumeTemplates } from "@/lib/documents/resume-format";
import { apiErrorResponse } from "@/lib/user-context";

// Owner-scoped edit and review routes for tailored documents (D031). Every read and write runs in
// one transaction against a row locked by (id, userId), so another user's document is a 404 and
// concurrent edits cannot drop a confirmation.

export type EditableDocumentRow = {
  id: string;
  userId: string;
  // GeneratedDocument.content or ResumeVersion.fullText: the exact exported bytes.
  content: string;
  evidenceSnapshotId: string | null;
  metadata: unknown;
  summary?: string | null;
  skills?: string[];
};

export type EditableDocumentTransaction = {
  findOwnedForUpdate(input: { id: string; userId: string }): Promise<EditableDocumentRow | null>;
  update(input: { id: string; userId: string; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  writeAudit(input: { userId: string; action: string; resourceId: string; metadata: Record<string, unknown> }): Promise<void>;
};

export type EditableDocumentRouteDependencies = {
  requireUserId: () => Promise<string>;
  checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<void>;
  transaction: <T>(work: (tx: EditableDocumentTransaction) => Promise<T>) => Promise<T>;
  now?: () => Date;
};

type Params = { params: Promise<{ id: string }> };

const generatedDocumentPatchSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  content: z.string().trim().min(1).max(30000).optional()
});

const resumeVersionPatchSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  fullText: z.string().trim().min(1).max(30000).optional(),
  skills: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  template: z.enum(resumeTemplates).optional(),
  pageSize: z.enum(resumePageSizes).optional(),
  fontFamily: z.enum(resumeFontFamilies).optional(),
  accentColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
  fontSize: z.number().int().min(9).max(12).optional(),
  lineSpacing: z.number().int().min(100).max(150).optional()
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const reviewActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CONFIRM_FLAG"),
    flagId: z.string().regex(/^flag:[0-9a-f]{24}$/u),
    contentHash: sha256
  }).strict(),
  z.object({
    action: z.literal("CONFIRM_LEGACY_DOCUMENT"),
    contentHash: sha256
  }).strict()
]);

const kindConfig = {
  COVER_LETTER: { routeKey: "generated-documents", auditPrefix: "generated-document", contentField: "content" },
  RESUME: { routeKey: "resume-versions", auditPrefix: "resume-version", contentField: "fullText" }
} as const;

function notFound() {
  return new PublicApiError("Document not found.", 404);
}

function reviewSummary(review: StoredDocumentReview) {
  return {
    contentHash: review.contentHash,
    userEditCount: review.segments.filter((segment) => segment.origin === "USER_EDIT").length,
    pendingFlagCount: review.flags.filter((flag) => !flag.confirmedAt).length
  };
}

function sameSkills(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

// A real text change clears the exact generated-evidence binding (the bytes are no longer exactly
// generated) and records line provenance and flags against the captured generated baseline.
function reviewForContentEdit(input: {
  kind: DocumentKind;
  existing: EditableDocumentRow;
  nextContent: string;
  now: Date;
}) {
  const baseline = resolveReviewBaseline({ kind: input.kind, existing: input.existing, now: input.now });
  const previous = readStoredDocumentReview(input.existing.metadata);
  const review = buildDocumentReview({ baseline, content: input.nextContent, previous, now: input.now });
  return { review, metadata: withDocumentReview(input.existing.metadata, review) };
}

function editHandler<Input extends Record<string, unknown>>(
  dependencies: EditableDocumentRouteDependencies,
  kind: DocumentKind,
  schema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  contentChanged: (input: Input, existing: EditableDocumentRow) => boolean,
  responseKey: "document" | "version"
) {
  const config = kindConfig[kind];
  return async function PATCH(request: NextRequest, { params }: Params) {
    try {
      const userId = await dependencies.requireUserId();
      await dependencies.checkRateLimit(`${config.routeKey}:update:${userId}`, 60, 60_000);
      const { id } = await params;
      const input = schema.parse(await request.json());
      const now = (dependencies.now ?? (() => new Date()))();
      const result = await dependencies.transaction(async (tx) => {
        const existing = await tx.findOwnedForUpdate({ id, userId });
        if (!existing) throw notFound();
        // Saving the same text again refreshes a stored review that no longer matches the bytes.
        const stored = readStoredDocumentReview(existing.metadata);
        const reviewOutdated = typeof input[config.contentField] === "string" &&
          stored !== null && stored.contentHash !== documentContentHash(existing.content);
        const changed = contentChanged(input, existing) || reviewOutdated;
        const edit = changed
          ? reviewForContentEdit({
              kind,
              existing,
              nextContent: typeof input[config.contentField] === "string" ? input[config.contentField] as string : existing.content,
              now
            })
          : null;
        const updated = await tx.update({
          id: existing.id,
          userId,
          data: {
            ...input,
            ...(edit ? { evidenceSnapshotId: null, metadata: edit.metadata } : {})
          }
        });
        const summary = edit ? reviewSummary(edit.review) : null;
        await tx.writeAudit({
          userId,
          action: `${config.auditPrefix}.update`,
          resourceId: existing.id,
          metadata: {
            evidenceBindingInvalidated: Boolean(edit),
            ...(summary ? { userEditCount: summary.userEditCount, pendingFlagCount: summary.pendingFlagCount } : {})
          }
        });
        return { updated, summary };
      });
      return NextResponse.json({ [responseKey]: result.updated, review: result.summary });
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}

export function createGeneratedDocumentPatchHandler(dependencies: EditableDocumentRouteDependencies) {
  return editHandler(
    dependencies,
    "COVER_LETTER",
    generatedDocumentPatchSchema,
    (input, existing) => typeof input.content === "string" && input.content !== existing.content,
    "document"
  );
}

export function createResumeVersionPatchHandler(dependencies: EditableDocumentRouteDependencies) {
  return editHandler(
    dependencies,
    "RESUME",
    resumeVersionPatchSchema,
    (input, existing) =>
      (typeof input.fullText === "string" && input.fullText !== existing.content) ||
      (Object.hasOwn(input, "summary") && (input.summary ?? null) !== (existing.summary ?? null)) ||
      (Object.hasOwn(input, "skills") && !sameSkills(input.skills, existing.skills)),
    "version"
  );
}

export function createDocumentReviewHandler(dependencies: EditableDocumentRouteDependencies, kind: DocumentKind) {
  const config = kindConfig[kind];
  return async function POST(request: NextRequest, { params }: Params) {
    try {
      const userId = await dependencies.requireUserId();
      await dependencies.checkRateLimit(`${config.routeKey}:review:${userId}`, 60, 60_000);
      const { id } = await params;
      const input = reviewActionSchema.parse(await request.json());
      const now = (dependencies.now ?? (() => new Date()))();
      const review = await dependencies.transaction(async (tx) => {
        const existing = await tx.findOwnedForUpdate({ id, userId });
        if (!existing) throw notFound();
        const contentHash = documentContentHash(existing.content);
        // The confirmation covers exactly the bytes the user reviewed.
        if (input.contentHash !== contentHash) {
          throw new PublicApiError("This document changed. Review the current version before confirming.", 409, {
            code: "DOCUMENT_REVIEW_CONTENT_CHANGED"
          });
        }
        const stored = readStoredDocumentReview(existing.metadata);
        let next: StoredDocumentReview;
        let auditMetadata: Record<string, unknown>;
        if (input.action === "CONFIRM_FLAG") {
          if (!stored || stored.contentHash !== contentHash) {
            throw new PublicApiError("Save this document again before confirming its edits.", 409, {
              code: "DOCUMENT_REVIEW_OUTDATED"
            });
          }
          next = confirmDocumentReviewFlag({ review: stored, flagId: input.flagId, now });
          auditMetadata = {
            flagId: input.flagId,
            confirmedAt: next.flags.find((flag) => flag.id === input.flagId)?.confirmedAt ?? null,
            contentHash
          };
        } else {
          if (existing.evidenceSnapshotId !== null) {
            throw new PublicApiError("This document has fact citations. Confirm its flagged edits instead.", 409, {
              code: "DOCUMENT_REVIEW_NOT_LEGACY"
            });
          }
          next = confirmLegacyDocumentReview({ review: stored, content: existing.content, now });
          auditMetadata = { confirmedAt: next.legacyConfirmation?.confirmedAt ?? null, contentHash };
        }
        await tx.update({ id: existing.id, userId, data: { metadata: withDocumentReview(existing.metadata, next) } });
        await tx.writeAudit({
          userId,
          action: `${config.auditPrefix}.review.${input.action === "CONFIRM_FLAG" ? "confirm-flag" : "confirm-legacy"}`,
          resourceId: existing.id,
          metadata: auditMetadata
        });
        return { next, confirmedAt: auditMetadata.confirmedAt as string | null };
      });
      return NextResponse.json({
        review: {
          contentHash: review.next.contentHash,
          pendingFlagCount: review.next.flags.filter((flag) => !flag.confirmedAt).length,
          confirmedAt: review.confirmedAt
        }
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}
