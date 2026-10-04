import { createHash } from "node:crypto";

import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import { buildGeminiJsonRequest, readGeminiUsage } from "@/lib/ai/gemini";
import { getJobMatchEvidenceReferences } from "@/lib/ai/job-match";
import { assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  assembleAndValidateResumeV6,
  classifyResumeValidationFailure,
  RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA,
  RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInputV6 } from "@/lib/ai/resume-source-catalog";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { resumeParsePromptV6 } from "@/prompts/resumeParsePrompt";

const DIAGNOSTIC_MODEL = "gemini-3.5-flash-lite";
const DIAGNOSTIC_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const DIAGNOSTIC_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_INPUT_TOKENS = 12_000;
const DIAGNOSTIC_OUTPUT_TOKENS = 24_000;
const PINNED_RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION = "3";
const APPROVED_MAXIMUM_COST_MICROS = 63_600;
const EXPECTED_SOURCE_HASH = "93c706c5e3cec091218647f027fa1c63cccf48ec6240f74615747fcdd303cf06";
const EXPECTED_REQUEST_HASH = "de2e64078a993b8b31daf7908e6ba24b8ad72fc424c064f55566f50df77399b0";
const EXPECTED_SCHEMA_HASH = "08a6b93669e1c0ff2b5487193a5d9a69bf40cc817cbe3daa7064e2b6304c054d";
const MAX_RESPONSE_BYTES = 65_536;
const MAX_PROVIDER_MESSAGE_PREVIEW_BYTES = 256;
const SAFE_TOKEN = /^[A-Za-z0-9._~:/+=-]{1,200}$/u;
const SAFE_FIELD_PATH = /^(?:generationConfig|generation_config|systemInstruction|system_instruction|contents|model)(?:[A-Za-z0-9_.$\[\]-]{0,480})$/u;

export type GeminiResumeDiagnosticCategory =
  | "SCHEMA_TOO_COMPLEX"
  | "UNSUPPORTED_SCHEMA_KEYWORD"
  | "INVALID_SCHEMA_VALUE"
  | "UNSUPPORTED_THINKING_CONFIG"
  | "OUTPUT_TOKEN_LIMIT"
  | "MODEL_OR_ENDPOINT"
  | "MALFORMED_REQUEST"
  | "UNCLASSIFIED_INVALID_ARGUMENT"
  | "PROVIDER_REJECTION"
  | "UNPARSEABLE_PROVIDER_ERROR"
  | "RESPONSE_BODY_TOO_LARGE"
  | "INVALID_RESPONSE_ENVELOPE"
  | "INCOMPLETE_RESPONSE"
  | "INVALID_USAGE"
  | "INVALID_STRUCTURED_OUTPUT";

type DiagnosticFetch = typeof fetch;

type ProviderErrorDetail = {
  "@type"?: unknown;
  reason?: unknown;
  domain?: unknown;
  metadata?: unknown;
  fieldViolations?: unknown;
};

type ProviderErrorBody = {
  error?: {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeToken(value: unknown, apiKey: string, resumeText = "") {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return SAFE_TOKEN.test(normalized) && !containsSensitiveDiagnosticText(normalized, apiKey, resumeText)
    ? normalized
    : null;
}

function toSnakeCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function approvedFieldPathsFromRequest(value: unknown) {
  const paths = new Set<string>(["model"]);

  function visit(
    current: unknown,
    actualPath: string,
    snakePath: string,
    providerPath: string,
    insideSchema: boolean
  ) {
    if (actualPath) paths.add(actualPath);
    if (snakePath) paths.add(snakePath);
    if (providerPath) paths.add(providerPath);

    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        visit(
          item,
          `${actualPath}[${index}]`,
          `${snakePath}[${index}]`,
          `${providerPath}[${index}]`,
          insideSchema
        );
      });
      return;
    }
    if (!current || typeof current !== "object") return;

    for (const [key, child] of Object.entries(current)) {
      const snakeKey = toSnakeCase(key);
      const childInsideSchema = insideSchema || key === "responseJsonSchema";
      visit(
        child,
        actualPath ? `${actualPath}.${key}` : key,
        snakePath ? `${snakePath}.${snakeKey}` : snakeKey,
        providerPath
          ? `${providerPath}.${insideSchema ? key : snakeKey}`
          : insideSchema ? key : snakeKey,
        childInsideSchema
      );
    }
  }

  visit(value, "", "", "", false);
  return paths;
}

