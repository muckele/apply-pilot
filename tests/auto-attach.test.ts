import assert from "node:assert/strict";
import test from "node:test";

import type { ApplyKitDocument, ApplyKitDocumentStatus } from "@/lib/apply-kit/apply-kit-view";
import { chooseAutoAttach } from "@/lib/apply-page/auto-attach";

// Only the fields chooseAutoAttach reads; synthetic ids.
function doc(id: string, versionNumber: number, status: ApplyKitDocumentStatus): ApplyKitDocument {
  return { id, versionNumber, status, createdAt: `2026-11-0${versionNumber}T10:00:00.000Z` } as ApplyKitDocument;
}

const READY: ApplyKitDocumentStatus[] = ["AI_GROUNDED", "EDITED_CONFIRMED", "LEGACY_CONFIRMED"];
const NOT_READY: ApplyKitDocumentStatus[] = ["NEEDS_REVIEW", "NEEDS_REGENERATION"];

test("auto-attach picks the newest ready document when nothing is attached", () => {
  const docs = [doc("v4", 4, "NEEDS_REVIEW"), doc("v3", 3, "EDITED_CONFIRMED"), doc("v2", 2, "AI_GROUNDED"), doc("v1", 1, "LEGACY_CONFIRMED")];
  assert.equal(chooseAutoAttach(docs, null), "v3");
  assert.equal(chooseAutoAttach([...docs].reverse(), null), "v3", "newest by version, not by list order");
  for (const status of READY) assert.equal(chooseAutoAttach([doc("v1", 1, status)], null), "v1", status);
});

test("auto-attach keeps a ready attached document", () => {
  for (const status of READY) {
    assert.equal(chooseAutoAttach([doc("v2", 2, "AI_GROUNDED"), doc("v1", 1, status)], "v1"), null, status);
  }
});

test("auto-attach replaces a stale attached document", () => {
  for (const status of NOT_READY) {
    assert.equal(chooseAutoAttach([doc("v2", 2, "AI_GROUNDED"), doc("v1", 1, status)], "v1"), "v2", status);
  }
  assert.equal(chooseAutoAttach([doc("v2", 2, "AI_GROUNDED")], "gone"), "v2", "an attached id that isn't listed counts as not ready");
});

test("auto-attach never picks a document that needs review or regeneration", () => {
  const docs = NOT_READY.map((status, index) => doc(`v${index + 1}`, index + 1, status));
  assert.equal(chooseAutoAttach(docs, null), null);
  assert.equal(chooseAutoAttach(docs, "v1"), null);
  assert.equal(chooseAutoAttach([], null), null);
});
