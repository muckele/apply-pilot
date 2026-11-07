import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { PublicApiError } from "@/lib/api-errors";
import {
  createDocumentReviewHandler,
  createGeneratedDocumentPatchHandler,
  createResumeVersionPatchHandler,
  type EditableDocumentRouteDependencies,
  type EditableDocumentRow
} from "@/lib/documents/document-edit-routes";
import {
  documentContentHash,
  readStoredDocumentReview
} from "@/lib/documents/document-review";

const OWNER = "user-owner";
const OTHER = "user-other";
const NOW = new Date("2026-11-03T12:00:00.000Z");
const SNAPSHOT = "snapshot-current";

const coverText = [
  "Dear Example Co Hiring Team,",
  "I led a team of 5 engineers at Example Co.",
  "Sincerely,",
  "Synthetic Applicant"
].join("\n");
const resumeText = "Synthetic Applicant\nSUMMARY\nBuilt reliable TypeScript services.";

type Row = EditableDocumentRow & { title: string; template?: string };

function fixtures() {
  const covers: Row[] = [
    {
      id: "cover-owner",
      userId: OWNER,
      title: "Owner cover letter",
      content: coverText,
      evidenceSnapshotId: SNAPSHOT,
      metadata: {
        angle: "Reliability",
        claimsUsed: [{
          claim: "I led a team of 5 engineers at Example Co.",
          citations: [{ ref: "resume.workHistory[0]", excerpt: "Led a team of 5 engineers at Example Co." }]
        }]
      }
    },
    { id: "cover-legacy", userId: OWNER, title: "Legacy letter", content: "Legacy body text.", evidenceSnapshotId: null, metadata: null },
    { id: "cover-other", userId: OTHER, title: "Other cover letter", content: "Other user's private letter.", evidenceSnapshotId: null, metadata: null }
  ];
  const resumes: Row[] = [
    {
      id: "resume-owner",
      userId: OWNER,
      title: "Owner resume",
      content: resumeText,
      evidenceSnapshotId: SNAPSHOT,
      metadata: {
        claimEvidence: [{
          claim: "Built reliable TypeScript services.",
          citations: [{ ref: "resume.achievements[0]", excerpt: "Built reliable TypeScript services." }]
        }]
      },
      summary: "Engineer",
      skills: ["TypeScript"],
      template: "CLASSIC"
    },
    { id: "resume-other", userId: OTHER, title: "Other resume", content: "Other user's resume.", evidenceSnapshotId: null, metadata: null, summary: null, skills: [] }
  ];
  return { covers, resumes };
}

function harness(rows: Row[], kind: "COVER_LETTER" | "RESUME", userId = OWNER, overrides: Partial<EditableDocumentRouteDependencies> = {}) {
  const calls = { rate: [] as string[], transactions: 0, audits: [] as Array<Record<string, unknown>> };
  const deps: EditableDocumentRouteDependencies = {
    requireUserId: async () => userId,
    checkRateLimit: async (key) => { calls.rate.push(key); },
    now: () => NOW,
    transaction: async (work) => {
      calls.transactions += 1;
      return work({
        findOwnedForUpdate: async ({ id, userId: owner }) => {
          const row = rows.find((candidate) => candidate.id === id && candidate.userId === owner);
          return row ? structuredClone(row) : null;
        },
        update: async ({ id, userId: owner, data }) => {
          const row = rows.find((candidate) => candidate.id === id && candidate.userId === owner);
          assert.ok(row, "updates stay owner-scoped");
          const { content, fullText, ...rest } = data as Record<string, unknown>;
          Object.assign(row, rest);
          const nextContent = kind === "RESUME" ? fullText : content;
          if (typeof nextContent === "string") row.content = nextContent;
          const { content: stored, ...shape } = row;
          return kind === "RESUME" ? { ...shape, fullText: stored } : { ...shape, content: stored };
        },
        writeAudit: async (entry) => { calls.audits.push(entry); }
      });
    },
    ...overrides
  };
  return { deps, calls };
}

function jsonRequest(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/documents", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("another user's generated document or résumé version cannot be edited or reviewed", async () => {
  const { covers, resumes } = fixtures();
  const before = structuredClone({ covers, resumes });
  const cover = harness(covers, "COVER_LETTER", OTHER);
  const resume = harness(resumes, "RESUME", OTHER);

  const responses = [
    await createGeneratedDocumentPatchHandler(cover.deps)(jsonRequest("PATCH", { content: "Hijacked" }), params("cover-owner")),
    await createResumeVersionPatchHandler(resume.deps)(jsonRequest("PATCH", { fullText: "Hijacked" }), params("resume-owner")),
    await createDocumentReviewHandler(cover.deps, "COVER_LETTER")(
      jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: documentContentHash("Legacy body text.") }),
      params("cover-legacy")
    ),
    await createDocumentReviewHandler(resume.deps, "RESUME")(
      jsonRequest("POST", { action: "CONFIRM_FLAG", flagId: "flag:000000000000000000000000", contentHash: documentContentHash(resumeText) }),
      params("resume-owner")
    )
  ];
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Synthetic Applicant|Legacy body/);
  }
  assert.deepEqual({ covers, resumes }, before);
  assert.deepEqual([...cover.calls.audits, ...resume.calls.audits], []);
});

