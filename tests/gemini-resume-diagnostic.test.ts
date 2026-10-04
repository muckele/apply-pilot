import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import {
  buildPinnedGeminiResumeDiagnosticRequest,
  runPinnedGeminiResumeDiagnostic
} from "@/lib/ai/gemini-resume-diagnostic";
import { MODEL_PRICING_REGISTRY } from "@/lib/ai/pricing";
import * as resumeModule from "@/lib/ai/resume";
import { RESUME_PARSE_RESPONSE_JSON_SCHEMA } from "@/lib/ai/resume";
import { resumeParsePrompt } from "@/prompts/resumeParsePrompt";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";

const EXPECTED_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const EXPECTED_SOURCE_HASH = "93c706c5e3cec091218647f027fa1c63cccf48ec6240f74615747fcdd303cf06";
const EXPECTED_REQUEST_HASH = "0b2ad8f4387cadf8a85d82a6547fd2d9b32c7bcac12d751bcf68e9514b98e8d0";
const EXPECTED_SCHEMA_HASH = "d3add80f52de8af6944abb6e44f9de048490d1484b463de9c4dad0713e572db7";
const EXPECTED_RESPONSE_LIMIT_BYTES = 65_536;
const HOSTED_RUNTIME_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "VERCEL_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE"
] as const;

async function withLocalRuntime<T>(operation: () => Promise<T>) {
  const previous = new Map(HOSTED_RUNTIME_KEYS.map((key) => [key, process.env[key]]));
  HOSTED_RUNTIME_KEYS.forEach((key) => delete process.env[key]);
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runLocalPinnedDiagnostic(
  apiKey: string,
  options: { fetchImpl?: typeof fetch } = {}
) {
  return withLocalRuntime(() => runPinnedGeminiResumeDiagnostic(apiKey, {
    ...options,
    resumeText: fullSizeSyntheticDocxExtractedText
  } as Parameters<typeof runPinnedGeminiResumeDiagnostic>[1]));
}

test("builds only the approved pinned full-synthetic Gemini request", async () => {
  const request = buildPinnedGeminiResumeDiagnosticRequest(fullSizeSyntheticDocxExtractedText);
  assert.equal(request.endpoint, EXPECTED_ENDPOINT);
  assert.equal(request.timeoutMs, 180_000);
  assert.equal(request.maximumCostMicros, 63_600);
  assert.equal(request.responseBodyLimitBytes, EXPECTED_RESPONSE_LIMIT_BYTES);
  assert.equal(request.sourceHash, EXPECTED_SOURCE_HASH);
  assert.equal(request.requestHash, EXPECTED_REQUEST_HASH);
  assert.equal(request.schemaHash, EXPECTED_SCHEMA_HASH);

  const body = JSON.parse(request.bodyJson);
  assert.equal(body.contents[0].parts[0].text, JSON.stringify({
    resumeText: fullSizeSyntheticDocxExtractedText
  }));
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
  assert.equal(body.generationConfig.maxOutputTokens, 24_000);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  const projectedRequest = buildGeminiJsonRequest({
    systemPrompt: resumeParsePrompt,
    payload: { resumeText: fullSizeSyntheticDocxExtractedText },
    responseJsonSchema: (resumeModule as typeof resumeModule & {
      RESUME_PARSE_GEMINI_RESPONSE_JSON_SCHEMA?: unknown;
    }).RESUME_PARSE_GEMINI_RESPONSE_JSON_SCHEMA as Record<string, unknown>,
    maxOutputTokens: 24_000,
    thinkingLevel: "LOW"
  });
  assert.deepEqual(
    body.generationConfig.responseJsonSchema,
    projectedRequest.generationConfig.responseJsonSchema
  );
  assert.equal(Buffer.byteLength(request.bodyJson), 16_505);
  assert.equal(Buffer.byteLength(JSON.stringify(body.generationConfig.responseJsonSchema)), 3_762);
  assert.doesNotMatch(JSON.stringify(body.generationConfig.responseJsonSchema), /"maxItems"/);

  const fullSchemaBaseline = buildGeminiJsonRequest({
    systemPrompt: resumeParsePrompt,
    payload: { resumeText: fullSizeSyntheticDocxExtractedText },
    responseJsonSchema: RESUME_PARSE_RESPONSE_JSON_SCHEMA,
    maxOutputTokens: 24_000,
    thinkingLevel: "LOW"
  });
  const candidateSchema = body.generationConfig.responseJsonSchema;
  body.generationConfig.responseJsonSchema = fullSchemaBaseline.generationConfig.responseJsonSchema;
  assert.deepEqual(body, fullSchemaBaseline, "only responseJsonSchema may differ from the rejected request shape");
  assert.equal(
    (JSON.stringify(fullSchemaBaseline.generationConfig.responseJsonSchema).match(/"maxItems"/g) ?? []).length,
    14
  );
  assert.equal((JSON.stringify(candidateSchema).match(/"maxItems"/g) ?? []).length, 0);
});

test("fails closed if registered pricing would exceed the approved maximum", () => {
  const pricing = MODEL_PRICING_REGISTRY["gemini-3.5-flash-lite"];
  const priorOutputPrice = pricing.outputUsdPerMillion;
  pricing.outputUsdPerMillion = 2.5001;
  try {
    assert.throws(
      () => buildPinnedGeminiResumeDiagnosticRequest(),
      /approved maximum cost/
    );
  } finally {
    pricing.outputUsdPerMillion = priorOutputPrice;
  }
});

test("rejects an absent ephemeral key before transport", async () => {
  let calls = 0;
  await assert.rejects(
    runLocalPinnedDiagnostic("  ", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      }
    }),
    /masked prompt/
  );
  assert.equal(calls, 0);
});

