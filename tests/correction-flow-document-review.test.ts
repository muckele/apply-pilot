import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FIXTURE
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCorrectionFlowDocumentPayload,
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
import {
  buildCorrectionFlowDocumentDiagnosticManifest,
  createCorrectionFlowDocumentReviewGenerationRunner
} from "@/lib/ai/correction-flow-document-diagnostic";
import {
  buildCorrectionFlowDocumentReviewManifest,
  correctionFlowDocumentReviewConsent,
  createCorrectionFlowDocumentReviewRunner
} from "@/lib/ai/correction-flow-document-review";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";

const exactHead = "f".repeat(40);
const credential = "offline-review-credential-never-log";
const fixedResumeOutput = syntheticTailoredResumeOutput();
const fixedCoverLetterOutput = syntheticCoverLetterOutput();

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
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function manifest(mode: "offline_stubbed" | "live_synthetic" = "offline_stubbed") {
  return buildCorrectionFlowDocumentReviewManifest({
    exactHead,
    providerMode: mode,
    generatedAt: new Date("2026-10-10T05:00:00.000Z"),
    payload: syntheticCorrectionFlowDocumentPayload(),
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  });
}

function consentFor(value: ReturnType<typeof manifest>) {
  return correctionFlowDocumentReviewConsent.parse({
    manifestHash: value.manifestHash,
    exactHead: value.exactHead,
    providerMode: value.providerMode,
    approvedCallCount: 2,
    approvedConservativeReservationMicros: 112_125,
    approvedStepTimeoutMs: 180_000,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: value.providerMode === "live_synthetic",
    noRetry: true,
    noFallback: true,
    stopAfterFirstFailure: true,
    noOwnerData: true,
    noProductionWrites: true,
    noDatabaseWrites: true,
    noEmployerInteraction: true,
    noJobMatchCalls: true,
    rawProviderOutputRetention: false,
    validatedDocumentPersistentRetention: false,
    validatedDocumentLocalDisplay: true,
    validatedDocumentLifetimeMs: 900_000,
    safeReceiptOnly: true,
    approvedAt: "2026-10-10T05:01:00.000Z"
  });
}

test("the v3 review manifest freezes the exact visible-review scope and generation plan", () => {
  const value = manifest();
  assert.equal(value.contractVersion, "3");
  assert.equal(value.callCount, 2);
  assert.equal(value.stepTimeoutMs, 180_000);
  assert.equal(value.conservativeReservationMicros, 112_125);
  assert.equal(value.recipient, "google-gemini-developer-api");
  assert.equal(value.rawProviderOutputRetention, false);
  assert.equal(value.validatedDocumentPersistentRetention, false);
  assert.equal(value.validatedDocumentLocalDisplay, true);
  assert.equal(value.validatedDocumentLifetimeMs, 900_000);
  assert.equal(value.safeReceiptOnly, true);
  assert.equal(value.jobMatchCalls, 0);
  assert.equal(value.productionWrites, false);
  assert.equal(value.databaseWrites, false);
  assert.equal(value.employerInteraction, false);
  assert.deepEqual(value.requiredOwnerAttestations, [
    "reviewedAllPages", "reviewedWritingQuality", "reviewedVisualLayout"
  ]);
  assert.deepEqual(value.calls.map((call) => [call.stage, call.model, call.thinkingLevel]), [
    ["tailored_resume", "gemini-3.8-flash", "LOW"],
    ["cover_letter", "gemini-3.8-flash", "LOW"]
  ]);
  assert.throws(() => correctionFlowDocumentReviewConsent.parse({
    ...consentFor(value),
    validatedDocumentLifetimeMs: 900_001
  }));
});

