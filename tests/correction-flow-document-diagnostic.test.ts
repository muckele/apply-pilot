import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FIXTURE,
  SYNTHETIC_CORRECTION_FLOW_FACT
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
import {
  buildCorrectionFlowDocumentDiagnosticManifest,
  correctionFlowDocumentDiagnosticConsent,
  createCorrectionFlowDocumentDiagnosticRunner,
  type CorrectionFlowDocumentDiagnosticReceipt
} from "@/lib/ai/correction-flow-document-diagnostic";

const exactHead = "d".repeat(40);
const credential = "synthetic-two-document-key-never-log";

function manifest(mode: "offline_stubbed" | "live_synthetic" = "offline_stubbed") {
  return buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead,
    providerMode: mode,
    generatedAt: new Date("2026-10-10T01:00:00.000Z"),
    payload: syntheticCorrectionFlowDocumentPayload(),
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  });
}

function consentFor(value: ReturnType<typeof manifest>) {
  return correctionFlowDocumentDiagnosticConsent.parse({
    manifestHash: value.manifestHash,
    exactHead: value.exactHead,
    providerMode: value.providerMode,
    approvedCallCount: 2,
    approvedConservativeReservationMicros: value.conservativeReservationMicros,
    approvedStepTimeoutMs: value.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: value.providerMode === "live_synthetic",
    noRetry: true,
    noFallback: true,
    stopAfterFirstFailure: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    rawOutputRetention: false,
    outputEmission: false,
    inMemoryExportVerification: true,
    approvedAt: "2026-10-10T01:01:00.000Z"
  });
}

function providerResponse(value: unknown, usage = {
  promptTokenCount: 100,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 50,
  thoughtsTokenCount: 10,
  totalTokenCount: 160
}) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: usage
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "safe-document-diagnostic-id" }
  });
}

function runnerFor({
  value = manifest(),
  responses = [syntheticTailoredResumeOutput(), syntheticCoverLetterOutput()],
  onRequest,
  verifyExports
}: {
  value?: ReturnType<typeof manifest>;
  responses?: unknown[];
  onRequest?: (index: number, input: RequestInfo | URL, init?: RequestInit) => void;
  verifyExports?: Parameters<typeof createCorrectionFlowDocumentDiagnosticRunner>[0]["verifyExports"];
} = {}) {
  let index = 0;
  return createCorrectionFlowDocumentDiagnosticRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async (input, init) => {
      onRequest?.(index, input, init);
      const response = responses[index];
      index += 1;
      if (response instanceof Response) return response;
      return providerResponse(response);
    },
    verifyExports
  });
}

test("the two-document manifest freezes prompt v8, the 70-fact catalog, both wires, and the exact cap", () => {
  const value = manifest();
  assert.equal(value.contractVersion, "1");
  assert.equal(value.callCount, 2);
  assert.equal(value.stepTimeoutMs, 180_000);
  assert.equal(value.noRetry, true);
  assert.equal(value.noFallback, true);
  assert.equal(value.stopAfterFirstFailure, true);
  assert.equal(value.rawOutputRetention, false);
  assert.equal(value.outputEmission, false);
  assert.equal(value.factCatalogCount, 70);
  assert.equal(value.factCatalogHash, "c85e2373bf28d2e2098ec1b938fe278c4c64a2261bcc69e5720541012bf70c3e");
  assert.equal(value.payloadHash, "5d14da2d3089bddd18ed973ccccf46084e421d019a327ffdc7bab4d0076ed0ae");
  assert.equal(value.reviewedEvidenceHash, "46fb6df5fa80cc28988eddce47d24d1554feeceaf8de8fe04a4210f371ee0708");
  assert.deepEqual(value.calls.map((call) => [
    call.stage,
    call.model,
    call.promptVersion,
    call.thinkingLevel,
    call.maximumInputTokens,
    call.maximumOutputTokens,
    call.maximumCostMicros,
    call.wireRequestHash
  ]), [
    ["tailored_resume", "gemini-3.8-flash", "8", "LOW", 56_000, 6_000, 64_500,
      "49247fbe57954a9a53b46b0c1a8fd49acaa834ea4e40311b8dda560b5a6b3f26"],
    ["cover_letter", "gemini-3.8-flash", "8", "LOW", 56_000, 1_500, 47_625,
      "ae4b579e9d8c08ddd1a08580cf1dacac23ed4dcbaa5192221afe0dc848d50e3a"]
  ]);
  assert.deepEqual(value.calls.map((call) => call.pricingSnapshot), [
    {
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 3.75,
      cachedInputUsdPerMillion: 0.075,
      validFrom: "2026-10-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z"
    },
    {
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 3.75,
      cachedInputUsdPerMillion: 0.075,
      validFrom: "2026-10-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z"
    }
  ]);
  assert.equal(value.conservativeReservationMicros, 112_125);

  const changed = syntheticCorrectionFlowDocumentPayload();
  if (!changed.resume) throw new Error("Expected synthetic resume.");
  changed.resume.summary = "Owner data must never enter this diagnostic.";
  assert.throws(() => buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date(value.generatedAt),
    payload: changed,
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  }), /exact frozen synthetic fixture/iu);
});

