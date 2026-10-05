import { createHash } from "node:crypto";

import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import { runGeminiResumeDiagnosticCore } from "@/lib/ai/gemini-resume-diagnostic";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import {
  assembleAndValidateResumeV9,
  prepareResumeParseV9Request,
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_PROMPT_VERSION
} from "@/lib/ai/resume";
import { resumeParsePromptV9 } from "@/prompts/resumeParsePrompt";

const CANDIDATE_COMMIT = "e712ad7829f2706b147f4b76ef49337c0d246e1b";
const DIAGNOSTIC_MODEL = "gemini-3.5-flash-lite";
const DIAGNOSTIC_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const DIAGNOSTIC_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_INPUT_TOKENS = 12_000;
const DIAGNOSTIC_OUTPUT_TOKENS = 24_000;
const APPROVED_MAXIMUM_COST_MICROS = 63_600;
const PINNED_PROMPT_VERSION = "11";
const PINNED_CACHE_VERSION = "12";
const PINNED_WIRE_SCHEMA_VERSION = "6";
const EXPECTED_SOURCE_HASH = "579be60d3d8e66dfd013e7cfa92a689746a4f74f811ea3c31934521f24e62799";
const EXPECTED_REQUEST_HASH = "ea70c338a29242014f89eaa2b2d9b354898f262055a7746bee4862413b6237d7";
const EXPECTED_SCHEMA_HASH = "d59e1ba2ba364ddf3706fdc68922e8e1b31e492c6ee6dcbb4f40fa967d4e9db1";
const EXPECTED_CANONICAL_PROJECTION_HASH = "2d9771a9c6ba364376fbbc7ed98eecd86bde6601ddece5708c8923bb195d15a6";
const EXPECTED_SOURCE_BYTES = 5_447;
const EXPECTED_SOURCE_LINES = 65;
const EXPECTED_REACHABLE_NONBLANK_LINES = 46;
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeNarrativeProjection(value: string) {
  return value
    .trim()
    .replace(/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u, "")
    .replace(/\s+/gu, " ");
}

function canonicalEducationProjection(record: {
  credential: string | null;
  fieldOfStudy: string | null;
}) {
  const seen = new Set<string>();
  return [record.credential, record.fieldOfStudy]
    .filter((value): value is string => value !== null)
    .flatMap((value) => normalizeNarrativeProjection(value).split(" "))
    .filter((token) => token.toLocaleLowerCase("en-US") !== "in")
    .filter((token) => {
      const key = token.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" ");
}

export function fingerprintCanonicalResumeV9Projection(validated: {
  contactInfo: Record<string, string | null>;
  workHistory: Array<{
    sourceText: string;
    company: string;
    title: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: string[];
  }>;
  projects: Array<{
    sourceText: string;
    name: string;
    description: string | null;
    date: string | null;
    technologies: string[];
    bullets: string[];
  }>;
  education: Array<{
    sourceText: string;
    institution: string;
    credential: string | null;
    fieldOfStudy: string | null;
    startDate: string | null;
    endDate: string | null;
    details: string[];
  }>;
  certifications: Array<{
    sourceText: string;
    name: string;
    issuer: string | null;
    date: string | null;
    expirationDate: string | null;
    details: string[];
  }>;
}) {
  return sha256(JSON.stringify({
    contactInfo: validated.contactInfo,
    workHistory: validated.workHistory.map((record) => ({
      ...record,
      bullets: record.bullets.map(normalizeNarrativeProjection)
    })),
    projects: validated.projects.map((record) => ({
      ...record,
      bullets: record.bullets.map(normalizeNarrativeProjection)
    })),
    education: validated.education.map((record) => ({
      sourceText: record.sourceText,
      institution: record.institution,
      credentialAndFieldOfStudy: canonicalEducationProjection(record),
      startDate: record.startDate,
      endDate: record.endDate,
      details: record.details.map(normalizeNarrativeProjection)
    })),
    certifications: validated.certifications.map((record) => ({
      ...record,
      details: record.details.map(normalizeNarrativeProjection)
    }))
  }));
}

export function buildPinnedGeminiResumeV9DiagnosticRequest(resumeText = "") {
  if (
    RESUME_PARSE_PROMPT_VERSION !== PINNED_PROMPT_VERSION
    || RESUME_PARSE_CACHE_VERSION !== PINNED_CACHE_VERSION
    || RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION !== PINNED_WIRE_SCHEMA_VERSION
  ) {
    throw new Error("Pinned Gemini V9 diagnostic versions no longer match the candidate.");
  }

  const prepared = prepareResumeParseV9Request(resumeText, "gemini");
  if (prepared.policy.maxInputTokens !== DIAGNOSTIC_INPUT_TOKENS) {
    throw new Error("Pinned Gemini V9 diagnostic input policy does not match the approved bound.");
  }
  if (prepared.outputTokenLimit !== DIAGNOSTIC_OUTPUT_TOKENS) {
    throw new Error("Pinned Gemini V9 diagnostic output policy does not match the approved bound.");
  }
  const maximumCostMicros = estimateAiCostMicros({
    model: DIAGNOSTIC_MODEL,
    inputTokens: prepared.policy.maxInputTokens,
    outputTokens: prepared.outputTokenLimit
  });
  if (maximumCostMicros !== APPROVED_MAXIMUM_COST_MICROS) {
    throw new Error("Pinned Gemini V9 diagnostic cost no longer matches the approved maximum.");
  }

  const sourceBytes = Buffer.byteLength(prepared.normalizedText);
  const sourceLineCount = prepared.normalizedText.split(/\r?\n/u).length;
  const sourceHash = sha256(prepared.normalizedText);
  if (
    sourceBytes !== EXPECTED_SOURCE_BYTES
    || sourceLineCount !== EXPECTED_SOURCE_LINES
    || sourceHash !== EXPECTED_SOURCE_HASH
  ) {
    throw new Error("Pinned Gemini V9 diagnostic source does not match the approved synthetic fixture.");
  }

  const body = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV9,
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
    throw new Error("Pinned Gemini V9 diagnostic request does not match the approved hashes.");
  }

  return {
    bodyJson,
    cacheVersion: PINNED_CACHE_VERSION,
    candidateCommit: CANDIDATE_COMMIT,
    contractVersion: "9" as const,
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
    sourceBytes,
    sourceHash,
    sourceLineCount,
    thinkingLevel: "LOW" as const,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    wireSchemaVersion: PINNED_WIRE_SCHEMA_VERSION
  };
}