test("fixed outputs reach one exact local review and yield only a safe attestation receipt", async () => {
  const value = manifest();
  const responses = [fixedResumeOutput, fixedCoverLetterOutput];
  const providerRequestBodies: string[] = [];
  let providerCalls = 0;
  let readyCalls = 0;
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async (_input, init) => {
      providerRequestBodies.push(String(init?.body));
      return providerResponse(responses[providerCalls++]);
    },
    now: () => new Date("2026-10-10T05:02:00.000Z"),
    async onReviewReady(review) {
      readyCalls += 1;
      const state = await fetch(review.stateUrl).then((response) => response.json()) as {
        envelopeHash: string;
        documents: Array<{ kind: "resume" | "cover_letter"; validatedOutputHash: string; renderedPdfHash: string }>;
      };
      for (const pdfUrl of review.pdfUrls) {
        const response = await fetch(pdfUrl);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }
      const response = await fetch(review.submissionUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(review.reviewUrl).origin },
        body: JSON.stringify({
          envelopeHash: state.envelopeHash,
          documents: state.documents.map((document, index) => ({
            kind: document.kind,
            validatedOutputHash: document.validatedOutputHash,
            renderedPdfHash: document.renderedPdfHash,
            disposition: index === 0 ? "approved" : "needs_revision",
            reason: index === 0 ? null : "tone",
            reviewedAllPages: true,
            reviewedWritingQuality: true,
            reviewedVisualLayout: true
          }))
        })
      });
      assert.equal(response.status, 200);
    }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(receipt.failureCode, null, JSON.stringify(receipt));
  assert.equal(providerCalls, 2);
  assert.equal(providerRequestBodies.length, 2);
  assert.doesNotMatch(
    providerRequestBodies.join("\n"),
    /expectedRecommendation|expectedBand|reviewDispositions/iu
  );
  assert.equal(readyCalls, 1);
  assert.equal(receipt.status, "needs_revision");
  assert.equal(receipt.providerCallsStarted, 2);
  assert.equal(receipt.reviewAttestation?.documents.length, 2);
  assert.equal(receipt.reviewAttestation?.documents[0].reviewedAllPages, true);
  assert.equal(receipt.reviewAttestation?.documents[1].reason, "tone");
  assert.equal(receipt.validatedDocumentPersistentRetention, false);
  assert.equal(receipt.rawProviderOutputRetained, false);
  assert.equal(receipt.safeReceiptOnly, true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(credential, "u"));
  assert.doesNotMatch(serialized, /professionalSummary|Dear Synthetic|Synthetic owner confirms/u);
  assert.doesNotMatch(serialized, /resumeText|coverLetter|claimEvidence|claimsUsed|pdfBytes/u);
});

test("startup and ready-callback failures overwrite every claimed PDF buffer", async () => {
  for (const failure of ["start", "ready"] as const) {
    const value = manifest();
    const responses = [fixedResumeOutput, fixedCoverLetterOutput];
    let providerCalls = 0;
    let pdfs: readonly Buffer[] = [];
    let closeCalled = false;
    const startReview = async (
      input: Parameters<typeof startCorrectionFlowDocumentOwnerReview>[0]
    ): Promise<Awaited<ReturnType<typeof startCorrectionFlowDocumentOwnerReview>>> => {
      pdfs = input.renderedPdfs.map((pdf) => pdf.bytes);
      if (failure === "start") throw new Error("synthetic start failure");
      let resolveClosed!: (value: { reason: "error" }) => void;
      const closed = new Promise<{ reason: "error" }>((resolve) => { resolveClosed = resolve; });
      return {
        origin: "http://127.0.0.1:43210",
        reviewUrl: "http://127.0.0.1:43210/review/token",
        stateUrl: "http://127.0.0.1:43210/api/state/token",
        submissionUrl: "http://127.0.0.1:43210/api/review/token",
        cancelUrl: "http://127.0.0.1:43210/api/cancel/token",
        pdfUrls: [
          "http://127.0.0.1:43210/artifacts/token/resume/hash.pdf",
          "http://127.0.0.1:43210/artifacts/token/cover-letter/hash.pdf"
        ] as const,
        finished: new Promise<never>(() => undefined),
        closed,
        close() {
          closeCalled = true;
          input.renderedPdfs.forEach((pdf) => pdf.bytes.fill(0));
          resolveClosed({ reason: "error" });
        },
        phase: () => "reviewing" as const,
        hasPrivateInput: () => true,
        deliveredPdfCount: () => 0
      } as Awaited<ReturnType<typeof startCorrectionFlowDocumentOwnerReview>>;
    };
    const runner = createCorrectionFlowDocumentReviewRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => providerResponse(responses[providerCalls++]),
      startReview,
      async onReviewReady() {
        throw new Error("synthetic stdout failure");
      }
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.failureCode, "OWNER_REVIEW_INCOMPLETE");
    assert.equal(providerCalls, 2);
    assert.equal(pdfs.length, 2);
    assert.equal(pdfs.every((pdf) => pdf.every((byte) => byte === 0)), true);
    assert.equal(closeCalled, failure === "ready");
  }
});