test("an owner's text edit keeps AI citations, marks the edit as theirs and flags a changed metric", async () => {
  const { covers } = fixtures();
  const { deps, calls } = harness(covers, "COVER_LETTER");
  const edited = coverText.replace("team of 5", "team of 12").replace("Sincerely,", "With thanks,");
  const response = await createGeneratedDocumentPatchHandler(deps)(jsonRequest("PATCH", { content: edited }), params("cover-owner"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.document.content, edited);
  assert.deepEqual(body.review, { contentHash: documentContentHash(edited), userEditCount: 2, pendingFlagCount: 1 });

  const row = covers.find((candidate) => candidate.id === "cover-owner")!;
  assert.equal(row.evidenceSnapshotId, null, "Edited bytes are never presented as exactly generated.");
  assert.equal((row.metadata as { angle: string }).angle, "Reliability");
  const review = readStoredDocumentReview(row.metadata)!;
  assert.equal(review.baseline.kind, "GENERATED");
  assert.equal(review.baseline.kind === "GENERATED" ? review.baseline.evidenceSnapshotId : null, SNAPSHOT);
  assert.deepEqual(review.segments.map((segment) => segment.origin), ["GENERATED", "USER_EDIT", "USER_EDIT", "GENERATED"]);
  assert.equal(review.flags.length, 1);
  assert.deepEqual(review.flags[0]!.claims.map((claim) => claim.text), ["12"]);
  assert.deepEqual(calls.rate, [`generated-documents:update:${OWNER}`]);
  assert.equal(calls.audits.length, 1);
  assert.deepEqual(calls.audits[0], {
    userId: OWNER,
    action: "generated-document.update",
    resourceId: "cover-owner",
    metadata: { evidenceBindingInvalidated: true, userEditCount: 2, pendingFlagCount: 1 }
  });
  assert.doesNotMatch(row.content, /your edit/iu, "Provenance markers never enter the document bytes.");
});

test("title-only and formatting-only edits keep the exact evidence binding without a review", async () => {
  const { covers, resumes } = fixtures();
  const cover = harness(covers, "COVER_LETTER");
  const coverResponse = await createGeneratedDocumentPatchHandler(cover.deps)(jsonRequest("PATCH", { title: "Renamed letter" }), params("cover-owner"));
  assert.equal(coverResponse.status, 200);
  assert.equal((await coverResponse.json()).review, null);
  assert.equal(covers[0]!.evidenceSnapshotId, SNAPSHOT);
  assert.equal(readStoredDocumentReview(covers[0]!.metadata), null);

  const resume = harness(resumes, "RESUME");
  const formatOnly = await createResumeVersionPatchHandler(resume.deps)(jsonRequest("PATCH", { template: "MODERN", fullText: resumeText }), params("resume-owner"));
  assert.equal(formatOnly.status, 200);
  assert.equal(resumes[0]!.evidenceSnapshotId, SNAPSHOT, "Resubmitting identical text is not an edit.");
  assert.equal(resumes[0]!.template, "MODERN");

  const textEdit = await createResumeVersionPatchHandler(resume.deps)(
    jsonRequest("PATCH", { fullText: `${resumeText}\nEarned the PMP certification in 2022.` }),
    params("resume-owner")
  );
  assert.equal(textEdit.status, 200);
  const body = await textEdit.json();
  assert.equal(body.version.fullText, `${resumeText}\nEarned the PMP certification in 2022.`);
  assert.equal(body.review.pendingFlagCount, 1);
  assert.equal(resumes[0]!.evidenceSnapshotId, null);
  const review = readStoredDocumentReview(resumes[0]!.metadata)!;
  assert.deepEqual(review.segments.find((segment) => segment.text.startsWith("Built"))?.citations, [
    { ref: "resume.achievements[0]", excerpt: "Built reliable TypeScript services." }
  ]);
  assert.deepEqual(resume.calls.audits.map((entry) => entry.action), ["resume-version.update", "resume-version.update"]);
});

test("the owner confirms each flagged edit and the confirmation is recorded with a timestamp", async () => {
  const { covers } = fixtures();
  const { deps, calls } = harness(covers, "COVER_LETTER");
  const edited = coverText.replace("team of 5", "team of 12");
  await createGeneratedDocumentPatchHandler(deps)(jsonRequest("PATCH", { content: edited }), params("cover-owner"));
  const flagId = readStoredDocumentReview(covers[0]!.metadata)!.flags[0]!.id;
  const review = createDocumentReviewHandler(deps, "COVER_LETTER");

  const stale = await review(jsonRequest("POST", { action: "CONFIRM_FLAG", flagId, contentHash: documentContentHash(coverText) }), params("cover-owner"));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "DOCUMENT_REVIEW_CONTENT_CHANGED");

  const unknown = await review(jsonRequest("POST", { action: "CONFIRM_FLAG", flagId: "flag:ffffffffffffffffffffffff", contentHash: documentContentHash(edited) }), params("cover-owner"));
  assert.equal(unknown.status, 404);

  const confirmed = await review(jsonRequest("POST", { action: "CONFIRM_FLAG", flagId, contentHash: documentContentHash(edited) }), params("cover-owner"));
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { review: { contentHash: documentContentHash(edited), pendingFlagCount: 0, confirmedAt: NOW.toISOString() } });
  assert.equal(readStoredDocumentReview(covers[0]!.metadata)!.flags[0]!.confirmedAt, NOW.toISOString());
  assert.equal(covers[0]!.content, edited);
  assert.deepEqual(calls.audits.at(-1), {
    userId: OWNER,
    action: "generated-document.review.confirm-flag",
    resourceId: "cover-owner",
    metadata: { flagId, confirmedAt: NOW.toISOString(), contentHash: documentContentHash(edited) }
  });
  assert.ok(calls.rate.includes(`generated-documents:review:${OWNER}`));
});