test("the runner sends two ordered production requests and retains hashes rather than document output", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const runner = runnerFor({
    onRequest(index, input, init) {
      requests.push({
        index,
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body))
      });
    }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.providerCallsStarted, 2);
  assert.equal(receipt.providerCallsCompleted, 2);
  assert.equal(receipt.knownInputTokens, 200);
  assert.equal(receipt.knownOutputTokens, 120);
  assert.equal(receipt.knownEstimatedCostMicros, 600);
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.match(receipt.validatedOutputHashes.tailoredResume ?? "", /^[a-f0-9]{64}$/u);
  assert.match(receipt.validatedOutputHashes.coverLetter ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(receipt.exportVerification?.inMemoryOnly, true);
  assert.equal(receipt.exportVerification?.resume.docxRoundTripExact, true);
  assert.equal(receipt.exportVerification?.resume.pdfCriticalFactsPresent, true);
  assert.equal(receipt.exportVerification?.coverLetter.docxRoundTripExact, true);
  assert.equal(receipt.exportVerification?.coverLetter.pdfCriticalFactsPresent, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) =>
    ((request.body as Record<string, unknown>).generationConfig as Record<string, unknown>).maxOutputTokens
  ), [6_000, 1_500]);
  for (const request of requests) {
    const body = request.body as Record<string, unknown>;
    assert.match(String(request.url), /\/models\/gemini-3\.8-flash:generateContent$/u);
    assert.equal((request.headers as Record<string, string>)["x-goog-api-key"], credential);
    assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, {
      thinkingLevel: "LOW"
    });
    const responseSchema = (body.generationConfig as Record<string, unknown>).responseJsonSchema;
    assert.doesNotMatch(
      JSON.stringify(responseSchema),
      /claimEvidence|citations|sourceRef|excerpt|"ref"/u,
    );
    assert.doesNotMatch(JSON.stringify(body), /expectedRecommendation|expectedBand|reviewDispositions/u);
  }
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(credential, "u"));
  assert.doesNotMatch(serialized, /professionalSummary|Synthetic owner confirms|Dear Hiring Team/u);

  const second = await runner.run(new AbortController().signal);
  assert.equal(second.failureCode, "DIAGNOSTIC_ALREADY_USED");
  assert.equal(requests.length, 2);
});

test("resume failure, cost overflow, and uncertain transport all stop before cover generation", async () => {
  const privateSentinel = "private-first-stage-output-never-retain";
  const cases: Array<{
    response: unknown;
    expectedCode: string;
    expectedCompleted: number;
    expectedUnknown: number;
  }> = [
    {
      response: { ...syntheticTailoredResumeOutput(), professionalSummary: null,
        formattingWarnings: [privateSentinel] },
      expectedCode: "PROVIDER_DOCUMENT_SCHEMA_INVALID",
      expectedCompleted: 1,
      expectedUnknown: 0
    },
    {
      response: providerResponse(syntheticTailoredResumeOutput(), {
        promptTokenCount: 56_001,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 1,
        thoughtsTokenCount: 0,
        totalTokenCount: 56_002
      }),
      expectedCode: "CONSERVATIVE_RESERVATION_EXCEEDED",
      expectedCompleted: 1,
      expectedUnknown: 0
    },
    {
      response: new Error("private disconnect"),
      expectedCode: "GEMINI_PROVIDER_FAILED",
      expectedCompleted: 0,
      expectedUnknown: 1
    }
  ];

  for (const item of cases) {
    let calls = 0;
    const value = manifest();
    const runner = createCorrectionFlowDocumentDiagnosticRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => {
        calls += 1;
        if (item.response instanceof Error) throw item.response;
        if (item.response instanceof Response) return item.response;
        return providerResponse(item.response);
      }
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.failureStage, "tailored_resume");
    assert.equal(receipt.failureCode, item.expectedCode);
    assert.equal(receipt.providerCallsStarted, 1);
    assert.equal(receipt.providerCallsCompleted, item.expectedCompleted);
    assert.equal(receipt.unknownBillingCallCount, item.expectedUnknown);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(privateSentinel, "u"));
  }
});

