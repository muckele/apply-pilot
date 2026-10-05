import assert from "node:assert/strict";
import test from "node:test";

import { hashAiInput } from "@/lib/ai/input-hash";
import { GeminiProviderError } from "@/lib/ai/gemini";
import {
  JOB_MATCH_MODEL,
  JOB_MATCH_PROMPT_VERSION,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import {
  buildApplicantQualificationSnapshot,
  buildQualificationPreparation,
  createGeminiQualificationTransport,
  QUALIFICATION_MAX_CALLS,
  QUALIFICATION_MAX_RESPONSE_BYTES,
  QUALIFICATION_REQUEST_TIMEOUT_MS,
  QualificationRunStoppedError,
  runJobMatchQualification,
  type QualificationExecutionConsent,
  type QualificationPreparation,
  type QualificationReviewCase,
  type QualificationTransport
} from "@/lib/ai/job-match-qualification";
import {
  buildConservativeQualificationReviewGuides,
  createQualificationReviewArtifact
} from "@/lib/ai/job-match-qualification-owner-review";
import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";

const privateRawText = "PRIVATE OWNER RESUME: customer-facing TypeScript and SQL work.";

function applicantApiResponses() {
  return {
    master: {
      resume: {
        id: "resume-private-1",
        title: "Private owner resume",
        parsedAt: "2026-10-05T04:39:07.750Z",
        rawText: privateRawText,
        summary: "Customer-facing technical operator.",
        skills: ["TypeScript", "SQL"],
        achievements: ["Improved a source-backed workflow."],
        workHistory: [{ title: "Operations Lead", bullets: ["Owned customer workflows."] }],
        projects: [{ name: "Private project", bullets: ["Built an API."] }],
        education: [{ credential: "Bachelor of Arts", fieldOfStudy: "Business Administration" }],
        certifications: [{ name: "Private certificate", details: ["480 hours"] }],
        contactInfo: { email: "must-not-cross@example.test" },
        filePath: "/private/resume.docx"
      }
    },
    profile: {
      user: { id: "user-private-1", email: "must-not-cross@example.test" },
      profile: {
        careerGoals: "Build reliable customer-facing systems.",
        preferredRoles: ["Solutions Engineer", "Customer Success Engineer"],
        preferredLocations: ["Los Angeles", "Remote"],
        remotePreference: "HYBRID",
        salaryTargetMin: 75_000,
        salaryTargetMax: 130_000,
        skillsToEmphasize: ["TypeScript", "SQL"],
        skillsNotToExaggerate: ["Kubernetes"],
        workAuthorizationNotes: "must not cross",
        dealBreakers: ["must not cross"]
      }
    }
  };
}

function validModelOutput(recommendation: "apply now" | "consider" | "skip"): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: recommendation === "apply now" ? 82 : recommendation === "consider" ? 61 : 24,
    resumeKeywordScore: 60,
    skillsMatchScore: 60,
    experienceMatchScore: 60,
    careerGoalScore: 60,
    locationWorkStyleScore: 50,
    compensationScore: 50,
    confidenceScore: 70,
    confidenceBasis: "Synthetic transport result for offline contract testing.",
    factualMatches: [],
    requirementGaps: [],
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "PRIVATE MODEL OUTPUT MUST NOT BE RETAINED",
      coverLetterAngle: "PRIVATE MODEL OUTPUT MUST NOT BE RETAINED"
    },
    recommendation
  };
}

function approvedConsent(manifestHash: string): QualificationExecutionConsent {
  return {
    recipient: "google-gemini-developer-api",
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    approvedManifestHash: manifestHash,
    approvedCallCount: 4,
    approvedMaximumCostMicros: 290_880,
    privateApplicantDataSharingApproved: true,
    noRetry: true,
    noDatabaseWrites: true,
    noRoutingWrites: true,
    noEmployerInteraction: true,
    approvedAt: "2026-10-05T17:00:00.000Z"
  };
}

const noDisagreements: QualificationReviewCase = async () => ({ disagreementCategories: [] });

function reviewedPreparation(): QualificationPreparation {
  const { master, profile } = applicantApiResponses();
  const snapshot = buildApplicantQualificationSnapshot(master, profile);
  const now = new Date("2026-10-05T17:00:00Z");
  const draft = buildQualificationPreparation(snapshot, JOB_MATCH_QUALIFICATION_CASES, now);
  const reviewGuides = buildConservativeQualificationReviewGuides(draft, JOB_MATCH_QUALIFICATION_CASES);
  const attestations = draft.privateInputs.map((entry) => createQualificationReviewArtifact({
    preparation: draft,
    reviewGuides,
    reviewedAt: "2026-10-05T16:55:00.000Z",
    decision: {
      caseId: entry.caseId,
      factsCurrent: true,
      clarifications: reviewGuides.find((guide) => guide.caseId === entry.caseId)?.clarifications.map((question) => ({
        questionId: question.id,
        answer: "not_sure" as const,
        context: ""
      })) ?? [],
      preferences: { location: "unknown", workStyle: "unknown", compensation: "unknown" },
      recommendation: entry.expectedRecommendation,
      rationale: "Synthetic canonical review artifact for runner coverage."
    }
  }).attestation);
  return buildQualificationPreparation(snapshot, JOB_MATCH_QUALIFICATION_CASES, now, attestations);
}

