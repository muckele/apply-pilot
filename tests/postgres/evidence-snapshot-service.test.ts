import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import type { MatchInput } from "@/lib/ai/job-match";
import { PublicApiError } from "@/lib/api-errors";
import {
  type EvidenceSnapshotSaveInput,
  reviewedEvidenceFromSnapshot
} from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { createJobMatchRunner } from "@/lib/jobs";
import {
  buildCurrentJobMatchInput,
  currentJobMatchInputHash
} from "@/lib/jobs/current-job-match";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const requirement = "Bachelor's degree in business or equivalent experience";

async function guardedDatabaseUrl() {
  const config = validatePostgresTestEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  return config.url;
}

function analysisOutput() {
  return {
    contractVersion: "3",
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    requirementGaps: [{
      requirement,
      jobRequirement: { ref: "job.requirements[0]", excerpt: requirement },
      missingKeywords: ["business"]
    }]
  };
}

async function createFixture(client: PrismaClient, label: string) {
  const suffix = randomUUID();
  const user = await client.user.create({
    data: { email: `${label}-${suffix}@example.test` },
    select: { id: true }
  });
  const job = await client.jobPosting.create({
    data: {
      userId: user.id,
      title: "Synthetic solutions operator",
      normalizedTitle: `synthetic-solutions-${suffix}`,
      company: "Synthetic Example",
      normalizedCompany: `synthetic-example-${suffix}`,
      normalizedLocation: `remote-${suffix}`,
      sourceUrl: `https://example.test/jobs/${suffix}`,
      normalizedApplyUrl: `https://example.test/apply/${suffix}`,
      description: "Synthetic role requiring business education.",
      requirements: [requirement],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      sourceType: "MANUAL",
      missingKeywords: [],
      supportedKeywords: [],
      concerns: []
    }
  });
  const resume = await client.resume.create({
    data: {
      userId: user.id,
      isMaster: true,
      title: "Synthetic source",
      rawText: "Bachelor of Arts in Business Administration",
      summary: "Customer-facing technical operator.",
      skills: ["Discovery"],
      achievements: [],
      workHistory: [],
      projects: [],
      education: [{
        sourceText: "Bachelor of Arts in Business Administration",
        institution: "Synthetic University",
        credential: "Bachelor of Arts",
        fieldOfStudy: "Business Administration",
        startDate: null,
        endDate: null,
        details: []
      }],
      certifications: []
    }
  });
  const plainInput = buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence: null });
  const analysis = await client.aIAnalysis.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      type: "JOB_MATCH",
      model: JOB_MATCH_MODEL,
      promptName: "jobMatchPrompt",
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      inputHash: currentJobMatchInputHash(plainInput),
      input: { fixture: true },
      output: analysisOutput()
    }
  });
  const resumeVersion = await client.resumeVersion.create({
    data: {
      userId: user.id,
      resumeId: resume.id,
      jobPostingId: job.id,
      title: "Historical synthetic resume",
      skills: [],
      fullText: "Historical synthetic resume"
    }
  });
  const cover = await client.generatedDocument.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      type: "COVER_LETTER",
      title: "Historical synthetic cover",
      content: "Historical synthetic cover"
    }
  });
  await client.application.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      resumeVersionId: resumeVersion.id,
      coverLetterVersionId: cover.id
    }
  });
  return { user, job, resume, analysis, resumeVersion, cover };
}

function sourceRequest(fixture: Awaited<ReturnType<typeof createFixture>>, requestId: string): EvidenceSnapshotSaveInput {
  return {
    schema: "apply-pilot/evidence-snapshot-save/v1",
    requestId,
    resumeId: fixture.resume.id,
    resumeUpdatedAt: fixture.resume.updatedAt.toISOString(),
    reviewedAnalysis: {
      id: fixture.analysis.id,
      inputHash: fixture.analysis.inputHash!,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION
    },
    decisions: [{
      gapId: "gap:0",
      kind: "SOURCE_CORRECTION",
      sourceFactId: "fact:resume.rawText",
      sourceExcerpt: "Bachelor of Arts in Business Administration",
      correctedFact: "Bachelor of Arts in Business Administration",
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }]
  };
}

