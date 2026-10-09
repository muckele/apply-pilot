import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FACT,
  SYNTHETIC_CORRECTION_FLOW_FIXTURE,
  SYNTHETIC_CORRECTION_FLOW_REQUIREMENT
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent
} from "@/lib/ai/correction-flow-qualification";
import {
  createCorrectionFlowProviderAdapter,
  type CorrectionFlowProviderFetches
} from "@/lib/ai/correction-flow-provider-adapter";
import type { MatchInput } from "@/lib/ai/job-match";

const exactHead = "8d850d0dcf9a141cf41363cc09cb2cde24c8317c";
const dummyGeminiKey = "dummy-gemini-key-never-send";
const dummyOpenAiKey = "dummy-openai-key-never-send";

function manifest() {
  return buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date("2026-10-09T12:00:00.000Z"),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
}

function consentFor(value: ReturnType<typeof manifest>) {
  return correctionFlowQualificationConsent.parse({
    manifestHash: value.manifestHash,
    exactHead: value.exactHead,
    providerMode: value.providerMode,
    approvedCallCount: 4,
    approvedConservativeReservationMicros: value.conservativeReservationMicros,
    approvedStepTimeoutMs: value.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: value.providerMode === "live_synthetic",
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: "2026-10-09T12:01:00.000Z"
  });
}

function initialMatchOutput() {
  return {
    contractVersion: "3",
    overallFitScore: 55,
    resumeKeywordScore: 70,
    skillsMatchScore: 70,
    experienceMatchScore: 70,
    careerGoalScore: 80,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 80,
    confidenceBasis: "Synthetic qualification fixture.",
    factualMatches: [],
    requirementGaps: [{
      requirement: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT,
      jobRequirement: { ref: "job.requirements[0]", excerpt: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT },
      missingKeywords: ["Quenby"]
    }],
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "Use current reviewed evidence.",
      coverLetterAngle: "Use current reviewed evidence."
    },
    recommendation: "consider"
  } as const;
}

function updatedMatchOutput() {
  return {
    ...initialMatchOutput(),
    overallFitScore: 90,
    requirementGaps: [],
    recommendation: "apply now"
  } as const;
}

function resumeOutput() {
  return {
    professionalSummary: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: `${SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary}\n${SYNTHETIC_CORRECTION_FLOW_FACT}`,
    claimEvidence: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
      citations: [{
        ref: "resume.summary",
        excerpt: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary
      }]
    }, {
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
    }]
  };
}

function coverOutput() {
  return {
    title: "Synthetic Employer Service Operations Director cover letter",
    coverLetter: `Dear Synthetic Employer Hiring Team,\n\nI am writing to apply for the Service Operations Director position.\n\n${SYNTHETIC_CORRECTION_FLOW_FACT}\n\nSincerely,\nTaylor Boundary`,
    angle: "Use only current reviewed evidence.",
    claimsUsed: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
    }]
  };
}

function matchInput(reviewed: boolean): MatchInput {
  return {
    job: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.job) as MatchInput["job"],
    resume: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume) as NonNullable<MatchInput["resume"]>,
    profile: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile) as NonNullable<MatchInput["profile"]>,
    reviewedEvidence: reviewed ? {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "synthetic-snapshot",
      snapshotHash: "a".repeat(64),
      facts: [{
        gapId: "gap:0",
        fact: SYNTHETIC_CORRECTION_FLOW_FACT,
        sourceRef: null,
        provenance: "OWNER_ATTESTED"
      }],
      unresolvedGapIds: []
    } : null
  };
}

function documentPayload() {
  const input = matchInput(true);
  return { job: input.job, resume: input.resume, profile: input.profile, reviewedEvidence: input.reviewedEvidence };
}

function jsonResponse(value: unknown, provider: "gemini" | "openai") {
  if (provider === "gemini") {
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 0,
        totalTokenCount: 150
      }
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "safe-gemini-id" } });
  }
  return new Response(JSON.stringify({
    id: "safe-openai-id",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0 } }
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "safe-openai-id" } });
}

function stubFetches(capturedBodies: unknown[]): CorrectionFlowProviderFetches {
  let geminiCall = 0;
  let openAiCall = 0;
  return {
    gemini: async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      const output = geminiCall++ === 0 ? initialMatchOutput() : updatedMatchOutput();
      return jsonResponse(output, "gemini");
    },
    openai: async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      const output = openAiCall++ === 0 ? resumeOutput() : coverOutput();
      return jsonResponse(output, "openai");
    }
  };
}

