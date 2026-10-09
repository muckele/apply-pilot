import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FACT,
  SYNTHETIC_CORRECTION_FLOW_FIXTURE
} from "@/evaluation/correction-flow-qualification-fixture";
import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import {
  buildCorrectionFlowResumeDiagnosticManifest,
  correctionFlowResumeDiagnosticConsent,
  createCorrectionFlowResumeDiagnosticRunner
} from "@/lib/ai/correction-flow-resume-diagnostic";

const exactHead = "8".repeat(40);
const credential = "synthetic-diagnostic-key-never-log";

function manifest(mode: "offline_stubbed" | "live_synthetic" = "offline_stubbed") {
  return buildCorrectionFlowResumeDiagnosticManifest({
    exactHead,
    providerMode: mode,
    generatedAt: new Date("2026-10-09T22:00:00.000Z"),
    payload: syntheticCorrectionFlowDocumentPayload(),
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  });
}

function consentFor(value: ReturnType<typeof manifest>) {
  return correctionFlowResumeDiagnosticConsent.parse({
    manifestHash: value.manifestHash,
    exactHead: value.exactHead,
    providerMode: value.providerMode,
    approvedCallCount: 1,
    approvedConservativeReservationMicros: value.conservativeReservationMicros,
    approvedStepTimeoutMs: value.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: value.providerMode === "live_synthetic",
    noRetry: true,
    noFallback: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    rawOutputRetention: false,
    approvedAt: "2026-10-09T22:01:00.000Z"
  });
}

function validOutput() {
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

function providerResponse(value: unknown) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 10,
      totalTokenCount: 160
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "safe-diagnostic-id" }
  });
}

test("the one-call manifest binds the complete reviewed payload and exact production request", () => {
  const value = manifest();
  assert.equal(value.callCount, 1);
  assert.equal(value.call.stage, "tailored_resume");
  assert.equal(value.call.model, "gemini-3.8-flash");
  assert.equal(value.call.promptVersion, "4");
  assert.equal(value.call.thinkingLevel, "LOW");
  assert.equal(value.call.maximumInputTokens, 56_000);
  assert.equal(value.call.maximumOutputTokens, 6_000);
  assert.equal(value.conservativeReservationMicros, 64_500);
  assert.equal(value.payloadHash, "8101fc98203c04abb7963b211a0a8542ed81f5faf8772e98cf6719e0635635c0");
  assert.equal(value.reviewedEvidenceHash, "7646bd358e0b45e25d74d1a85c66a7d9ed8bb7eafbd39b833e8a3863c29505ec");
  assert.equal(value.schemaHash, "3a3593ed2dac836b31a279c14be21886e26db1f3910f262e9e4676b72ba7e7fc");
  assert.equal(value.wireRequestHash, "8273e8f10c362c2e0657b07a743c440b618b6ad5ef82cb942e04fd48d3d40b85");

  for (const mutate of [
    (changed: ReturnType<typeof syntheticCorrectionFlowDocumentPayload>) => {
      (changed.reviewedEvidence as { snapshotId: string }).snapshotId = "different-snapshot";
    },
    (changed: ReturnType<typeof syntheticCorrectionFlowDocumentPayload>) => {
      if (!changed.job) throw new Error("Expected synthetic job.");
      changed.job.title = "Owner job must never enter this diagnostic";
    },
    (changed: ReturnType<typeof syntheticCorrectionFlowDocumentPayload>) => {
      if (!changed.resume) throw new Error("Expected synthetic resume.");
      changed.resume.summary = "Owner resume must never enter this diagnostic";
    },
    (changed: ReturnType<typeof syntheticCorrectionFlowDocumentPayload>) => {
      if (!changed.profile) throw new Error("Expected synthetic profile.");
      changed.profile.fullName = "Owner Name";
    }
  ]) {
    const changed = syntheticCorrectionFlowDocumentPayload();
    mutate(changed);
    assert.throws(() => buildCorrectionFlowResumeDiagnosticManifest({
      exactHead,
      providerMode: "offline_stubbed",
      generatedAt: new Date(value.generatedAt),
      payload: changed,
      safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
    }), /exact frozen synthetic fixture/iu);
  }
});

test("the runner rejects a copied manifest whose truthful limits were altered without rehashing", () => {
  const value = manifest();
  const copied = {
    ...value,
    stepTimeoutMs: 60_000
  } as unknown as typeof value;
  assert.throws(() => createCorrectionFlowResumeDiagnosticRunner({
    manifest: copied,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(validOutput())
  }), /frozen manifest/iu);
});