test("the applicant bridge selects the exact production projection and excludes account/contact fields", () => {
  const { master, profile } = applicantApiResponses();
  const snapshot = buildApplicantQualificationSnapshot(master, profile);

  assert.deepEqual(Object.keys(snapshot.resume), [
    "summary", "rawText", "skills", "achievements", "workHistory", "projects", "education", "certifications"
  ]);
  assert.deepEqual(Object.keys(snapshot.profile), [
    "careerGoals", "preferredRoles", "preferredLocations", "remotePreference", "salaryTargetMin",
    "salaryTargetMax", "skillsToEmphasize", "skillsNotToExaggerate"
  ]);
  assert.equal(snapshot.masterResumeId, "resume-private-1");
  assert.equal(snapshot.parsedAt, "2026-10-05T04:39:07.750Z");
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-cross@example\.test|filePath|workAuthorizationNotes|dealBreakers/);
});

test("preparation pins four immutable public cases and production-identical request hashes", () => {
  const { master, profile } = applicantApiResponses();
  const snapshot = buildApplicantQualificationSnapshot(master, profile);
  const preparation = buildQualificationPreparation(snapshot, JOB_MATCH_QUALIFICATION_CASES, new Date("2026-10-05T17:00:00Z"));

  assert.equal(preparation.safeManifest.caseCount, 4);
  assert.equal(preparation.safeManifest.readiness, "blocked_human_review_required");
  assert.equal(preparation.safeManifest.maximumCostMicros, 290_880);
  assert.equal(preparation.privateInputs.length, 4);
  assert.equal(Object.isFrozen(preparation.privateInputs), true);
  for (const [index, prepared] of preparation.privateInputs.entries()) {
    const expected: MatchInput = {
      job: JOB_MATCH_QUALIFICATION_CASES[index].job,
      resume: snapshot.resume,
      profile: snapshot.profile
    };
    assert.equal(
      prepared.inputHash,
      hashAiInput("jobMatchPrompt", JOB_MATCH_PROMPT_VERSION, expected),
      prepared.caseId
    );
    assert.equal(prepared.jobProjectionHash, JOB_MATCH_QUALIFICATION_CASES[index].jobProjectionHash);
    assert.equal(
      preparation.safeManifest.cases[index].sourceEvidenceSha256,
      hashAiInput(
        "jobMatchQualificationSourceEvidence",
        "1",
        JOB_MATCH_QUALIFICATION_CASES[index].provenance.sourceEvidence
      )
    );
  }
  assert.doesNotMatch(JSON.stringify(preparation.safeManifest), /PRIVATE OWNER RESUME|Private project|Business Administration/);
});

test("the runner executes four cases sequentially once and retains safe metadata only", async () => {
  const preparation = reviewedPreparation();
  let active = 0;
  let maximumActive = 0;
  const seen: string[] = [];
  const transport: QualificationTransport = async (request) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    seen.push(request.caseId);
    assert.equal(request.timeoutMs, QUALIFICATION_REQUEST_TIMEOUT_MS);
    assert.equal(request.maxResponseBytes, QUALIFICATION_MAX_RESPONSE_BYTES);
    assert.equal(request.model, JOB_MATCH_MODEL);
    assert.equal(request.promptVersion, JOB_MATCH_PROMPT_VERSION);
    await Promise.resolve();
    active -= 1;
    return {
      value: validModelOutput(request.expectedRecommendation),
      finishReason: "STOP",
      responseBytes: 900,
      elapsedMs: 25,
      requestId: `synthetic-${request.caseId}`,
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 0,
        visibleOutputTokens: 300,
        thinkingTokens: 200
      }
    };
  };

  const report = await runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport,
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(seen, JOB_MATCH_QUALIFICATION_CASES.map((entry) => entry.id));
  assert.equal(report.status, "completed");
  assert.equal(report.results.length, QUALIFICATION_MAX_CALLS);
  assert.equal(report.results.every((result) => result.humanBandAgreement), true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /PRIVATE OWNER RESUME|PRIVATE MODEL OUTPUT|Private project|Business Administration/);
  assert.doesNotMatch(serialized, /factualMatches|requirementGaps|resumeAngle|coverLetterAngle/);
});

