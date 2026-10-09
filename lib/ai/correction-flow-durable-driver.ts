import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import {
  createCorrectionFlowProviderAdapter,
  type CorrectionFlowProviderCredentials,
  type CorrectionFlowProviderFetches
} from "@/lib/ai/correction-flow-provider-adapter";
import {
  runCorrectionFlowQualification,
  type CorrectionFlowProviderCallMetrics,
  type CorrectionFlowQualificationConsent,
  type CorrectionFlowQualificationManifest
} from "@/lib/ai/correction-flow-qualification";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import type { MatchInput } from "@/lib/ai/job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import {
  createCoverLetterRouteHandler,
  createTailoredResumeRouteHandler
} from "@/lib/jobs/application-document-generation-routes";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { createJobMatchRunner } from "@/lib/jobs";
import { extractResumeDocxText } from "@/lib/resume-docx-text";

export type DurableCorrectionFlowInput = Readonly<{
  databaseUrl: string;
  manifest: CorrectionFlowQualificationManifest;
  consent: CorrectionFlowQualificationConsent;
  credentials: CorrectionFlowProviderCredentials;
  fetches?: CorrectionFlowProviderFetches;
  signal?: AbortSignal;
}>;

export async function runDurableCorrectionFlowQualification({
  databaseUrl,
  manifest,
  consent,
  credentials,
  fetches,
  signal
}: DurableCorrectionFlowInput) {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const userId = `synthetic-correction-qualification-${randomUUID()}`;
  let jobId = "";
  let resumeId = "";
  let resumeUpdatedAt = "";
  let resumeVersionId = "";
  let coverDocumentId = "";
  let currentSnapshotId = "";
  let activeProviderSignal: AbortSignal | null = null;
  const scoredInputs: MatchInput[] = [];
  const providerCallMetrics = new Map<
    CorrectionFlowProviderCallMetrics["stage"],
    CorrectionFlowProviderCallMetrics
  >();
  const providerAdapter = createCorrectionFlowProviderAdapter({
    manifest,
    consent,
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
    fetches
  });

  const requireProviderSignal = () => {
    if (!activeProviderSignal) {
      throw new Error("Provider signal was not bound to the qualification step.");
    }
    return activeProviderSignal;
  };
  const withProviderSignal = async <T>(stepSignal: AbortSignal, invoke: () => Promise<T>) => {
    if (activeProviderSignal) {
      throw new Error("Concurrent correction-flow provider calls are not allowed.");
    }
    activeProviderSignal = stepSignal;
    try {
      return await invoke();
    } finally {
      activeProviderSignal = null;
    }
  };
  const completedMetrics = (stage: CorrectionFlowProviderCallMetrics["stage"]) => {
    const value = providerCallMetrics.get(stage);
    if (!value) throw new Error(`Missing provider metrics for ${stage}.`);
    return value;
  };

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
      if (!isDeepStrictEqual(input.resume, structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume))) {
        throw new Error("Durable qualification resume projection changed unexpectedly.");
      }
      scoredInputs.push(input);
      const stage = scoredInputs.length === 1 ? "initial_match" : "updated_match";
      const call = await providerAdapter.scoreMatch(stage, input, requireProviderSignal());
      providerCallMetrics.set(stage, call.metrics);
      return call.result;
    };
    const runner = createJobMatchRunner({ prismaClient: client, score });
    const resumePost = createTailoredResumeRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => userId,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      tailorResume: (async (payload: unknown) => {
        assertDocumentPayload(payload);
        const call = await providerAdapter.tailorResume(
          payload as ApplicationDocumentPayload,
          requireProviderSignal()
        );
        providerCallMetrics.set("tailored_resume", call.metrics);
        return call.result;
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
        const call = await providerAdapter.draftCoverLetter(
          payload as ApplicationDocumentPayload,
          requireProviderSignal()
        );
        providerCallMetrics.set("cover_letter", call.metrics);
        return call.result;
      }) as never,
      writeAuditLog: async () => undefined
    });

    return await runCorrectionFlowQualification({
      manifest,
      consent,
      signal,
      driver: {
        async initialMatch(stepSignal) {
          await withProviderSignal(stepSignal, () =>
            runner(userId, jobId, { force: true, highCostConfirmed: true }));
          return completedMetrics("initial_match");
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
          const targetGap = review.gaps.find((gap) =>
            gap.requirement === SYNTHETIC_CORRECTION_FLOW_REQUIREMENT);
          if (!targetGap || analysis.model !== JOB_MATCH_MODEL ||
            analysis.promptVersion !== JOB_MATCH_PROMPT_VERSION) {
            throw new Error("Initial qualification analysis did not preserve the frozen correction target.");
          }
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
        async updatedMatch(stepSignal) {
          await withProviderSignal(stepSignal, () =>
            runner(userId, jobId, { force: true, highCostConfirmed: true }));
          const reviewedFacts = scoredInputs.at(-1)?.reviewedEvidence?.facts.map((fact) => fact.fact);
          if (JSON.stringify(reviewedFacts) !== JSON.stringify([SYNTHETIC_CORRECTION_FLOW_FACT])) {
            throw new Error("Updated qualification did not receive the frozen reviewed fact.");
          }
          return completedMetrics("updated_match");
        },
        async generateResume(stepSignal) {
          const response = await withProviderSignal(stepSignal, () =>
            resumePost(confirmedRequest("tailored-resume"), {
              params: Promise.resolve({ id: jobId })
            }));
          if (response.status !== 200) throw new Error("Tailored resume route did not succeed.");
          const body = await response.json();
          if (body.version.evidenceSnapshotId !== currentSnapshotId) {
            throw new Error("Tailored resume was not bound to current evidence.");
          }
          resumeVersionId = body.version.id;
          return completedMetrics("tailored_resume");
        },
        async generateCoverLetter(stepSignal) {
          const response = await withProviderSignal(stepSignal, () =>
            coverPost(confirmedRequest("cover-letter"), {
              params: Promise.resolve({ id: jobId })
            }));
          if (response.status !== 200) throw new Error("Cover letter route did not succeed.");
          const body = await response.json();
          if (body.document.evidenceSnapshotId !== currentSnapshotId) {
            throw new Error("Cover letter was not bound to current evidence.");
          }
          coverDocumentId = body.document.id;
          return completedMetrics("cover_letter");
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
          if (resumeResponse.status !== 200 || coverResponse.status !== 200) {
            throw new Error("Qualification document export did not succeed.");
          }
          const resumeText = await extractResumeDocxText(Buffer.from(await resumeResponse.arrayBuffer()));
          const coverText = await extractResumeDocxText(Buffer.from(await coverResponse.arrayBuffer()));
          return {
            resume: exportChecks(
              resumeVersion.fullText,
              resumeText,
              resumeVersion.evidenceSnapshotId,
              currentSnapshotId
            ),
            coverLetter: exportChecks(
              coverDocument.content,
              coverText,
              coverDocument.evidenceSnapshotId,
              currentSnapshotId
            )
          };
        },
        async cleanup() {
          await client.user.deleteMany({ where: { id: userId } });
        }
      }
    });
  } finally {
    let finalizationError: unknown = null;
    try {
      await client.user.deleteMany({ where: { id: userId } });
    } catch (error) {
      finalizationError = error;
    }
    try {
      await client.$disconnect();
    } catch (error) {
      finalizationError ??= error;
    }
    if (finalizationError) throw finalizationError;
  }
}

function assertDocumentPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  if (!serialized.includes(SYNTHETIC_CORRECTION_FLOW_FACT) ||
    !serialized.includes(SYNTHETIC_CORRECTION_FLOW_DEGREE) ||
    serialized.includes(SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT) ||
    serialized.includes(SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT)) {
    throw new Error("Application document payload did not match the frozen synthetic evidence.");
  }
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
    correctionPresent: generated.includes(SYNTHETIC_CORRECTION_FLOW_FACT) &&
      exported.includes(SYNTHETIC_CORRECTION_FLOW_FACT),
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
