import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  assertApplicationJsonContentType,
  readBoundedApplicationRunPacketJson,
  toPublicApplicationRunAnswerPacket
} from "@/lib/application-runs/answer-packet-api";
import { MAX_FUTURE_RAW_HTTP_BODY_BYTES } from "@/lib/application-runs/form-inspection";

function assertPublicError(
  error: unknown,
  expected: { status: number; code: string; message?: string }
): boolean {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, expected.status);
  assert.equal(error.details?.code, expected.code);
  if (expected.message) assert.equal(error.message, expected.message);
  return true;
}

function byteRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  hooks: { onPull?: () => void; onCancel?: () => void } = {}
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      hooks.onCancel?.();
    }
  });
  return new Request("http://localhost/api/application-runs/run/packet", {
    method: "POST",
    headers,
    body,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

test("F4 POST media type accepts JSON variants and rejects missing or unsupported types", () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON; Charset=UTF-8"]) {
    assert.doesNotThrow(() => assertApplicationJsonContentType(new Request("http://localhost", {
      headers: { "Content-Type": contentType }
    })));
  }

  for (const contentType of [undefined, "text/plain", "multipart/form-data", "application/octet-stream", "text/html"]) {
    const request = new Request("http://localhost", {
      headers: contentType ? { "Content-Type": contentType } : undefined
    });
    assert.throws(
      () => assertApplicationJsonContentType(request),
      (error: unknown) => assertPublicError(error, {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json."
      }),
      contentType
    );
  }
});

test("bounded reader parses valid streamed JSON with missing or acceptable Content-Length", async () => {
  const expected = { message: "résumé", nested: { ok: true } };
  const bytes = jsonBytes(expected);
  const split = Math.floor(bytes.byteLength / 2);

  assert.deepEqual(
    await readBoundedApplicationRunPacketJson(byteRequest([bytes.slice(0, split), bytes.slice(split)])),
    expected
  );
  assert.deepEqual(
    await readBoundedApplicationRunPacketJson(byteRequest([bytes], { "Content-Length": String(bytes.byteLength) })),
    expected
  );
});

test("bounded reader accepts an exact-limit JSON body and counts multibyte UTF-8 bytes", async () => {
  const exactJson = JSON.stringify("x".repeat(MAX_FUTURE_RAW_HTTP_BODY_BYTES - 2));
  assert.equal(new TextEncoder().encode(exactJson).byteLength, MAX_FUTURE_RAW_HTTP_BODY_BYTES);
  assert.equal(
    await readBoundedApplicationRunPacketJson(byteRequest([new TextEncoder().encode(exactJson)])),
    "x".repeat(MAX_FUTURE_RAW_HTTP_BODY_BYTES - 2)
  );

  const multibyte = JSON.stringify("é".repeat(Math.floor(MAX_FUTURE_RAW_HTTP_BODY_BYTES / 2)));
  assert.ok(multibyte.length <= MAX_FUTURE_RAW_HTTP_BODY_BYTES);
  assert.ok(new TextEncoder().encode(multibyte).byteLength > MAX_FUTURE_RAW_HTTP_BODY_BYTES);
  await assert.rejects(
    readBoundedApplicationRunPacketJson(byteRequest([new TextEncoder().encode(multibyte)])),
    (error: unknown) => assertPublicError(error, { status: 413, code: "REQUEST_BODY_TOO_LARGE" })
  );
});