test("the frozen corpus runs end to end through the production Gemini request builder with a synthetic fetch", async () => {
  const preparation = reviewedPreparation();
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = String(init?.body ?? "");
    requests.push({ url: String(url), body });
    const expected = JOB_MATCH_QUALIFICATION_CASES[requests.length - 1].expectedRecommendation;
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(validModelOutput(expected)) }] } }],
      usageMetadata: {
        promptTokenCount: 1_000,
        candidatesTokenCount: 300,
        thoughtsTokenCount: 200,
        totalTokenCount: 1_500
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-goog-request-id": `synthetic-${requests.length}` }
    });
  };

  const report = await runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport: createGeminiQualificationTransport({ apiKey: "synthetic-never-send", fetchImpl }),
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  });

  assert.equal(report.status, "completed");
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.match(request.body, /PRIVATE OWNER RESUME/);
    assert.match(request.body, /responseJsonSchema/);
  }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE OWNER RESUME|PRIVATE MODEL OUTPUT|synthetic-never-send/);
});

test("the runner stops on the first failure without retrying or leaking the thrown detail", async () => {
  const preparation = reviewedPreparation();
  let calls = 0;
  const transport: QualificationTransport = async (request) => {
    calls += 1;
    if (calls === 2) throw new Error(`transport failed around ${privateRawText}`);
    return {
      value: validModelOutput(request.expectedRecommendation),
      finishReason: "STOP",
      responseBytes: 500,
      elapsedMs: 10,
      requestId: null,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        visibleOutputTokens: 10,
        thinkingTokens: 0
      }
    };
  };

  await assert.rejects(
    runJobMatchQualification({
      preparation,
      consent: approvedConsent(preparation.safeManifest.manifestHash),
      transport,
      reviewCase: noDisagreements,
      now: new Date("2026-10-05T17:00:00Z")
    }),
    (error: unknown) => {
      assert.equal(calls, 2);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /PRIVATE OWNER RESUME|TypeScript and SQL/);
      assert.match(error.message, /stopped at case 2/i);
      return true;
    }
  );
});

test("execution fails closed before transport on stale input, incomplete consent, bounds, or expired pricing", async () => {
  const { master, profile } = applicantApiResponses();
  const preparation = reviewedPreparation();
  let calls = 0;
  const transport: QualificationTransport = async (request) => {
    calls += 1;
    return {
      value: validModelOutput(request.expectedRecommendation),
      finishReason: "STOP",
      responseBytes: QUALIFICATION_MAX_RESPONSE_BYTES + 1,
      elapsedMs: 1,
      requestId: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        visibleOutputTokens: 1,
        thinkingTokens: 0
      }
    };
  };

  const pendingReview = buildQualificationPreparation(
    buildApplicantQualificationSnapshot(master, profile),
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2026-10-05T17:00:00Z")
  );
  await assert.rejects(runJobMatchQualification({
    preparation: pendingReview,
    consent: approvedConsent(pendingReview.safeManifest.manifestHash),
    transport,
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), /consent/i);
  assert.equal(calls, 0);

  await assert.rejects(runJobMatchQualification({
    preparation,
    consent: { ...approvedConsent(preparation.safeManifest.manifestHash), approvedCallCount: 3 },
    transport,
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), /consent/i);
  assert.equal(calls, 0);

  await assert.rejects(runJobMatchQualification({
    preparation,
    consent: approvedConsent("stale-manifest-hash"),
    transport,
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), /manifest hash/i);
  assert.equal(calls, 0);

  await assert.rejects(runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport,
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), (error: unknown) => {
    assert.ok(error instanceof QualificationRunStoppedError);
    assert.equal((error.safeReport as { failureCode: string }).failureCode, "RESPONSE_BODY_LIMIT_EXCEEDED");
    return true;
  });
  assert.equal(calls, 1);

  const expired = buildQualificationPreparation(
    buildApplicantQualificationSnapshot(master, profile),
    JOB_MATCH_QUALIFICATION_CASES,
    new Date("2027-01-01T00:00:00Z")
  );
  assert.equal(expired.safeManifest.readiness, "blocked_pricing_review_required");
});

test("execution rejects a forged fifth private input before any transport call", async () => {
  const preparation = reviewedPreparation();
  const forged = {
    ...preparation,
    privateInputs: [...preparation.privateInputs, preparation.privateInputs[0]]
  } as QualificationPreparation;
  let calls = 0;

  await assert.rejects(runJobMatchQualification({
    preparation: forged,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport: async () => {
      calls += 1;
      throw new Error("must not run");
    },
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), /integrity/i);
  assert.equal(calls, 0);
});

test("human review attestations bind the complete open-gap list", () => {
  const reviewed = reviewedPreparation();
  const { master, profile } = applicantApiResponses();
  const changedCases = JOB_MATCH_QUALIFICATION_CASES.map((entry, index) => index === 0
    ? {
        ...entry,
        humanReview: {
          ...entry.humanReview,
          openGaps: [...entry.humanReview.openGaps, "A newly inserted unreviewed gap."]
        }
      }
    : entry);
  const attestations = reviewed.privateInputs.map((entry) => {
    assert.ok(entry.humanReviewAttestation);
    return entry.humanReviewAttestation;
  });

  assert.throws(() => buildQualificationPreparation(
    buildApplicantQualificationSnapshot(master, profile),
    changedCases,
    new Date("2026-10-05T17:00:00Z"),
    attestations
  ), /attestation mismatch/i);
});

test("a paid invalid model response retains safe billing metadata without raw output", async () => {
  const preparation = reviewedPreparation();

  await assert.rejects(runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport: async () => ({
      value: { rawPrivateModelText: "PRIVATE INVALID MODEL OUTPUT" },
      finishReason: "STOP",
      responseBytes: 321,
      elapsedMs: 45,
      requestId: "request-safe-123",
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 0,
        visibleOutputTokens: 300,
        thinkingTokens: 200
      }
    }),
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), (error: unknown) => {
    assert.ok(error instanceof QualificationRunStoppedError);
    const safe = error.safeReport as {
      failureCode: string;
      totalKnownEstimatedCostMicros: number;
      failedCall: Record<string, unknown>;
    };
    assert.equal(safe.failureCode, "MODEL_OUTPUT_VALIDATION_FAILED");
    assert.equal(safe.failedCall.billingDisposition, "known");
    assert.equal(safe.failedCall.requestId, "request-safe-123");
    assert.equal(safe.failedCall.inputTokens, 1_000);
    assert.equal(safe.failedCall.outputTokens, 500);
    assert.equal(safe.failedCall.responseBytes, 321);
    assert.ok(safe.totalKnownEstimatedCostMicros > 0);
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE INVALID MODEL OUTPUT|rawPrivateModelText/);
    return true;
  });
});

