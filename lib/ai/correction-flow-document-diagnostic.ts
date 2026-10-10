import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import JSZip from "jszip";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  assembleCoverLetterProviderOutput,
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  type CoverLetterProviderOutput,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  APPLICATION_DOCUMENT_MODEL,
  APPLICATION_DOCUMENT_PROMPT_VERSION,
  APPLICATION_DOCUMENT_THINKING_LEVEL
} from "@/lib/ai/application-document-version";
import { assertConservativeApplicationDocumentWireBound } from "@/lib/ai/client";
import {
  buildCoverLetterGeminiJsonSchema,
  buildCoverLetterSystemPrompt,
  coverLetterProviderSchema,
  coverLetterSchema
} from "@/lib/ai/documents";
import {
  buildGeminiJsonRequest,
  callGeminiJsonProvider,
  GeminiProviderError,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { hashAiInput } from "@/lib/ai/input-hash";
import { assertAiInputWithinLimits, AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { getModelPricing, type ModelPricing } from "@/lib/ai/pricing";
import {
  buildTailoredResumeGeminiJsonSchema,
  buildTailoredResumeSystemPrompt,
  tailoredResumeProviderSchema,
  tailoredResumeSchema
} from "@/lib/ai/resume";
import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
  renderCanonicalApplicationDocumentV1,
  renderGenericDocument
} from "@/lib/documents/export-renderer";
import { extractResumeDocxText } from "@/lib/resume-docx-text";

export const CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CONTRACT_VERSION = "1" as const;
export const CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CALL_COUNT = 2 as const;
export const CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_STEP_TIMEOUT_MS = 180_000 as const;

const FROZEN_SYNTHETIC_PAYLOAD_HASH =
  "8101fc98203c04abb7963b211a0a8542ed81f5faf8772e98cf6719e0635635c0";
const FROZEN_SYNTHETIC_REVIEWED_EVIDENCE_HASH =
  "7646bd358e0b45e25d74d1a85c66a7d9ed8bb7eafbd39b833e8a3863c29505ec";
const FROZEN_SYNTHETIC_FACT_CATALOG_HASH =
  "b26115a41ce6bdfd5c0775bbb10010052cec17ee8de2fe441f3ed2a072e02f15";
const FROZEN_SYNTHETIC_FACT_COUNT = 37;

const providerModeSchema = z.enum(["offline_stubbed", "live_synthetic"]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

type ProviderStage = "tailored_resume" | "cover_letter";
type DiagnosticStage = ProviderStage | "verify_exports";
type PricingSnapshot = Readonly<{
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  validFrom: string | null;
  validUntil: string | null;
}>;

type CallPlan = Readonly<{
  stage: ProviderStage;
  provider: "google-gemini-developer-api";
  model: typeof APPLICATION_DOCUMENT_MODEL;
  promptVersion: typeof APPLICATION_DOCUMENT_PROMPT_VERSION;
  thinkingLevel: typeof APPLICATION_DOCUMENT_THINKING_LEVEL;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumCostMicros: number;
  pricingSnapshot: PricingSnapshot;
  schemaHash: string;
  wireRequestHash: string;
}>;

export type CorrectionFlowDocumentDiagnosticManifest = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CONTRACT_VERSION;
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  generatedAt: string;
  callCount: typeof CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CALL_COUNT;
  stepTimeoutMs: typeof CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_STEP_TIMEOUT_MS;
  noRetry: true;
  noFallback: true;
  stopAfterFirstFailure: true;
  syntheticApplicantOnly: true;
  rawOutputRetention: false;
  outputEmission: false;
  inMemoryExportVerification: true;
  productionWrites: false;
  employerInteraction: false;
  safeLabel: string;
  calls: readonly [CallPlan, CallPlan];
  conservativeReservationMicros: number;
  payloadHash: string;
  reviewedEvidenceHash: string;
  factCatalogCount: number;
  factCatalogHash: string;
  manifestHash: string;
}>;

type RequestPlan = Readonly<{
  systemPrompt: string;
  responseJsonSchema: Record<string, unknown>;
  body: ReturnType<typeof buildGeminiJsonRequest>;
  policy: (typeof AI_FEATURE_POLICIES)[AiFeature];
}>;

function documentRequestPlan(
  stage: ProviderStage,
  payload: ApplicationDocumentPayload
): RequestPlan {
  const resume = stage === "tailored_resume";
  const feature = resume ? "RESUME_TAILOR" : "COVER_LETTER";
  const systemPrompt = resume
    ? buildTailoredResumeSystemPrompt(payload)
    : buildCoverLetterSystemPrompt(payload);
  const responseJsonSchema = resume
    ? buildTailoredResumeGeminiJsonSchema(payload)
    : buildCoverLetterGeminiJsonSchema(payload);
  const { policy } = assertAiInputWithinLimits(feature, systemPrompt, {
    payload,
    responseJsonSchema
  });
  const body = buildGeminiJsonRequest({
    systemPrompt,
    payload,
    responseJsonSchema,
    maxOutputTokens: policy.maxOutputTokens,
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
  });
  assertConservativeApplicationDocumentWireBound(feature, policy.maxInputTokens, body);
  return Object.freeze({ systemPrompt, responseJsonSchema, body, policy });
}

function buildCallPlan(stage: ProviderStage, payload: ApplicationDocumentPayload): CallPlan {
  const request = documentRequestPlan(stage, payload);
  const pricingSnapshot = applicationDocumentPricingSnapshot();
  return Object.freeze({
    stage,
    provider: "google-gemini-developer-api" as const,
    model: APPLICATION_DOCUMENT_MODEL,
    promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL,
    maximumInputTokens: request.policy.maxInputTokens,
    maximumOutputTokens: request.policy.maxOutputTokens,
    maximumCostMicros: estimateSnapshotCostMicros({
      pricing: pricingSnapshot,
      inputTokens: request.policy.maxInputTokens,
      outputTokens: request.policy.maxOutputTokens
    }),
    pricingSnapshot,
    schemaHash: hashAiInput(
      "correctionFlowDocumentDiagnosticSchema",
      stage,
      request.responseJsonSchema
    ),
    wireRequestHash: hashAiInput("correctionFlowProviderWire", "1", request.body)
  });
}

function applicationDocumentPricingSnapshot(): PricingSnapshot {
  const pricing = getModelPricing(APPLICATION_DOCUMENT_MODEL);
  return Object.freeze({
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
    validFrom: pricing.validFrom ?? null,
    validUntil: pricing.validUntil ?? null
  });
}

function estimateSnapshotCostMicros({
  pricing,
  inputTokens,
  outputTokens,
  cachedInputTokens = 0
}: {
  pricing: PricingSnapshot;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}) {
  const cachedTokens = Math.min(inputTokens, Math.max(0, cachedInputTokens));
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  return Math.max(0, Math.ceil(
    uncachedTokens * pricing.inputUsdPerMillion +
    cachedTokens * pricing.cachedInputUsdPerMillion +
    outputTokens * pricing.outputUsdPerMillion
  ));
}

function normalizedPricing(pricing: ModelPricing): PricingSnapshot {
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
    validFrom: pricing.validFrom ?? null,
    validUntil: pricing.validUntil ?? null
  };
}