test("the runner sends exactly one production-shaped request and retains only a success hash", async () => {
  const value = manifest();
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const runner = createCorrectionFlowResumeDiagnosticRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return providerResponse(validOutput());
    }
  });

  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.providerHttpStatus, 200);
  assert.equal(receipt.finishReason, "STOP");
  assert.equal(receipt.jsonParseStatus, "parsed");
  assert.equal(receipt.knownInputTokens, 100);
  assert.equal(receipt.knownOutputTokens, 60);
  assert.equal(receipt.knownEstimatedCostMicros, 300);
  assert.match(receipt.validatedOutputHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/models\/gemini-3\.8-flash:generateContent$/u);
  assert.equal(requests[0].headers.get("x-goog-api-key"), credential);
  assert.equal(requests[0].headers.has("authorization"), false);
  const generation = requests[0].body.generationConfig as Record<string, unknown>;
  assert.equal(generation.maxOutputTokens, 6_000);
  assert.deepEqual(generation.thinkingConfig, { thinkingLevel: "LOW" });
  assert.equal(generation.responseMimeType, "application/json");
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(credential, "u"));
  assert.doesNotMatch(JSON.stringify(receipt), /professionalSummary|claimEvidence/u);

  const second = await runner.run(new AbortController().signal);
  assert.equal(second.status, "stopped");
  assert.equal(second.failureCode, "DIAGNOSTIC_CALL_ALREADY_USED");
  assert.equal(requests.length, 1);
});

test("structural and factual failures retain bounded category, path, usage, and cost without output", async () => {
  const privateSentinel = "private-provider-output-must-not-appear";
  for (const [output, expectedCode, expectedPath] of [
    [{ ...validOutput(), professionalSummary: null, formattingWarnings: [privateSentinel] },
      "PROVIDER_DOCUMENT_SCHEMA_INVALID", "output.professionalSummary"],
    [{
      ...validOutput(),
      professionalSummary: `Synthetic owner led an unsupported lunar logistics program ${privateSentinel}.`,
      resumeText: `Synthetic owner led an unsupported lunar logistics program ${privateSentinel}.`,
      claimEvidence: [{
        claim: `Synthetic owner led an unsupported lunar logistics program ${privateSentinel}.`,
        citations: [{ ref: "resume.summary", excerpt: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary }]
      }]
    }, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "output.claimEvidence[0].claim"]
  ] as const) {
    const value = manifest();
    const runner = createCorrectionFlowResumeDiagnosticRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => providerResponse(output)
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.failureCode, expectedCode);
    assert.equal(receipt.failureFieldPath, expectedPath);
    assert.equal(receipt.providerCallsStarted, 1);
    assert.equal(receipt.providerCallsCompleted, 1);
    assert.equal(receipt.knownEstimatedCostMicros, 300);
    assert.equal(receipt.unknownBillingCallCount, 0);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(privateSentinel, "u"));
  }
});

test("the observed fifth-claim unknown-reference category remains privacy-safe and exact", async () => {
  const value = manifest();
  const output = validOutput();
  output.claimEvidence = [
    ...output.claimEvidence,
    ...output.claimEvidence,
    {
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      citations: [{
        ref: "reviewedEvidence.facts[0]",
        excerpt: SYNTHETIC_CORRECTION_FLOW_FACT
      }]
    }
  ];
  const runner = createCorrectionFlowResumeDiagnosticRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(output)
  });

  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "APPLICATION_DOCUMENT_UNKNOWN_REFERENCE");
  assert.equal(receipt.failureFieldPath, "output.claimEvidence[4].citations[0].ref");
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.providerHttpStatus, 200);
  assert.equal(receipt.finishReason, "STOP");
  assert.equal(receipt.jsonParseStatus, "parsed");
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /reviewedEvidence\.facts|Synthetic owner/u);
});

test("transport uncertainty is one-shot and a live manifest forbids an injected transport", async () => {
  const value = manifest();
  let calls = 0;
  const runner = createCorrectionFlowResumeDiagnosticRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("private disconnect detail");
    }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "GEMINI_PROVIDER_FAILED");
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 0);
  assert.equal(receipt.unknownBillingCallCount, 1);
  assert.equal(calls, 1);
  await runner.run(new AbortController().signal);
  assert.equal(calls, 1);

  const live = manifest("live_synthetic");
  assert.throws(() => createCorrectionFlowResumeDiagnosticRunner({
    manifest: live,
    consent: consentFor(live),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(validOutput())
  }), /transport override/iu);
});

test("provider-responded failures preserve completion, HTTP, billing, usage, and one-shot accounting", async () => {
  const cases = [{
    response: new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
    expectedStatus: 429,
    expectedCostMicros: 0
  }, {
    response: new Response(JSON.stringify({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 10,
        totalTokenCount: 160
      }
    }), { status: 200 }),
    expectedStatus: 200,
    expectedCostMicros: 300
  }, {
    response: new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not-json" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 10,
        totalTokenCount: 160
      }
    }), { status: 200 }),
    expectedStatus: 200,
    expectedCostMicros: 300
  }] as const;

  for (const diagnosticCase of cases) {
    const value = manifest();
    let calls = 0;
    const runner = createCorrectionFlowResumeDiagnosticRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => {
        calls += 1;
        return diagnosticCase.response;
      }
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.failureCode, "GEMINI_PROVIDER_FAILED");
    assert.equal(receipt.providerCallsStarted, 1);
    assert.equal(receipt.providerCallsCompleted, 1);
    assert.equal(receipt.providerHttpStatus, diagnosticCase.expectedStatus);
    assert.equal(receipt.knownEstimatedCostMicros, diagnosticCase.expectedCostMicros);
    assert.equal(receipt.unknownBillingCallCount, 0);
    assert.equal(calls, 1);
    await runner.run(new AbortController().signal);
    assert.equal(calls, 1);
  }
});