test("the manifest-bound adapter executes exactly four ordered SDK requests with zero retries", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: stubFetches(capturedBodies)
  });
  const signal = new AbortController().signal;

  const initial = await adapter.scoreMatch("initial_match", matchInput(false), signal);
  const updated = await adapter.scoreMatch("updated_match", matchInput(true), signal);
  const resume = await adapter.tailorResume(documentPayload(), signal);
  const cover = await adapter.draftCoverLetter(documentPayload(), signal);

  assert.equal(initial.result.recommendation, "consider");
  assert.equal(updated.result.recommendation, "apply now");
  assert.equal(resume.result.professionalSummary, SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary);
  assert.match(cover.result.coverLetter, new RegExp(SYNTHETIC_CORRECTION_FLOW_FACT, "u"));
  assert.deepEqual(adapter.completedStages(), [
    "initial_match", "updated_match", "tailored_resume", "cover_letter"
  ]);
  assert.equal(capturedBodies.length, 4);
  const serialized = JSON.stringify(capturedBodies);
  assert.doesNotMatch(serialized, /expectedRecommendation|expectedBand|reviewedRecommendation|disagreementCategories/u);
  assert.doesNotMatch(serialized, new RegExp(`${dummyGeminiKey}|${dummyOpenAiKey}`, "u"));
  await assert.rejects(
    adapter.draftCoverLetter(documentPayload(), signal),
    (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_CALL_LIMIT_REACHED"
  );
  assert.equal(capturedBodies.length, 4);
});

test("the adapter rejects substituted fixture data before a provider request", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  assert.throws(
    () => createCorrectionFlowProviderAdapter({
      manifest: value,
      consent: consentFor(value),
      fixture: { ...SYNTHETIC_CORRECTION_FLOW_FIXTURE, job: { ...SYNTHETIC_CORRECTION_FLOW_FIXTURE.job,
        company: "Substituted Employer" } },
      credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
      fetches: stubFetches(capturedBodies)
    }),
    (error: unknown) => (error as { code?: unknown }).code === "MANIFEST_FIXTURE_MISMATCH"
  );
  assert.equal(capturedBodies.length, 0);
});

test("offline mode requires both explicit stub transports", () => {
  const value = manifest();
  assert.throws(
    () => createCorrectionFlowProviderAdapter({
      manifest: value,
      consent: consentFor(value),
      fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
      credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
      fetches: {}
    }),
    (error: unknown) => (error as { code?: unknown }).code === "OFFLINE_TRANSPORT_REQUIRED"
  );
});

test("live mode rejects injected transports that could be mislabeled as real", () => {
  const value = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "live_synthetic",
    generatedAt: new Date("2026-10-09T12:00:00.000Z"),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
  assert.throws(
    () => createCorrectionFlowProviderAdapter({
      manifest: value,
      consent: consentFor(value),
      fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
      credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
      fetches: stubFetches([])
    }),
    (error: unknown) => (error as { code?: unknown }).code === "LIVE_TRANSPORT_OVERRIDE_FORBIDDEN"
  );
});

test("the adapter rejects a tampered manifest even when its stored hash is unchanged", () => {
  const value = manifest();
  const tampered = {
    ...value,
    calls: value.calls.map((call, index) => index === 0 ? { ...call, model: "tampered-model" } : call)
  } as unknown as typeof value;
  assert.throws(
    () => createCorrectionFlowProviderAdapter({
      manifest: tampered,
      consent: consentFor(value),
      fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
      credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
      fetches: stubFetches([])
    }),
    (error: unknown) => (error as { code?: unknown }).code === "MANIFEST_FIXTURE_MISMATCH"
  );
});

test("the adapter rejects an out-of-order stage before a provider request", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: stubFetches(capturedBodies)
  });

  await assert.rejects(
    adapter.scoreMatch("updated_match", matchInput(true), new AbortController().signal),
    (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_CALL_ORDER_MISMATCH"
  );
  assert.equal(capturedBodies.length, 0);
});

