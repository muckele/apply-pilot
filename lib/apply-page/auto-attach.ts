import type { ApplyKitDocument, ApplyKitDocumentStatus } from "@/lib/apply-kit/apply-kit-view";

// Which documents the Apply page attaches to the job's application by itself. Only a document that
// is ready to use is ever attached; one that needs review or a new version never is.

const READY_STATUSES: ReadonlySet<ApplyKitDocumentStatus> = new Set(["AI_GROUNDED", "EDITED_CONFIRMED", "LEGACY_CONFIRMED"]);

export function isReadyDocument(document: Pick<ApplyKitDocument, "status">): boolean {
  return READY_STATUSES.has(document.status);
}

/**
 * The newest ready document, when nothing is attached or the attached one isn't ready (or isn't
 * listed). Null when the attached document is ready, so a version the user chose is kept.
 */
export function chooseAutoAttach(docs: ApplyKitDocument[], attachedId: string | null): string | null {
  const attached = attachedId === null ? undefined : docs.find((document) => document.id === attachedId);
  if (attached && isReadyDocument(attached)) return null;
  const newest = docs
    .filter(isReadyDocument)
    .reduce<ApplyKitDocument | null>((best, document) => {
      if (!best) return document;
      if (document.versionNumber !== best.versionNumber) return document.versionNumber > best.versionNumber ? document : best;
      return document.createdAt > best.createdAt ? document : best;
    }, null);
  return newest?.id ?? null;
}