function safeFieldPath(value: unknown, approvedFieldPaths: ReadonlySet<string>) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SAFE_FIELD_PATH.test(normalized) && approvedFieldPaths.has(normalized)
    ? normalized
    : null;
}

function unique(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function detailType(value: unknown) {
  if (value === "type.googleapis.com/google.rpc.ErrorInfo") return "ErrorInfo";
  if (value === "type.googleapis.com/google.rpc.BadRequest") return "BadRequest";
  if (value === "type.googleapis.com/google.rpc.PreconditionFailure") return "PreconditionFailure";
  return null;
}

function pathsFromMessage(message: string, approvedFieldPaths: ReadonlySet<string>) {
  return unique(
    message.match(/\b(?:generationConfig|generation_config|systemInstruction|system_instruction|contents|model)(?:[A-Za-z0-9_.$\[\]-]{0,480})/gu)
      ?.map((value) => safeFieldPath(value, approvedFieldPaths)) ?? []
  ).slice(0, 10);
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function containsPromptExcerpt(value: string) {
  const normalizedValue = normalizeWhitespace(value);
  const normalizedPrompt = normalizeWhitespace(resumeParsePromptV6);
  const excerptLength = 16;
  for (let index = 0; index + excerptLength <= normalizedValue.length; index += 1) {
    if (normalizedPrompt.includes(normalizedValue.slice(index, index + excerptLength))) {
      return true;
    }
  }
  return false;
}

function containsSourceExcerpt(value: string, resumeText: string) {
  const normalizedValue = normalizeWhitespace(value);
  const normalizedSource = normalizeWhitespace(resumeText);
  const excerptLength = 16;
  for (let index = 0; index + excerptLength <= normalizedValue.length; index += 1) {
    if (normalizedSource.includes(normalizedValue.slice(index, index + excerptLength))) {
      return true;
    }
  }
  return false;
}

function isSecretLikeToken(token: string) {
  if (token.length < 24) return false;
  if (token === "generativelanguage.googleapis.com") return false;
  return !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(token);
}

function containsSecretLikeToken(value: string) {
  return value.match(/[A-Za-z0-9._~:/+=-]{24,}/gu)?.some(isSecretLikeToken) ?? false;
}

function containsSensitiveDiagnosticText(value: string, apiKey: string, resumeText: string) {
  return Boolean(apiKey && value.includes(apiKey))
    || containsSecretLikeToken(value)
    || containsPromptExcerpt(value)
    || containsSourceExcerpt(value, resumeText)
    || Boolean(resumeText && value.includes(JSON.stringify({ resumeText })))
    || Boolean(resumeText && value.includes(resumeText))
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value);
}

function redactSecretLikeTokens(value: string) {
  return value.replace(/[A-Za-z0-9._~:/+=-]{24,}/gu, (token) =>
    isSecretLikeToken(token) ? "[REDACTED_SECRET]" : token);
}

function truncateUtf8(value: string, maximumBytes: number) {
  let bytes = 0;
  let preview = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    preview += character;
    bytes += characterBytes;
  }
  return {
    preview,
    truncated: bytes < Buffer.byteLength(value)
  };
}