export function buildCorrectionFlowDocumentDiagnosticManifest({
  exactHead,
  providerMode,
  generatedAt,
  payload,
  safeLabel
}: {
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  generatedAt: Date;
  payload: ApplicationDocumentPayload;
  safeLabel: string;
}): CorrectionFlowDocumentDiagnosticManifest {
  if (!/^[a-f0-9]{40}$/u.test(exactHead)) {
    throw new Error("Document diagnostic exact head must be a full Git SHA.");
  }
  providerModeSchema.parse(providerMode);
  const normalizedLabel = safeLabel.trim();
  if (!normalizedLabel || normalizedLabel.length > 160) {
    throw new Error("Document diagnostic safe label is invalid.");
  }
  if (!payload.reviewedEvidence) throw new Error("Document diagnostic reviewed evidence is required.");
  const payloadHash = hashAiInput("correctionFlowResumeDiagnosticPayload", "1", payload);
  const reviewedEvidenceHash = hashAiInput(
    "correctionFlowResumeDiagnosticReviewedEvidence",
    "1",
    payload.reviewedEvidence
  );
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factCatalogHash = hashAiInput("applicationDocumentFactCatalog", "7", facts);
  if (
    payloadHash !== FROZEN_SYNTHETIC_PAYLOAD_HASH ||
    reviewedEvidenceHash !== FROZEN_SYNTHETIC_REVIEWED_EVIDENCE_HASH ||
    factCatalogHash !== FROZEN_SYNTHETIC_FACT_CATALOG_HASH ||
    facts.length !== FROZEN_SYNTHETIC_FACT_COUNT
  ) {
    throw new Error("Document diagnostic requires the exact frozen synthetic fixture.");
  }
  const calls = Object.freeze([
    buildCallPlan("tailored_resume", payload),
    buildCallPlan("cover_letter", payload)
  ] as const);
  const core = Object.freeze({
    contractVersion: CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CONTRACT_VERSION,
    exactHead,
    providerMode,
    generatedAt: generatedAt.toISOString(),
    callCount: CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CALL_COUNT,
    stepTimeoutMs: CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_STEP_TIMEOUT_MS,
    noRetry: true as const,
    noFallback: true as const,
    stopAfterFirstFailure: true as const,
    syntheticApplicantOnly: true as const,
    rawOutputRetention: false as const,
    outputEmission: false as const,
    inMemoryExportVerification: true as const,
    productionWrites: false as const,
    employerInteraction: false as const,
    safeLabel: normalizedLabel,
    calls,
    conservativeReservationMicros: calls.reduce((total, call) => total + call.maximumCostMicros, 0),
    payloadHash,
    reviewedEvidenceHash,
    factCatalogCount: facts.length,
    factCatalogHash
  });
  return Object.freeze({
    ...core,
    manifestHash: hashAiInput("correctionFlowDocumentDiagnosticManifest", "1", core)
  });
}

