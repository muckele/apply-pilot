import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { assertApplicationDocumentEvidenceCurrent } from "@/lib/applications/document-currentness";
import {
  createDocumentReviewHandler,
  createGeneratedDocumentPatchHandler,
  createResumeVersionPatchHandler,
  type EditableDocumentRouteDependencies
} from "@/lib/documents/document-edit-routes";
import { generatedDocumentEditTransaction, resumeVersionEditTransaction } from "@/lib/documents/document-edit-store";
import { documentContentHash, readStoredDocumentReview, resolveDocumentReadiness } from "@/lib/documents/document-review";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT, resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const requirement = "Bachelor's degree in business or equivalent experience";
const generatedLetter = "Dear Synthetic Example Hiring Team,\nI led a team of 5 analysts at Synthetic Example.\nSincerely,\nSynthetic Owner";

function deps(userId: string, transaction: EditableDocumentRouteDependencies["transaction"]): EditableDocumentRouteDependencies {
  return { requireUserId: async () => userId, checkRateLimit: async () => {}, transaction };
}

function jsonRequest(method: string, body: unknown) {
  return new NextRequest("http://127.0.0.1/api/documents", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("D031 edits and confirmations persist through the real owner-scoped Prisma store", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  assertPostgresTestMajorVersion(await verifyLivePostgresTestDatabase(config));
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const suffix = randomUUID();
  const owner = await client.user.create({ data: { email: `d031-owner-${suffix}@example.test` }, select: { id: true } });
  const other = await client.user.create({ data: { email: `d031-other-${suffix}@example.test` }, select: { id: true } });
  try {
    const job = await client.jobPosting.create({
      data: {
        userId: owner.id, title: "Synthetic analyst", normalizedTitle: `synthetic-analyst-${suffix}`, company: "Synthetic Example",
        normalizedCompany: `synthetic-example-${suffix}`, normalizedLocation: `remote-${suffix}`, sourceUrl: `https://example.test/jobs/${suffix}`,
        normalizedApplyUrl: `https://example.test/apply/${suffix}`, description: "Synthetic role.", requirements: [requirement],
        preferredQualifications: [], benefits: [], detectedTechStack: [], sourceType: "MANUAL", missingKeywords: [], supportedKeywords: [], concerns: []
      }
    });
    const resume = await client.resume.create({
      data: {
        userId: owner.id, isMaster: true, title: "Synthetic source", rawText: "Bachelor of Arts in Business Administration",
        summary: "Synthetic analyst.", skills: [], achievements: [], workHistory: [], projects: [], certifications: [],
        education: [{ sourceText: "Bachelor of Arts in Business Administration", institution: "Synthetic University", credential: "Bachelor of Arts", fieldOfStudy: "Business Administration", startDate: null, endDate: null, details: [] }]
      }
    });
    const analysis = await client.aIAnalysis.create({
      data: {
        userId: owner.id, jobPostingId: job.id, type: "JOB_MATCH", model: JOB_MATCH_MODEL, promptName: "jobMatchPrompt", promptVersion: JOB_MATCH_PROMPT_VERSION,
        inputHash: currentJobMatchInputHash(buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence: null })), input: { fixture: true },
        output: { contractVersion: "3", promptVersion: JOB_MATCH_PROMPT_VERSION, requirementGaps: [{ requirement, jobRequirement: { ref: "job.requirements[0]", excerpt: requirement }, missingKeywords: ["business"] }] }
      }
    });
    const saved = await saveEvidenceSnapshot(owner.id, job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v1", requestId: `d031-${suffix}`, resumeId: resume.id, resumeUpdatedAt: resume.updatedAt.toISOString(),
      reviewedAnalysis: { id: analysis.id, inputHash: analysis.inputHash!, model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION },
      decisions: [{ gapId: "gap:0", kind: "SOURCE_CORRECTION", sourceFactId: "fact:resume.rawText", sourceExcerpt: "Bachelor of Arts in Business Administration", correctedFact: "Bachelor of Arts in Business Administration", reuseScope: "JOB_ONLY", masterProfileOptIn: false }]
    });
    const cover = await client.generatedDocument.create({
      data: {
        userId: owner.id, jobPostingId: job.id, evidenceSnapshotId: saved.snapshot.id, type: "COVER_LETTER", title: "Synthetic letter", content: generatedLetter,
        metadata: { angle: "kept", claimsUsed: [{ claim: "I led a team of 5 analysts at Synthetic Example.", citations: [{ ref: "resume.rawText", excerpt: "Led a team of 5 analysts at Synthetic Example." }] }] }
      }
    });
    const legacyResume = await client.resumeVersion.create({
      data: { userId: owner.id, resumeId: resume.id, jobPostingId: job.id, title: "Legacy synthetic resume", skills: [], fullText: "Legacy synthetic resume text." }
    });

    // Another user can neither edit nor confirm the owner's documents.
    const foreignEdit = await createGeneratedDocumentPatchHandler(deps(other.id, generatedDocumentEditTransaction))(jsonRequest("PATCH", { content: "Hijacked" }), params(cover.id));
    const foreignLegacy = await createDocumentReviewHandler(deps(other.id, resumeVersionEditTransaction), "RESUME")(
      jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: documentContentHash("Legacy synthetic resume text.") }), params(legacyResume.id));
    assert.equal(foreignEdit.status, 404);
    assert.equal(foreignLegacy.status, 404);
    assert.equal((await client.generatedDocument.findUniqueOrThrow({ where: { id: cover.id } })).content, generatedLetter);
    assert.equal((await client.resumeVersion.findUniqueOrThrow({ where: { id: legacyResume.id } })).metadata, null);

    // The owner edits a metric: the binding clears, provenance and a flag persist in JSON.
    const edited = generatedLetter.replace("team of 5", "team of 9");
    const editResponse = await createGeneratedDocumentPatchHandler(deps(owner.id, generatedDocumentEditTransaction))(jsonRequest("PATCH", { content: edited }), params(cover.id));
    assert.equal(editResponse.status, 200);
    let row = await client.generatedDocument.findUniqueOrThrow({ where: { id: cover.id } });
    assert.equal(row.evidenceSnapshotId, null);
    assert.equal((row.metadata as { angle: string }).angle, "kept");
    const review = readStoredDocumentReview(row.metadata)!;
    assert.equal(review.baseline.kind === "GENERATED" ? review.baseline.evidenceSnapshotId : null, saved.snapshot.id);
    assert.deepEqual(review.flags.map((flag) => flag.claims.map((claim) => claim.text)), [["9"]]);

    const freshJob = await client.jobPosting.findUniqueOrThrow({ where: { id: job.id }, include: { currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } } });
    const freshResume = await client.resume.findUniqueOrThrow({ where: { id: resume.id }, select: { id: true, updatedAt: true } });
    const evidence = resolveCurrentReviewedEvidence(freshJob, freshResume);
    const readiness = (artifact: { evidenceSnapshotId: string | null; content: string; metadata: unknown }) => resolveDocumentReadiness({
      jobBound: true, currentEvidenceSnapshotId: freshJob.currentEvidenceSnapshotId, currentEvidenceSourceValid: evidence.currentEvidenceSourceValid, artifact
    }).state;
    assert.equal(readiness({ ...row, content: row.content }), "EDITED_NEEDS_REVIEW");
    assert.throws(() => assertApplicationDocumentEvidenceCurrent({ currentEvidenceSnapshotId: freshJob.currentEvidenceSnapshotId, currentEvidenceSourceValid: evidence.currentEvidenceSourceValid, coverLetterVersion: row }));

    const confirm = await createDocumentReviewHandler(deps(owner.id, generatedDocumentEditTransaction), "COVER_LETTER")(
      jsonRequest("POST", { action: "CONFIRM_FLAG", flagId: review.flags[0]!.id, contentHash: documentContentHash(edited) }), params(cover.id));
    assert.equal(confirm.status, 200);
    row = await client.generatedDocument.findUniqueOrThrow({ where: { id: cover.id } });
    assert.ok(readStoredDocumentReview(row.metadata)!.flags[0]!.confirmedAt);
    assert.equal(readiness({ ...row, content: row.content }), "EDITED_READY");
    assert.doesNotThrow(() => assertApplicationDocumentEvidenceCurrent({ currentEvidenceSnapshotId: freshJob.currentEvidenceSnapshotId, currentEvidenceSourceValid: evidence.currentEvidenceSourceValid, coverLetterVersion: row }));

    // A legacy résumé version becomes usable after one whole-document confirmation, and a later
    // text edit through the résumé route requires that confirmation again.
    const legacyConfirm = await createDocumentReviewHandler(deps(owner.id, resumeVersionEditTransaction), "RESUME")(
      jsonRequest("POST", { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: documentContentHash("Legacy synthetic resume text.") }), params(legacyResume.id));
    assert.equal(legacyConfirm.status, 200);
    let legacyRow = await client.resumeVersion.findUniqueOrThrow({ where: { id: legacyResume.id } });
    assert.equal(readiness({ ...legacyRow, content: legacyRow.fullText }), "LEGACY_CONFIRMED");
    assert.doesNotThrow(() => assertApplicationDocumentEvidenceCurrent({ currentEvidenceSnapshotId: freshJob.currentEvidenceSnapshotId, currentEvidenceSourceValid: evidence.currentEvidenceSourceValid, resumeVersion: legacyRow }));
    const legacyEdit = await createResumeVersionPatchHandler(deps(owner.id, resumeVersionEditTransaction))(jsonRequest("PATCH", { fullText: "Legacy synthetic resume text.\nAdded later." }), params(legacyResume.id));
    assert.equal(legacyEdit.status, 200);
    legacyRow = await client.resumeVersion.findUniqueOrThrow({ where: { id: legacyResume.id } });
    assert.equal(readiness({ ...legacyRow, content: legacyRow.fullText }), "LEGACY_REVIEW_REQUIRED");

    const audits = await client.auditLog.findMany({ where: { userId: owner.id, resourceId: { in: [cover.id, legacyResume.id] } }, select: { action: true } });
    assert.deepEqual(audits.map((entry) => entry.action).sort(), [
      "generated-document.review.confirm-flag", "generated-document.update", "resume-version.review.confirm-legacy", "resume-version.update"
    ]);
    assert.equal(await client.auditLog.count({ where: { userId: other.id } }), 0);
  } finally {
    await client.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await client.$disconnect();
  }
});