test("rejects provider-controlled field tokens outside the finite approved request tree", async () => {
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        details: [{
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{
            field: "generationConfig.PRIVATESECRET123456789",
            description: "Response schema is too complex"
          }]
        }]
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.category, "SCHEMA_TOO_COMPLEX");
  assert.deepEqual(result.fieldPaths, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATESECRET123456789/);
});

test("refuses CI and hosted execution before even an injected transport", async () => {
  for (const runtimeKey of ["CI", "VERCEL"] as const) {
    const prior = process.env[runtimeKey];
    process.env[runtimeKey] = "1";
    let calls = 0;
    try {
      await assert.rejects(
        runPinnedGeminiResumeDiagnostic("synthetic-secret", {
          resumeText: fullSizeSyntheticDocxExtractedText,
          fetchImpl: async () => {
            calls += 1;
            return new Response(null, { status: 200 });
          }
        }),
        /local interactive diagnostic/
      );
    } finally {
      if (prior === undefined) delete process.env[runtimeKey];
      else process.env[runtimeKey] = prior;
    }
    assert.equal(calls, 0);
  }
});

test("makes one request and returns structured safe rejection diagnostics", async () => {
  const privateText = "private@example.com must not escape";
  const secret = "secret-must-not-escape";
  let calls = 0;
  const result = await runLocalPinnedDiagnostic(secret, {
    fetchImpl: async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], secret);
      return new Response(JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: `Response schema is too complex. ${privateText}`,
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "SCHEMA_VALIDATION_FAILED",
              domain: "generativelanguage.googleapis.com",
              metadata: { unsafeValue: privateText }
            },
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [
                {
                  field: "generationConfig.responseJsonSchema.properties.contractVersion",
                  description: privateText
                }
              ]
            }
          ]
        }
      }), {
        status: 400,
        headers: { "x-goog-request-id": "request_ABC-123" }
      });
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    outcome: "rejected",
    httpStatus: 400,
    providerCode: "INVALID_ARGUMENT",
    requestId: "request_ABC-123",
    category: "SCHEMA_TOO_COMPLEX",
    fieldPaths: ["generationConfig.responseJsonSchema.properties.contractVersion"],
    fieldViolationCount: 1,
    detailTypes: ["ErrorInfo", "BadRequest"],
    errorReason: "SCHEMA_VALIDATION_FAILED",
    errorDomain: "generativelanguage.googleapis.com",
    metadataKeys: ["unsafeValue"],
    providerMessagePreview: "Response schema is too complex. [REDACTED_EMAIL] must not escape",
    providerMessageBytes: 67,
    providerMessageFingerprint: createHash("sha256")
      .update("Response schema is too complex. [REDACTED_EMAIL] must not escape")
      .digest("hex"),
    providerMessageTruncated: false,
    responseBodyBytes: 542,
    responseBodyTruncated: false
  });
  assert.doesNotMatch(JSON.stringify(result), /private@example\.com|secret-must-not-escape/);
});