test("a provider rejection retains bounded status and billing disposition without detail", async () => {
  const preparation = reviewedPreparation();

  await assert.rejects(runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport: async () => {
      throw new GeminiProviderError("PRIVATE PROVIDER DETAIL", {
        providerResponded: true,
        billingDisposition: "not_charged",
        httpStatus: 429,
        providerCode: "RESOURCE_EXHAUSTED",
        requestId: "request-bounded-429"
      });
    },
    reviewCase: noDisagreements,
    now: new Date("2026-10-05T17:00:00Z")
  }), (error: unknown) => {
    assert.ok(error instanceof QualificationRunStoppedError);
    const failed = (error.safeReport as {
      failedCall: Record<string, unknown>;
    }).failedCall;
    assert.equal(failed.billingDisposition, "not_charged");
    assert.equal(failed.httpStatus, 429);
    assert.equal(failed.providerCode, "RESOURCE_EXHAUSTED");
    assert.equal(failed.requestId, "request-bounded-429");
    assert.equal(failed.estimatedCostMicros, 0);
    assert.doesNotMatch(JSON.stringify(error.safeReport), /PRIVATE PROVIDER DETAIL/);
    return true;
  });
});

test("transient review sees full normalized evidence but retains categories only", async () => {
  const preparation = reviewedPreparation();
  let reviewed = 0;
  const report = await runJobMatchQualification({
    preparation,
    consent: approvedConsent(preparation.safeManifest.manifestHash),
    transport: async (request) => ({
      value: validModelOutput(request.expectedRecommendation),
      finishReason: "STOP",
      responseBytes: 400,
      elapsedMs: 5,
      requestId: null,
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        visibleOutputTokens: 100,
        thinkingTokens: 0
      }
    }),
    reviewCase: async ({ matchInput, normalizedOutput }) => {
      reviewed += 1;
      assert.match(matchInput.resume?.rawText ?? "", /PRIVATE OWNER RESUME/);
      assert.equal(normalizedOutput.advice.resumeAngle, "PRIVATE MODEL OUTPUT MUST NOT BE RETAINED");
      assert.equal(Object.isFrozen(normalizedOutput), true);
      assert.equal(Object.isFrozen(normalizedOutput.advice), true);
      assert.equal(Reflect.set(normalizedOutput, "recommendation", "PRIVATE_LEAK"), false);
      assert.throws(() => normalizedOutput.advice.keywordsToEmphasize.push("PRIVATE_LEAK"), TypeError);
      return { disagreementCategories: ["advice_claim"] };
    },
    now: new Date("2026-10-05T17:00:00Z")
  });

  assert.equal(reviewed, 4);
  assert.equal(report.results.every((result) =>
    (result.disagreementCategories as string[]).includes("advice_claim")), true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE OWNER RESUME|PRIVATE MODEL OUTPUT|PRIVATE_LEAK/);
});
