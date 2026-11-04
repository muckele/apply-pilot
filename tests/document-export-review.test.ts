import assert from "node:assert/strict";
import { test } from "node:test";

import JSZip from "jszip";
import { NextRequest } from "next/server";

import { createDocumentExportRouteHandlers } from "@/lib/documents/document-export-route";
import {
  buildDocumentReview,
  confirmDocumentReviewFlag,
  confirmLegacyDocumentReview,
  resolveReviewBaseline,
  withDocumentReview
} from "@/lib/documents/document-review";

const OWNER = "export-owner";
const OTHER = "export-other";
const SNAPSHOT = "snapshot-current";
const NOW = new Date("2026-11-03T09:00:00.000Z");
const reviewedAt = new Date("2026-10-08T12:00:00.000Z");

const jobPosting = (snapshotId: string | null = SNAPSHOT) => ({
  currentEvidenceSnapshotId: snapshotId,
  evidenceSnapshotGeneration: 1,
  currentEvidenceSnapshot: snapshotId ? {
    id: snapshotId,
    resumeId: "resume-master",
    sourceResumeUpdatedAt: reviewedAt,
    snapshotHash: "a".repeat(64),
    reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
  } : null,
  user: { resumes: [{ id: "resume-master", updatedAt: reviewedAt }] }
});

const generated = "Dear Example Co Hiring Team,\nI led a team of 5 engineers at Example Co.\nSincerely,\nSynthetic Applicant";
const claimsUsed = [{
  claim: "I led a team of 5 engineers at Example Co.",
  citations: [{ ref: "resume.workHistory[0]", excerpt: "Led a team of 5 engineers at Example Co." }]
}];
const edited = generated.replace("team of 5", "team of 12");

function editedMetadata(confirm: boolean) {
  const baseline = resolveReviewBaseline({
    kind: "COVER_LETTER",
    existing: { content: generated, evidenceSnapshotId: SNAPSHOT, metadata: { claimsUsed } },
    now: NOW
  });
  let review = buildDocumentReview({ baseline, content: edited, previous: null, now: NOW });
  if (confirm) review = confirmDocumentReviewFlag({ review, flagId: review.flags[0]!.id, now: NOW });
  return withDocumentReview({ claimsUsed }, review);
}

type Row = { id: string; userId: string; title: string; content: string; evidenceSnapshotId: string | null; metadata: unknown; jobPosting: ReturnType<typeof jobPosting> | null };

function exportRoute(rows: Row[], userId = OWNER) {
  const lookups: Array<{ id: string; userId: string }> = [];
  const handlers = createDocumentExportRouteHandlers({
    requireUserId: async () => userId,
    checkRateLimit: async () => {},
    findGeneratedDocument: async (input) => {
      lookups.push(input);
      return rows.find((row) => row.id === input.id && row.userId === input.userId) ?? null;
    },
    findResumeVersion: async () => null
  });
  return { handlers, lookups };
}

function exportRequest(documentId: string, format: "markdown" | "docx" | "pdf") {
  return new NextRequest("http://localhost/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, format })
  });
}

async function docxText(response: Response) {
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((match) => match[1]).join("\n");
}

test("an edited document with an unconfirmed factual flag is refused until the owner confirms it", async () => {
  const rows: Row[] = [{ id: "cover", userId: OWNER, title: "Letter", content: edited, evidenceSnapshotId: null, metadata: editedMetadata(false), jobPosting: jobPosting() }];
  const response = await exportRoute(rows).handlers.POST(exportRequest("cover", "markdown"));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "APPLICATION_DOCUMENT_REVIEW_REQUIRED");
  assert.equal(body.reviewState, "EDITED_NEEDS_REVIEW");
});

test("an edited and confirmed document exports its exact current bytes without edit markers", async () => {
  const rows: Row[] = [{ id: "cover", userId: OWNER, title: "Letter", content: edited, evidenceSnapshotId: null, metadata: editedMetadata(true), jobPosting: jobPosting() }];
  const { handlers } = exportRoute(rows);
  const markdown = await handlers.POST(exportRequest("cover", "markdown"));
  assert.equal(markdown.status, 200);
  assert.equal(await markdown.text(), edited);

  const docx = await handlers.POST(exportRequest("cover", "docx"));
  assert.equal(docx.status, 200);
  const text = await docxText(docx);
  assert.match(text, /team of 12 engineers/u);
  assert.doesNotMatch(text, /your edit|USER_EDIT|confirm/iu);

  const pdf = await handlers.POST(exportRequest("cover", "pdf"));
  assert.equal(pdf.status, 200);
  assert.doesNotMatch(Buffer.from(await pdf.arrayBuffer()).toString("latin1"), /your edit|USER_EDIT/iu);
});

test("an edited document still goes stale with its evidence", async () => {
  const rows: Row[] = [{ id: "cover", userId: OWNER, title: "Letter", content: edited, evidenceSnapshotId: null, metadata: editedMetadata(true), jobPosting: jobPosting("snapshot-newer") }];
  const response = await exportRoute(rows).handlers.POST(exportRequest("cover", "markdown"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "APPLICATION_DOCUMENT_EVIDENCE_STALE");
});

test("a legacy document exports only after its one whole-document confirmation", async () => {
  const legacy = "Legacy Applicant\nLed 40-person programs at Northwind.";
  const unconfirmed: Row[] = [{ id: "legacy", userId: OWNER, title: "Legacy", content: legacy, evidenceSnapshotId: null, metadata: null, jobPosting: jobPosting() }];
  const refused = await exportRoute(unconfirmed).handlers.POST(exportRequest("legacy", "markdown"));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).reviewState, "LEGACY_REVIEW_REQUIRED");

  const confirmed: Row[] = [{ ...unconfirmed[0]!, metadata: withDocumentReview(null, confirmLegacyDocumentReview({ review: null, content: legacy, now: NOW })) }];
  const response = await exportRoute(confirmed).handlers.POST(exportRequest("legacy", "markdown"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), legacy);

  const changed: Row[] = [{ ...confirmed[0]!, content: `${legacy}\nChanged later.` }];
  assert.equal((await exportRoute(changed).handlers.POST(exportRequest("legacy", "markdown"))).status, 409);
});

test("export refuses another user's confirmed document without leaking its bytes", async () => {
  const rows: Row[] = [{ id: "cover", userId: OWNER, title: "Letter", content: edited, evidenceSnapshotId: null, metadata: editedMetadata(true), jobPosting: jobPosting() }];
  const { handlers, lookups } = exportRoute(rows, OTHER);
  for (const format of ["markdown", "docx", "pdf"] as const) {
    const response = await handlers.POST(exportRequest("cover", format));
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /team of 12|Synthetic Applicant/u);
  }
  assert.ok(lookups.every((lookup) => lookup.userId === OTHER));
});
