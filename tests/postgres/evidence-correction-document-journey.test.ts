import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";
import type { NextRequest } from "next/server";

import { createDocumentExportRouteHandlers } from "@/app/api/documents/export/route";
import { hashAiInput } from "@/lib/ai/input-hash";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { validateAndNormalizeJobMatchOutput, type MatchInput } from "@/lib/ai/job-match";
import { assembleAndValidateResumeV9 } from "@/lib/ai/resume";
import {
  acceptedEvidenceFactsFromSnapshot,
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  reviewedEvidenceFromSnapshot
} from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { createJobMatchRunner } from "@/lib/jobs";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import {
  createCoverLetterRouteHandler,
  createTailoredResumeRouteHandler
} from "@/lib/jobs/application-document-generation-routes";
import { extractResumeDocxText } from "@/lib/resume-docx-text";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV9FromCanonical } from "@/tests/fixtures/resume-v9-provider-data";

const degreeFact = "Bachelor of Arts in Business Administration";
const originalOwnerFact = "Synthetic owner confirms leading 40-person global delivery programs.";
const removedOwnerFact = "Synthetic owner confirms an obsolete certification.";
const replacementOwnerFact = "Synthetic owner confirms leading cross-functional service portfolio reviews.";
const jobRequirements = [
  "Business education in Zephyrite governance",
  "Global delivery scale in Asterism programs",
  "Legacy certification for Quenby systems"
] as const;
const missingRequirementKeywords = ["Zephyrite", "Asterism", "Quenby"] as const;

