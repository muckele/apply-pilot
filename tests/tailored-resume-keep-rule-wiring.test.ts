import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import { APPLICATION_DOCUMENT_PROMPT_VERSION } from "@/lib/ai/application-document-version";
import { guardedGeminiMaximumCostMicros } from "@/lib/ai/guarded-gemini";
import { AI_FEATURE_POLICIES } from "@/lib/ai/policy";
import { buildTailoredResumeSystemPrompt } from "@/lib/ai/resume";
import { buildApplicationDocumentPayload } from "@/lib/ai/resume-tailoring-payload";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";

test("tailoring and cover-letter limits match the owner-approved live numbers and stay under ten cents", () => {
  assert.equal(AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens, 12_000);
  assert.equal(AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens, 36_000);
  assert.equal(AI_FEATURE_POLICIES.COVER_LETTER.maxOutputTokens, 6_000);
  assert.equal(AI_FEATURE_POLICIES.COVER_LETTER.maxInputTokens, 36_000);
  // gemini-3.8-flash: $0.75 / M input, $3.75 / M output including thinking.
  assert.equal(guardedGeminiMaximumCostMicros("RESUME_TAILOR"), 72_000);
  assert.equal(guardedGeminiMaximumCostMicros("COVER_LETTER"), 49_500);
  assert.ok(guardedGeminiMaximumCostMicros("RESUME_TAILOR") < 100_000);
  assert.ok(guardedGeminiMaximumCostMicros("COVER_LETTER") < 100_000);
  const policy = readFileSync(new URL("../lib/ai/policy.ts", import.meta.url), "utf8");
  assert.match(policy, /5,985 of 6,000/u);
  assert.match(policy, /18,676 input/u);
  assert.match(policy, /\$0\.072/u);
  assert.match(policy, /\$0\.0495/u);
});

test("application documents use prompt/cache version 13 for the trim-but-keep-every-job rule", () => {
  assert.equal(APPLICATION_DOCUMENT_PROMPT_VERSION, "13");
});

test("the tailoring prompt tells Gemini what is required, what may be trimmed, the floors and protected facts", () => {
  const payload = buildApplicationDocumentPayload(
    syntheticCorrectionFlowDocumentPayload().job,
    syntheticCorrectionFlowDocumentPayload().resume,
    syntheticCorrectionFlowDocumentPayload().profile,
    syntheticCorrectionFlowDocumentPayload().reviewedEvidence,
    { citations: [{ ref: "resume.workHistory[1]", excerpt: "Mentored six service coordinators" }] }
  );
  const prompt = buildTailoredResumeSystemPrompt(payload);
  assert.match(prompt, /Always keep[^.]*identity\/contact header[^.]*summary[^.]*every work-history record[^.]*education[^.]*certification/isu);
  assert.match(prompt, /may trim[^.]*skills[^.]*achievements[^.]*projects[^.]*individual bullets/isu);
  assert.match(prompt, /min\(2, its bullet count\) bullets/u);
  assert.match(prompt, /min\(10, total\) skills/u);
  assert.match(prompt, /min\(2, total\) achievements/u);
  assert.match(prompt, /Owner-attested[^.]*optional/isu);
  assert.match(prompt, /never trim[^.]*protected/isu);
  assert.doesNotMatch(prompt, /Represent every available skills item/u);
  const mentored = buildApplicationDocumentFactCatalog(payload).find((fact) =>
    fact.excerpt.startsWith("Mentored six service coordinators"))!;
  assert.match(prompt, new RegExp(`Protected factIds[^\\n]*${mentored.factId}`, "u"));
});

test("the document payload carries only résumé match citations as protected evidence", () => {
  const payload = buildApplicationDocumentPayload(null, { rawText: "A" }, null, null, {
    citations: [
      { ref: "resume.skills[0]", excerpt: "TypeScript", extra: "dropped" },
      { ref: "resume.skills[1]", excerpt: 7 },
      "not a citation"
    ]
  });
  assert.deepEqual(payload.protectedEvidence, { citations: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }] });
  assert.equal("protectedEvidence" in buildApplicationDocumentPayload(null, { rawText: "A" }, null, null), false,
    "documents without match protection keep their previous payload shape");
});

