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
import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import type { MatchInput } from "@/lib/ai/job-match";

const exactHead = "8d850d0dcf9a141cf41363cc09cb2cde24c8317c";
const dummyGeminiKey = "dummy-gemini-key-never-send";
const credentials = { geminiApiKey: dummyGeminiKey };

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
  const facts = buildApplicationDocumentFactCatalog(documentPayload());
  const summaryFactId = facts.find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary)?.factId;
  const reviewedFactId = facts.find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FACT)?.factId;
  assert.ok(summaryFactId && reviewedFactId);
  return {
    professionalSummary: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
    professionalSummaryFactId: summaryFactId,
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [{ claim: SYNTHETIC_CORRECTION_FLOW_FACT, factId: reviewedFactId }],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: `${SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary}\n${SYNTHETIC_CORRECTION_FLOW_FACT}`
  };
}

function coverOutput() {
  const reviewedFactId = buildApplicationDocumentFactCatalog(documentPayload())
    .find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FACT)?.factId;
  assert.ok(reviewedFactId);
  return {
    title: "Synthetic Employer Service Operations Director cover letter",
    coverLetter: `Dear Synthetic Employer Hiring Team,\n\nI am writing to apply for the Service Operations Director position.\n\n${SYNTHETIC_CORRECTION_FLOW_FACT}\n\nSincerely,\nTaylor Boundary`,
    angle: "Use only current reviewed evidence.",
    claimsUsed: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      factId: reviewedFactId
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

function jsonResponse(value: unknown) {
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

function stubFetches(
  capturedBodies: unknown[],
  capturedUrls: string[] = [],
  capturedHeaders: Headers[] = [],
  outputs: readonly unknown[] = [initialMatchOutput(), updatedMatchOutput(), resumeOutput(), coverOutput()]
): CorrectionFlowProviderFetches {
  let geminiCall = 0;
  return {
    gemini: async (input, init) => {
      capturedUrls.push(String(input));
      capturedHeaders.push(new Headers(init?.headers));
      capturedBodies.push(JSON.parse(String(init?.body)));
      const output = outputs[geminiCall++];
      if (!output) throw new Error("Unexpected Gemini call.");
      return jsonResponse(output);
    }
  };
}

test("the manifest-bound adapter executes exactly four ordered SDK requests with zero retries", async () => {
  const value = manifest();
  const capturedBodies: unknown[] = [];
  const capturedUrls: string[] = [];
  const capturedHeaders: Headers[] = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
    fetches: stubFetches(capturedBodies, capturedUrls, capturedHeaders)
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
  assert.deepEqual(capturedUrls, Array(4).fill(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
  ));
  assert.equal(capturedHeaders.length, 4);
  for (const headers of capturedHeaders) {
    assert.equal(headers.get("x-goog-api-key"), dummyGeminiKey);
    assert.equal(headers.has("authorization"), false);
  }
  assert.deepEqual(capturedBodies.map((body) => {
    const generation = (body as { generationConfig: Record<string, unknown> }).generationConfig;
    return [generation.maxOutputTokens, generation.thinkingConfig];
  }), [
    [8_192, { thinkingLevel: "MEDIUM" }],
    [8_192, { thinkingLevel: "MEDIUM" }],
    [6_000, { thinkingLevel: "LOW" }],
    [1_500, { thinkingLevel: "LOW" }]
  ]);
  for (const body of capturedBodies) {
    const generation = (body as { generationConfig: Record<string, unknown> }).generationConfig;
    assert.equal(generation.responseMimeType, "application/json");
    assert.ok(generation.responseJsonSchema);
  }
  const factIds = buildApplicationDocumentFactCatalog(documentPayload()).map((fact) => fact.factId);
  const resumeBody = capturedBodies[2] as {
    systemInstruction: { parts: Array<{ text: string }> };
    generationConfig: {
      responseJsonSchema: {
        properties: { professionalSummaryFactId: { enum: string[] } }
      }
    };
  };
  const coverBody = capturedBodies[3] as {
    systemInstruction: { parts: Array<{ text: string }> };
    generationConfig: {
      responseJsonSchema: {
        properties: { claimsUsed: { items: { properties: { factId: { enum: string[] } } } } }
      }
    };
  };
  assert.deepEqual(
    resumeBody.generationConfig.responseJsonSchema.properties.professionalSummaryFactId.enum
      .filter((value) => value !== "__NO_APPLICANT_FACT__"),
    factIds
  );
  assert.deepEqual(
    coverBody.generationConfig.responseJsonSchema.properties.claimsUsed.items.properties.factId.enum,
    factIds
  );
  for (const body of [resumeBody, coverBody]) {
    assert.match(body.systemInstruction.parts[0]?.text ?? "", /Allowed applicant atomic facts/u);
    assert.match(body.systemInstruction.parts[0]?.text ?? "", /Never return source references/u);
  }
  const serialized = JSON.stringify(capturedBodies);
  assert.doesNotMatch(serialized, /expectedRecommendation|expectedBand|reviewedRecommendation|disagreementCategories/u);
  assert.doesNotMatch(serialized, new RegExp(dummyGeminiKey, "u"));
  await assert.rejects(
    adapter.draftCoverLetter(documentPayload(), signal),
    (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_CALL_LIMIT_REACHED"
  );
  assert.equal(capturedBodies.length, 4);
});

test("document schema failures retain a safe output path and known provider usage", async () => {
  const value = manifest();
  const invalidResume = { ...resumeOutput(), professionalSummary: null };
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
    fetches: stubFetches([], [], [], [initialMatchOutput(), updatedMatchOutput(), invalidResume])
  });
  const signal = new AbortController().signal;
  await adapter.scoreMatch("initial_match", matchInput(false), signal);
  await adapter.scoreMatch("updated_match", matchInput(true), signal);

  await assert.rejects(
    adapter.tailorResume(documentPayload(), signal),
    (error: unknown) => {
      const failure = error as Record<string, unknown>;
      return failure.code === "PROVIDER_DOCUMENT_SCHEMA_INVALID" &&
        failure.fieldPath === "output.professionalSummary" &&
        failure.billingStatus === "known" &&
        failure.providerCompleted === true &&
        failure.inputTokens === 100 &&
        failure.outputTokens === 50 &&
        failure.cachedInputTokens === 0 &&
        failure.estimatedCostMicros === 263;
    }
  );
});

test("document claim failures retain their safe validator code and output path", async () => {
  const value = manifest();
  const unsupportedClaim = "Synthetic owner led an unsupported lunar logistics program.";
  const invalidResume = {
    ...resumeOutput(),
    professionalSummary: unsupportedClaim,
    resumeText: unsupportedClaim,
    resumeTextClaims: []
  };
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
    fetches: stubFetches([], [], [], [initialMatchOutput(), updatedMatchOutput(), invalidResume])
  });
  const signal = new AbortController().signal;
  await adapter.scoreMatch("initial_match", matchInput(false), signal);
  await adapter.scoreMatch("updated_match", matchInput(true), signal);

  await assert.rejects(
    adapter.tailorResume(documentPayload(), signal),
    (error: unknown) => {
      const failure = error as Record<string, unknown>;
      return failure.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
        failure.fieldPath === "output.claimEvidence[0].claim" &&
        failure.billingStatus === "known" &&
        failure.providerCompleted === true;
    }
  );
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
      credentials,
      fetches: stubFetches(capturedBodies)
    }),
    (error: unknown) => (error as { code?: unknown }).code === "MANIFEST_FIXTURE_MISMATCH"
  );
  assert.equal(capturedBodies.length, 0);
});