test("declared overflow rejects before pulling the stream and malformed lengths are stable", async () => {
  let pulls = 0;
  const declaredOverflowRequest = byteRequest(
    [jsonBytes({ ok: true })],
    { "Content-Length": String(MAX_FUTURE_RAW_HTTP_BODY_BYTES + 1) },
    { onPull: () => { pulls += 1; } }
  );
  await Promise.resolve();
  const pullsBeforeRead = pulls;
  await assert.rejects(
    readBoundedApplicationRunPacketJson(declaredOverflowRequest),
    (error: unknown) => assertPublicError(error, { status: 413, code: "REQUEST_BODY_TOO_LARGE" })
  );
  assert.equal(pulls, pullsBeforeRead);

  for (const contentLength of ["-1", "1.5", "abc", "1, 2"]) {
    await assert.rejects(
      readBoundedApplicationRunPacketJson(byteRequest([jsonBytes({ ok: true })], {
        "Content-Length": contentLength
      })),
      (error: unknown) => assertPublicError(error, { status: 400, code: "INVALID_CONTENT_LENGTH" }),
      contentLength
    );
  }

  await assert.rejects(
    readBoundedApplicationRunPacketJson(byteRequest([jsonBytes({ ok: true })], {
      "Content-Length": "9".repeat(400)
    })),
    (error: unknown) => assertPublicError(error, { status: 413, code: "REQUEST_BODY_TOO_LARGE" })
  );
});

test("actual streamed overflow cancels the reader and preserves the authoritative 413", async () => {
  let cancelled = false;
  const oversized = new Uint8Array(MAX_FUTURE_RAW_HTTP_BODY_BYTES + 1);
  await assert.rejects(
    readBoundedApplicationRunPacketJson(byteRequest([oversized], { "Content-Length": "1" }, {
      onCancel: () => { cancelled = true; }
    })),
    (error: unknown) => assertPublicError(error, {
      status: 413,
      code: "REQUEST_BODY_TOO_LARGE",
      message: "The request body is too large."
    })
  );
  assert.equal(cancelled, true);
});

test("malformed UTF-8 and JSON return stable INVALID_JSON without parser or body excerpts", async () => {
  const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
  await assert.rejects(
    readBoundedApplicationRunPacketJson(byteRequest([invalidUtf8])),
    (error: unknown) => assertPublicError(error, {
      status: 400,
      code: "INVALID_JSON",
      message: "The request body must contain valid JSON."
    })
  );

  const malformed = new TextEncoder().encode('{"private-question":"do not leak",}');
  await assert.rejects(
    readBoundedApplicationRunPacketJson(byteRequest([malformed])),
    (error: unknown) => {
      assertPublicError(error, {
        status: 400,
        code: "INVALID_JSON",
        message: "The request body must contain valid JSON."
      });
      assert.equal((error as Error).message.includes("private-question"), false);
      assert.equal((error as Error).message.includes("position"), false);
      return true;
    }
  );
});

test("unexpected stream failures return stable INVALID_REQUEST_BODY", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("raw stream secret"));
    }
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body,
    duplex: "half"
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedApplicationRunPacketJson(request),
    (error: unknown) => assertPublicError(error, {
      status: 400,
      code: "INVALID_REQUEST_BODY",
      message: "The request body could not be read."
    })
  );
});