function errorCode(error: unknown) {
  return error instanceof PublicApiError ? error.details?.code : null;
}

function reassessmentResult(input: MatchInput) {
  return {
    contractVersion: "3" as const,
    overallFitScore: 88,
    resumeKeywordScore: 86,
    skillsMatchScore: 87,
    experienceMatchScore: 89,
    careerGoalScore: 90,
    locationWorkStyleScore: 91,
    compensationScore: null,
    confidenceScore: 85,
    confidenceBasis: "Synthetic reviewed evidence is explicit.",
    factualMatches: [],
    requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Use reviewed evidence.", coverLetterAngle: "Use reviewed evidence." },
    recommendation: "apply now" as const,
    compensationAssessment: { score: null, reason: "missing_both" as const },
    confidenceAssessment: {
      score: 85,
      label: "Uncalibrated model self-assessment" as const,
      basis: "Synthetic reviewed evidence is explicit."
    },
    whyGoodMatch: ["Reviewed evidence supports the requirement."],
    concerns: [],
    missingKeywords: [],
    supportedKeywords: ["business"],
    keywordsToEmphasize: [],
    suggestedResumeAngle: "Use reviewed evidence.",
    suggestedCoverLetterAngle: "Use reviewed evidence.",
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    inputHash: currentJobMatchInputHash(input),
    usage: {
      provider: "gemini" as const,
      model: JOB_MATCH_MODEL,
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      requestHash: currentJobMatchInputHash(input),
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      estimatedCostMicros: 1,
      mocked: true
    }
  };
}

