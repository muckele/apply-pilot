import assert from "node:assert/strict";
import test from "node:test";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import {
  JOB_MATCH_MODEL,
  JOB_MATCH_PROMPT_VERSION,
  type JobMatchModelOutput
} from "@/lib/ai/job-match";
import {
  buildOwnerBrowserHandoffSnippet,
  QUALIFICATION_BRIDGE_MAX_BODY_BYTES,
  startJobMatchQualificationBridge,
  startJobMatchQualificationExecutionBridge
} from "@/lib/ai/job-match-qualification-bridge";
import {
  buildConservativeQualificationReviewGuides,
  createQualificationReviewArtifact
} from "@/lib/ai/job-match-qualification-owner-review";

function privatePayload() {
  return {
    master: {
      resume: {
        id: "private-resume-id",
        parsedAt: "2026-10-05T04:39:07.750Z",
        summary: "Private customer-facing summary",
        rawText: "PRIVATE RAW RESUME",
        skills: ["SQL"],
        achievements: [],
        workHistory: [],
        projects: [],
        education: [],
        certifications: []
      }
    },
    profile: {
      profile: {
        careerGoals: "Private goals",
        preferredRoles: ["Solutions Engineer"],
        preferredLocations: ["Los Angeles"],
        remotePreference: "HYBRID",
        salaryTargetMin: 75_000,
        salaryTargetMax: 130_000,
        skillsToEmphasize: ["SQL"],
        skillsNotToExaggerate: []
      }
    }
  };
}

function validOutput(recommendation: "apply now" | "consider" | "skip"): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: recommendation === "apply now" ? 80 : recommendation === "consider" ? 60 : 20,
    resumeKeywordScore: 60,
    skillsMatchScore: 60,
    experienceMatchScore: 60,
    careerGoalScore: 60,
    locationWorkStyleScore: 50,
    compensationScore: 50,
    confidenceScore: 70,
    confidenceBasis: "Synthetic bridge result.",
    factualMatches: [],
    requirementGaps: [],
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "PRIVATE BRIDGE MODEL OUTPUT",
      coverLetterAngle: "PRIVATE BRIDGE MODEL OUTPUT"
    },
    recommendation
  };
}

test("the owner handoff snippet reads only authenticated GET routes and sends only exact projections", () => {
  const snippet = buildOwnerBrowserHandoffSnippet({
    bridgeUrl: "http://127.0.0.1:12345/qualification-input/token_abc",
    expectedAppOrigin: "https://apply.example.test"
  });

  assert.match(snippet, /\/api\/resumes\/master/);
  assert.match(snippet, /\/api\/profile/);
  assert.match(snippet, /credentials: "same-origin"/);
  assert.match(snippet, /cache: "no-store"/);
  assert.match(snippet, /summary: resume\.summary/);
  assert.match(snippet, /skillsNotToExaggerate: profile\.skillsNotToExaggerate/);
  assert.doesNotMatch(snippet, /localStorage|sessionStorage|document\.cookie|user\.email|contactInfo|filePath/);
  assert.doesNotMatch(snippet, /GEMINI_API_KEY|authorization/i);
});

test("the loopback bridge enforces exact origin, bounded input, one-shot consumption, and safe output", async (t) => {
  const bridge = await startJobMatchQualificationBridge({
    allowedOrigin: "https://apply.example.test",
    cases: JOB_MATCH_QUALIFICATION_CASES,
    now: new Date("2026-10-05T17:00:00Z"),
    timeoutMs: 5_000
  });
  t.after(() => bridge.close());

  const rejected = await fetch(bridge.url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.test" },
    body: JSON.stringify(privatePayload())
  });
  assert.equal(rejected.status, 403);

  const oversized = await fetch(bridge.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://apply.example.test"
    },
    body: JSON.stringify({ oversized: "x".repeat(QUALIFICATION_BRIDGE_MAX_BODY_BYTES + 1) })
  });
  assert.equal(oversized.status, 413);

  const preflight = await fetch(bridge.url, {
    method: "OPTIONS",
    headers: {
      origin: "https://apply.example.test",
      "access-control-request-private-network": "true"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://apply.example.test");
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

  const handoffs = await Promise.allSettled([
    fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://apply.example.test" },
      body: JSON.stringify(privatePayload())
    }),
    fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://apply.example.test" },
      body: JSON.stringify(privatePayload())
    })
  ]);
  const fulfilled = handoffs.filter((entry): entry is PromiseFulfilledResult<Response> => entry.status === "fulfilled");
  const accepted = fulfilled.find((entry) => entry.value.status === 200)?.value;
  assert.ok(accepted);
  assert.equal(handoffs.filter((entry) => entry.status === "fulfilled" && entry.value.status === 200).length, 1);
  assert.ok(handoffs.some((entry) => entry.status === "rejected" || entry.value.status === 409));
  const body = await accepted.json() as { manifestHash: string; caseCount: number };
  assert.equal(body.caseCount, 4);
  assert.match(body.manifestHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE RAW RESUME|Private goals|private-resume-id/);

  const completed = await bridge.done;
  assert.equal(completed.manifestHash, body.manifestHash);
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE RAW RESUME|Private goals|private-resume-id/);
});