test("linked synthetic correction journey persists reviewed facts into both generated and exported documents", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const canonicalFixture = fullSizeSyntheticProviderOutput();
  const docx = await readFile(new URL("../fixtures/synthetic-resume-estimator-boundary.docx", import.meta.url));
  const extracted = await extractResumeDocxText(docx);
  assert.equal(extracted, fullSizeSyntheticDocxExtractedText);
  const providerProjection = providerV9FromCanonical(extracted, canonicalFixture);
  const parsed = assembleAndValidateResumeV9(extracted, providerProjection);
  assert.equal(parsed.contractVersion, "9");
  assert.equal(parsed.workHistory.length, canonicalFixture.workHistory.length);
  assert.equal(parsed.projects.length, canonicalFixture.projects.length);
  assert.deepEqual(parsed.sourceSections.at(-1), canonicalFixture.sourceSections.at(-1));

  const user = await client.user.create({ data: { email: `linked-correction-${randomUUID()}@example.test` } });
  try {
    const job = await client.jobPosting.create({ data: {
      userId: user.id,
      title: "Service Operations Director",
      normalizedTitle: `service-operations-director-${randomUUID()}`,
      company: "Synthetic Employer",
      normalizedCompany: `synthetic-employer-${randomUUID()}`,
      normalizedLocation: "remote-linked-correction",
      sourceUrl: `https://example.test/jobs/${randomUUID()}`,
      normalizedApplyUrl: `https://example.test/apply/${randomUUID()}`,
      description: "Lead service delivery, business operations, TypeScript, and PostgreSQL programs.",
      requirements: [...jobRequirements],
      preferredQualifications: [], benefits: [], detectedTechStack: ["TypeScript", "PostgreSQL"],
      sourceType: "MANUAL", missingKeywords: [], supportedKeywords: [], concerns: []
    } });
    const resume = await client.resume.create({ data: {
      userId: user.id,
      isMaster: true,
      title: "Linked Synthetic Master Resume",
      rawText: extracted,
      summary: parsed.summary,
      skills: parsed.skills,
      achievements: parsed.achievements,
      workHistory: parsed.workHistory as Prisma.InputJsonValue,
      projects: parsed.projects as Prisma.InputJsonValue,
      education: parsed.education as Prisma.InputJsonValue,
      certifications: parsed.certifications as Prisma.InputJsonValue
    } });
    const plainInput = buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence: null });
    const initialOutput = validateAndNormalizeJobMatchOutput(plainInput, {
      contractVersion: "3",
      overallFitScore: 45,
      resumeKeywordScore: 45,
      skillsMatchScore: 45,
      experienceMatchScore: 45,
      careerGoalScore: 45,
      locationWorkStyleScore: 45,
      compensationScore: null,
      confidenceScore: 90,
      confidenceBasis: "Synthetic gaps cite exact structured requirements.",
      factualMatches: [],
      requirementGaps: jobRequirements.map((requirement, index) => ({
        requirement,
        jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirement },
        missingKeywords: [missingRequirementKeywords[index]!]
      })),
      advice: {
        keywordsToEmphasize: [],
        resumeAngle: "Resolve only with reviewed evidence.",
        coverLetterAngle: "Resolve only with reviewed evidence."
      },
      recommendation: "consider"
    }).normalized;
    const analysis = await client.aIAnalysis.create({ data: {
      userId: user.id,
      jobPostingId: job.id,
      type: "JOB_MATCH",
      model: JOB_MATCH_MODEL,
      promptName: "jobMatchPrompt",
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      inputHash: currentJobMatchInputHash(plainInput),
      input: { fixture: "linked-correction" },
      output: { ...initialOutput, promptVersion: JOB_MATCH_PROMPT_VERSION }
    } });
    const initial = await saveEvidenceSnapshot(user.id, job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v1",
      requestId: `linked-initial-${randomUUID()}`,
      resumeId: resume.id,
      resumeUpdatedAt: resume.updatedAt.toISOString(),
      reviewedAnalysis: {
        id: analysis.id,
        inputHash: analysis.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: [
        {
          gapId: "gap:0",
          kind: "SOURCE_CORRECTION",
          sourceFactId: "fact:resume.rawText",
          sourceExcerpt: degreeFact,
          correctedFact: degreeFact,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        {
          gapId: "gap:1",
          kind: "OWNER_ATTESTATION",
          attestedFact: originalOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        {
          gapId: "gap:2",
          kind: "OWNER_ATTESTATION",
          attestedFact: removedOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        }
      ]
    });

    const scoredInputs: MatchInput[] = [];
    const runner = createJobMatchRunner({ prismaClient: client, score: async (input) => {
      scoredInputs.push(input);
      return noGapMatch(input);
    } });
    await runner(user.id, job.id, { force: true });
    const firstReassessment = await client.aIAnalysis.findFirstOrThrow({ where: {
      userId: user.id, jobPostingId: job.id, evidenceSnapshotId: initial.snapshot.id, type: "JOB_MATCH"
    }, orderBy: { createdAt: "desc" } });
    const initialSnapshot = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: initial.snapshot.id } });
    const accepted = acceptedEvidenceFactsFromSnapshot(initialSnapshot);
    assert.deepEqual(accepted.map((fact) => fact.fact), [degreeFact, originalOwnerFact, removedOwnerFact]);

    const final = await saveEvidenceSnapshot(user.id, job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v2",
      requestId: `linked-final-${randomUUID()}`,
      resumeId: resume.id,
      resumeUpdatedAt: resume.updatedAt.toISOString(),
      reviewedAnalysis: {
        id: firstReassessment.id,
        inputHash: firstReassessment.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: [],
      acceptedFactActions: [
        { factId: accepted[0]!.factId, action: "RETAIN" },
        {
          factId: accepted[1]!.factId,
          action: "REPLACE_OWNER_ATTESTATION",
          attestedFact: replacementOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        { factId: accepted[2]!.factId, action: "REMOVE" }
      ]
    });
    await runner(user.id, job.id, { force: true });
    const finalSnapshot = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: final.snapshot.id } });
    assert.deepEqual(reviewedEvidenceFromSnapshot(finalSnapshot).facts.map((fact) => ({
      fact: fact.fact, provenance: fact.provenance
    })), [
      { fact: degreeFact, provenance: "SUBMITTED_RESUME" },
      { fact: replacementOwnerFact, provenance: "OWNER_ATTESTED" }
    ]);
    const finalScoreInput = scoredInputs.at(-1)!;
    assert.deepEqual(finalScoreInput.reviewedEvidence?.facts.map((fact) => fact.fact), [
      degreeFact, replacementOwnerFact
    ]);
    assert.doesNotMatch(JSON.stringify(finalScoreInput), new RegExp(removedOwnerFact, "u"));

    const resumePost = createTailoredResumeRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      tailorResume: (async (payload: unknown) => {
        assertFinalDocumentPayload(payload);
        const promptVersion = "3";
        return {
          professionalSummary: `${degreeFact}. ${replacementOwnerFact}`,
          skillsSection: ["TypeScript", "PostgreSQL", "Service delivery"],
          bulletRewrites: [],
          rolesOrProjectsToEmphasize: ["Service Operations Director"],
          unsupportedKeywords: [],
          formattingWarnings: [],
          resumeText: `SYNTHETIC TAILORED RESUME\n${degreeFact}\n${replacementOwnerFact}`,
          claimEvidence: [
            { claim: degreeFact, citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: degreeFact }] },
            { claim: replacementOwnerFact, citations: [{ ref: "reviewedEvidence.facts[1].fact", excerpt: replacementOwnerFact }] }
          ],
          model: "stubbed-openai",
          promptVersion,
          inputHash: hashAiInput("resumeTailorPrompt", promptVersion, payload),
          usage: stubUsage("resumeTailorPrompt", promptVersion, payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });
    const coverPost = createCoverLetterRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      draftCoverLetter: (async (payload: unknown) => {
        assertFinalDocumentPayload(payload);
        const promptVersion = "3";
        return {
          title: "Synthetic Employer Service Operations Director cover letter",
          coverLetter: `Dear Synthetic Employer,\n\n${degreeFact}. ${replacementOwnerFact}\n\nSincerely,\nTaylor Boundary`,
          angle: "Use only retained and replaced reviewed evidence.",
          claimsUsed: [
            { claim: degreeFact, citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: degreeFact }] },
            { claim: replacementOwnerFact, citations: [{ ref: "reviewedEvidence.facts[1].fact", excerpt: replacementOwnerFact }] }
          ],
          model: "stubbed-openai",
          promptVersion,
          inputHash: hashAiInput("coverLetterPrompt", promptVersion, payload),
          usage: stubUsage("coverLetterPrompt", promptVersion, payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });
    const resumeResponse = await resumePost(new Request("http://localhost/api/jobs/x/tailored-resume", {
      method: "POST"
    }) as NextRequest, { params: Promise.resolve({ id: job.id }) });
    const coverResponse = await coverPost(new Request("http://localhost/api/jobs/x/cover-letter", {
      method: "POST"
    }) as NextRequest, { params: Promise.resolve({ id: job.id }) });
    assert.equal(resumeResponse.status, 200);
    assert.equal(coverResponse.status, 200);
    const resumeBody = await resumeResponse.json();
    const coverBody = await coverResponse.json();
    assert.equal(resumeBody.version.evidenceSnapshotId, final.snapshot.id);
    assert.equal(coverBody.document.evidenceSnapshotId, final.snapshot.id);

    const exportHandlers = createDocumentExportRouteHandlers({
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      findGeneratedDocument: ({ id, userId }) => client.generatedDocument.findFirst({
        where: { id, userId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      }),
      findResumeVersion: ({ id, userId }) => client.resumeVersion.findFirst({
        where: { id, userId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      })
    });
    const exportedResume = await exportHandlers.POST(exportRequest({ resumeVersionId: resumeBody.version.id }));
    const exportedCover = await exportHandlers.POST(exportRequest({ documentId: coverBody.document.id }));
    assert.equal(exportedResume.status, 200);
    assert.equal(exportedCover.status, 200);
    const resumeText = await extractResumeDocxText(Buffer.from(await exportedResume.arrayBuffer()));
    const coverText = await extractResumeDocxText(Buffer.from(await exportedCover.arrayBuffer()));
    for (const output of [resumeText, coverText]) {
      assert.match(output, new RegExp(degreeFact, "u"));
      assert.match(output, new RegExp(replacementOwnerFact, "u"));
      assert.doesNotMatch(output, new RegExp(removedOwnerFact, "u"));
    }
  } finally {
    await client.user.delete({ where: { id: user.id } });
    await client.$disconnect();
  }
});