test("cover failure occurs only after an accepted resume and retains a bounded field path", async () => {
  const invalidCover = {
    ...syntheticCoverLetterOutput(),
    claimsUsed: [{ claim: SYNTHETIC_CORRECTION_FLOW_FACT, factId: "fact:9999" }]
  };
  const runner = runnerFor({ responses: [syntheticTailoredResumeOutput(), invalidCover] });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureStage, "cover_letter");
  assert.equal(receipt.failureCode, "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID");
  assert.equal(receipt.failureFieldPath, "output.claimsUsed[0].factId");
  assert.equal(receipt.providerCallsStarted, 2);
  assert.equal(receipt.providerCallsCompleted, 2);
  assert.match(receipt.validatedOutputHashes.tailoredResume ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(receipt.validatedOutputHashes.coverLetter, null);
  assert.equal(receipt.exportVerification, null);
});

test("cancellation before dispatch and between stages starts no unauthorized later call", async () => {
  const before = new AbortController();
  before.abort();
  let beforeCalls = 0;
  const beforeRunner = runnerFor({ onRequest() { beforeCalls += 1; } });
  const beforeReceipt = await beforeRunner.run(before.signal);
  assert.equal(beforeReceipt.failureCode, "EXECUTION_CANCELLED");
  assert.equal(beforeReceipt.providerCallsStarted, 0);
  assert.equal(beforeCalls, 0);

  const between = new AbortController();
  let calls = 0;
  const betweenRunner = runnerFor({
    onRequest() {
      calls += 1;
      if (calls === 1) between.abort();
    }
  });
  const betweenReceipt = await betweenRunner.run(between.signal);
  assert.equal(betweenReceipt.status, "stopped");
  assert.equal(betweenReceipt.failureCode, "EXECUTION_CANCELLED");
  assert.equal(betweenReceipt.providerCallsStarted, 1);
  assert.equal(calls, 1);
});

test("a pricing window that cannot cover both timeouts stops before the first provider call", async () => {
  for (const checkedAt of ["2026-12-31T23:56:00.001Z", "2027-01-01T00:00:00.000Z"]) {
    const value = manifest();
    let calls = 0;
    const runner = createCorrectionFlowDocumentDiagnosticRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => {
        calls += 1;
        return providerResponse(syntheticTailoredResumeOutput());
      },
      now: () => new Date(checkedAt)
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.failureStage, "tailored_resume");
    assert.equal(receipt.failureCode, "AI_MODEL_PRICING_WINDOW_UNSAFE");
    assert.equal(receipt.providerCallsStarted, 0);
    assert.equal(receipt.providerCallsCompleted, 0);
    assert.equal(receipt.unknownBillingCallCount, 0);
    assert.equal(calls, 0);
  }
});

test("canonical DOCX export preserves every supported ATS bullet marker semantically", async () => {
  for (const marker of ["-", "*", "•"]) {
    const resume = syntheticTailoredResumeOutput();
    resume.resumeText = resume.resumeText.replace(
      SYNTHETIC_CORRECTION_FLOW_FACT,
      `${marker} ${SYNTHETIC_CORRECTION_FLOW_FACT}`
    );
    const receipt = await runnerFor({
      responses: [resume, syntheticCoverLetterOutput()]
    }).run(new AbortController().signal);
    assert.equal(receipt.status, "passed", `Expected ${marker} bullet to round-trip.`);
    assert.equal(receipt.exportVerification?.resume.docxRoundTripExact, true);
    assert.equal(receipt.exportVerification?.resume.docxCriticalFactsPresent, true);
    assert.equal(receipt.exportVerification?.resume.pdfCriticalFactsPresent, true);
  }
});

test("manifest tampering, transport substitution, and export failure fail closed", async () => {
  const value = manifest();
  const tampered = { ...value, conservativeReservationMicros: 1 } as typeof value;
  assert.throws(() => createCorrectionFlowDocumentDiagnosticRunner({
    manifest: tampered,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(syntheticTailoredResumeOutput())
  }), /frozen manifest/iu);

  const live = manifest("live_synthetic");
  assert.throws(() => createCorrectionFlowDocumentDiagnosticRunner({
    manifest: live,
    consent: consentFor(live),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(syntheticTailoredResumeOutput())
  }), /transport override is forbidden/iu);

  const runner = runnerFor({
    verifyExports: async () => { throw new Error("private export detail"); }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureStage, "verify_exports");
  assert.equal(receipt.failureCode, "EXPORT_VERIFICATION_FAILED");
  assert.equal(receipt.providerCallsStarted, 2);
  assert.equal(receipt.providerCallsCompleted, 2);
  assert.equal(receipt.exportVerification, null);
});

test("the receipt type never exposes a document-output field", () => {
  const receipt = {} as CorrectionFlowDocumentDiagnosticReceipt;
  assert.equal("resume" in receipt, false);
  assert.equal("coverLetter" in receipt, false);
  assert.equal("rawOutput" in receipt, false);
});