test("returns only a bounded redacted synthetic provider-message diagnostic", async () => {
  const apiKey = "AIzaCredentialMustNeverEscape123456789";
  const secretLike = "abcdefghijklmnopqrstuvwxyzabcdef";
  const separatorSecretLike = "AbCdEfGh_IjKlMnOp-QrStUvWx1234";
  const base64SecretLike = "AbCdEfGh/IjKlMnOp+QrStUvWx=1234";
  const lowercaseSeparatorSecretLike = "abcdefghijkl_mnopqrstuvwxyz";
  const rawMessage = [
    "Request contains\tan invalid argument.",
    `Credential ${apiKey}`,
    `Trace ${secretLike}`,
    `Opaque ${separatorSecretLike}`,
    `Base64 ${base64SecretLike}`,
    `Lowercase ${lowercaseSeparatorSecretLike}`,
    "private@example.com"
  ].join("\n");
  const result = await runLocalPinnedDiagnostic(apiKey, {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: rawMessage
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.providerMessageBytes, Buffer.byteLength(rawMessage));
  assert.equal(result.providerMessagePreview,
    "Request contains an invalid argument. Credential [REDACTED_CREDENTIAL] "
    + "Trace [REDACTED_SECRET] Opaque [REDACTED_SECRET] "
    + "Base64 [REDACTED_SECRET] Lowercase [REDACTED_SECRET] [REDACTED_EMAIL]");
  assert.equal(result.providerMessageTruncated, false);
  assert.equal(result.providerMessageFingerprint,
    createHash("sha256").update(result.providerMessagePreview).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp([
    apiKey,
    secretLike,
    separatorSecretLike,
    base64SecretLike.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    lowercaseSeparatorSecretLike,
    "private@example\\.com"
  ].join("|")));
});

test("suppresses a provider message that quotes any prompt excerpt", async () => {
  const promptExcerpt = resumeParsePrompt.slice(200, 231);
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: `Invalid request: ${promptExcerpt}`
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.providerMessagePreview, "[REDACTED_PROMPT_EXCERPT]");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(promptExcerpt.slice(0, 20)));
});

test("suppresses a provider message that quotes any synthetic resume excerpt", async () => {
  const sourceExcerpt = fullSizeSyntheticDocxExtractedText.slice(0, 31);
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: `Invalid request near ${sourceExcerpt}`
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.providerMessagePreview, "[REDACTED_SYNTHETIC_INPUT]");
  assert.doesNotMatch(JSON.stringify(result), /Taylor Boundary/);
});

test("rejects credential echoes from every structured provider field", async () => {
  const apiKey = "AIzaStructuredCredentialMustNeverEscape98765";
  const result = await runLocalPinnedDiagnostic(apiKey, {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: apiKey,
        status: apiKey,
        message: "Request contains an invalid argument.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: apiKey,
          domain: apiKey,
          metadata: { [apiKey]: "not returned" }
        }]
      }
    }), {
      status: 400,
      headers: { "x-goog-request-id": apiKey }
    })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.requestId, null);
  assert.equal(result.providerCode, null);
  assert.equal(result.errorReason, null);
  assert.equal(result.errorDomain, null);
  assert.deepEqual(result.metadataKeys, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
});

test("rejects separator-bearing opaque tokens from every structured provider field", async () => {
  const opaqueToken = "AbCdEfGh_IjKlMnOp-QrStUvWx1234";
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: opaqueToken,
        status: opaqueToken,
        message: "Request contains an invalid argument.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: opaqueToken,
          domain: opaqueToken,
          metadata: { [opaqueToken]: "not returned" }
        }]
      }
    }), {
      status: 400,
      headers: { "x-goog-request-id": opaqueToken }
    })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.requestId, null);
  assert.equal(result.providerCode, null);
  assert.equal(result.errorReason, null);
  assert.equal(result.errorDomain, null);
  assert.deepEqual(result.metadataKeys, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(opaqueToken));
});

test("rejects Base64-shaped opaque tokens from every structured provider field", async () => {
  const opaqueToken = "AbCdEfGh/IjKlMnOp+QrStUvWx=1234";
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: opaqueToken,
        status: opaqueToken,
        message: "Request contains an invalid argument.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: opaqueToken,
          domain: opaqueToken,
          metadata: { [opaqueToken]: "not returned" }
        }]
      }
    }), {
      status: 400,
      headers: { "x-goog-request-id": opaqueToken }
    })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.requestId, null);
  assert.equal(result.providerCode, null);
  assert.equal(result.errorReason, null);
  assert.equal(result.errorDomain, null);
  assert.deepEqual(result.metadataKeys, []);
  assert.ok(!JSON.stringify(result).includes(opaqueToken));
});

test("rejects long single-class opaque tokens split by permitted separators", async () => {
  const opaqueToken = "abcdefghijkl_mnopqrstuvwxyz";
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: opaqueToken,
        status: opaqueToken,
        message: "Request contains an invalid argument.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: opaqueToken,
          domain: opaqueToken,
          metadata: { [opaqueToken]: "not returned" }
        }]
      }
    }), {
      status: 400,
      headers: { "x-goog-request-id": opaqueToken }
    })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.requestId, null);
  assert.equal(result.providerCode, null);
  assert.equal(result.errorReason, null);
  assert.equal(result.errorDomain, null);
  assert.deepEqual(result.metadataKeys, []);
  assert.ok(!JSON.stringify(result).includes(opaqueToken));
});