const exportJobEvidenceSelect = {
  currentEvidenceSnapshotId: true,
  evidenceSnapshotGeneration: true,
  currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
  user: { select: { resumes: {
    where: { isMaster: true },
    orderBy: { updatedAt: "desc" as const },
    take: 1,
    select: { id: true, updatedAt: true }
  } } }
} as const;

function exportRequest(input: { documentId?: string; resumeVersionId?: string }) {
  return new Request("http://localhost/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, format: "docx" })
  }) as NextRequest;
}

function assertFinalDocumentPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  assert.match(serialized, new RegExp(degreeFact, "u"));
  assert.match(serialized, new RegExp(replacementOwnerFact, "u"));
  assert.doesNotMatch(serialized, new RegExp(removedOwnerFact, "u"));
}

function stubUsage(promptName: string, promptVersion: string, payload: unknown) {
  return {
    provider: "openai" as const,
    model: "stubbed-openai",
    promptVersion,
    requestHash: hashAiInput(promptName, promptVersion, payload),
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    estimatedCostMicros: 0,
    mocked: true
  };
}

function noGapMatch(input: MatchInput) {
  const inputHash = currentJobMatchInputHash(input);
  return {
    contractVersion: "3" as const,
    overallFitScore: 90,
    resumeKeywordScore: 90,
    skillsMatchScore: 90,
    experienceMatchScore: 90,
    careerGoalScore: 90,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 90,
    confidenceBasis: "Synthetic reviewed evidence is explicit.",
    factualMatches: [], requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Use reviewed evidence.", coverLetterAngle: "Use reviewed evidence." },
    recommendation: "apply now" as const,
    compensationAssessment: { score: null, reason: "missing_both" as const },
    confidenceAssessment: { score: 90, label: "Uncalibrated model self-assessment" as const,
      basis: "Synthetic reviewed evidence is explicit." },
    whyGoodMatch: ["Reviewed evidence supports the requirements."],
    concerns: [], missingKeywords: [], supportedKeywords: ["business", "service delivery"],
    keywordsToEmphasize: [], suggestedResumeAngle: "Use reviewed evidence.",
    suggestedCoverLetterAngle: "Use reviewed evidence.",
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    inputHash,
    usage: { provider: "gemini" as const, model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION,
      requestHash: inputHash, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0,
      estimatedCostMicros: 0, mocked: true }
  };
}