function safeProviderMessage(message: string, apiKey: string, resumeText: string) {
  const providerMessageBytes = Buffer.byteLength(message);
  if (!message) {
    return {
      providerMessagePreview: null,
      providerMessageBytes,
      providerMessageFingerprint: null,
      providerMessageTruncated: false
    };
  }

  let sanitized = containsPromptExcerpt(message)
    ? "[REDACTED_PROMPT_EXCERPT]"
    : containsSourceExcerpt(message, resumeText)
      ? "[REDACTED_SYNTHETIC_INPUT]"
      : message;
  sanitized = sanitized.split(apiKey).join("[REDACTED_CREDENTIAL]");
  sanitized = sanitized
    .split(JSON.stringify({ resumeText })).join("[REDACTED_SYNTHETIC_INPUT]")
    .split(resumeText).join("[REDACTED_SYNTHETIC_INPUT]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]");
  sanitized = normalizeWhitespace(redactSecretLikeTokens(sanitized));
  const { preview, truncated } = truncateUtf8(
    sanitized,
    MAX_PROVIDER_MESSAGE_PREVIEW_BYTES
  );
  return {
    providerMessagePreview: preview || null,
    providerMessageBytes,
    providerMessageFingerprint: preview ? sha256(sanitized) : null,
    providerMessageTruncated: truncated
  };
}

function categorizeProviderRejection(providerCode: string | null, evidence: string) {
  const normalized = evidence.toLowerCase();
  if (/schema.{0,80}(?:too complex|complexity|too large|deeply nested)|(?:too complex|complexity).{0,80}schema/u.test(normalized)) {
    return "SCHEMA_TOO_COMPLEX" as const;
  }
  if (/thinking[_a-z.]*config|thinking[_a-z.]*level/u.test(normalized)) {
    return "UNSUPPORTED_THINKING_CONFIG" as const;
  }
  if (/max[_a-z.]*output[_a-z.]*tokens|output token limit/u.test(normalized)) {
    return "OUTPUT_TOKEN_LIMIT" as const;
  }
  if (/response[_a-z.]*json[_a-z.]*schema|responsejsonschema/u.test(normalized)) {
    if (/unknown|unsupported|not supported|unrecognized/u.test(normalized)) {
      return "UNSUPPORTED_SCHEMA_KEYWORD" as const;
    }
    return "INVALID_SCHEMA_VALUE" as const;
  }
  if (/model.{0,60}(?:not found|unsupported|unknown)|endpoint/u.test(normalized)) {
    return "MODEL_OR_ENDPOINT" as const;
  }
  if (/malformed|invalid json payload|invalid request body/u.test(normalized)) {
    return "MALFORMED_REQUEST" as const;
  }
  return providerCode === "INVALID_ARGUMENT"
    ? "UNCLASSIFIED_INVALID_ARGUMENT" as const
    : "PROVIDER_REJECTION" as const;
}

