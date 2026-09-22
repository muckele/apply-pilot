import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import {
  createApplicationRunDocumentExportRouteHandlers
} from "@/app/api/application-runs/[id]/answers/[answerId]/document-export/route";
import { PublicApiError } from "@/lib/api-errors";
import { UnauthorizedError } from "@/lib/user-context";

const USER_ID = "user-1";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const ANSWER_ID = "clz8w7m9a0005qwer1234tyui";
const PACKET_HASH = "d".repeat(64);
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedStateVersion: 7,
    answerPacketVersion: 4,
    packetHash: PACKET_HASH,
    format: "docx",
    ...overrides
  };
}

function request(body: unknown, contentType = "application/json"): NextRequest {
  return new NextRequest(
    `http://localhost/api/application-runs/${RUN_ID}/answers/${ANSWER_ID}/document-export`,
    {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify(body)
    }
  );
}

function rawRequest(body: string, contentType?: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/application-runs/${RUN_ID}/answers/${ANSWER_ID}/document-export`,
    {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      body
    }
  );
}

function context(id = RUN_ID, answerId = ANSWER_ID) {
  return { params: Promise.resolve({ id, answerId }) };
}

function route(options: {
  requireUserId?: () => Promise<string>;
  checkRateLimit?: (key: string, limit?: number, windowMs?: number) => Promise<void>;
  exportResult?: {
    bytes: Buffer;
    artifactType: "RESUME" | "COVER_LETTER";
    format: "docx";
    contentType: typeof DOCX_TYPE;
    filename: "apply-pilot-resume.docx" | "apply-pilot-cover-letter.docx";
  };
  exportError?: Error;
} = {}) {
  const calls = {
    rate: [] as Array<[string, number, number]>,
    service: [] as unknown[]
  };
  const handlers = createApplicationRunDocumentExportRouteHandlers({
    requireUserId: options.requireUserId ?? (async () => USER_ID),
    checkRateLimit: options.checkRateLimit ?? (async (key, limit, windowMs) => {
      calls.rate.push([key, limit ?? Number.NaN, windowMs ?? Number.NaN]);
    }),
    exportApprovedApplicationRunDocument: async (input) => {
      calls.service.push(input);
      if (options.exportError) throw options.exportError;
      return options.exportResult ?? {
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x52]),
        artifactType: "RESUME",
        format: "docx",
        contentType: DOCX_TYPE,
        filename: "apply-pilot-resume.docx"
      };
    }
  });
  return { handlers, calls };
}

test("unauthenticated document export is no-store and dispatches nothing else", async () => {
  const { handlers, calls } = route({
    requireUserId: async () => {
      throw new UnauthorizedError();
    }
  });

  const response = await handlers.POST(request(validBody()), context());

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.rate, []);
  assert.deepEqual(calls.service, []);
});

test("invalid run and answer CUIDs fail before rate limiting or body/service work", async (t) => {
  for (const [label, routeContext] of [
    ["run", context("not-a-cuid", ANSWER_ID)],
    ["answer", context(RUN_ID, "not-a-cuid")]
  ] as const) {
    await t.test(label, async () => {
      const { handlers, calls } = route();
      const response = await handlers.POST(request(validBody()), routeContext);
      assert.equal(response.status, 422);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(calls.rate, []);
      assert.deepEqual(calls.service, []);
    });
  }
});

test("malformed JSON is rejected after the authenticated document-export rate charge", async () => {
  const { handlers, calls } = route();

  const response = await handlers.POST(rawRequest("{"), context());

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.rate, [[`application-runs:document-export:${USER_ID}`, 30, 60_000]]);
  assert.deepEqual(calls.service, []);
});

test("strict four-field body rejects missing, wrong, unknown, unsafe, hash, and format inputs", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["missing expectedStateVersion", {
      answerPacketVersion: 4,
      packetHash: PACKET_HASH,
      format: "docx"
    }],
    ["wrong expectedStateVersion type", validBody({ expectedStateVersion: "7" })],
    ["unknown documentId", validBody({ documentId: "caller-controlled" })],
    ["negative expectedStateVersion", validBody({ expectedStateVersion: -1 })],
    ["fractional expectedStateVersion", validBody({ expectedStateVersion: 1.5 })],
    ["unsafe expectedStateVersion", validBody({ expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 })],
    ["zero answerPacketVersion", validBody({ answerPacketVersion: 0 })],
    ["negative answerPacketVersion", validBody({ answerPacketVersion: -1 })],
    ["fractional answerPacketVersion", validBody({ answerPacketVersion: 2.5 })],
    ["unsafe answerPacketVersion", validBody({ answerPacketVersion: Number.MAX_SAFE_INTEGER + 1 })],
    ["uppercase packet hash", validBody({ packetHash: "A".repeat(64) })],
    ["short packet hash", validBody({ packetHash: "a".repeat(63) })],
    ["PDF format", validBody({ format: "pdf" })],
    ["wrong format type", validBody({ format: 1 })]
  ];
  for (const [label, body] of cases) {
    await t.test(label, async () => {
      const { handlers, calls } = route();
      const response = await handlers.POST(request(body), context());
      assert.equal(response.status, 422);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(calls.rate, [[`application-runs:document-export:${USER_ID}`, 30, 60_000]]);
      assert.deepEqual(calls.service, []);
    });
  }
});

test("valid JSON under text/plain is accepted without an independent media-type gate", async () => {
  const { handlers, calls } = route();

  const response = await handlers.POST(request(validBody(), "text/plain"), context());

  assert.equal(response.status, 200);
  assert.equal(calls.service.length, 1);
});

test("rate-limit failure prevents body parsing and service dispatch", async () => {
  const { handlers, calls } = route({
    checkRateLimit: async (key, limit, windowMs) => {
      calls.rate.push([key, limit ?? Number.NaN, windowMs ?? Number.NaN]);
      throw new PublicApiError("Too many requests.", 429);
    }
  });

  const response = await handlers.POST(rawRequest("{"), context());

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.rate, [[`application-runs:document-export:${USER_ID}`, 30, 60_000]]);
  assert.deepEqual(calls.service, []);
});

test("valid route dispatches the exact authenticated run-bound authority input", async () => {
  const { handlers, calls } = route();

  await handlers.POST(request(validBody()), context());

  assert.deepEqual(calls.service, [{
    userId: USER_ID,
    runId: RUN_ID,
    answerId: ANSWER_ID,
    expectedStateVersion: 7,
    answerPacketVersion: 4,
    packetHash: PACKET_HASH,
    format: "docx"
  }]);
});

test("resume success returns only raw DOCX bytes and exact private attachment headers", async () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x52, 0x00, 0xff]);
  const { handlers } = route({
    exportResult: {
      bytes,
      artifactType: "RESUME",
      format: "docx",
      contentType: DOCX_TYPE,
      filename: "apply-pilot-resume.docx"
    }
  });

  const response = await handlers.POST(request(validBody()), context());

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), DOCX_TYPE);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="apply-pilot-resume.docx"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("authorization"), null);
});

test("cover-letter success uses the exact fixed cover-letter filename", async () => {
  const { handlers } = route({
    exportResult: {
      bytes: Buffer.from("cover-docx"),
      artifactType: "COVER_LETTER",
      format: "docx",
      contentType: DOCX_TYPE,
      filename: "apply-pilot-cover-letter.docx"
    }
  });

  const response = await handlers.POST(request(validBody()), context());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="apply-pilot-cover-letter.docx"');
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("service domain and renderer failures retain stable codes and no-store", async (t) => {
  for (const [code, status] of [
    ["RUN_DOCUMENT_STALE", 409],
    ["RUN_DOCUMENT_RENDER_FAILED", 500]
  ] as const) {
    await t.test(code, async () => {
      const { handlers } = route({
        exportError: new PublicApiError("Safe document export failure.", status, { code })
      });
      const response = await handlers.POST(request(validBody()), context());
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Safe document export failure.", code });
    });
  }
});