test("a legacy document is confirmed once as a whole, while a generated document cannot use that path", async () => {
  const { covers } = fixtures();
  const { deps, calls } = harness(covers, "COVER_LETTER");
  const review = createDocumentReviewHandler(deps, "COVER_LETTER");
  const legacyHash = documentContentHash("Legacy body text.");

  const generated = await review(jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: documentContentHash(coverText) }), params("cover-owner"));
  assert.equal(generated.status, 409);
  assert.equal((await generated.json()).code, "DOCUMENT_REVIEW_NOT_LEGACY");

  const response = await review(jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: legacyHash }), params("cover-legacy"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { review: { contentHash: legacyHash, pendingFlagCount: 0, confirmedAt: NOW.toISOString() } });
  const stored = readStoredDocumentReview(covers[1]!.metadata)!;
  assert.deepEqual(stored.legacyConfirmation, { confirmedAt: NOW.toISOString(), contentHash: legacyHash });
  assert.ok(stored.segments.every((segment) => segment.origin === "LEGACY" && segment.citations.length === 0));
  assert.equal(covers[1]!.content, "Legacy body text.");
  assert.equal(calls.audits.at(-1)?.action, "generated-document.review.confirm-legacy");
});

test("re-saving identical text refreshes a stored review that no longer matches the document bytes", async () => {
  const { covers } = fixtures();
  const { deps } = harness(covers, "COVER_LETTER");
  const patch = createGeneratedDocumentPatchHandler(deps);
  const edited = coverText.replace("team of 5", "team of 12");
  await patch(jsonRequest("PATCH", { content: edited }), params("cover-owner"));
  covers[0]!.content = `${edited}\nWritten outside the review.`;

  const response = await patch(jsonRequest("PATCH", { content: covers[0]!.content }), params("cover-owner"));
  assert.equal(response.status, 200);
  const review = readStoredDocumentReview(covers[0]!.metadata)!;
  assert.equal(review.contentHash, documentContentHash(covers[0]!.content));
  assert.equal(review.baseline.kind, "GENERATED", "The original generated baseline is kept.");
  assert.equal(review.segments.at(-1)?.origin, "USER_EDIT");
});

test("authentication and rate-limit failures stop before any document transaction", async () => {
  const { covers } = fixtures();
  const unauthenticated = harness(covers, "COVER_LETTER", OWNER, {
    requireUserId: async () => { throw new PublicApiError("Authentication required.", 401); }
  });
  const limited = harness(covers, "COVER_LETTER", OWNER, {
    checkRateLimit: async () => { throw new PublicApiError("Too many requests.", 429); }
  });
  for (const { deps, calls } of [unauthenticated, limited]) {
    const patch = await createGeneratedDocumentPatchHandler(deps)(jsonRequest("PATCH", { content: "Edited" }), params("cover-owner"));
    const confirm = await createDocumentReviewHandler(deps, "COVER_LETTER")(
      jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: documentContentHash("Legacy body text.") }),
      params("cover-legacy")
    );
    assert.ok([401, 429].includes(patch.status));
    assert.equal(confirm.status, patch.status);
    assert.equal(calls.transactions, 0);
  }
  assert.equal(covers[0]!.content, coverText);
});