test("the adapter rejects unapproved reviewed evidence before a provider request", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: stubFetches(capturedBodies)
  });
  const input = matchInput(false);
  input.reviewedEvidence = {
    schema: "apply-pilot/job-match-reviewed-evidence/v1",
    snapshotId: "unapproved-snapshot",
    snapshotHash: "b".repeat(64),
    facts: [{
      gapId: "gap:extra",
      fact: "Unapproved synthetic extra fact.",
      sourceRef: null,
      provenance: "OWNER_ATTESTED"
    }],
    unresolvedGapIds: []
  };

  await assert.rejects(
    adapter.scoreMatch("initial_match", input, new AbortController().signal),
    (error: unknown) =>
      (error as { code?: unknown; fieldPath?: unknown }).code === "MANIFEST_CORRECTION_MISMATCH" &&
      (error as { fieldPath?: unknown }).fieldPath === "reviewedEvidence"
  );
  assert.equal(capturedBodies.length, 0);
});

test("the adapter rejects hidden reviewed-evidence properties before serialization", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: stubFetches(capturedBodies)
  });
  const signal = new AbortController().signal;
  await adapter.scoreMatch("initial_match", matchInput(false), signal);
  const input = matchInput(true);
  input.reviewedEvidence = {
    schema: "apply-pilot/job-match-reviewed-evidence/v1",
    snapshotId: "unapproved-snapshot",
    snapshotHash: "b".repeat(64),
    facts: [{
      gapId: "gap:0",
      fact: SYNTHETIC_CORRECTION_FLOW_FACT,
      sourceRef: null,
      provenance: "OWNER_ATTESTED",
      privateNote: "must not cross the provider boundary"
    }],
    unresolvedGapIds: []
  } as never;

  await assert.rejects(
    adapter.scoreMatch("updated_match", input, signal),
    (error: unknown) => (error as { code?: unknown }).code === "MANIFEST_CORRECTION_MISMATCH"
  );
  assert.equal(capturedBodies.length, 1);
});

test("the adapter rejects a concurrent next stage without starting another request", async () => {
  const value = manifest();
  const gate: { release?: (response: Response) => void } = {};
  let markStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let geminiRequests = 0;
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: {
      gemini: async () => {
        geminiRequests += 1;
        markStarted?.();
        return new Promise<Response>((resolve) => {
          gate.release = resolve;
        });
      },
      openai: stubFetches([]).openai
    }
  });
  const signal = new AbortController().signal;
  const first = adapter.scoreMatch("initial_match", matchInput(false), signal);
  await started;

  await assert.rejects(
    adapter.scoreMatch("updated_match", matchInput(true), signal),
    (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_CALL_IN_FLIGHT"
  );
  assert.equal(geminiRequests, 1);
  assert.ok(gate.release);
  gate.release(jsonResponse(initialMatchOutput(), "gemini"));
  await first;
  assert.equal(adapter.completedStages().length, 1);
});

test("provider diagnostics never expose explicit credentials and OpenAI performs no retry", async () => {
  const value = manifest();
  let openAiCalls = 0;
  const fetches = { ...stubFetches([]) };
  fetches.openai = async () => {
    openAiCalls += 1;
    return new Response(JSON.stringify({ error: { message: `${dummyOpenAiKey}: do not expose` } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  };
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches
  });
  const signal = new AbortController().signal;
  await adapter.scoreMatch("initial_match", matchInput(false), signal);
  await adapter.scoreMatch("updated_match", matchInput(true), signal);

  let failure: unknown;
  try {
    await adapter.tailorResume(documentPayload(), signal);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(openAiCalls, 1);
  assert.equal((failure as { code?: unknown }).code, "OPENAI_PROVIDER_FAILED");
  assert.doesNotMatch(String((failure as Error).message), new RegExp(dummyOpenAiKey, "u"));
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(dummyOpenAiKey, "u"));
});

test("a cancelled Gemini transport settles before the adapter rejects", async () => {
  const value = manifest();
  let transportSettled = false;
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: { geminiApiKey: dummyGeminiKey, openAiApiKey: dummyOpenAiKey },
    fetches: {
      gemini: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Gemini stub did not receive an abort signal.");
        const settle = () => setImmediate(() => {
          transportSettled = true;
          reject(signal.reason);
        });
        if (signal.aborted) settle();
        else signal.addEventListener("abort", settle, { once: true });
      }),
      openai: stubFetches([]).openai
    }
  });
  const controller = new AbortController();
  const pending = adapter.scoreMatch("initial_match", matchInput(false), controller.signal);
  controller.abort(new Error("synthetic cancellation"));

  await assert.rejects(pending, (error: unknown) =>
    (error as { code?: unknown }).code === "GEMINI_PROVIDER_FAILED");
  assert.equal(transportSettled, true);
});