test("safe receipts distinguish owner cancellation and original review expiry", async () => {
  for (const mode of ["cancel", "expiry"] as const) {
    const value = manifest();
    let providerCalls = 0;
    let heldPdfs: readonly Buffer[] = [];
    const runner = createCorrectionFlowDocumentReviewRunner({
      manifest: value,
      consent: consentFor(value),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => providerResponse([fixedResumeOutput, fixedCoverLetterOutput][providerCalls++]),
      startReview: async (input) => {
        heldPdfs = input.renderedPdfs.map(pdf => pdf.bytes);
        return startCorrectionFlowDocumentOwnerReview({ ...input, sessionTimeoutMs: mode === "expiry" ? 30 : 5_000 });
      },
      async onReviewReady(review) {
        if (mode === "cancel") {
          const result = await fetch(review.cancelUrl, {method:"POST", headers:{origin:new URL(review.reviewUrl).origin}});
          assert.equal(result.status, 204);
        }
      }
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(receipt.failureCode, mode === "cancel" ? "OWNER_REVIEW_CANCELLED" : "OWNER_REVIEW_EXPIRED");
    assert.equal(receipt.reviewAttestation, null);
    assert.equal(providerCalls, 2);
    assert.equal(heldPdfs.every(pdf => pdf.every(byte => byte === 0)), true);
  }
});

test("cancellation during review startup closes the session before readiness and overwrites PDFs", async () => {
  const value = manifest();
  const responses = [fixedResumeOutput, fixedCoverLetterOutput];
  const controller = new AbortController();
  let providerCalls = 0;
  let readyCalls = 0;
  let pdfs: readonly Buffer[] = [];
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(responses[providerCalls++]),
    startReview(input) {
      pdfs = input.renderedPdfs.map((pdf) => pdf.bytes);
      const startup = startCorrectionFlowDocumentOwnerReview(input);
      controller.abort();
      return startup;
    },
    onReviewReady() { readyCalls += 1; }
  });
  const receipt = await runner.run(controller.signal);
  assert.equal(receipt.failureCode, "EXECUTION_CANCELLED");
  assert.equal(providerCalls, 2);
  assert.equal(readyCalls, 0);
  assert.equal(pdfs.length, 2);
  assert.equal(pdfs.every((pdf) => pdf.every((byte) => byte === 0)), true);
});

test("failure, cancellation, and invalid consent never start a later stage or expose documents", async () => {
  const value = manifest();
  assert.throws(() => createCorrectionFlowDocumentReviewRunner({
    manifest: value,
    consent: { ...consentFor(value), manifestHash: "0".repeat(64) },
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(fixedResumeOutput)
  }), /consent|manifest/iu);

  let calls = 0;
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value,
    consent: consentFor(value),
    payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => {
      calls += 1;
      return providerResponse({ invalid: "private-provider-output" });
    }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.reviewAttestation, null);
  assert.doesNotMatch(JSON.stringify(receipt), /private-provider-output/u);
});