test("caps the normalized provider-message preview at 256 UTF-8 bytes", async () => {
  const rawMessage = `Invalid ${"é".repeat(300)}`;
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: rawMessage
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.providerMessageBytes, Buffer.byteLength(rawMessage));
  assert.ok(result.providerMessagePreview);
  assert.ok(Buffer.byteLength(result.providerMessagePreview) <= 256);
  assert.equal(result.providerMessageTruncated, true);
});

test("extracts only known request field paths from an unstructured provider message", async () => {
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Invalid value at generationConfig.maxOutputTokens and private@example.com"
      }
    }), { status: 400 })
  });

  assert.equal(result.outcome, "rejected");
  if (result.outcome !== "rejected") assert.fail("expected a rejected diagnostic response");
  assert.equal(result.category, "OUTPUT_TOKEN_LIMIT");
  assert.deepEqual(result.fieldPaths, ["generationConfig.maxOutputTokens"]);
  assert.doesNotMatch(JSON.stringify(result), /private@example\.com/);
});

test("validates a full synthetic provider response in memory without returning raw output", async () => {
  const providerOutput = JSON.stringify(fullSizeSyntheticProviderOutput());
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: providerOutput }] }
      }],
      usageMetadata: {
        promptTokenCount: 4_000,
        candidatesTokenCount: 7_500,
        thoughtsTokenCount: 100,
        totalTokenCount: 11_600
      }
    }), { status: 200 })
  });

  assert.deepEqual(result, {
    outcome: "validated",
    httpStatus: 200,
    finishReason: "STOP",
    usage: {
      inputTokens: 4_000,
      outputTokens: 7_600,
      cachedInputTokens: 0,
      visibleOutputTokens: 7_500,
      thinkingTokens: 100
    },
    responseBodyBytes: 26_701,
    responseBodyTruncated: false,
    validation: {
      contractVersion: "5",
      sourceFacts: "complete",
      sourceSectionCount: 9,
      workHistoryCount: 5,
      projectCount: 2,
      educationCount: 2,
      certificationCount: 1,
      achievementCount: 2,
      applicationPlan: "passed",
      jobMatch: "passed",
      tailoring: "passed"
    }
  });
  assert.ok(!JSON.stringify(result).includes(providerOutput));
  assert.doesNotMatch(JSON.stringify(result), /Taylor Boundary|taylor\.boundary@example\.test/);
});

test("a successful response without usage metadata is not reported as cost-validated", async () => {
  const providerOutput = JSON.stringify(fullSizeSyntheticProviderOutput());
  const envelope = JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: providerOutput }] }
    }]
  });
  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => new Response(envelope, { status: 200 })
  });

  assert.deepEqual(result, {
    outcome: "invalid_response",
    httpStatus: 200,
    category: "INVALID_USAGE",
    finishReason: "STOP",
    usage: null,
    responseBodyBytes: Buffer.byteLength(envelope),
    responseBodyTruncated: false
  });
  assert.ok(!JSON.stringify(result).includes(providerOutput));
});

test("cancels an oversized response body and never retries", async () => {
  let calls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(EXPECTED_RESPONSE_LIMIT_BYTES + 1)));
    },
    cancel() {
      cancelled = true;
    }
  });

  const result = await runLocalPinnedDiagnostic("synthetic-secret", {
    fetchImpl: async () => {
      calls += 1;
      return new Response(body, { status: 400 });
    }
  });

  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(result, {
    outcome: "rejected",
    httpStatus: 400,
    providerCode: null,
    requestId: null,
    category: "RESPONSE_BODY_TOO_LARGE",
    fieldPaths: [],
    fieldViolationCount: 0,
    detailTypes: [],
    errorReason: null,
    errorDomain: null,
    metadataKeys: [],
    providerMessagePreview: null,
    providerMessageBytes: null,
    providerMessageFingerprint: null,
    providerMessageTruncated: false,
    responseBodyBytes: EXPECTED_RESPONSE_LIMIT_BYTES + 1,
    responseBodyTruncated: true
  });
});