test("save reconstructs canonical authority, advances the pointer, and reports stale selected artifacts", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-save");

  try {
    const result = await saveEvidenceSnapshot(
      fixture.user.id,
      fixture.job.id,
      sourceRequest(fixture, `save-${randomUUID()}`)
    );
    assert.equal(result.replayed, false);
    assert.equal(result.snapshot.isCurrent, true);
    assert.deepEqual(result.invalidations, {
      assessmentIds: [fixture.analysis.id],
      resumeDocumentIds: [fixture.resumeVersion.id],
      coverLetterDocumentIds: [fixture.cover.id],
      totalCount: 3,
      reason: "EVIDENCE_SNAPSHOT_CHANGED"
    });

    const [job, snapshot] = await Promise.all([
      client.jobPosting.findUniqueOrThrow({
        where: { id: fixture.job.id },
        select: { currentEvidenceSnapshotId: true, evidenceSnapshotGeneration: true }
      }),
      client.evidenceSnapshot.findUniqueOrThrow({ where: { id: result.snapshot.id } })
    ]);
    assert.equal(job.currentEvidenceSnapshotId, snapshot.id);
    assert.equal(job.evidenceSnapshotGeneration, 1);
    assert.equal(snapshot.requestHash.length, 64);
    assert.equal(snapshot.sourceProjectionHash.length, 64);
    assert.equal(snapshot.gapProjectionHash.length, 64);
    assert.equal(snapshot.snapshotHash, result.snapshot.hash);
    assert.doesNotMatch(JSON.stringify(snapshot.reviewPayload), /Customer-facing technical operator/);
    assert.doesNotMatch(JSON.stringify(snapshot.reviewPayload), /Synthetic University/);
    assert.match(JSON.stringify(snapshot.reviewPayload), /Business Administration/);
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("exact historical replay is read-only and a changed body under the same request ID conflicts", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-replay");
  const firstRequest = sourceRequest(fixture, `replay-${randomUUID()}`);

  try {
    const first = await saveEvidenceSnapshot(fixture.user.id, fixture.job.id, firstRequest);
    const firstSnapshot = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: first.snapshot.id } });
    const reviewedEvidence = reviewedEvidenceFromSnapshot(firstSnapshot);
    const currentJob = await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } });
    const currentResume = await client.resume.findUniqueOrThrow({ where: { id: fixture.resume.id } });
    const reassessedInput = buildCurrentJobMatchInput({
      job: currentJob,
      resume: currentResume,
      profile: null,
      reviewedEvidence
    });
    const reassessment = await client.aIAnalysis.create({
      data: {
        userId: fixture.user.id,
        jobPostingId: fixture.job.id,
        evidenceSnapshotId: first.snapshot.id,
        type: "JOB_MATCH",
        model: JOB_MATCH_MODEL,
        promptName: "jobMatchPrompt",
        promptVersion: JOB_MATCH_PROMPT_VERSION,
        inputHash: currentJobMatchInputHash(reassessedInput),
        input: { fixture: true },
        output: analysisOutput()
      }
    });
    const secondRequest: EvidenceSnapshotSaveInput = {
      ...sourceRequest(fixture, `second-${randomUUID()}`),
      reviewedAnalysis: {
        id: reassessment.id,
        inputHash: reassessment.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: [{
        gapId: "gap:0",
        kind: "OWNER_ATTESTATION",
        attestedFact: "Synthetic owner-attested business operations evidence.",
        ownerAttested: true,
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      }]
    };
    const second = await saveEvidenceSnapshot(fixture.user.id, fixture.job.id, secondRequest);

    const replay = await saveEvidenceSnapshot(fixture.user.id, fixture.job.id, firstRequest);
    assert.equal(replay.replayed, true);
    assert.equal(replay.snapshot.id, first.snapshot.id);
    assert.equal(replay.snapshot.isCurrent, false);
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({
        where: { id: fixture.job.id },
        select: { currentEvidenceSnapshotId: true, evidenceSnapshotGeneration: true }
      })).currentEvidenceSnapshotId,
      second.snapshot.id
    );
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .evidenceSnapshotGeneration,
      2
    );

    await assert.rejects(
      saveEvidenceSnapshot(fixture.user.id, fixture.job.id, {
        ...firstRequest,
        decisions: [{
          gapId: "gap:0",
          kind: "UNRESOLVED",
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        }]
      }),
      (error: unknown) => errorCode(error) === "EVIDENCE_IDEMPOTENCY_CONFLICT"
    );
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("stale source, analysis, and cross-owner requests fail without changing snapshot state", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-stale");
  const other = await createFixture(client, "evidence-other-owner");

  try {
    const staleSource = sourceRequest(fixture, `stale-source-${randomUUID()}`);
    await client.resume.update({
      where: { id: fixture.resume.id },
      data: { summary: "Changed after review." }
    });
    await assert.rejects(
      saveEvidenceSnapshot(fixture.user.id, fixture.job.id, staleSource),
      (error: unknown) => errorCode(error) === "EVIDENCE_SOURCE_STALE"
    );
    await assert.rejects(
      saveEvidenceSnapshot(other.user.id, fixture.job.id, sourceRequest(fixture, `cross-owner-${randomUUID()}`)),
      (error: unknown) => errorCode(error) === "EVIDENCE_JOB_NOT_FOUND"
    );
    assert.equal(await client.evidenceSnapshot.count({ where: { jobPostingId: fixture.job.id } }), 0);
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({
        where: { id: fixture.job.id },
        select: { currentEvidenceSnapshotId: true }
      })).currentEvidenceSnapshotId,
      null
    );
  } finally {
    await client.user.deleteMany({ where: { id: { in: [fixture.user.id, other.user.id] } } });
    await client.$disconnect();
  }
});