test("the generation-to-bundle entry point cannot manufacture consent outside canonical v3", () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const diagnosticManifest = buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date("2026-10-10T05:00:00.000Z"),
    payload,
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  });
  const manufacturedAuthorizationAttempt = {
    manifest: diagnosticManifest,
    authorization: {
      contractVersion: "2",
      manifestHash: "0".repeat(64),
      exactHead,
      payloadHash: diagnosticManifest.payloadHash,
      reviewedEvidenceHash: diagnosticManifest.reviewedEvidenceHash,
      factCatalogHash: diagnosticManifest.factCatalogHash,
      promptVersion: diagnosticManifest.calls[0].promptVersion,
      model: diagnosticManifest.calls[0].model,
      thinkingLevel: diagnosticManifest.calls[0].thinkingLevel,
      generationId: "fabricated-generation",
      rawProviderOutputRetention: false,
      validatedDocumentPersistentRetention: false,
      validatedDocumentLocalDisplay: true,
      safeReceiptOnly: true,
      approvedAt: "2026-10-10T05:01:00.000Z"
    },
    payload,
    credentials: { geminiApiKey: credential },
    fetchImpl: async () => providerResponse(fixedResumeOutput)
  };
  assert.throws(() => createCorrectionFlowDocumentReviewGenerationRunner(
    manufacturedAuthorizationAttempt as unknown as Parameters<
      typeof createCorrectionFlowDocumentReviewGenerationRunner
    >[0]
  ), /canonical v3|consent/iu);
});


test("obsolete or altered rendering manifests stop before mocked provider dispatch", () => {
  const current = manifest();
  let dispatches = 0;
  for (const changed of [
    { ...current, contractVersion: "2" },
    { ...current, rendering: { ...current.rendering, layoutVersion: "2" } },
    { ...current, rendering: { ...current.rendering, layoutVersion: "3" } },
    { ...current, rendering: { ...current.rendering, resumeFormat: { ...current.rendering.resumeFormat, fontSize: 10 } } }
  ]) {
    assert.throws(() => createCorrectionFlowDocumentReviewRunner({
      manifest: changed as typeof current,
      consent: consentFor(current),
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => { dispatches += 1; return providerResponse(fixedResumeOutput); }
    }), /manifest/i);
  }
  assert.equal(dispatches, 0);
});

test("a rejected generated claim emits bounded server-resolved fact and provider origin without prose", async () => {
  const value = manifest();
  const wire = structuredClone(fixedResumeOutput);
  const header = "Contoso Service Systems | Senior Service Operations Manager | Remote | 2021–Present";
  wire.resumeText = wire.resumeText.replace(header, header.replace("Contoso Service Systems", "Invented Employer"));
  wire.resumeTextClaims.find(item => item.claim === header)!.claim = header.replace("Contoso Service Systems", "Invented Employer");
  wire.resumeTextClaims.reverse();
  const originIndex = wire.resumeTextClaims.findIndex(item => item.claim.includes("Invented Employer"));
  let calls = 0;
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value, consent: consentFor(value), payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential }, fetchImpl: async () => { calls += 1; return providerResponse(wire); },
    startReview: async () => { throw new Error("A rejected resume must never start review."); }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(receipt.failureFieldPath, "output.claimEvidence[32].claim");
  assert.deepEqual((receipt as unknown as { failureClaimSource?: unknown }).failureClaimSource, {
    factId: wire.resumeTextClaims[originIndex].factId,
    originFieldPath: `resumeTextClaims[${originIndex}].claim`,
    reason: "ordered_token_mismatch"
  });
  assert.doesNotMatch(JSON.stringify(receipt), /Invented Employer|Contoso Service Systems|Senior Service|"claim":|"excerpt":|"resumeText":/u);
  assert.equal(receipt.reviewAttestation, null);
});