export async function runPinnedGeminiResumeV9Diagnostic(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; resumeText: string }
) {
  const result = await runGeminiResumeDiagnosticCore(apiKey, options, {
    assembleAndValidate: assembleAndValidateResumeV9,
    buildRequest: buildPinnedGeminiResumeV9DiagnosticRequest,
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
      const sourceLines = options.resumeText.split(/\r?\n/u);
      const nonblankSourceLines = sourceLines.map((line) => line.trim()).filter(Boolean);
      const reachableSource = validated.sourceSections.flatMap((section) => [
        section.heading,
        section.sourceText,
        ...section.recordBlocks
      ]).filter(Boolean).join("\n");
      if (
        contactProjectionCount !== 8
        || sourceLines.length !== EXPECTED_SOURCE_LINES
        || nonblankSourceLines.length !== EXPECTED_REACHABLE_NONBLANK_LINES
        || nonblankSourceLines.some((line) => !reachableSource.includes(line))
      ) {
        throw new Error("Pinned Gemini V9 diagnostic source reachability did not match the approved fixture.");
      }
      const educationSection = validated.sourceSections.find(
        (section) => section.section === "education"
      );
      const educationRecordLineCounts = educationSection?.recordBlocks.map(
        (record) => record.split(/\r?\n/u).filter((line) => line.trim()).length
      ) ?? [];
      const workBulletCount = validated.workHistory.reduce(
        (count, record) => count + record.bullets.length,
        0
      );
      const workBulletCounts = validated.workHistory.map((record) => record.bullets.length);
      const projectBulletCounts = validated.projects.map((record) => record.bullets.length);
      const projectTechnologyCounts = validated.projects.map(
        (record) => record.technologies.length
      );
      const educationDetailCounts = validated.education.map((record) => record.details.length);
      const certificationDetailCounts = validated.certifications.map(
        (record) => record.details.length
      );
      const canonicalProjectionHash = fingerprintCanonicalResumeV9Projection(validated);
      const completeWorkCore = validated.workHistory.every((record) =>
        record.title !== null
        && record.company !== null
        && record.startDate !== null
        && record.endDate !== null);
      const completeProjectCore = validated.projects.every((record) =>
        record.name !== null
        && record.description !== null
        && record.date !== null);
      const completeEducationCore = validated.education[0]?.institution !== null
        && validated.education[0]?.credential !== null
        && validated.education[0]?.startDate !== null
        && validated.education[0]?.endDate !== null
        && validated.education[1]?.institution !== null
        && validated.education[1]?.credential !== null
        && validated.education[1]?.fieldOfStudy !== null
        && validated.education[1]?.endDate !== null;
      const sourceSectionOrder = validated.sourceSections
        .map((section) => section.section)
        .join(",");
      if (
        validated.workHistory.length !== 5
        || workBulletCount !== 21
        || workBulletCounts.join(",") !== "4,4,5,3,5"
        || !completeWorkCore
        || validated.projects.length !== 2
        || projectBulletCounts.join(",") !== "1,1"
        || projectTechnologyCounts.join(",") !== "2,2"
        || !completeProjectCore
        || validated.education.length !== 2
        || educationRecordLineCounts.length !== 2
        || educationRecordLineCounts[0] !== 2
        || educationRecordLineCounts[1] !== 1
        || educationDetailCounts.join(",") !== "1,0"
        || !completeEducationCore
        || sourceSectionOrder !== "contactInfo,summary,skills,workHistory,projects,education"
        || validated.certifications.length !== 0
        || certificationDetailCounts.length !== 0
        || validated.achievements.length !== 0
        || canonicalProjectionHash !== EXPECTED_CANONICAL_PROJECTION_HASH
      ) {
        throw new Error("Pinned Gemini V9 diagnostic projections did not match the approved fixture.");
      }
      return {
        candidateCommit: CANDIDATE_COMMIT,
        recordAuthority: "server_owned_finite_ids" as const,
        sourceAuthority: "server_owned_lossless" as const,
        rawSourceFallback: "preserved" as const,
        contactProjectionCount,
        sourceLineCount: sourceLines.length,
        reachableNonblankLineCount: nonblankSourceLines.length,
        workBulletCount,
        workBulletCounts,
        projectBulletCounts,
        projectTechnologyCounts,
        educationDetailCounts,
        educationRecordLineCounts: educationRecordLineCounts as [number, number],
        certificationDetailCounts,
        canonicalProjectionCompleteness: "passed" as const,
        canonicalProjectionHash,
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
