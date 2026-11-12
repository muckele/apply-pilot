import type { ApplyKitDocument, ApplyKitDocumentStatus } from "@/lib/apply-kit/apply-kit-view";

// Which documents the Apply page attaches to the job's application by itself. Only a document that
// is ready to use is ever attached; one that needs review or a new version never is.

const READY_STATUSES: ReadonlySet<ApplyKitDocumentStatus> = new Set(["AI_GROUNDED", "EDITED_CONFIRMED", "LEGACY_CONFIRMED"]);

export function isReadyDocument(document: Pick<ApplyKitDocument, "status">): boolean {
  return READY_STATUSES.has(document.status);
}

// Newest by version number (then creation time), whatever the list order.
function newestOf(docs: ApplyKitDocument[]): ApplyKitDocument | null {
  return docs.reduce<ApplyKitDocument | null>((best, document) => {
    if (!best) return document;
    if (document.versionNumber !== best.versionNumber) return document.versionNumber > best.versionNumber ? document : best;
    return document.createdAt > best.createdAt ? document : best;
  }, null);
}

/**
 * The once-on-mount pick: the newest ready document when nothing is attached, or the attached one
 * needs a new version (NEEDS_REGENERATION) or isn't listed. Null when the attached one is ready, so
 * a version the user chose is kept, or is waiting for its review (NEEDS_REVIEW), so an edited
 * version isn't swapped for an older one behind the user's back.
 */
export function chooseAutoAttach(docs: ApplyKitDocument[], attachedId: string | null): string | null {
  const attached = attachedId === null ? undefined : docs.find((document) => document.id === attachedId);
  if (attached && attached.status !== "NEEDS_REGENERATION") return null;
  return newestOf(docs.filter(isReadyDocument))?.id ?? null;
}

/**
 * After a write or a confirmed review in this page: the newest document that became ready since
 * `seenReadyIds`, even when another ready version is attached. Null when nothing new is ready, or
 * it is already the attached one.
 */
export function chooseJustReady(docs: ApplyKitDocument[], seenReadyIds: ReadonlySet<string>, attachedId: string | null): string | null {
  const newest = newestOf(docs.filter((document) => isReadyDocument(document) && !seenReadyIds.has(document.id)));
  return newest && newest.id !== attachedId ? newest.id : null;
}
