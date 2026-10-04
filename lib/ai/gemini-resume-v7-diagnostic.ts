import { createHash } from "node:crypto";

import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import {
  assertResumeDiagnosticConsumerCoverage,
  runGeminiResumeDiagnosticCore
} from "@/lib/ai/gemini-resume-diagnostic";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  assembleAndValidateResumeV7,
  prepareResumeParseV7Request,
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_PROMPT_VERSION
} from "@/lib/ai/resume";
import { resumeParsePromptV7 } from "@/prompts/resumeParsePrompt";

const DIAGNOSTIC_MODEL = "gemini-3.5-flash-lite";
const DIAGNOSTIC_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const DIAGNOSTIC_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_INPUT_TOKENS = 12_000;
const DIAGNOSTIC_OUTPUT_TOKENS = 24_000;
const APPROVED_MAXIMUM_COST_MICROS = 63_600;
const EXPECTED_SOURCE_HASH = "ef2af3269f33639e869fa202440fe29d654aaa580e67a07a0c54a5b416b33823";
const EXPECTED_REQUEST_HASH = "14e084686614fab6aeeedacc37fa7d42f0d390c076ddd4798acd953bdf890eb3";
const EXPECTED_SCHEMA_HASH = "a25c70d983f109e05a15529e06637e4c52d21b0ffe1760df1b6b120660c69c57";
const MAX_RESPONSE_BYTES = 65_536;
const SAFE_PROVIDER_CODES = new Set([
  "ABORTED",
  "ALREADY_EXISTS",
  "CANCELLED",
  "DATA_LOSS",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "OUT_OF_RANGE",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
  "UNKNOWN"
]);
const SAFE_FINISH_REASONS = new Set([
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "LANGUAGE",
  "MALFORMED_FUNCTION_CALL",
  "MAX_TOKENS",
  "OTHER",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SAFETY",
  "SPII",
  "STOP",
  "UNEXPECTED_TOOL_CALL"
]);

export { assertResumeDiagnosticConsumerCoverage };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildPinnedGeminiResumeV7DiagnosticRequest(resumeText = "") {
  const prepared = prepareResumeParseV7Request(resumeText, "gemini");
  if (prepared.policy.maxInputTokens !== DIAGNOSTIC_INPUT_TOKENS) {
    throw new Error("Pinned Gemini v7 diagnostic input policy does not match the approved bound.");
  }
  if (prepared.outputTokenLimit !== DIAGNOSTIC_OUTPUT_TOKENS) {
    throw new Error("Pinned Gemini v7 diagnostic output policy does not match production.");
  }
  const maximumCostMicros = estimateAiCostMicros({
    model: DIAGNOSTIC_MODEL,
    inputTokens: prepared.policy.maxInputTokens,
    outputTokens: prepared.outputTokenLimit
  });
  if (maximumCostMicros > APPROVED_MAXIMUM_COST_MICROS) {
    throw new Error("Pinned Gemini v7 diagnostic exceeds the approved maximum cost.");
  }

  const sourceHash = sha256(prepared.normalizedText);
  if (sourceHash !== EXPECTED_SOURCE_HASH) {
    throw new Error("Pinned Gemini v7 diagnostic source does not match the approved synthetic fixture.");
  }
  if (
    RESUME_PARSE_PROMPT_VERSION !== "9"
    || RESUME_PARSE_CACHE_VERSION !== "10"
    || RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION !== "4"
  ) {
    throw new Error("Pinned Gemini v7 diagnostic versions no longer match production.");
  }

  const body = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV7,
    payload: prepared.payload,
    responseJsonSchema: prepared.geminiResponseSchema,
    maxOutputTokens: prepared.outputTokenLimit,
    thinkingLevel: "LOW"
  });
  const bodyJson = JSON.stringify(body);
  const schemaJson = JSON.stringify(body.generationConfig.responseJsonSchema);
  const requestHash = sha256(bodyJson);
  const schemaHash = sha256(schemaJson);
  if (requestHash !== EXPECTED_REQUEST_HASH || schemaHash !== EXPECTED_SCHEMA_HASH) {
    throw new Error("Pinned Gemini v7 diagnostic request does not match the approved hashes.");
  }

  return {
    bodyJson,
    cacheVersion: RESUME_PARSE_CACHE_VERSION,
    contractVersion: "7" as const,
    endpoint: DIAGNOSTIC_ENDPOINT,
    maximumCostMicros,
    maximumInputTokens: prepared.policy.maxInputTokens,
    maximumOutputTokens: prepared.outputTokenLimit,
    model: DIAGNOSTIC_MODEL,
    promptVersion: RESUME_PARSE_PROMPT_VERSION,
    requestBodyBytes: Buffer.byteLength(bodyJson),
    requestHash,
    responseBodyLimitBytes: MAX_RESPONSE_BYTES,
    schemaBytes: Buffer.byteLength(schemaJson),
    schemaHash,
    sourceHash,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    wireSchemaVersion: RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION
  };
}

export async function runPinnedGeminiResumeV7Diagnostic(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; resumeText: string }
) {
  const result = await runGeminiResumeDiagnosticCore(apiKey, options, {
    assembleAndValidate: assembleAndValidateResumeV7,
    buildRequest: buildPinnedGeminiResumeV7DiagnosticRequest,
    validationExtra: (validated) => ({
      recordAuthority: "server_owned" as const,
      structuralRecordCount: validated.workHistory.length
        + validated.projects.length
        + validated.education.length
        + validated.certifications.length
    })
  });
  if (result.outcome === "rejected") {
    return {
      ...result,
      providerCode: result.providerCode && SAFE_PROVIDER_CODES.has(result.providerCode)
        ? result.providerCode
        : null,
      requestId: null,
      errorReason: null,
      errorDomain: null,
      metadataKeys: [],
      providerMessagePreview: null
    };
  }
  if (
    "finishReason" in result
    && typeof result.finishReason === "string"
    && !SAFE_FINISH_REASONS.has(result.finishReason)
  ) {
    return { ...result, finishReason: null };
  }
  return result;
}