export const correctionFlowDocumentDiagnosticConsent = z.object({
  manifestHash: sha256Schema,
  exactHead: z.string().regex(/^[a-f0-9]{40}$/u),
  providerMode: providerModeSchema,
  approvedCallCount: z.literal(CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CALL_COUNT),
  approvedConservativeReservationMicros: z.number().int().nonnegative(),
  approvedStepTimeoutMs: z.literal(CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_STEP_TIMEOUT_MS),
  syntheticApplicantDataSharingApproved: z.literal(true),
  existingCredentialUseApproved: z.boolean(),
  noRetry: z.literal(true),
  noFallback: z.literal(true),
  stopAfterFirstFailure: z.literal(true),
  noOwnerData: z.literal(true),
  noProductionWrites: z.literal(true),
  noEmployerInteraction: z.literal(true),
  rawOutputRetention: z.literal(false),
  outputEmission: z.literal(false),
  inMemoryExportVerification: z.literal(true),
  approvedAt: z.string().datetime({ offset: true })
}).strict();

export type CorrectionFlowDocumentDiagnosticConsent = z.infer<
  typeof correctionFlowDocumentDiagnosticConsent
>;

function assertConsent(
  manifest: CorrectionFlowDocumentDiagnosticManifest,
  value: unknown
) {
  const consent = correctionFlowDocumentDiagnosticConsent.parse(value);
  if (
    consent.manifestHash !== manifest.manifestHash ||
    consent.exactHead !== manifest.exactHead ||
    consent.providerMode !== manifest.providerMode ||
    consent.approvedConservativeReservationMicros !== manifest.conservativeReservationMicros ||
    consent.existingCredentialUseApproved !== (manifest.providerMode === "live_synthetic")
  ) {
    throw new Error("Document diagnostic consent does not match the frozen manifest.");
  }
  return consent;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

async function extractExactCanonicalDocxContent(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("Canonical DOCX is missing word/document.xml.");
  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
    .map((paragraph) => {
      const text = decodeXml(
        [...paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
          .map((match) => match[1])
          .join("")
      );
      return /<w:numPr(?:\s[^>]*)?>/u.test(paragraph[0]) ? `• ${text}` : text;
    })
    .join("\n");
}

function extractGeneratedPdfText(bytes: Buffer) {
  const source = bytes.toString("utf8");
  if (!source.startsWith("%PDF-1.4\n")) throw new Error("Canonical PDF header is missing.");
  return [...source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/gu)]
    .map((match) => match[1].replace(/\\([()\\])/gu, "$1"))
    .join("\n");
}

function comparable(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeBulletMarker(value: string, marker: "•" | "-") {
  return value.replace(/^\s*[-*•]\s+/u, `${marker} `);
}

function docxRoundTripComparable(value: string) {
  return value.split(/\r?\n/u).map((line) => normalizeBulletMarker(line, "•")).join("\n");
}

function pdfComparable(value: string) {
  return comparable(normalizeBulletMarker(value, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/gu, "?"));
}

function criticalFactsPresent(source: string, extracted: string, pdf: boolean) {
  const normalize = (line: string) => pdf
    ? pdfComparable(line)
    : comparable(normalizeBulletMarker(line, "•"));
  const haystack = comparable(extracted.split(/\r?\n/u).map(normalize).join("\n"));
  return source.split(/\r?\n/u)
    .map(normalize)
    .filter(Boolean)
    .every((line) => haystack.includes(line));
}

const exportArtifactSchema = z.object({
  docxByteHash: sha256Schema,
  docxExtractedTextHash: sha256Schema,
  pdfByteHash: sha256Schema,
  pdfExtractedTextHash: sha256Schema,
  docxRoundTripExact: z.boolean(),
  docxCriticalFactsPresent: z.boolean(),
  pdfCriticalFactsPresent: z.boolean()
}).strict();

const exportVerificationSchema = z.object({
  inMemoryOnly: z.literal(true),
  resume: exportArtifactSchema,
  coverLetter: exportArtifactSchema
}).strict();

export type CorrectionFlowDocumentExportVerification = z.infer<typeof exportVerificationSchema>;

async function verifyArtifact(
  artifactType: "RESUME" | "COVER_LETTER",
  content: string
) {
  const [docx, pdf] = await Promise.all([
    renderCanonicalApplicationDocumentV1({ artifactType, content }),
    renderGenericDocument({
      content,
      format: "pdf",
      resumeFormat: {
        template: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.template,
        pageSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.pageSize,
        fontFamily: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontFamily,
        accentColor: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.accentColor,
        fontSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontSize,
        lineSpacing: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.lineSpacing
      }
    })
  ]);
  const [exactDocx, productionDocx] = await Promise.all([
    extractExactCanonicalDocxContent(docx),
    extractResumeDocxText(docx)
  ]);
  const extractedPdf = extractGeneratedPdfText(pdf);
  return Object.freeze({
    docxByteHash: sha256(docx),
    docxExtractedTextHash: sha256(productionDocx),
    pdfByteHash: sha256(pdf),
    pdfExtractedTextHash: sha256(extractedPdf),
    docxRoundTripExact: docxRoundTripComparable(exactDocx) === docxRoundTripComparable(content),
    docxCriticalFactsPresent: criticalFactsPresent(content, productionDocx, false),
    pdfCriticalFactsPresent: criticalFactsPresent(content, extractedPdf, true)
  });
}

async function verifyExportsDefault(input: {
  tailoredResume: z.infer<typeof tailoredResumeSchema>;
  coverLetter: z.infer<typeof coverLetterSchema>;
}) {
  const [resume, coverLetter] = await Promise.all([
    verifyArtifact("RESUME", input.tailoredResume.resumeText),
    verifyArtifact("COVER_LETTER", input.coverLetter.coverLetter)
  ]);
  const verification = exportVerificationSchema.parse({
    inMemoryOnly: true,
    resume,
    coverLetter
  });
  if (
    !verification.resume.docxRoundTripExact ||
    !verification.resume.docxCriticalFactsPresent ||
    !verification.resume.pdfCriticalFactsPresent ||
    !verification.coverLetter.docxRoundTripExact ||
    !verification.coverLetter.docxCriticalFactsPresent ||
    !verification.coverLetter.pdfCriticalFactsPresent
  ) {
    throw new Error("In-memory application-document export verification failed.");
  }
  return verification;
}

function outputFieldPath(path: readonly PropertyKey[]) {
  let value = "output";
  for (const part of path) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) value += `[${part}]`;
    else if (typeof part === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(part)) value += `.${part}`;
    else return null;
  }
  return value.length <= 240 ? value : null;
}