const reviewedAt = new Date("2026-11-01T12:00:00.000Z");
function evidenceClient(analysis: unknown) {
  const queries: unknown[] = [];
  const client = {
    jobPosting: {
      findFirstOrThrow: async () => ({
        id: "job-1",
        userId: "user-1",
        title: "Account Executive",
        company: "Example Buyer Co",
        currentEvidenceSnapshotId: "snapshot-1",
        evidenceSnapshotGeneration: 1,
        currentEvidenceSnapshot: {
          id: "snapshot-1",
          resumeId: "resume-1",
          sourceResumeUpdatedAt: reviewedAt,
          snapshotHash: "a".repeat(64),
          reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
        }
      })
    },
    resume: {
      findFirst: async () => ({ id: "resume-1", updatedAt: reviewedAt, rawText: "Jordan Sample", skills: ["Salesforce", "Gong"] })
    },
    userProfile: { findUnique: async () => null },
    aIAnalysis: {
      findFirst: async (query: unknown) => {
        queries.push(query);
        return analysis;
      }
    }
  };
  return { client, queries };
}

test("tailoring reads protected résumé citations from the latest job match for the current evidence snapshot", async () => {
  const { client, queries } = evidenceClient({
    output: {
      factualMatches: [
        { applicantEvidence: [{ ref: "resume.skills[1]", excerpt: "Gong" }, { ref: "reviewedEvidence.facts[0]", excerpt: "x" }] },
        { applicantEvidence: [{ ref: "resume.skills[1]", excerpt: "Gong" }, { ref: "resume.rawText", excerpt: "Jordan Sample" }] }
      ]
    }
  });
  const result = await readApplicationDocumentEvidence(client as never, "user-1", "job-1", { protectMatchEvidence: true });
  assert.deepEqual(result.payload.protectedEvidence, {
    citations: [{ ref: "resume.skills[1]", excerpt: "Gong" }, { ref: "resume.rawText", excerpt: "Jordan Sample" }]
  });
  assert.deepEqual(queries, [{
    where: { userId: "user-1", jobPostingId: "job-1", type: "JOB_MATCH", evidenceSnapshotId: "snapshot-1" },
    orderBy: { createdAt: "desc" },
    select: { output: true }
  }]);
});

test("cover letters and jobs without a current match keep an unprotected payload", async () => {
  const withMatch = evidenceClient({ output: { factualMatches: [{ applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "Salesforce" }] }] } });
  const cover = await readApplicationDocumentEvidence(withMatch.client as never, "user-1", "job-1");
  assert.equal("protectedEvidence" in cover.payload, false);
  assert.equal(withMatch.queries.length, 0, "the cover-letter path does not read match analyses");

  const noMatch = evidenceClient(null);
  const resume = await readApplicationDocumentEvidence(noMatch.client as never, "user-1", "job-1", { protectMatchEvidence: true });
  assert.deepEqual(resume.payload.protectedEvidence, { citations: [] });

  const malformed = evidenceClient({ output: { factualMatches: "nope" } });
  const tolerant = await readApplicationDocumentEvidence(malformed.client as never, "user-1", "job-1", { protectMatchEvidence: true });
  assert.deepEqual(tolerant.payload.protectedEvidence, { citations: [] });
});

test("the tailored-resume route binds protection into both evidence reads and stores the left-out list", () => {
  const handlers = readFileSync(new URL("../lib/jobs/application-document-generation-routes.ts", import.meta.url), "utf8");
  const reads = handlers.match(/readApplicationDocumentEvidence\([^)]*protectMatchEvidence: true[^)]*\)/gu) ?? [];
  assert.equal(reads.length, 2);
  assert.match(handlers, /metadata: \{[^}]*claimEvidence: tailored\.claimEvidence[^}]*leftOut/u);
});
