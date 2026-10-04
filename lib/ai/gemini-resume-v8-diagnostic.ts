import { createHash } from "node:crypto";

import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import {
  assertResumeDiagnosticConsumerCoverage,
  runGeminiResumeDiagnosticCore
} from "@/lib/ai/gemini-resume-diagnostic";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  assembleAndValidateResumeV8,
  prepareResumeParseV8Request,
  RESUME_PARSE_V8_CACHE_VERSION,
  RESUME_PARSE_V8_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_V8_PROMPT_VERSION
} from "@/lib/ai/resume";
import { resumeParsePromptV8 } from "@/prompts/resumeParsePrompt";

const CANDIDATE_COMMIT = "105ba6f29d298d58c9636eb6ab17212adf50132c";
const DIAGNOSTIC_MODEL = "gemini-3.5-flash-lite";
const DIAGNOSTIC_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const DIAGNOSTIC_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_INPUT_TOKENS = 12_000;
const DIAGNOSTIC_OUTPUT_TOKENS = 24_000;
const APPROVED_MAXIMUM_COST_MICROS = 63_600;
const PINNED_PROMPT_VERSION = "10";
const PINNED_CACHE_VERSION = "11";
const PINNED_WIRE_SCHEMA_VERSION = "5";
const EXPECTED_SOURCE_HASH = "ef2af3269f33639e869fa202440fe29d654aaa580e67a07a0c54a5b416b33823";
const EXPECTED_REQUEST_HASH = "6727cbe7a1c6a7efaae9243c0e7ddca40a608da458b4d31793c60e31fed956ab";
const EXPECTED_SCHEMA_HASH = "5d6f75cde707327a89f44a453df3cfcb5737f4e574fba1b3b4cb2ffb9a31d983";
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

export function buildPinnedGeminiResumeV8DiagnosticRequest(resumeText = "") {
  if (
    RESUME_PARSE_V8_PROMPT_VERSION !== PINNED_PROMPT_VERSION
    || RESUME_PARSE_V8_CACHE_VERSION !== PINNED_CACHE_VERSION
    || RESUME_PARSE_V8_GEMINI_WIRE_SCHEMA_VERSION !== PINNED_WIRE_SCHEMA_VERSION
  ) {
    throw new Error("Pinned Gemini V8 diagnostic versions no longer match the candidate.");
  }

  const prepared = prepareResumeParseV8Request(resumeText, "gemini");
  if (prepared.policy.maxInputTokens !== DIAGNOSTIC_INPUT_TOKENS) {
    throw new Error("Pinned Gemini V8 diagnostic input policy does not match the approved bound.");
  }
  if (prepared.outputTokenLimit !== DIAGNOSTIC_OUTPUT_TOKENS) {
    throw new Error("Pinned Gemini V8 diagnostic output policy does not match the approved bound.");
  }
  const maximumCostMicros = estimateAiCostMicros({
    model: DIAGNOSTIC_MODEL,
    inputTokens: prepared.policy.maxInputTokens,
    outputTokens: prepared.outputTokenLimit
  });
  if (maximumCostMicros !== APPROVED_MAXIMUM_COST_MICROS) {
    throw new Error("Pinned Gemini V8 diagnostic cost no longer matches the approved maximum.");
  }

  const sourceHash = sha256(prepared.normalizedText);
  if (sourceHash !== EXPECTED_SOURCE_HASH) {
    throw new Error("Pinned Gemini V8 diagnostic source does not match the approved synthetic fixture.");
  }
  const body = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV8,
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
    throw new Error("Pinned Gemini V8 diagnostic request does not match the approved hashes.");
  }

  return {
    bodyJson,
    cacheVersion: PINNED_CACHE_VERSION,
    candidateCommit: CANDIDATE_COMMIT,
    contractVersion: "8" as const,
    endpoint: DIAGNOSTIC_ENDPOINT,
    maximumCostMicros,
    maximumCostUsd: (maximumCostMicros / 1_000_000).toFixed(6),
    maximumInputTokens: prepared.policy.maxInputTokens,
    maximumOutputTokens: prepared.outputTokenLimit,
    method: "POST" as const,
    model: DIAGNOSTIC_MODEL,
    promptVersion: PINNED_PROMPT_VERSION,
    redirect: "error" as const,
    requestBodyBytes: Buffer.byteLength(bodyJson),
    requestHash,
    responseBodyLimitBytes: MAX_RESPONSE_BYTES,
    schemaBytes: Buffer.byteLength(schemaJson),
    schemaHash,
    sourceBytes: Buffer.byteLength(prepared.normalizedText),
    sourceHash,
    thinkingLevel: "LOW" as const,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    wireSchemaVersion: PINNED_WIRE_SCHEMA_VERSION
  };
}

export async function runPinnedGeminiResumeV8Diagnostic(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; resumeText: string }
) {
  const result = await runGeminiResumeDiagnosticCore(apiKey, options, {
    assembleAndValidate: assembleAndValidateResumeV8,
    buildRequest: buildPinnedGeminiResumeV8DiagnosticRequest,
    validationExtra: (validated) => {
      const contactProjectionCount = [
        validated.contactInfo.name,
        validated.contactInfo.headline,
        validated.contactInfo.email,
        validated.contactInfo.phone,
        validated.contactInfo.location,
        validated.contactInfo.linkedin,
        validated.contactInfo.github,
        validated.contactInfo.portfolio
      ].filter((value) => value !== null).length;
      if (contactProjectionCount !== 8) {
        throw new Error("Pinned Gemini V8 diagnostic omitted a contact projection.");
      }
      return {
        candidateCommit: CANDIDATE_COMMIT,
        recordAuthority: "server_owned_finite_ids" as const,
        sourceAuthority: "server_owned_lossless" as const,
        losslessFields: [
          "sourceSections",
          "summary",
          "achievements",
          "sectionStatus"
        ] as const,
        skillsProjection: "source_backed_semantic_subset" as const,
        rawSourceFallback: "preserved" as const,
        contactProjectionCount,
        contactProjectionCompleteness: "passed" as const,
        structuralRecordCount: validated.workHistory.length
          + validated.projects.length
          + validated.education.length
          + validated.certifications.length
      };
    }
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