test("the execution bridge keeps the exact handoff in memory through review, consent, and four calls", async (t) => {
  let calls = 0;
  let transientReviews = 0;
  const bridge = await startJobMatchQualificationExecutionBridge({
    allowedOrigin: "https://apply.example.test",
    cases: JOB_MATCH_QUALIFICATION_CASES,
    now: new Date("2026-10-05T17:00:00Z"),
    timeoutMs: 5_000,
    attestHumanInputs: async (draft) => {
      assert.equal(draft.safeManifest.readiness, "blocked_human_review_required");
      assert.match(draft.privateInputs[0].input.resume?.rawText ?? "", /PRIVATE RAW RESUME/);
      const reviewGuides = buildConservativeQualificationReviewGuides(draft, JOB_MATCH_QUALIFICATION_CASES);
      return draft.privateInputs.map((entry) => createQualificationReviewArtifact({
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
          rationale: "Synthetic canonical review artifact for execution-bridge coverage."
        }
      }).attestation);
    },
    authorizeExecution: async (manifest) => {
      assert.equal(manifest.readiness, "ready_for_separate_execution_consent");
      assert.equal(manifest.maximumCostMicros, 290_880);
      return {
        recipient: "google-gemini-developer-api",
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION,
        approvedManifestHash: manifest.manifestHash,
        approvedCallCount: 4,
        approvedMaximumCostMicros: manifest.maximumCostMicros as number,
        privateApplicantDataSharingApproved: true,
        noRetry: true,
        noDatabaseWrites: true,
        noRoutingWrites: true,
        noEmployerInteraction: true,
        approvedAt: "2026-10-05T17:00:00.000Z"
      };
    },
    transport: async (request) => {
      calls += 1;
      assert.match(request.payload.resume?.rawText ?? "", /PRIVATE RAW RESUME/);
      return {
        value: validOutput(request.expectedRecommendation),
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          cachedInputTokens: 0,
          visibleOutputTokens: 100,
          thinkingTokens: 0
        },
        finishReason: "STOP",
        responseBytes: 500,
        elapsedMs: 10,
        requestId: `bridge-${calls}`
      };
    },
    reviewCase: async ({ matchInput, normalizedOutput }) => {
      transientReviews += 1;
      assert.match(matchInput.resume?.rawText ?? "", /PRIVATE RAW RESUME/);
      assert.equal(normalizedOutput.advice.resumeAngle, "PRIVATE BRIDGE MODEL OUTPUT");
      return { disagreementCategories: [] };
    }
  });
  t.after(() => bridge.close());

  const response = await fetch(bridge.url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(privatePayload())
  });
  assert.equal(response.status, 200);
  const safeReport = await response.json() as { status: string; completedCaseCount: number };
  assert.equal(safeReport.status, "completed");
  assert.equal(safeReport.completedCaseCount, 4);
  assert.equal(calls, 4);
  assert.equal(transientReviews, 4);
  assert.doesNotMatch(JSON.stringify(safeReport), /PRIVATE RAW RESUME|Private goals|PRIVATE BRIDGE MODEL OUTPUT/);

  const completed = await bridge.done as { status: string };
  assert.equal(completed.status, "completed");
});