function validatorFieldPath(value: unknown) {
  if (typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:(?:\.[A-Za-z][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/u.test(value)) {
    return null;
  }
  const parts = (value.match(/[A-Za-z][A-Za-z0-9_-]*|\[\d+\]/gu) ?? [])
    .map((part) => part.startsWith("[") ? Number(part.slice(1, -1)) : part);
  return outputFieldPath(parts);
}

class DocumentDiagnosticError extends Error {
  readonly code: string;
  readonly fieldPath: string | null;
  readonly failureClass: "unsupported_applicant_term" | "source_relation_mismatch" | null;

  constructor(
    code: string,
    message: string,
    options: {
      fieldPath?: string | null;
      failureClass?: "unsupported_applicant_term" | "source_relation_mismatch" | null;
    } = {}
  ) {
    super(message);
    this.name = "DocumentDiagnosticError";
    this.code = code;
    this.fieldPath = options.fieldPath ?? null;
    this.failureClass = options.failureClass ?? null;
  }
}

export type CorrectionFlowDocumentDiagnosticReceipt = Readonly<{
  contractVersion: typeof CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CONTRACT_VERSION;
  status: "passed" | "stopped";
  manifestHash: string;
  exactHead: string;
  providerMode: z.infer<typeof providerModeSchema>;
  conservativeReservationMicros: number;
  providerCallsStarted: number;
  providerCallsCompleted: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownCachedInputTokens: number;
  knownEstimatedCostMicros: number;
  unknownBillingCallCount: number;
  noRetryAttempted: true;
  noFallbackAttempted: true;
  stoppedAfterFirstFailure: true;
  rawOutputRetained: false;
  outputEmitted: false;
  failureStage: DiagnosticStage | null;
  failureCode: string | null;
  failureClass: "unsupported_applicant_term" | "source_relation_mismatch" | null;
  failureFieldPath: string | null;
  validatedOutputHashes: Readonly<{
    tailoredResume: string | null;
    coverLetter: string | null;
  }>;
  exportVerification: CorrectionFlowDocumentExportVerification | null;
}>;

function baseReceipt(
  manifest: CorrectionFlowDocumentDiagnosticManifest
): CorrectionFlowDocumentDiagnosticReceipt {
  return {
    contractVersion: CORRECTION_FLOW_DOCUMENT_DIAGNOSTIC_CONTRACT_VERSION,
    status: "stopped",
    manifestHash: manifest.manifestHash,
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    conservativeReservationMicros: manifest.conservativeReservationMicros,
    providerCallsStarted: 0,
    providerCallsCompleted: 0,
    knownInputTokens: 0,
    knownOutputTokens: 0,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 0,
    unknownBillingCallCount: 0,
    noRetryAttempted: true,
    noFallbackAttempted: true,
    stoppedAfterFirstFailure: true,
    rawOutputRetained: false,
    outputEmitted: false,
    failureStage: null,
    failureCode: null,
    failureClass: null,
    failureFieldPath: null,
    validatedOutputHashes: Object.freeze({ tailoredResume: null, coverLetter: null }),
    exportVerification: null
  };
}

export function createCorrectionFlowDocumentDiagnosticRunner({
  manifest,
  consent,
  payload,
  credentials,
  fetchImpl,
  verifyExports,
  now
}: {
  manifest: CorrectionFlowDocumentDiagnosticManifest;
  consent: CorrectionFlowDocumentDiagnosticConsent;
  payload: ApplicationDocumentPayload;
  credentials: Readonly<{ geminiApiKey: string }>;
  fetchImpl?: typeof fetch;
  verifyExports?: typeof verifyExportsDefault;
  now?: () => Date;
}) {
  const canonical = buildCorrectionFlowDocumentDiagnosticManifest({
    exactHead: manifest.exactHead,
    providerMode: manifest.providerMode,
    generatedAt: new Date(manifest.generatedAt),
    payload,
    safeLabel: manifest.safeLabel
  });
  if (!isDeepStrictEqual(canonical, manifest)) {
    throw new Error("Document diagnostic payload or metadata does not match the frozen manifest.");
  }
  assertConsent(canonical, consent);
  if (manifest.providerMode === "offline_stubbed" && typeof fetchImpl !== "function") {
    throw new Error("Offline document diagnostic requires an injected transport.");
  }
  if (manifest.providerMode === "live_synthetic" && fetchImpl !== undefined) {
    throw new Error("Live document diagnostic transport override is forbidden.");
  }
  if (manifest.providerMode === "live_synthetic" && verifyExports !== undefined) {
    throw new Error("Live document diagnostic export override is forbidden.");
  }
  if (manifest.providerMode === "live_synthetic" && now !== undefined) {
    throw new Error("Live document diagnostic clock override is forbidden.");
  }
  const apiKey = credentials.geminiApiKey.trim();
  if (!apiKey) throw new Error("Gemini credential is required.");
  const exportVerifier = verifyExports ?? verifyExportsDefault;
  const currentTime = now ?? (() => new Date());
  let used = false;

  return Object.freeze({
    async run(signal: AbortSignal): Promise<CorrectionFlowDocumentDiagnosticReceipt> {
      if (used) return { ...baseReceipt(manifest), failureCode: "DIAGNOSTIC_ALREADY_USED" };
      used = true;
      let receipt = baseReceipt(manifest);
      let failureStage: DiagnosticStage | null = null;
      let tailoredResume: z.infer<typeof tailoredResumeSchema> | null = null;
      let coverLetter: z.infer<typeof coverLetterSchema> | null = null;

      const recordUsage = (usage: GeminiUsage, pricing: PricingSnapshot) => {
        receipt = {
          ...receipt,
          knownInputTokens: receipt.knownInputTokens + usage.inputTokens,
          knownOutputTokens: receipt.knownOutputTokens + usage.outputTokens,
          knownCachedInputTokens: receipt.knownCachedInputTokens + usage.cachedInputTokens,
          knownEstimatedCostMicros: receipt.knownEstimatedCostMicros + estimateSnapshotCostMicros({
            pricing,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens
          })
        };
      };

      const runProviderStage = async (stage: ProviderStage) => {
        if (signal.aborted) {
          throw new DocumentDiagnosticError("EXECUTION_CANCELLED", "Document diagnostic was cancelled.");
        }
        const plan = manifest.calls.find((call) => call.stage === stage);
        if (!plan) throw new DocumentDiagnosticError("PROVIDER_STAGE_NOT_APPROVED", "Provider stage is absent.");
        const checkedAt = currentTime();
        let activePricing: PricingSnapshot;
        try {
          activePricing = normalizedPricing(getModelPricing(plan.model, checkedAt));
        } catch {
          throw new DocumentDiagnosticError(
            "AI_MODEL_PRICING_WINDOW_UNSAFE",
            "Document diagnostic pricing is not currently valid."
          );
        }
        const remainingCallCount = stage === "tailored_resume" ? 2 : 1;
        const validityDeadline = plan.pricingSnapshot.validUntil === null
          ? null
          : new Date(plan.pricingSnapshot.validUntil).getTime();
        if (
          !isDeepStrictEqual(activePricing, plan.pricingSnapshot) ||
          (validityDeadline !== null &&
            checkedAt.getTime() + remainingCallCount * manifest.stepTimeoutMs >= validityDeadline)
        ) {
          throw new DocumentDiagnosticError(
            "AI_MODEL_PRICING_WINDOW_UNSAFE",
            "Document diagnostic pricing cannot cover the remaining provider window."
          );
        }
        const request = documentRequestPlan(stage, payload);
        receipt = { ...receipt, providerCallsStarted: receipt.providerCallsStarted + 1 };
        let response;
        try {
          response = await callGeminiJsonProvider({
            apiKey,
            model: plan.model,
            systemPrompt: request.systemPrompt,
            payload,
            responseJsonSchema: request.responseJsonSchema,
            maxOutputTokens: request.policy.maxOutputTokens,
            thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL,
            timeoutMs: manifest.stepTimeoutMs,
            maxResponseBytes: 1_000_000,
            fetchImpl,
            signal
          });
        } catch (error) {
          const provider = error instanceof GeminiProviderError ? error : null;
          if (provider?.providerResponded === true) {
            receipt = { ...receipt, providerCallsCompleted: receipt.providerCallsCompleted + 1 };
          }
          if (provider?.usage) recordUsage(provider.usage, plan.pricingSnapshot);
          else if (provider?.billingDisposition !== "not_charged") {
            receipt = { ...receipt, unknownBillingCallCount: receipt.unknownBillingCallCount + 1 };
          }
          throw new DocumentDiagnosticError(
            signal.aborted ? "EXECUTION_CANCELLED" : "GEMINI_PROVIDER_FAILED",
            "Gemini document diagnostic did not complete safely."
          );
        }
        receipt = { ...receipt, providerCallsCompleted: receipt.providerCallsCompleted + 1 };
        recordUsage(response.usage, plan.pricingSnapshot);
        const stageCost = estimateSnapshotCostMicros({
          pricing: plan.pricingSnapshot,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cachedInputTokens: response.usage.cachedInputTokens
        });
        if (
          response.usage.inputTokens > plan.maximumInputTokens ||
          response.usage.outputTokens > plan.maximumOutputTokens ||
          response.usage.cachedInputTokens > response.usage.inputTokens ||
          stageCost > plan.maximumCostMicros ||
          receipt.knownEstimatedCostMicros > manifest.conservativeReservationMicros
        ) {
          throw new DocumentDiagnosticError(
            "CONSERVATIVE_RESERVATION_EXCEEDED",
            "Document diagnostic exceeded its frozen reservation."
          );
        }
        if (signal.aborted) {
          throw new DocumentDiagnosticError("EXECUTION_CANCELLED", "Document diagnostic was cancelled.");
        }

        if (stage === "tailored_resume") {
          const providerParsed = tailoredResumeProviderSchema.safeParse(response.value);
          if (!providerParsed.success) {
            throw new DocumentDiagnosticError(
              "PROVIDER_DOCUMENT_SCHEMA_INVALID",
              "Gemini returned an invalid resume shape.",
              { fieldPath: outputFieldPath(providerParsed.error.issues[0]?.path ?? []) }
            );
          }
          try {
            const assembled = assembleTailoredResumeProviderOutput(
              payload,
              providerParsed.data as TailoredResumeProviderOutput
            );
            return validateTailoredResumeClaims(payload, tailoredResumeSchema.parse(assembled));
          } catch (error) {
            const code = error instanceof PublicApiError &&
              typeof error.details?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.details.code)
              ? error.details.code
              : "PROVIDER_DOCUMENT_CLAIM_INVALID";
            const failureClass = error instanceof PublicApiError &&
              (error.details?.failureClass === "unsupported_applicant_term" ||
                error.details?.failureClass === "source_relation_mismatch")
              ? error.details.failureClass
              : null;
            throw new DocumentDiagnosticError(code, "Resume factual validation failed.", {
              fieldPath: error instanceof PublicApiError
                ? validatorFieldPath(error.details?.fieldPath)
                : null,
              failureClass
            });
          }
        }

        const providerParsed = coverLetterProviderSchema.safeParse(response.value);
        if (!providerParsed.success) {
          throw new DocumentDiagnosticError(
            "PROVIDER_DOCUMENT_SCHEMA_INVALID",
            "Gemini returned an invalid cover-letter shape.",
            { fieldPath: outputFieldPath(providerParsed.error.issues[0]?.path ?? []) }
          );
        }
        try {
          const assembled = assembleCoverLetterProviderOutput(
            payload,
            providerParsed.data as CoverLetterProviderOutput
          );
          return validateCoverLetterClaims(payload, coverLetterSchema.parse(assembled));
        } catch (error) {
          const code = error instanceof PublicApiError &&
            typeof error.details?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.details.code)
            ? error.details.code
            : "PROVIDER_DOCUMENT_CLAIM_INVALID";
          const failureClass = error instanceof PublicApiError &&
            (error.details?.failureClass === "unsupported_applicant_term" ||
              error.details?.failureClass === "source_relation_mismatch")
            ? error.details.failureClass
            : null;
          throw new DocumentDiagnosticError(code, "Cover-letter factual validation failed.", {
            fieldPath: error instanceof PublicApiError
              ? validatorFieldPath(error.details?.fieldPath)
              : null,
            failureClass
          });
        }
      };

      try {
        failureStage = "tailored_resume";
        tailoredResume = await runProviderStage("tailored_resume") as z.infer<typeof tailoredResumeSchema>;
        receipt = {
          ...receipt,
          validatedOutputHashes: {
            ...receipt.validatedOutputHashes,
            tailoredResume: hashAiInput("correctionFlowDocumentDiagnosticResume", "1", tailoredResume)
          }
        };
        failureStage = "cover_letter";
        coverLetter = await runProviderStage("cover_letter") as z.infer<typeof coverLetterSchema>;
        receipt = {
          ...receipt,
          validatedOutputHashes: {
            ...receipt.validatedOutputHashes,
            coverLetter: hashAiInput("correctionFlowDocumentDiagnosticCoverLetter", "1", coverLetter)
          }
        };
        failureStage = "verify_exports";
        if (signal.aborted) {
          throw new DocumentDiagnosticError("EXECUTION_CANCELLED", "Document diagnostic was cancelled.");
        }
        let exportVerification: CorrectionFlowDocumentExportVerification;
        try {
          exportVerification = exportVerificationSchema.parse(await exportVerifier({
            tailoredResume,
            coverLetter
          }));
        } catch {
          throw new DocumentDiagnosticError(
            "EXPORT_VERIFICATION_FAILED",
            "In-memory export verification failed."
          );
        }
        return Object.freeze({
          ...receipt,
          status: "passed" as const,
          failureStage: null,
          exportVerification
        });
      } catch (error) {
        const failure = error instanceof DocumentDiagnosticError
          ? error
          : new DocumentDiagnosticError("DOCUMENT_DIAGNOSTIC_FAILED", "Document diagnostic failed.");
        return Object.freeze({
          ...receipt,
          status: "stopped" as const,
          failureStage,
          failureCode: failure.code,
          failureClass: failure.failureClass,
          failureFieldPath: failure.fieldPath,
          exportVerification: null
        });
      } finally {
        tailoredResume = null;
        coverLetter = null;
      }
    }
  });
}