test("exact generated bullet evidence traverses transport, validation and exports before review", async () => {
  for (const glyph of ["-", "*", "•", "▪", "◦", "–", "—"]) {
    const value = manifest();
    const wire = structuredClone(fixedResumeOutput);
    wire.resumeText = wire.resumeText.replace(/^[-*•▪◦–—]\s+/gmu, `${glyph} `);
    const lines = wire.resumeText.split("\n");
    for (const item of wire.resumeTextClaims) {
      const generatedBullet = lines.find(line => /^[-*•▪◦–—]\s+/u.test(line.trim()) && line.trim().slice(2) === item.claim);
      if (generatedBullet) item.claim = generatedBullet;
    }
    assert.ok(wire.resumeTextClaims.some(item => item.claim.startsWith(`${glyph} `)));
    let calls = 0;
    let reviews = 0;
    const pdfs: Buffer[] = [];
    const runner = createCorrectionFlowDocumentReviewRunner({
      manifest: value, consent: consentFor(value), payload: syntheticCorrectionFlowDocumentPayload(),
      credentials: { geminiApiKey: credential },
      fetchImpl: async () => providerResponse([wire, fixedCoverLetterOutput][calls++]),
      startReview: async (input) => {
        reviews += 1;
        pdfs.push(...input.renderedPdfs.map(pdf => pdf.bytes));
        throw new Error("Synthetic review startup probe; no listening socket.");
      }
    });
    const receipt = await runner.run(new AbortController().signal);
    assert.equal(calls, 2, JSON.stringify(receipt));
    assert.equal(reviews, 1, `${glyph}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.failureStage, "owner_review");
    assert.equal(receipt.failureCode, "OWNER_REVIEW_INCOMPLETE");
    assert.equal(pdfs.length, 2);
    assert.ok(pdfs.every(pdf => pdf.every(byte => byte === 0)));
  }
});

test("absent resume evidence stops once with a known fact and original provider path before assembly completes", async () => {
  const value = manifest();
  const wire = structuredClone(fixedResumeOutput);
  const item = wire.resumeTextClaims.pop()!;
  item.claim = "Invented provider-only achievement absent from the generated resume.";
  wire.resumeTextClaims.splice(3, 0, item);
  let calls = 0;
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value, consent: consentFor(value), payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential }, fetchImpl: async () => { calls += 1; return providerResponse(wire); },
    startReview: async () => { throw new Error("Absent evidence must never start review."); }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(receipt.failureCode, "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT");
  assert.equal(receipt.failureFieldPath, "output.resumeTextClaims[3].claim");
  assert.deepEqual(receipt.failureClaimSource, {
    factId: item.factId, originFieldPath: "resumeTextClaims[3].claim", reason: "not_in_output"
  });
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.equal(receipt.envelopeHash, null);
  assert.equal(receipt.reviewAttestation, null);
  assert.doesNotMatch(JSON.stringify(receipt), /Invented provider-only|"claim":|"excerpt":|"resumeText":/u);
});

test("an unknown selected fact cannot gain assembly-failure provenance", async () => {
  const value = manifest();
  const wire = structuredClone(fixedResumeOutput);
  wire.resumeTextClaims[3] = { claim: "Absent private provider prose.", factId: "fact:9999" };
  let calls = 0;
  const runner = createCorrectionFlowDocumentReviewRunner({
    manifest: value, consent: consentFor(value), payload: syntheticCorrectionFlowDocumentPayload(),
    credentials: { geminiApiKey: credential }, fetchImpl: async () => { calls += 1; return providerResponse(wire); }
  });
  const receipt = await runner.run(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(receipt.failureCode, "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID");
  assert.equal(receipt.failureFieldPath, "output.resumeTextClaims[3].factId");
  assert.equal(receipt.failureClaimSource, null);
  assert.doesNotMatch(JSON.stringify(receipt), /fact:9999|Absent private/u);
});