async function readBoundedBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        return { text, bytes, truncated: false };
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { text: "", bytes, truncated: true };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function safeRejectedResult(
  response: Response,
  body: Awaited<ReturnType<typeof readBoundedBody>>,
  approvedFieldPaths: ReadonlySet<string>,
  apiKey: string,
  resumeText: string
) {
  const requestId = ["x-goog-request-id", "x-request-id", "x-guploader-uploadid"]
    .map((header) => safeToken(response.headers.get(header), apiKey, resumeText))
    .find((value): value is string => value !== null) ?? null;
  if (body.truncated) {
    return {
      outcome: "rejected" as const,
      httpStatus: response.status,
      providerCode: null,
      requestId,
      category: "RESPONSE_BODY_TOO_LARGE" as const,
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
      responseBodyBytes: body.bytes,
      responseBodyTruncated: true
    };
  }

  let parsed: ProviderErrorBody;
  try {
    parsed = JSON.parse(body.text) as ProviderErrorBody;
  } catch {
    return {
      outcome: "rejected" as const,
      httpStatus: response.status,
      providerCode: null,
      requestId,
      category: "UNPARSEABLE_PROVIDER_ERROR" as const,
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
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }

  const providerCode = safeToken(parsed.error?.status, apiKey, resumeText)
    ?? safeToken(parsed.error?.code, apiKey, resumeText);
  const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
  const providerMessage = safeProviderMessage(message, apiKey, resumeText);
  const details = Array.isArray(parsed.error?.details)
    ? parsed.error.details.filter((detail): detail is ProviderErrorDetail => Boolean(detail) && typeof detail === "object")
    : [];
  const fieldViolations = details.flatMap((detail) => Array.isArray(detail.fieldViolations)
    ? detail.fieldViolations.filter((item): item is { field?: unknown; description?: unknown } =>
        Boolean(item) && typeof item === "object")
    : []);
  const structuredPaths = fieldViolations.map((violation) =>
    safeFieldPath(violation.field, approvedFieldPaths));
  const fieldPaths = unique([
    ...structuredPaths,
    ...pathsFromMessage(message, approvedFieldPaths)
  ]).slice(0, 10);
  const diagnosticEvidence = [
    message,
    ...fieldPaths,
    ...fieldViolations.map((violation) => typeof violation.description === "string" ? violation.description : "")
  ].join("\n");
  const errorInfo = details.find((detail) => detailType(detail["@type"]) === "ErrorInfo");
  const metadata = errorInfo?.metadata && typeof errorInfo.metadata === "object" && !Array.isArray(errorInfo.metadata)
    ? errorInfo.metadata as Record<string, unknown>
    : null;

  return {
    outcome: "rejected" as const,
    httpStatus: response.status,
    providerCode,
    requestId,
    category: categorizeProviderRejection(providerCode, diagnosticEvidence),
    fieldPaths,
    fieldViolationCount: fieldViolations.length,
    detailTypes: unique(details.map((detail) => detailType(detail["@type"]))).slice(0, 10),
    errorReason: safeToken(errorInfo?.reason, apiKey, resumeText),
    errorDomain: safeToken(errorInfo?.domain, apiKey, resumeText),
    metadataKeys: metadata
      ? unique(Object.keys(metadata).map((key) => safeToken(key, apiKey, resumeText))).slice(0, 20)
      : [],
    ...providerMessage,
    responseBodyBytes: body.bytes,
    responseBodyTruncated: false
  };
}

export function buildPinnedGeminiResumeDiagnosticRequest(resumeText = "") {
  const payload = buildResumeProviderSourceInputV6(resumeText);
  const { policy } = assertAiInputWithinLimits("RESUME_PARSE", resumeParsePromptV6, {
    payload,
    // Preserve the production admission posture: cost and size are checked against
    // the stricter canonical schema, not the relaxed Gemini wire projection.
    responseJsonSchema: RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA
  });
  if (policy.maxInputTokens !== DIAGNOSTIC_INPUT_TOKENS) {
    throw new Error("Pinned Gemini diagnostic input policy does not match the approved bound.");
  }
  const maximumCostMicros = estimateAiCostMicros({
    model: DIAGNOSTIC_MODEL,
    inputTokens: policy.maxInputTokens,
    outputTokens: DIAGNOSTIC_OUTPUT_TOKENS
  });
  if (maximumCostMicros > APPROVED_MAXIMUM_COST_MICROS) {
    throw new Error("Pinned Gemini diagnostic exceeds the approved maximum cost.");
  }

  const sourceHash = sha256(resumeText);
  if (sourceHash !== EXPECTED_SOURCE_HASH) {
    throw new Error("Pinned Gemini diagnostic source does not match the approved synthetic fixture.");
  }
  const body = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV6,
    payload,
    responseJsonSchema: RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA,
    maxOutputTokens: DIAGNOSTIC_OUTPUT_TOKENS,
    thinkingLevel: "LOW"
  });
  const bodyJson = JSON.stringify(body);
  const requestHash = sha256(bodyJson);
  const schemaHash = sha256(JSON.stringify(body.generationConfig.responseJsonSchema));
  if (requestHash !== EXPECTED_REQUEST_HASH || schemaHash !== EXPECTED_SCHEMA_HASH) {
    throw new Error("Pinned Gemini diagnostic request does not match the approved hashes.");
  }

  return {
    bodyJson,
    endpoint: DIAGNOSTIC_ENDPOINT,
    maximumCostMicros,
    model: DIAGNOSTIC_MODEL,
    requestHash,
    responseBodyLimitBytes: MAX_RESPONSE_BYTES,
    schemaHash,
    sourceHash,
    wireSchemaVersion: PINNED_RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS
  };
}

