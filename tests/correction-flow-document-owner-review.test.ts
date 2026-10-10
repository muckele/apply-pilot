import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { buildCorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { startCorrectionFlowDocumentOwnerReview } from "@/lib/ai/correction-flow-document-owner-review";

const hash = (character: string) => character.repeat(64);

function fixture() {
  const envelope = buildCorrectionFlowDocumentReviewEnvelope({
    manifestHash: hash("1"), exactHead: "a".repeat(40), payloadHash: hash("2"),
    sourceResumeHash: hash("3"), profileHash: hash("4"), jobProjectionHash: hash("5"),
    reviewedEvidenceHash: hash("6"), factCatalogHash: hash("7"), promptVersion: "7",
    model: "gemini-3.8-flash", thinkingLevel: "LOW", generationId: "generation-owner-review",
    documents: [
      { kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: hash("9") },
      { kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: hash("b") }
    ]
  });
  const resumePdf = Buffer.from("%PDF-1.4\nsynthetic resume pdf");
  const coverPdf = Buffer.from("%PDF-1.4\nsynthetic cover letter pdf");
  return {
    envelope,
    documents: [
      {
        kind: "resume" as const,
        title: "Synthetic tailored resume",
        text: "Taylor Boundary\nSUMMARY\nSynthetic resume fact.",
        evidence: [{ claim: "Synthetic resume fact.", citations: [{ ref: "resume.summary", excerpt: "Synthetic source fact." }] }]
      },
      {
        kind: "cover_letter" as const,
        title: "Synthetic cover letter",
        text: "Dear Synthetic Employer,\n\nSynthetic cover-letter fact.",
        evidence: [{ claim: "Synthetic cover-letter fact.", citations: [{ ref: "resume.summary", excerpt: "Synthetic source fact." }] }]
      }
    ] as const,
    renderedPdfs: [
      { kind: "resume" as const, bytes: resumePdf },
      { kind: "cover_letter" as const, bytes: coverPdf }
    ] as const,
    resumePdf,
    coverPdf
  };
}

function submission(envelopeHash: string) {
  return {
    envelopeHash,
    documents: [
      {
        kind: "resume", validatedOutputHash: hash("8"), renderedPdfHash: hash("9"),
        disposition: "approved", reason: null, reviewedAllPages: true,
        reviewedWritingQuality: true, reviewedVisualLayout: true
      },
      {
        kind: "cover_letter", validatedOutputHash: hash("a"), renderedPdfHash: hash("b"),
        disposition: "needs_revision", reason: "tone", reviewedAllPages: true,
        reviewedWritingQuality: true, reviewedVisualLayout: true
      }
    ]
  };
}

async function rawRequest(url: string, options: {
  method?: string;
  host?: string;
  origin?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}) {
  const parsed = new URL(url);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: options.method ?? "GET",
      headers: {
        host: options.host ?? parsed.host,
        ...(options.origin ? { origin: options.origin } : {}),
        ...options.headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

test("the loopback review serves only tokenized no-store state, assets, and exact inline PDFs", async (t) => {
  const input = fixture();
  const review = await startCorrectionFlowDocumentOwnerReview({
    envelope: input.envelope,
    documents: input.documents,
    renderedPdfs: input.renderedPdfs,
    now: () => new Date("2026-10-10T04:10:00.000Z")
  });
  t.after(() => review.close("test_cleanup"));
  assert.match(review.reviewUrl, /^http:\/\/127\.0\.0\.1:\d+\/review\/[A-Za-z0-9_-]{43}$/u);
  assert.equal(review.phase(), "reviewing");
  assert.equal(review.hasPrivateInput(), true);

  const page = await fetch(review.reviewUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-src 'self'/u);
  assert.match(await page.text(), /Synthetic local review only/u);

  const state = await fetch(review.stateUrl);
  const stateBody = await state.json() as { envelopeHash: string; documents: Array<{ title: string }> };
  assert.equal(state.status, 200);
  assert.equal(stateBody.envelopeHash, input.envelope.envelopeHash);
  assert.deepEqual(stateBody.documents.map((document) => document.title), [
    "Synthetic tailored resume", "Synthetic cover letter"
  ]);

  for (const pdfUrl of review.pdfUrls) {
    const pdf = await fetch(pdfUrl);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.headers.get("content-disposition"), "inline");
    assert.equal(pdf.headers.get("cache-control"), "private, no-store");
    assert.equal(pdf.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(Buffer.from(await pdf.arrayBuffer()).toString("utf8"), /^%PDF-1\.4/u);
  }
  assert.equal(review.deliveredPdfCount(), 2);

  assert.equal((await rawRequest(review.reviewUrl, { host: "evil.example" })).status, 400);
  assert.equal((await fetch(`${review.origin}/review/guessed`)).status, 404);
  assert.equal((await rawRequest(review.pdfUrls[0], { headers: { range: "bytes=0-4" } })).status, 416);
});

test("submission requires both delivered exact PDFs, exact origin, and all bounded attestations", async () => {
  const input = fixture();
  const review = await startCorrectionFlowDocumentOwnerReview({
    envelope: input.envelope,
    documents: input.documents,
    renderedPdfs: input.renderedPdfs,
    now: () => new Date("2026-10-10T04:10:00.000Z")
  });
  const request = (body: unknown, origin = review.origin) => rawRequest(review.submissionUrl, {
    method: "POST",
    origin,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal((await request(submission(input.envelope.envelopeHash))).status, 400);
  await fetch(review.pdfUrls[0]).then((response) => response.arrayBuffer());
  await fetch(review.pdfUrls[1]).then((response) => response.arrayBuffer());
  assert.equal((await request(submission(input.envelope.envelopeHash), "http://wrong.example")).status, 403);
  assert.equal((await request({
    ...submission(input.envelope.envelopeHash),
    documents: [
      { ...submission(input.envelope.envelopeHash).documents[0], reviewedVisualLayout: false },
      submission(input.envelope.envelopeHash).documents[1]
    ]
  })).status, 400);

  const response = await request(submission(input.envelope.envelopeHash));
  assert.equal(response.status, 200);
  const receipt = JSON.parse(response.body) as {
    attestation: { reviewEnvelopeHash: string; attestationHash: string; documents: unknown[] };
  };
  assert.equal(receipt.attestation.reviewEnvelopeHash, input.envelope.envelopeHash);
  assert.equal(receipt.attestation.documents.length, 2);
  const completed = await review.finished;
  assert.equal(completed.attestationHash, receipt.attestation.attestationHash);
  await review.closed;
  assert.equal(review.phase(), "closed");
  assert.equal(review.hasPrivateInput(), false);
  assert.equal(input.resumePdf.every((byte) => byte === 0), true);
  assert.equal(input.coverPdf.every((byte) => byte === 0), true);
  assert.doesNotMatch(response.body, /Synthetic resume fact|Synthetic source fact|Dear Synthetic/u);
});

test("cancellation and timeout close once, reject completion, and clear all held material", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const input = fixture();
    const review = await startCorrectionFlowDocumentOwnerReview({
      envelope: input.envelope,
      documents: input.documents,
      renderedPdfs: input.renderedPdfs,
      sessionTimeoutMs: mode === "timeout" ? 20 : 1_000,
      now: () => new Date("2026-10-10T04:10:00.000Z")
    });
    if (mode === "cancel") {
      const cancelled = await rawRequest(review.cancelUrl, {
        method: "POST",
        origin: review.origin,
        headers: { "content-type": "text/plain" },
        body: ""
      });
      assert.equal(cancelled.status, 204);
    }
    const closed = await review.closed;
    assert.equal(closed.reason, mode === "cancel" ? "owner_cancel" : "session_timeout");
    await assert.rejects(review.finished, /closed/u);
    assert.equal(review.hasPrivateInput(), false);
    assert.equal(input.resumePdf.every((byte) => byte === 0), true);
    assert.equal(input.coverPdf.every((byte) => byte === 0), true);
    review.close("repeat_close");
  }
});

test("a partial submission body is destroyed when the owner closes the review", async () => {
  const input = fixture();
  const review = await startCorrectionFlowDocumentOwnerReview({
    envelope: input.envelope,
    documents: input.documents,
    renderedPdfs: input.renderedPdfs
  });
  const url = new URL(review.submissionUrl);
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      host: url.host,
      origin: review.origin,
      "content-type": "application/json",
      "content-length": "1000"
    }
  });
  const settled = new Promise<void>((resolve) => {
    request.on("error", () => resolve());
    request.on("close", () => resolve());
  });
  request.write("{");
  await new Promise((resolve) => setTimeout(resolve, 10));
  review.close("owner_close");
  await settled;
  await review.closed;
  assert.equal(review.hasPrivateInput(), false);
});