test("reassessment consumes reviewed provenance and binds the published analysis to the exact snapshot", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-reassess");

  try {
    const saved = await saveEvidenceSnapshot(
      fixture.user.id,
      fixture.job.id,
      sourceRequest(fixture, `reassess-${randomUUID()}`)
    );
    const capturedInputs: MatchInput[] = [];
    const run = createJobMatchRunner({
      prismaClient: client,
      score: async (input) => {
        capturedInputs.push(input);
        return reassessmentResult(input);
      }
    });

    const result = await run(fixture.user.id, fixture.job.id, { force: true });
    assert.equal(result.cached, false);
    const capturedInput = capturedInputs[0]!;
    assert.equal(capturedInput.reviewedEvidence?.snapshotId, saved.snapshot.id);
    assert.deepEqual(capturedInput.reviewedEvidence?.facts, [{
      gapId: "gap:0",
      fact: "Bachelor of Arts in Business Administration",
      provenance: "SUBMITTED_RESUME",
      sourceRef: "resume.rawText"
    }]);
    const published = await client.aIAnalysis.findFirstOrThrow({
      where: { id: { not: fixture.analysis.id }, jobPostingId: fixture.job.id },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(published.evidenceSnapshotId, saved.snapshot.id);
    assert.equal(published.inputHash, currentJobMatchInputHash(capturedInput));
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("reassessment refuses to publish when the current snapshot changes during scoring", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-reassess-race");

  try {
    const saved = await saveEvidenceSnapshot(
      fixture.user.id,
      fixture.job.id,
      sourceRequest(fixture, `race-first-${randomUUID()}`)
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scorerStarted!: () => void;
    const started = new Promise<void>((resolve) => { scorerStarted = resolve; });
    const run = createJobMatchRunner({
      prismaClient: client,
      score: async (input) => {
        scorerStarted();
        await gate;
        return reassessmentResult(input);
      }
    });
    const pending = run(fixture.user.id, fixture.job.id, { force: true });
    await started;

    const first = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: saved.snapshot.id } });
    const newer = await client.evidenceSnapshot.create({
      data: {
        userId: first.userId,
        jobPostingId: first.jobPostingId,
        resumeId: first.resumeId,
        reviewedAnalysisId: first.reviewedAnalysisId,
        requestId: `race-newer-${randomUUID()}`,
        requestHash: "1".repeat(64),
        schemaVersion: first.schemaVersion,
        sourceResumeUpdatedAt: first.sourceResumeUpdatedAt,
        snapshotHash: "2".repeat(64),
        sourceProjectionHash: first.sourceProjectionHash,
        gapProjectionHash: first.gapProjectionHash,
        reviewPayload: first.reviewPayload!
      }
    });
    await client.jobPosting.update({
      where: { id: fixture.job.id },
      data: {
        currentEvidenceSnapshotId: newer.id,
        evidenceSnapshotGeneration: { increment: 1 }
      }
    });
    release();

    await assert.rejects(pending, (error: unknown) => errorCode(error) === "JOB_MATCH_INPUT_STALE");
    assert.equal(await client.aIAnalysis.count({ where: { jobPostingId: fixture.job.id } }), 1);
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } })).overallFitScore,
      null
    );
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("a replaced master resume rebases through a fresh null-bound analysis and advances generation", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-source-rebase");

  try {
    const first = await saveEvidenceSnapshot(
      fixture.user.id,
      fixture.job.id,
      sourceRequest(fixture, `rebase-first-${randomUUID()}`)
    );
    await client.resume.update({ where: { id: fixture.resume.id }, data: { isMaster: false } });
    const replacement = await client.resume.create({
      data: {
        userId: fixture.user.id,
        isMaster: true,
        title: "Replacement synthetic source",
        rawText: "Bachelor of Arts in Business Administration",
        summary: "Replacement customer-facing operator.",
        skills: ["Discovery"],
        achievements: [],
        workHistory: [],
        projects: [],
        education: [{
          sourceText: "Bachelor of Arts in Business Administration",
          institution: "Synthetic University",
          credential: "Bachelor of Arts",
          fieldOfStudy: "Business Administration",
          startDate: null,
          endDate: null,
          details: []
        }],
        certifications: []
      }
    });
    const captured: MatchInput[] = [];
    const run = createJobMatchRunner({
      prismaClient: client,
      score: async (input) => {
        captured.push(input);
        return reassessmentResult(input);
      }
    });
    await run(fixture.user.id, fixture.job.id, { force: true });
    assert.equal(captured[0]?.reviewedEvidence, null);
    assert.equal(captured[0]?.evidenceSnapshotGeneration, 1);
    const rebaseAnalysis = await client.aIAnalysis.findFirstOrThrow({
      where: { jobPostingId: fixture.job.id, id: { not: fixture.analysis.id } },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(rebaseAnalysis.evidenceSnapshotId, null);

    const second = await saveEvidenceSnapshot(fixture.user.id, fixture.job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v1",
      requestId: `rebase-second-${randomUUID()}`,
      resumeId: replacement.id,
      resumeUpdatedAt: replacement.updatedAt.toISOString(),
      reviewedAnalysis: {
        id: rebaseAnalysis.id,
        inputHash: rebaseAnalysis.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: []
    });
    const job = await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } });
    assert.equal(job.currentEvidenceSnapshotId, second.snapshot.id);
    assert.notEqual(job.currentEvidenceSnapshotId, first.snapshot.id);
    assert.equal(job.evidenceSnapshotGeneration, 2);
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("deleting current evidence never rewinds generation or revives an earlier null-bound analysis", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-delete-generation");

  try {
    const saved = await saveEvidenceSnapshot(
      fixture.user.id,
      fixture.job.id,
      sourceRequest(fixture, `delete-generation-${randomUUID()}`)
    );
    await client.evidenceSnapshot.delete({ where: { id: saved.snapshot.id } });
    const afterDeletion = await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } });
    assert.equal(afterDeletion.currentEvidenceSnapshotId, null);
    assert.equal(afterDeletion.evidenceSnapshotGeneration, 1);

    let scorerCalls = 0;
    const run = createJobMatchRunner({
      prismaClient: client,
      score: async (input) => {
        scorerCalls += 1;
        assert.equal(input.evidenceSnapshotGeneration, 1);
        return reassessmentResult(input);
      }
    });
    await run(fixture.user.id, fixture.job.id);
    assert.equal(scorerCalls, 1);
    const replacement = await client.aIAnalysis.findFirstOrThrow({
      where: { jobPostingId: fixture.job.id },
      orderBy: { createdAt: "desc" }
    });
    assert.notEqual(replacement.id, fixture.analysis.id);
    assert.equal(replacement.evidenceSnapshotId, null);
    assert.notEqual(replacement.inputHash, fixture.analysis.inputHash);
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});

test("concurrent identical saves converge to one immutable snapshot and one current pointer", async () => {
  const databaseUrl = await guardedDatabaseUrl();
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixture = await createFixture(client, "evidence-concurrent-replay");
  const request = sourceRequest(fixture, `concurrent-${randomUUID()}`);

  try {
    const [left, right] = await Promise.all([
      saveEvidenceSnapshot(fixture.user.id, fixture.job.id, request),
      saveEvidenceSnapshot(fixture.user.id, fixture.job.id, request)
    ]);
    assert.equal(left.snapshot.id, right.snapshot.id);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    assert.equal(await client.evidenceSnapshot.count({ where: { jobPostingId: fixture.job.id } }), 1);
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } })).currentEvidenceSnapshotId,
      left.snapshot.id
    );
    assert.equal(
      (await client.jobPosting.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .evidenceSnapshotGeneration,
      1
    );
  } finally {
    await client.user.delete({ where: { id: fixture.user.id } });
    await client.$disconnect();
  }
});