test("offline mode requires an explicit Gemini stub transport", () => {
  const value = manifest();
  assert.throws(
    () => createCorrectionFlowProviderAdapter({
      manifest: value,
      consent: consentFor(value),
      fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
      credentials,
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
      credentials,
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
      credentials,
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
    credentials,
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
    credentials,
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
    credentials,
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
    credentials,
    fetches: {
      gemini: async () => {
        geminiRequests += 1;
        markStarted?.();
        return new Promise<Response>((resolve) => {
          gate.release = resolve;
        });
      }
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
  gate.release(jsonResponse(initialMatchOutput()));
  await first;
  assert.equal(adapter.completedStages().length, 1);
});

test("provider diagnostics never expose explicit credentials and Gemini performs no retry", async () => {
  const value = manifest();
  let geminiCalls = 0;
  const outputs = [initialMatchOutput(), updatedMatchOutput()];
  const fetches: CorrectionFlowProviderFetches = {
    gemini: async () => {
      const output = outputs[geminiCalls++];
      if (output) return jsonResponse(output);
      return new Response(JSON.stringify({ error: { message: `${dummyGeminiKey}: do not expose` } }), {
      status: 500,
      headers: { "content-type": "application/json" }
      });
    }
  };
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
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
  assert.equal(geminiCalls, 3);
  assert.equal((failure as { code?: unknown }).code, "GEMINI_PROVIDER_FAILED");
  assert.doesNotMatch(String((failure as Error).message), new RegExp(dummyGeminiKey, "u"));
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(dummyGeminiKey, "u"));
});

test("a cancelled Gemini transport settles before the adapter rejects", async () => {
  const value = manifest();
  let transportSettled = false;
  const adapter = createCorrectionFlowProviderAdapter({
    manifest: value,
    consent: consentFor(value),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials,
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
      })
    }
  });
  const controller = new AbortController();
  const pending = adapter.scoreMatch("initial_match", matchInput(false), controller.signal);
  controller.abort(new Error("synthetic cancellation"));

  await assert.rejects(pending, (error: unknown) =>
    (error as { code?: unknown }).code === "GEMINI_PROVIDER_FAILED");
  assert.equal(transportSettled, true);
});