test("public packet mapper explicitly copies owner fields and omits provenance and document hashes", () => {
  const createdAt = new Date("2026-08-26T20:00:00.000Z");
  const reviewedAt = new Date("2026-08-26T21:00:00.000Z");
  const optionKeys = ["a".repeat(64)];
  const choices = [{ key: optionKeys[0], label: "Yes", disabled: false }];
  const internal = {
    inspectionVersion: 2,
    packetVersion: 3,
    packetHash: "b".repeat(64),
    reviewedAt,
    createdAt,
    summary: {
      fieldCount: 4,
      proposableCount: 4,
      pendingReviewCount: 1,
      approvedCount: 2,
      rejectedCount: 1,
      manualOnlyCount: 0,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [
      {
        id: "answer-scalar",
        normalizedFieldKey: "1".repeat(64),
        originalQuestion: "Portfolio URL",
        normalizedQuestion: "portfolio url",
        semanticFieldKey: "professional.portfolio",
        fieldFingerprint: "2".repeat(64),
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "SCALAR", value: "https://example.com" },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null,
        sourceType: "ANSWER_VAULT",
        sourceIds: ["source-1"],
        evidenceIds: [],
        sourceFingerprint: "3".repeat(64),
        confidence: 100,
        finalValueHash: null,
        reviewHashVersion: null,
        proposedValue: null
      },
      {
        id: "answer-boolean",
        normalizedFieldKey: "4".repeat(64),
        originalQuestion: "Agree?",
        normalizedQuestion: "agree",
        semanticFieldKey: null,
        fieldFingerprint: "5".repeat(64),
        fieldType: "CHECKBOX_BOOLEAN",
        classification: "OTHER",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "BOOLEAN", value: true },
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt
      },
      {
        id: "answer-options",
        normalizedFieldKey: "6".repeat(64),
        originalQuestion: "Select one",
        normalizedQuestion: "select one",
        semanticFieldKey: null,
        fieldFingerprint: "7".repeat(64),
        fieldType: "SELECT_ONE",
        classification: "OTHER",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices,
        proposal: { kind: "OPTIONS", optionKeys },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "REJECTED",
        reviewedByUser: true,
        reviewedAt
      },
      {
        id: "answer-document",
        normalizedFieldKey: "8".repeat(64),
        originalQuestion: "Upload résumé",
        normalizedQuestion: "upload résumé",
        semanticFieldKey: "document.resume",
        fieldFingerprint: "9".repeat(64),
        fieldType: "FILE_UPLOAD",
        classification: "DOCUMENT",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: {
          kind: "DOCUMENT_REFERENCE",
          artifactType: "RESUME",
          documentId: "resume-version-1",
          contentHash: "c".repeat(64)
        },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt
      }
    ],
    policyHash: "d".repeat(64),
    inputHash: "e".repeat(64),
    normalizedSnapshot: { raw: true },
    targetUrl: "https://jobs.example.com/apply",
    userId: "user-1",
    token: "secret",
    auditMetadata: { hidden: true }
  };

  const dto = toPublicApplicationRunAnswerPacket(internal as never);

  assert.deepEqual(dto, {
    inspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: "b".repeat(64),
    reviewedAt: reviewedAt.toISOString(),
    createdAt: createdAt.toISOString(),
    summary: internal.summary,
    answers: [
      {
        id: "answer-scalar",
        normalizedFieldKey: "1".repeat(64),
        question: "Portfolio URL",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "SCALAR", value: "https://example.com" },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      },
      {
        id: "answer-boolean",
        normalizedFieldKey: "4".repeat(64),
        question: "Agree?",
        fieldType: "CHECKBOX_BOOLEAN",
        classification: "OTHER",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "BOOLEAN", value: true },
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: reviewedAt.toISOString()
      },
      {
        id: "answer-options",
        normalizedFieldKey: "6".repeat(64),
        question: "Select one",
        fieldType: "SELECT_ONE",
        classification: "OTHER",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [{ key: optionKeys[0], label: "Yes", disabled: false }],
        proposal: { kind: "OPTIONS", optionKeys: [optionKeys[0]] },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "REJECTED",
        reviewedByUser: true,
        reviewedAt: reviewedAt.toISOString()
      },
      {
        id: "answer-document",
        normalizedFieldKey: "8".repeat(64),
        question: "Upload résumé",
        fieldType: "FILE_UPLOAD",
        classification: "DOCUMENT",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: {
          kind: "DOCUMENT_REFERENCE",
          artifactType: "RESUME",
          documentId: "resume-version-1"
        },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: reviewedAt.toISOString()
      }
    ]
  });
  assert.equal("contentHash" in dto.answers[3].proposal!, false);
  assert.equal("sourceIds" in dto.answers[0], false);
  assert.equal("normalizedQuestion" in dto.answers[0], false);
  assert.equal("policyHash" in dto, false);

  dto.summary.fieldCount = 99;
  dto.answers[2].choices[0].label = "Changed";
  if (dto.answers[2].proposal?.kind === "OPTIONS") dto.answers[2].proposal.optionKeys[0] = "f".repeat(64);
  assert.equal(internal.summary.fieldCount, 4);
  assert.equal(choices[0].label, "Yes");
  assert.equal(optionKeys[0], "a".repeat(64));
});