function assertLocalDiagnosticRuntime() {
  const hosted = [
    process.env.VERCEL,
    process.env.VERCEL_ENV,
    process.env.AWS_LAMBDA_FUNCTION_NAME,
    process.env.K_SERVICE
  ].some((value) => Boolean(value));
  const continuousIntegration = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
  if (
    process.env.NODE_ENV === "production"
    || hosted
    || continuousIntegration
  ) {
    throw new Error("This command is restricted to a local interactive diagnostic runtime.");
  }
}

export async function runPinnedGeminiResumeDiagnostic(
  apiKey: string,
  options: { fetchImpl?: DiagnosticFetch; resumeText: string }
) {
  assertLocalDiagnosticRuntime();
  if (!apiKey.trim()) throw new Error("A Gemini API key must be supplied through the masked prompt.");
  const resumeText = options.resumeText;
  const request = buildPinnedGeminiResumeDiagnosticRequest(resumeText);
  const approvedFieldPaths = approvedFieldPathsFromRequest(JSON.parse(request.bodyJson));
  const response = await (options.fetchImpl ?? fetch)(request.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: request.bodyJson,
    signal: AbortSignal.timeout(request.timeoutMs)
  });
  const body = await readBoundedBody(response);
  if (!response.ok) {
    return safeRejectedResult(response, body, approvedFieldPaths, apiKey, resumeText);
  }
  if (body.truncated) {
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "RESPONSE_BODY_TOO_LARGE" as const,
      finishReason: null,
      usage: null,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: true
    };
  }

  let parsed: {
    candidates?: Array<{
      finishReason?: unknown;
      content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
    }>;
    usageMetadata?: Parameters<typeof readGeminiUsage>[0];
  };
  try {
    parsed = JSON.parse(body.text) as typeof parsed;
  } catch {
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "INVALID_RESPONSE_ENVELOPE" as const,
      finishReason: null,
      usage: null,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }
  const finishReason = safeToken(
    parsed.candidates?.[0]?.finishReason,
    apiKey,
    resumeText
  );
  let usage: ReturnType<typeof readGeminiUsage> | null = null;
  try {
    usage = readGeminiUsage(parsed.usageMetadata);
  } catch {
    usage = null;
  }
  if (finishReason !== "STOP") {
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "INCOMPLETE_RESPONSE" as const,
      finishReason,
      usage,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }
  if (usage === null) {
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "INVALID_USAGE" as const,
      finishReason: "STOP" as const,
      usage: null,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }

  const structuredText = parsed.candidates?.[0]?.content?.parts
    ?.filter((part) => part.thought !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("") ?? "";
  let value: unknown;
  try {
    value = JSON.parse(structuredText) as unknown;
  } catch {
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "INVALID_STRUCTURED_OUTPUT" as const,
      fieldPath: null,
      validationStage: "structured_json" as const,
      internalErrorCode: "STRUCTURED_JSON_PARSE_FAILED" as const,
      section: null,
      mismatchComponent: null,
      expected: null,
      actual: null,
      fingerprintAlgorithm: null,
      finishReason: "STOP" as const,
      usage,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }

  let consumerStage: "application_plan" | "job_match" | "tailoring" | null = null;
  try {
    const validated = assembleAndValidateResumeV6(resumeText, value);
    const consumerResume = { ...validated, rawText: resumeText };
    const diagnosticJob = {
      title: "Synthetic Systems Engineer",
      company: "Synthetic Boundary Labs",
      description: "Build reliable TypeScript systems with structured data and test automation.",
      requirements: ["TypeScript", "structured data", "test automation"],
      preferredQualifications: ["Cloud systems"],
      detectedTechStack: ["TypeScript"]
    };

    consumerStage = "application_plan";
    const plan = buildApplicationPlanPayload({ job: diagnosticJob, resume: consumerResume });
    const evidenceIds = new Set(plan.evidenceCatalog.map((entry) => entry.id));
    if (
      !evidenceIds.has("raw-source-1")
      || validated.projects.some((_, index) => !evidenceIds.has(`project-${index + 1}`))
      || validated.education.some((_, index) => !evidenceIds.has(`education-${index + 1}`))
      || validated.certifications.some((_, index) => !evidenceIds.has(`certification-${index + 1}`))
    ) {
      throw new Error("Application-plan consumer omitted canonical resume evidence.");
    }

    consumerStage = "job_match";
    const refs = getJobMatchEvidenceReferences({ job: diagnosticJob, resume: consumerResume });
    if (
      !refs.applicant.includes("resume.rawText")
      || validated.projects.some((_, index) => !refs.applicant.includes(`resume.projects[${index}]`))
      || validated.education.some((_, index) => !refs.applicant.includes(`resume.education[${index}]`))
      || validated.certifications.some((_, index) =>
        !refs.applicant.includes(`resume.certifications[${index}]`))
    ) {
      throw new Error("Job-match consumer omitted canonical resume evidence.");
    }

    consumerStage = "tailoring";
    const tailoring = buildResumeTailoringPayload(diagnosticJob, consumerResume, null);
    const tailoringResume = tailoring.resume as Record<string, unknown> | null;
    if (
      tailoringResume?.rawText !== resumeText
      || !Array.isArray(tailoringResume.projects)
      || tailoringResume.projects.length !== validated.projects.length
      || !Array.isArray(tailoringResume.education)
      || tailoringResume.education.length !== validated.education.length
      || !Array.isArray(tailoringResume.certifications)
      || tailoringResume.certifications.length !== validated.certifications.length
    ) {
      throw new Error("Tailoring consumer omitted canonical resume evidence.");
    }

    return {
      outcome: "validated" as const,
      httpStatus: response.status,
      finishReason: "STOP" as const,
      usage,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false,
      validation: {
        contractVersion: validated.contractVersion,
        sourceFacts: "complete" as const,
        sourceSectionCount: validated.sourceSections.length,
        workHistoryCount: validated.workHistory.length,
        projectCount: validated.projects.length,
        educationCount: validated.education.length,
        certificationCount: validated.certifications.length,
        achievementCount: validated.achievements.length,
        applicationPlan: "passed" as const,
        jobMatch: "passed" as const,
        tailoring: "passed" as const
      }
    };
  } catch (error) {
    const details = error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : null;
    const candidatePath = details && typeof details === "object" && "fieldPath" in details
      ? (details as { fieldPath?: unknown }).fieldPath
      : null;
    const fieldPath = typeof candidatePath === "string"
      && /^[A-Za-z][A-Za-z0-9]*(?:\[[0-9]+\]|\.[A-Za-z][A-Za-z0-9]*)*$/u.test(candidatePath)
      ? candidatePath
      : null;
    const classification = consumerStage === null
      ? classifyResumeValidationFailure(resumeText, value, error, apiKey)
      : {
          validationStage: consumerStage,
          internalErrorCode: "DIAGNOSTIC_CONSUMER_CHECK_FAILED" as const,
          section: null,
          mismatchComponent: null,
          expected: null,
          actual: null,
          fingerprintAlgorithm: null
        };
    return {
      outcome: "invalid_response" as const,
      httpStatus: response.status,
      category: "INVALID_STRUCTURED_OUTPUT" as const,
      fieldPath,
      ...classification,
      finishReason: "STOP" as const,
      usage,
      responseBodyBytes: body.bytes,
      responseBodyTruncated: false
    };
  }
}
