import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";
import type { NextRequest } from "next/server";

import { createDocumentExportRouteHandlers } from "@/app/api/documents/export/route";
import {
  SYNTHETIC_CORRECTION_FLOW_DEGREE,
  SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT,
  SYNTHETIC_CORRECTION_FLOW_FACT,
  SYNTHETIC_CORRECTION_FLOW_FIXTURE,
  SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT,
  SYNTHETIC_CORRECTION_FLOW_REQUIREMENT
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent,
  runCorrectionFlowQualification,
  type CorrectionFlowProviderCallMetrics
} from "@/lib/ai/correction-flow-qualification";
import { hashAiInput } from "@/lib/ai/input-hash";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { validateAndNormalizeJobMatchOutput, type MatchInput } from "@/lib/ai/job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import {
  createCoverLetterRouteHandler,
  createTailoredResumeRouteHandler
} from "@/lib/jobs/application-document-generation-routes";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import { createJobMatchRunner } from "@/lib/jobs";
import { extractResumeDocxText } from "@/lib/resume-docx-text";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const exactHead = "68a05e6c24b3be7efdd3471fc4b1ae9222363b8b";

test("offline qualification runner composes correction, reassessment, both documents, exports, and cleanup", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const userId = `synthetic-correction-qualification-${randomUUID()}`;
  let jobId = "";
  let resumeId = "";
  let resumeUpdatedAt = "";
  let resumeVersionId = "";
  let coverDocumentId = "";
  let currentSnapshotId = "";
  const scoredInputs: MatchInput[] = [];

  const manifest = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date("2026-10-09T02:00:00.000Z"),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
  const consent = correctionFlowQualificationConsent.parse({
    manifestHash: manifest.manifestHash,
    exactHead,
    providerMode: "offline_stubbed",
    approvedCallCount: 4,
    approvedConservativeReservationMicros: manifest.conservativeReservationMicros,
    approvedStepTimeoutMs: manifest.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: false,
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: "2026-10-09T02:05:00.000Z"
  });

  try {
    await client.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Synthetic Correction Qualification",
        profile: {
          create: {
            careerGoals: SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile.careerGoals,
            preferredRoles: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile.preferredRoles],
            preferredLocations: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile.preferredLocations],
            remotePreference: "REMOTE",
            salaryTargetMin: null,
            salaryTargetMax: null,
            industriesOfInterest: [],
            dealBreakers: [],
            skillsToEmphasize: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile.skillsToEmphasize],
            skillsNotToExaggerate: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile.skillsNotToExaggerate]
          }
        }
      }
    });
    const job = await client.jobPosting.create({
      data: {
        userId,
        title: SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.title,
        normalizedTitle: `service-operations-director-${randomUUID()}`,
        company: SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.company,
        normalizedCompany: `synthetic-employer-${randomUUID()}`,
        location: SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.location,
        normalizedLocation: `remote-${randomUUID()}`,
        remoteStatus: SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.remoteStatus,
        sourceUrl: `https://example.test/jobs/${randomUUID()}`,
        applyUrl: `https://example.test/apply/${randomUUID()}`,
        normalizedApplyUrl: `https://example.test/apply/${randomUUID()}`,
        description: SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.description,
        requirements: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.requirements],
        preferredQualifications: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.preferredQualifications],
        benefits: [],
        detectedTechStack: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.job.detectedTechStack],
        sourceType: "MANUAL",
        missingKeywords: [],
        supportedKeywords: [],
        concerns: []
      }
    });
    jobId = job.id;
    const resume = await client.resume.create({
      data: {
        userId,
        isMaster: true,
        title: "Synthetic Correction Qualification Resume",
        rawText: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.rawText,
        summary: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
        skills: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.skills],
        achievements: [...SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.achievements],
        workHistory: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.workHistory) as Prisma.InputJsonValue,
        projects: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.projects) as Prisma.InputJsonValue,
        education: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.education) as Prisma.InputJsonValue,
        certifications: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.certifications) as Prisma.InputJsonValue
      }
    });
    resumeId = resume.id;
    resumeUpdatedAt = resume.updatedAt.toISOString();

    const score = async (input: MatchInput) => {
      scoredInputs.push(input);
      return scoredInputs.length === 1 ? initialGapMatch(input) : correctedMatch(input);
    };
    const runner = createJobMatchRunner({ prismaClient: client, score });
    const resumePost = createTailoredResumeRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => userId,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      tailorResume: (async (payload: unknown) => {
        assertDocumentPayload(payload);
        return {
          professionalSummary: `${SYNTHETIC_CORRECTION_FLOW_DEGREE}. ${SYNTHETIC_CORRECTION_FLOW_FACT}`,
          skillsSection: ["Service delivery", "TypeScript", "PostgreSQL"],
          bulletRewrites: [],
          rolesOrProjectsToEmphasize: ["Service Operations Lead"],
          unsupportedKeywords: [],
          formattingWarnings: [],
          resumeText: `SYNTHETIC TAILORED RESUME\n${SYNTHETIC_CORRECTION_FLOW_DEGREE}\n${SYNTHETIC_CORRECTION_FLOW_FACT}`,
          claimEvidence: [{
            claim: SYNTHETIC_CORRECTION_FLOW_FACT,
            citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
          }],
          model: "gpt-4o-mini",
          promptVersion: "3",
          inputHash: hashAiInput("resumeTailorPrompt", "3", payload),
          usage: stubDocumentUsage("RESUME_TAILOR", payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });
    const coverPost = createCoverLetterRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => userId,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      draftCoverLetter: (async (payload: unknown) => {
        assertDocumentPayload(payload);
        return {
          title: "Synthetic Employer Service Operations Director cover letter",
          coverLetter: `Dear Synthetic Employer,\n\n${SYNTHETIC_CORRECTION_FLOW_DEGREE}. ${SYNTHETIC_CORRECTION_FLOW_FACT}\n\nSincerely,\nTaylor Boundary`,
          angle: "Use only current reviewed evidence.",
          claimsUsed: [{
            claim: SYNTHETIC_CORRECTION_FLOW_FACT,
            citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
          }],
          model: "gpt-4o-mini",
          promptVersion: "3",
          inputHash: hashAiInput("coverLetterPrompt", "3", payload),
          usage: stubDocumentUsage("COVER_LETTER", payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });

    const receipt = await runCorrectionFlowQualification({
      manifest,
      consent,
      driver: {
        async initialMatch() {
          await runner(userId, jobId, { force: true, highCostConfirmed: true });
          return providerMetrics("initial_match", "google-gemini-developer-api", JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION);
        },
        async applyPredeterminedCorrection() {
          const analysis = await client.aIAnalysis.findFirstOrThrow({
            where: { userId, jobPostingId: jobId, type: "JOB_MATCH" },
            orderBy: { createdAt: "desc" }
          });
          const currentResume = await client.resume.findUniqueOrThrow({ where: { id: resumeId } });
          const review = buildEvidenceCorrectionReview({
            jobId,
            resumeId,
            resumeUpdatedAt,
            resume: currentResume,
            analysisId: analysis.id,
            analysisInputHash: analysis.inputHash,
            analysisModel: analysis.model,
            analysisPromptVersion: analysis.promptVersion,
            analysisOutput: analysis.output
          });
          const targetGap = review.gaps.find((gap) => gap.requirement === SYNTHETIC_CORRECTION_FLOW_REQUIREMENT);
          assert.ok(targetGap, "initial match must preserve the predetermined synthetic gap");
          assert.equal(analysis.model, JOB_MATCH_MODEL);
          assert.equal(analysis.promptVersion, JOB_MATCH_PROMPT_VERSION);
          const saved = await saveEvidenceSnapshot(userId, jobId, {
            schema: "apply-pilot/evidence-snapshot-save/v1",
            requestId: `synthetic-correction-${randomUUID()}`,
            resumeId,
            resumeUpdatedAt,
            reviewedAnalysis: {
              id: analysis.id,
              inputHash: analysis.inputHash!,
              model: JOB_MATCH_MODEL,
              promptVersion: JOB_MATCH_PROMPT_VERSION
            },
            decisions: [{
              gapId: targetGap.id,
              kind: "OWNER_ATTESTATION",
              attestedFact: SYNTHETIC_CORRECTION_FLOW_FACT,
              ownerAttested: true,
              reuseScope: "JOB_ONLY",
              masterProfileOptIn: false
            }]
          });
          currentSnapshotId = saved.snapshot.id;
        },
        async updatedMatch() {
          await runner(userId, jobId, { force: true, highCostConfirmed: true });
          assert.deepEqual(scoredInputs.at(-1)?.reviewedEvidence?.facts.map((fact) => fact.fact), [
            SYNTHETIC_CORRECTION_FLOW_FACT
          ]);
          return providerMetrics("updated_match", "google-gemini-developer-api", JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION);
        },
        async generateResume() {
          const response = await resumePost(confirmedRequest("tailored-resume"), {
            params: Promise.resolve({ id: jobId })
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.version.evidenceSnapshotId, currentSnapshotId);
          resumeVersionId = body.version.id;
          return providerMetrics("tailored_resume", "openai-api", "gpt-4o-mini", "3");
        },
        async generateCoverLetter() {
          const response = await coverPost(confirmedRequest("cover-letter"), {
            params: Promise.resolve({ id: jobId })
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.document.evidenceSnapshotId, currentSnapshotId);
          coverDocumentId = body.document.id;
          return providerMetrics("cover_letter", "openai-api", "gpt-4o-mini", "3");
        },
        async verifyExports() {
          const handlers = createDocumentExportRouteHandlers({
            requireUserId: async () => userId,
            checkRateLimit: async () => undefined,
            findGeneratedDocument: ({ id, userId: ownerId }) => client.generatedDocument.findFirst({
              where: { id, userId: ownerId },
              include: { jobPosting: { select: exportJobEvidenceSelect } }
            }),
            findResumeVersion: ({ id, userId: ownerId }) => client.resumeVersion.findFirst({
              where: { id, userId: ownerId },
              include: { jobPosting: { select: exportJobEvidenceSelect } }
            })
          });
          const [resumeVersion, coverDocument] = await Promise.all([
            client.resumeVersion.findUniqueOrThrow({ where: { id: resumeVersionId } }),
            client.generatedDocument.findUniqueOrThrow({ where: { id: coverDocumentId } })
          ]);
          const resumeResponse = await handlers.POST(exportRequest({ resumeVersionId }));
          const coverResponse = await handlers.POST(exportRequest({ documentId: coverDocumentId }));
          assert.equal(resumeResponse.status, 200);
          assert.equal(coverResponse.status, 200);
          const resumeText = await extractResumeDocxText(Buffer.from(await resumeResponse.arrayBuffer()));
          const coverText = await extractResumeDocxText(Buffer.from(await coverResponse.arrayBuffer()));
          for (const content of [resumeVersion.fullText, resumeText, coverDocument.content, coverText]) {
            assert.match(content, new RegExp(SYNTHETIC_CORRECTION_FLOW_DEGREE, "u"));
          }
          return {
            resume: exportChecks(resumeVersion.fullText, resumeText, resumeVersion.evidenceSnapshotId, currentSnapshotId),
            coverLetter: exportChecks(coverDocument.content, coverText, coverDocument.evidenceSnapshotId, currentSnapshotId)
          };
        },
        async cleanup() {
          await client.user.deleteMany({ where: { id: userId } });
        }
      }
    });

    assert.equal(receipt.status, "passed");
    assert.equal(receipt.providerCallsStarted, 4);
    assert.equal(receipt.providerCallsCompleted, 4);
    assert.equal(receipt.knownEstimatedCostMicros, 616);
    assert.equal(receipt.cleanupStatus, "completed");
    assert.equal(await client.user.count({ where: { id: userId } }), 0);
    assert.doesNotMatch(JSON.stringify(receipt), /Taylor Boundary|Quenby|Business Administration/u);
  } finally {
    await client.user.deleteMany({ where: { id: userId } });
    await client.$disconnect();
  }
});

function initialGapMatch(input: MatchInput) {
  return normalizedMatch(input, {
    factualMatches: [],
    requirementGaps: [{
      requirement: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT,
      jobRequirement: { ref: "job.requirements[0]", excerpt: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT },
      missingKeywords: ["Quenby"]
    }],
    recommendation: "consider"
  });
}

function correctedMatch(input: MatchInput) {
  assert.match(JSON.stringify(input.reviewedEvidence), new RegExp(SYNTHETIC_CORRECTION_FLOW_FACT, "u"));
  return normalizedMatch(input, {
    factualMatches: [],
    requirementGaps: [],
    recommendation: "apply now"
  });
}

function normalizedMatch(input: MatchInput, overrides: {
  factualMatches: [];
  requirementGaps: Array<{
    requirement: string;
    jobRequirement: { ref: string; excerpt: string };
    missingKeywords: string[];
  }>;
  recommendation: "apply now" | "consider";
}) {
  const normalized = validateAndNormalizeJobMatchOutput(input, {
    contractVersion: "3",
    overallFitScore: overrides.recommendation === "apply now" ? 90 : 55,
    resumeKeywordScore: 70,
    skillsMatchScore: 70,
    experienceMatchScore: 70,
    careerGoalScore: 80,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 80,
    confidenceBasis: "Synthetic qualification fixture.",
    factualMatches: overrides.factualMatches,
    requirementGaps: overrides.requirementGaps,
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "Use current reviewed evidence.",
      coverLetterAngle: "Use current reviewed evidence."
    },
    recommendation: overrides.recommendation
  }).normalized;
  const inputHash = currentJobMatchInputHash(input);
  return {
    ...normalized,
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    inputHash,
    usage: {
      provider: "gemini" as const,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      requestHash: inputHash,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      estimatedCostMicros: 0,
      mocked: true
    }
  };
}

function providerMetrics(
  stage: CorrectionFlowProviderCallMetrics["stage"],
  provider: CorrectionFlowProviderCallMetrics["provider"],
  model: string,
  promptVersion: string
): CorrectionFlowProviderCallMetrics {
  const inputTokens = 100;
  const outputTokens = 50;
  const cachedInputTokens = 0;
  return {
    stage,
    provider,
    model,
    promptVersion,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedCostMicros: estimateAiCostMicros({ model, inputTokens, outputTokens, cachedInputTokens }),
    billingStatus: "known",
    providerCompleted: true,
    mocked: true
  };
}

function stubDocumentUsage(feature: "RESUME_TAILOR" | "COVER_LETTER", payload: unknown) {
  const promptName = feature === "RESUME_TAILOR" ? "resumeTailorPrompt" : "coverLetterPrompt";
  return {
    provider: "openai" as const,
    model: "gpt-4o-mini",
    promptVersion: "3",
    requestHash: hashAiInput(promptName, "3", payload),
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    estimatedCostMicros: 0,
    mocked: true
  };
}

function assertDocumentPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  assert.match(serialized, new RegExp(SYNTHETIC_CORRECTION_FLOW_FACT, "u"));
  assert.match(serialized, new RegExp(SYNTHETIC_CORRECTION_FLOW_DEGREE, "u"));
  assert.doesNotMatch(serialized, new RegExp(SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT, "u"));
  assert.doesNotMatch(serialized, new RegExp(SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT, "u"));
}

function confirmedRequest(path: string) {
  return new Request(`http://localhost/api/jobs/x/${path}`, {
    method: "POST",
    headers: {
      "x-ai-cost-confirmed": "true",
      "x-ai-data-confirmed": "true"
    }
  }) as NextRequest;
}

function exportRequest(input: { documentId?: string; resumeVersionId?: string }) {
  return new Request("http://localhost/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, format: "docx" })
  }) as NextRequest;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exportChecks(
  generated: string,
  exported: string,
  evidenceSnapshotId: string | null,
  expectedEvidenceSnapshotId: string
) {
  return {
    currentEvidenceSnapshotBound: evidenceSnapshotId === expectedEvidenceSnapshotId,
    correctionPresent: generated.includes(SYNTHETIC_CORRECTION_FLOW_FACT) && exported.includes(SYNTHETIC_CORRECTION_FLOW_FACT),
    supersededFactAbsent: !generated.includes(SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT) &&
      !exported.includes(SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT),
    unsupportedClaimsAbsent: !generated.includes(SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT) &&
      !exported.includes(SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT),
    generatedContentSha256: sha256(generated),
    exportedTextSha256: sha256(exported)
  };
}

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