test("CLI consumes one ephemeral secret and writes only the sanitized result", async () => {
  const cliModule = await import("@/scripts/diagnose-gemini-resume-schema").catch(() => null);
  assert.ok(cliModule, "the diagnostic CLI should exist");
  const secret = "owner-entered-secret";
  const writes: string[] = [];
  let receivedKey: string | null = null;
  let receivedResumeText: string | null = null;
  let reads = 0;
  let runtimeChecks = 0;
  const exitCode = await cliModule.runGeminiResumeDiagnosticCli({
    assertRuntime: () => {
      runtimeChecks += 1;
    },
    readSecret: async () => {
      reads += 1;
      return secret;
    },
    loadResumeText: async () => fullSizeSyntheticDocxExtractedText,
    runDiagnostic: async (apiKey, options) => {
      receivedKey = apiKey;
      receivedResumeText = options.resumeText;
      return {
        outcome: "validated" as const,
        httpStatus: 200,
        finishReason: "STOP" as const,
        usage: {
          inputTokens: 4_000,
          outputTokens: 7_600,
          cachedInputTokens: 0,
          visibleOutputTokens: 7_500,
          thinkingTokens: 100
        },
        responseBodyBytes: 26_701,
        responseBodyTruncated: false,
        validation: {
          contractVersion: "5" as const,
          sourceFacts: "complete" as const,
          sourceSectionCount: 9,
          workHistoryCount: 5,
          projectCount: 2,
          educationCount: 2,
          certificationCount: 1,
          achievementCount: 2,
          applicationPlan: "passed" as const,
          jobMatch: "passed" as const,
          tailoring: "passed" as const
        }
      };
    },
    write: (value) => writes.push(value)
  });

  assert.equal(exitCode, 0);
  assert.equal(runtimeChecks, 1);
  assert.equal(reads, 1);
  assert.equal(receivedKey, secret);
  assert.equal(receivedResumeText, fullSizeSyntheticDocxExtractedText);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"outcome": "validated"/);
  assert.match(writes[0], new RegExp(EXPECTED_SOURCE_HASH));
  assert.match(writes[0], new RegExp(EXPECTED_REQUEST_HASH));
  assert.match(writes[0], new RegExp(String(EXPECTED_RESPONSE_LIMIT_BYTES)));
  assert.doesNotMatch(writes[0], /owner-entered-secret/);
  assert.doesNotMatch(writes[0], /Taylor Boundary|taylor\.boundary@example\.test/);
});

test("CLI exits nonzero for a provider rejection and never retries", async () => {
  const cliModule = await import("@/scripts/diagnose-gemini-resume-schema");
  let calls = 0;
  const exitCode = await cliModule.runGeminiResumeDiagnosticCli({
    assertRuntime: () => undefined,
    loadResumeText: async () => fullSizeSyntheticDocxExtractedText,
    readSecret: async () => "synthetic-secret",
    runDiagnostic: async () => {
      calls += 1;
      return {
        outcome: "rejected" as const,
        httpStatus: 400,
        providerCode: "INVALID_ARGUMENT",
        requestId: null,
        category: "SCHEMA_TOO_COMPLEX" as const,
        fieldPaths: [],
        fieldViolationCount: 0,
        detailTypes: [],
        errorReason: null,
        errorDomain: null,
        metadataKeys: [],
        providerMessagePreview: "Response schema is too complex.",
        providerMessageBytes: 31,
        providerMessageFingerprint: createHash("sha256")
          .update("Response schema is too complex.")
          .digest("hex"),
        providerMessageTruncated: false,
        responseBodyBytes: 100,
        responseBodyTruncated: false
      };
    },
    write: () => undefined
  });

  assert.equal(exitCode, 1);
  assert.equal(calls, 1);
});

test("CLI owns the masked TTY prompt and the wrapper never handles the secret", async () => {
  const wrapper = await readFile(
    new URL("../scripts/run-gemini-resume-schema-diagnostic.sh", import.meta.url),
    "utf8"
  ).catch(() => null);
  assert.ok(wrapper, "the masked owner wrapper should exist");
  assert.match(wrapper, /exec node --import tsx scripts\/diagnose-gemini-resume-schema\.ts/);
  assert.doesNotMatch(wrapper, /read |printf|diagnostic_key|GEMINI_API_KEY|--api-key|\.env/);

  const cli = await readFile(
    new URL("../scripts/diagnose-gemini-resume-schema.ts", import.meta.url),
    "utf8"
  );
  assert.match(cli, /process\.stdin\.isTTY/);
  assert.match(cli, /"\/dev\/tty"/);
  assert.match(cli, /"-echo"/);
  assert.match(cli, /process\.env\.VERCEL/);
  assert.doesNotMatch(cli, /GEMINI_API_KEY|dotenv|(?:^|[\/"'])\.env(?:$|[\/"'])/m);
});
