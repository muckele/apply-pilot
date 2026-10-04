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
const EXPECTED_SOURCE_HASH = "93c706c5e3cec091218647f027fa1c63cccf48ec6240f74615747fcdd303cf06";
const EXPECTED_REQUEST_HASH = "bd4092d4a5144ba809da86e871dbab4c612f49d991d74952fda04336eaf0710c";
const EXPECTED_SCHEMA_HASH = "2e8764c96ef1e4c1b13f828bc5fc72a7a1bdae4bb480a224a222c7f6a59656f4";
const MAX_RESPONSE_BYTES = 65_536;

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

export function runPinnedGeminiResumeV7Diagnostic(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; resumeText: string }
) {
  return runGeminiResumeDiagnosticCore(apiKey, options, {
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
}
