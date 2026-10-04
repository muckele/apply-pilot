import { createHmac } from "node:crypto";

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { resumeParsePromptV6 } from "@/prompts/resumeParsePrompt";
import { resumeTailorPrompt } from "@/prompts/resumeTailorPrompt";
import {
  generateJson,
  getOpenAIClient,
  LocalAiUnavailableError,
  type AiInvocationOptions
} from "@/lib/ai/client";
import {
  findCachedAiResponse,
  getOrCreateAiSettings,
  hashAiInput,
  reconcileAiReservation,
  reconcileStaleAiReservations,
  reserveAiBudget
} from "@/lib/ai/application-plan-budget";
import {
  getAiFinancialPolicy,
  getAiModel,
  getAiProviderForFeature,
  getAiRuntimeMode
} from "@/lib/ai/config";
import {
  callGeminiJsonProvider,
  GeminiProviderError,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { AI_FEATURE_POLICIES, assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing, type AiProviderName } from "@/lib/ai/pricing";
import {
  buildResumeSourceCatalog,
  buildResumeProviderSourceInput,
  hasResumeSectionHeading,
  normalizeResumeLineEndings,
  type ResumeSourceSectionName,
  type ResumeTypedSectionName
} from "@/lib/ai/resume-source-catalog";
import { assembleParsedResumeFromSpans } from "@/lib/ai/resume-source-spans";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

export type { ResumeSourceSectionName } from "@/lib/ai/resume-source-catalog";

export const RESUME_PARSE_PROMPT_VERSION = "7";
export const RESUME_PARSE_CACHE_VERSION = "8";
export const RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION = "3";
export const RESUME_PARSE_PLANNED_JSON_TOKENS = 16_000;
const OPENAI_RESUME_PARSE_OUTPUT_TOKENS = 16_000;
const RESUME_PARSE_JSON_BYTES_PER_TOKEN = 2;
export const RESUME_PARSE_PLANNED_JSON_BYTES =
  RESUME_PARSE_PLANNED_JSON_TOKENS * RESUME_PARSE_JSON_BYTES_PER_TOKEN;
// JSON.stringify can expand one UTF-16 code unit to a six-byte `\uXXXX` escape.
// Reserve the full escaped warning budget so optional metadata cannot invalidate
// an otherwise-safe structured-output admission estimate.
const RESUME_PARSE_WARNING_CONTENT_BYTES = 5 * 100 * 6;
// sourceSections.sourceText plus its ordered recordBlocks account for two copies.
// The remaining copies are the minimum conservative allowance for the required
// typed projection: one canonical source/source-list copy, one semantic projection
// copy for structural records, and one extra project copy because technologies may
// legitimately overlap narrative bullets. JSON keys and collection punctuation are
// measured separately from the actual response shape below.
const RESUME_PARSE_REQUIRED_CONTENT_COPIES: Record<ResumeSourceSectionName, number> = {
  contactInfo: 4,
  summary: 3,
  skills: 3,
  workHistory: 4,
  projects: 5,
  education: 4,
  certifications: 4,
  achievements: 3,
  additional: 2
};

type ResumeSectionStatus = "present" | "absent";

type ResumeWorkHistoryItem = {
  sourceText: string;
  company: string;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  bullets: string[];
};

type ResumeProjectItem = {
  sourceText: string;
  name: string;
  description: string | null;
  date: string | null;
  technologies: string[];
  bullets: string[];
};

type ResumeEducationItem = {
  sourceText: string;
  institution: string;
  credential: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  details: string[];
};

type ResumeCertificationItem = {
  sourceText: string;
  name: string;
  issuer: string | null;
  date: string | null;
  expirationDate: string | null;
  details: string[];
};

export type ResumeSourceSection = {
  section: ResumeSourceSectionName;
  heading: string | null;
  sourceText: string;
  recordBlocks: string[];
};

type ParsedResumeCore = {
  contactInfo: {
    sourceText: string;
    name: string | null;
    headline: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    linkedin: string | null;
    github: string | null;
    portfolio: string | null;
  };
  summary: string;
  skills: string[];
  workHistory: ResumeWorkHistoryItem[];
  projects: ResumeProjectItem[];
  education: ResumeEducationItem[];
  certifications: ResumeCertificationItem[];
  achievements: string[];
  sectionStatus: {
    summary: ResumeSectionStatus;
    skills: ResumeSectionStatus;
    workHistory: ResumeSectionStatus;
    projects: ResumeSectionStatus;
    education: ResumeSectionStatus;
    certifications: ResumeSectionStatus;
    achievements: ResumeSectionStatus;
  };
  warnings: string[];
};

export type ParsedResumeV5 = ParsedResumeCore & {
  contractVersion: "5";
  sourceSections: ResumeSourceSection[];
};

export type ParsedResumeV6 = ParsedResumeCore & {
  contractVersion: "6";
  sourceSections: ResumeSourceSection[];
};

export type LegacyParsedResume = Omit<ParsedResumeCore, "certifications" | "projects"> & {
  contractVersion: "3";
  projects: Array<Omit<ResumeProjectItem, "date"> & { date?: string | null }>;
  certifications: Array<Omit<ResumeCertificationItem, "details"> & { details?: string[] }>;
};

export type ParsedResume = ParsedResumeV6 | ParsedResumeV5 | LegacyParsedResume;

export type ResumeParseRecordSpanV6 = {
  sectionId: string;
  startLineId: string;
  endLineId: string;
};

export type ResumeParseProviderV6 = {
  contractVersion: "6";
  recordSpans: ResumeParseRecordSpanV6[];
  contactInfo: Omit<ParsedResumeCore["contactInfo"], "sourceText">;
  summary: string;
  skills: string[];
  workHistory: Array<Omit<ResumeWorkHistoryItem, "sourceText"> & { spanIndex: number }>;
  projects: Array<Omit<ResumeProjectItem, "sourceText"> & { spanIndex: number }>;
  education: Array<Omit<ResumeEducationItem, "sourceText"> & { spanIndex: number }>;
  certifications: Array<Omit<ResumeCertificationItem, "sourceText"> & { spanIndex: number }>;
  achievements: string[];
  sectionStatus: ParsedResumeCore["sectionStatus"];
  warnings: string[];
};

export type ResumeValidationDiagnostic = {
  validationStage: "resume_schema" | "lossless_source_authority" | "typed_projection";
  internalErrorCode: string | null;
  section: ResumeSourceSectionName | null;
  mismatchComponent: string | null;
  expected: {
    unit: "utf8_bytes" | "properties";
    count: number;
    fingerprint: string | null;
  } | null;
  actual: {
    unit: "utf8_bytes" | "properties";
    count: number;
    fingerprint: string | null;
  } | null;
  fingerprintAlgorithm: "HMAC-SHA256" | null;
};

export type TailoredResumeOutput = {
  professionalSummary: string;
  skillsSection: string[];
  bulletRewrites: Array<{ original: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: string[];
  unsupportedKeywords: string[];
  formattingWarnings: string[];
  atsCompatibilityScore: number;
  jobFitScore: number;
  resumeText: string;
};

const scoreSchema = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));
function hasWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

const boundedSourceString = z.string().trim().min(1).max(2_000)
  .refine(hasWellFormedUtf16)
  .refine((value) => !/[\r\n]/.test(value));
const boundedSourceBlock = z.string().trim().min(1).max(20_000)
  .refine(hasWellFormedUtf16);
const nullableSourceString = z.union([boundedSourceString, z.null()]);
const nullableContactSourceString = z.union([
  boundedSourceString.refine((value) => !/[\r\n]/.test(value)),
  z.null()
]);
const sourceStringList = z.array(boundedSourceString).max(100);
const RESUME_PARSE_SOURCE_SECTION_LIMIT = 100;
const RESUME_PARSE_RECORD_BLOCK_LIMIT = 100;
const RESUME_PARSE_RECORD_PROJECTION_ITEMS = 25;
const recordSourceStringList = z.array(boundedSourceString)
  .max(RESUME_PARSE_RECORD_PROJECTION_ITEMS);
const sectionStatusSchema = z.enum(["present", "absent"]);
const forbiddenResumeControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const warningSchema = z.string().trim().min(1).max(100)
  .refine(hasWellFormedUtf16)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value));

const sourceSectionSchema = z.object({
  section: z.enum([
    "contactInfo", "summary", "skills", "workHistory", "projects", "education",
    "certifications", "achievements", "additional"
  ]),
  heading: nullableSourceString,
  sourceText: boundedSourceBlock,
  recordBlocks: z.array(boundedSourceBlock).min(1).max(RESUME_PARSE_RECORD_BLOCK_LIMIT)
}).strict();

export const parsedResumeSchema: z.ZodType<ParsedResumeV5, z.ZodTypeDef, unknown> = z.object({
  contractVersion: z.literal("5"),
  sourceSections: z.array(sourceSectionSchema).min(1).max(RESUME_PARSE_SOURCE_SECTION_LIMIT),
  contactInfo: z.object({
    sourceText: z.string().trim().max(20_000).refine(hasWellFormedUtf16),
    name: nullableContactSourceString,
    headline: nullableContactSourceString,
    email: nullableContactSourceString,
    phone: nullableContactSourceString,
    location: nullableContactSourceString,
    linkedin: nullableContactSourceString,
    github: nullableContactSourceString,
    portfolio: nullableContactSourceString
  }).strict(),
  summary: z.string().trim().max(2_000).refine(hasWellFormedUtf16),
  skills: sourceStringList,
  workHistory: z.array(z.object({
    sourceText: boundedSourceBlock,
    company: boundedSourceString,
    title: boundedSourceString,
    location: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    bullets: recordSourceStringList
  }).strict()).max(50),
  projects: z.array(z.object({
    sourceText: boundedSourceBlock,
    name: boundedSourceString,
    description: nullableSourceString,
    date: nullableSourceString,
    technologies: recordSourceStringList,
    bullets: recordSourceStringList
  }).strict()).max(50),
  education: z.array(z.object({
    sourceText: boundedSourceBlock,
    institution: boundedSourceString,
    credential: nullableSourceString,
    fieldOfStudy: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    details: recordSourceStringList
  }).strict()).max(30),
  certifications: z.array(z.object({
    sourceText: boundedSourceBlock,
    name: boundedSourceString,
    issuer: nullableSourceString,
    date: nullableSourceString,
    expirationDate: nullableSourceString,
    details: recordSourceStringList
  }).strict()).max(50),
  achievements: sourceStringList,
  sectionStatus: z.object({
    summary: sectionStatusSchema,
    skills: sectionStatusSchema,
    workHistory: sectionStatusSchema,
    projects: sectionStatusSchema,
    education: sectionStatusSchema,
    certifications: sectionStatusSchema,
    achievements: sectionStatusSchema
  }).strict(),
  warnings: z.array(warningSchema).max(5)
}).strict();

export const RESUME_PARSE_RECORD_SPAN_LIMIT = 180;
const sourceSectionIdSchema = z.string().regex(/^section-[1-9][0-9]*$/u);
const sourceLineIdSchema = z.string().regex(/^section-[1-9][0-9]*-line-[1-9][0-9]*$/u);
const spanIndexSchema = z.number().int().min(0).max(RESUME_PARSE_RECORD_SPAN_LIMIT - 1);
const recordSpanSchema = z.object({
  sectionId: sourceSectionIdSchema,
  startLineId: sourceLineIdSchema,
  endLineId: sourceLineIdSchema
}).strict();

export const resumeParseProviderV6Schema: z.ZodType<
  ResumeParseProviderV6,
  z.ZodTypeDef,
  unknown
> = z.object({
  contractVersion: z.literal("6"),
  recordSpans: z.array(recordSpanSchema).max(RESUME_PARSE_RECORD_SPAN_LIMIT),
  contactInfo: z.object({
    name: nullableContactSourceString,
    headline: nullableContactSourceString,
    email: nullableContactSourceString,
    phone: nullableContactSourceString,
    location: nullableContactSourceString,
    linkedin: nullableContactSourceString,
    github: nullableContactSourceString,
    portfolio: nullableContactSourceString
  }).strict(),
  summary: z.string().trim().max(2_000).refine(hasWellFormedUtf16),
  skills: sourceStringList,
  workHistory: z.array(z.object({
    spanIndex: spanIndexSchema,
    company: boundedSourceString,
    title: boundedSourceString,
    location: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    bullets: recordSourceStringList
  }).strict()).max(50),
  projects: z.array(z.object({
    spanIndex: spanIndexSchema,
    name: boundedSourceString,
    description: nullableSourceString,
    date: nullableSourceString,
    technologies: recordSourceStringList,
    bullets: recordSourceStringList
  }).strict()).max(50),
  education: z.array(z.object({
    spanIndex: spanIndexSchema,
    institution: boundedSourceString,
    credential: nullableSourceString,
    fieldOfStudy: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    details: recordSourceStringList
  }).strict()).max(30),
  certifications: z.array(z.object({
    spanIndex: spanIndexSchema,
    name: boundedSourceString,
    issuer: nullableSourceString,
    date: nullableSourceString,
    expirationDate: nullableSourceString,
    details: recordSourceStringList
  }).strict()).max(50),
  achievements: sourceStringList,
  sectionStatus: z.object({
    summary: sectionStatusSchema,
    skills: sectionStatusSchema,
    workHistory: sectionStatusSchema,
    projects: sectionStatusSchema,
    education: sectionStatusSchema,
    certifications: sectionStatusSchema,
    achievements: sectionStatusSchema
  }).strict(),
  warnings: z.array(warningSchema).max(5)
}).strict();

const nullableJsonString = { type: ["string", "null"], maxLength: 2_000 } as const;
const jsonString = { type: "string", maxLength: 2_000 } as const;
const jsonSourceBlock = { type: "string", maxLength: 20_000 } as const;
const jsonStringArray = { type: "array", items: jsonString, maxItems: 100 } as const;
const jsonRecordStringArray = {
  type: "array",
  items: jsonString,
  maxItems: RESUME_PARSE_RECORD_PROJECTION_ITEMS
} as const;

export const RESUME_PARSE_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contractVersion: { type: "string", enum: ["5"] },
    sourceSections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          section: {
            type: "string",
            enum: [
              "contactInfo", "summary", "skills", "workHistory", "projects", "education",
              "certifications", "achievements", "additional"
            ]
          },
          heading: nullableJsonString,
          sourceText: jsonSourceBlock,
          recordBlocks: {
            type: "array",
            items: jsonSourceBlock,
            maxItems: RESUME_PARSE_RECORD_BLOCK_LIMIT
          }
        },
        required: ["section", "heading", "sourceText", "recordBlocks"]
      },
      minItems: 1,
      maxItems: RESUME_PARSE_SOURCE_SECTION_LIMIT
    },
    contactInfo: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceText: jsonSourceBlock,
        name: nullableJsonString,
        headline: nullableJsonString,
        email: nullableJsonString,
        phone: nullableJsonString,
        location: nullableJsonString,
        linkedin: nullableJsonString,
        github: nullableJsonString,
        portfolio: nullableJsonString
      },
      required: ["sourceText", "name", "headline", "email", "phone", "location", "linkedin", "github", "portfolio"]
    },
    summary: { type: "string", maxLength: 2_000 },
    skills: jsonStringArray,
    workHistory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonSourceBlock,
          company: jsonString,
          title: jsonString,
          location: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          bullets: jsonRecordStringArray
        },
        required: ["sourceText", "company", "title", "location", "startDate", "endDate", "bullets"]
      },
      maxItems: 50
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonSourceBlock,
          name: jsonString,
          description: nullableJsonString,
          date: nullableJsonString,
          technologies: jsonRecordStringArray,
          bullets: jsonRecordStringArray
        },
        required: ["sourceText", "name", "description", "date", "technologies", "bullets"]
      },
      maxItems: 50
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonSourceBlock,
          institution: jsonString,
          credential: nullableJsonString,
          fieldOfStudy: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          details: jsonRecordStringArray
        },
        required: ["sourceText", "institution", "credential", "fieldOfStudy", "startDate", "endDate", "details"]
      },
      maxItems: 30
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonSourceBlock,
          name: jsonString,
          issuer: nullableJsonString,
          date: nullableJsonString,
          expirationDate: nullableJsonString,
          details: jsonRecordStringArray
        },
        required: ["sourceText", "name", "issuer", "date", "expirationDate", "details"]
      },
      maxItems: 50
    },
    achievements: jsonStringArray,
    sectionStatus: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", enum: ["present", "absent"] },
        skills: { type: "string", enum: ["present", "absent"] },
        workHistory: { type: "string", enum: ["present", "absent"] },
        projects: { type: "string", enum: ["present", "absent"] },
        education: { type: "string", enum: ["present", "absent"] },
        certifications: { type: "string", enum: ["present", "absent"] },
        achievements: { type: "string", enum: ["present", "absent"] }
      },
      required: [
        "summary", "skills", "workHistory", "projects", "education", "certifications", "achievements"
      ]
    },
    warnings: {
      type: "array",
      items: { type: "string", maxLength: 100, pattern: "^[^\\u0000-\\u001F\\u007F]*$" },
      maxItems: 5
    }
  },
  required: [
    "contractVersion", "sourceSections", "contactInfo", "summary", "skills", "workHistory", "projects",
    "education", "certifications", "achievements", "sectionStatus", "warnings"
  ]
} as const;

const jsonSpanIndex = {
  type: "integer",
  minimum: 0,
  maximum: RESUME_PARSE_RECORD_SPAN_LIMIT - 1
} as const;

export const RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contractVersion: { type: "string", enum: ["6"] },
    recordSpans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sectionId: { type: "string", pattern: "^section-[1-9][0-9]*$" },
          startLineId: {
            type: "string",
            pattern: "^section-[1-9][0-9]*-line-[1-9][0-9]*$"
          },
          endLineId: {
            type: "string",
            pattern: "^section-[1-9][0-9]*-line-[1-9][0-9]*$"
          }
        },
        required: ["sectionId", "startLineId", "endLineId"]
      },
      maxItems: RESUME_PARSE_RECORD_SPAN_LIMIT
    },
    contactInfo: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: nullableJsonString,
        headline: nullableJsonString,
        email: nullableJsonString,
        phone: nullableJsonString,
        location: nullableJsonString,
        linkedin: nullableJsonString,
        github: nullableJsonString,
        portfolio: nullableJsonString
      },
      required: ["name", "headline", "email", "phone", "location", "linkedin", "github", "portfolio"]
    },
    summary: { type: "string", maxLength: 2_000 },
    skills: jsonStringArray,
    workHistory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          spanIndex: jsonSpanIndex,
          company: jsonString,
          title: jsonString,
          location: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          bullets: jsonRecordStringArray
        },
        required: ["spanIndex", "company", "title", "location", "startDate", "endDate", "bullets"]
      },
      maxItems: 50
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          spanIndex: jsonSpanIndex,
          name: jsonString,
          description: nullableJsonString,
          date: nullableJsonString,
          technologies: jsonRecordStringArray,
          bullets: jsonRecordStringArray
        },
        required: ["spanIndex", "name", "description", "date", "technologies", "bullets"]
      },
      maxItems: 50
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          spanIndex: jsonSpanIndex,
          institution: jsonString,
          credential: nullableJsonString,
          fieldOfStudy: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          details: jsonRecordStringArray
        },
        required: ["spanIndex", "institution", "credential", "fieldOfStudy", "startDate", "endDate", "details"]
      },
      maxItems: 30
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          spanIndex: jsonSpanIndex,
          name: jsonString,
          issuer: nullableJsonString,
          date: nullableJsonString,
          expirationDate: nullableJsonString,
          details: jsonRecordStringArray
        },
        required: ["spanIndex", "name", "issuer", "date", "expirationDate", "details"]
      },
      maxItems: 50
    },
    achievements: jsonStringArray,
    sectionStatus: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", enum: ["present", "absent"] },
        skills: { type: "string", enum: ["present", "absent"] },
        workHistory: { type: "string", enum: ["present", "absent"] },
        projects: { type: "string", enum: ["present", "absent"] },
        education: { type: "string", enum: ["present", "absent"] },
        certifications: { type: "string", enum: ["present", "absent"] },
        achievements: { type: "string", enum: ["present", "absent"] }
      },
      required: [
        "summary", "skills", "workHistory", "projects", "education", "certifications", "achievements"
      ]
    },
    warnings: {
      type: "array",
      items: { type: "string", maxLength: 100, pattern: "^[^\\u0000-\\u001F\\u007F]*$" },
      maxItems: 5
    }
  },
  required: [
    "contractVersion", "recordSpans", "contactInfo", "summary", "skills", "workHistory",
    "projects", "education", "certifications", "achievements", "sectionStatus", "warnings"
  ]
} as const;

function omitMaxItemsFromJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitMaxItemsFromJsonSchema);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "maxItems" ? [] : [[key, omitMaxItemsFromJsonSchema(child)]])
  );
}

// Gemini can reject this otherwise-valid, deeply nested schema when all fourteen
// array maxima are present. Keep the complete canonical contract above for local
// validation, admission estimates, OpenAI, and every consumer. Only the Gemini
// wire representation omits maxItems; minItems and all structural constraints stay.
export const RESUME_PARSE_GEMINI_RESPONSE_JSON_SCHEMA =
  omitMaxItemsFromJsonSchema(RESUME_PARSE_RESPONSE_JSON_SCHEMA) as Record<string, unknown>;

export const RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA =
  omitMaxItemsFromJsonSchema(RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA) as Record<string, unknown>;

const tailoredResumeSchema: z.ZodType<TailoredResumeOutput, z.ZodTypeDef, unknown> = z.object({
  professionalSummary: z.string(),
  skillsSection: z.array(z.string()),
  bulletRewrites: z.array(
    z.object({
      original: z.string(),
      rewrite: z.string(),
      reason: z.string()
    })
  ),
  rolesOrProjectsToEmphasize: z.array(z.string()),
  unsupportedKeywords: z.array(z.string()),
  formattingWarnings: z.array(z.string()),
  atsCompatibilityScore: scoreSchema,
  jobFitScore: scoreSchema,
  resumeText: z.string()
});

function assertSourceSupported(source: string, value: string | null, path: string) {
  if (value === null || value === "") return;
  if (!source.includes(value)) {
    throw new PublicApiError(
      `Resume parsing returned ${path} that is not supported by the submitted resume source.`,
      422,
      { code: "RESUME_PARSE_UNSUPPORTED_FACT", fieldPath: path, retryable: false }
    );
  }
}

function assertOrderedSourceProjectionList(source: string, values: string[], fieldPath: string) {
  let cursor = 0;
  for (const [index, value] of values.entries()) {
    const start = source.indexOf(value, cursor);
    if (start < 0) {
      throw new PublicApiError(
        `Resume parsing returned duplicate or reordered entries in ${fieldPath}. No master resume was changed.`,
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          fieldPath: `${fieldPath}[${index}]`,
          retryable: false
        }
      );
    }
    cursor = start + value.length;
  }
}

function isExplicitResumeListEntry(entry: string) {
  return /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(entry);
}

function isUnambiguousNarrativeEntry(entry: string) {
  const explicitBullet = isExplicitResumeListEntry(entry);
  const completeStatement = !/[\r\n]/.test(entry) && /[.!?…]$/u.test(entry);
  return explicitBullet || completeStatement;
}

function assertUnambiguousNarrativeEntries(entries: string[], section: string, fieldPath: string) {
  entries.forEach((entry, index) => {
    const ambiguousWorkPipeNarrative = section === "workHistory" &&
      entry.includes("|") &&
      !isExplicitResumeListEntry(entry);
    if (!isUnambiguousNarrativeEntry(entry) || ambiguousWorkPipeNarrative) {
      throw new PublicApiError(
        `Resume parsing returned an ambiguous ${section} detail that could be a merged record boundary. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, fieldPath: `${fieldPath}[${index}]`, retryable: false }
      );
    }
  });
}

const englishRegionNames = (() => {
  const names = new Set<string>();
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = displayNames.of(code);
      if (name && name !== code) names.add(name.toLowerCase());
    }
  }
  return names;
})();

const commonRegionAbbreviations = new Set([
  ..."AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
  ..."AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "),
  ..."ACT NSW NT QLD SA TAS VIC WA".split(" ")
]);

const credentialDescriptorPattern = /^(?:cpa|cfa|mba|ph\.?d\.?|rn|esq)$/i;

function isStandaloneContactLocation(line: string) {
  const normalized = line.trim().toLowerCase();
  return /^(?:remote|hybrid|on[- ]?site|in[- ]person|usa|uk)$/i.test(normalized) ||
    englishRegionNames.has(normalized);
}

function classifyContactLocation(line: string): "location" | "not_location" | "ambiguous" {
  if (/^\s*(?:location|address)\s*:/i.test(line)) return "location";
  const trimmed = line.trim();
  if (isStandaloneContactLocation(trimmed)) return "location";
  if (commonRegionAbbreviations.has(trimmed.toUpperCase())) return "ambiguous";
  const tokens = trimmed.split(/\s+/);
  const trailingToken = tokens.at(-1);
  if (!line.includes(",") && tokens.length > 1 && trailingToken && commonRegionAbbreviations.has(trailingToken)) {
    const prefix = tokens.slice(0, -1).join(" ");
    return credentialDescriptorPattern.test(prefix) ? "not_location" : "ambiguous";
  }
  const suffix = line.split(",").at(-1)?.trim();
  const hasCountryOrRemote = /\b(?:remote|united states|usa|canada|united kingdom|uk)\b/i.test(line);
  const hasCountrySuffix = [...englishRegionNames].some((country) =>
    trimmed.toLowerCase().endsWith(` ${country}`)
  );
  const hasRegionSuffix = Boolean(
    suffix &&
    suffix !== trimmed &&
    (commonRegionAbbreviations.has(suffix) || englishRegionNames.has(suffix.toLowerCase()))
  );
  if (!hasCountryOrRemote && !hasCountrySuffix && !hasRegionSuffix) return "not_location";
  const prefix = line.includes(",")
    ? line.slice(0, line.lastIndexOf(",")).trim()
    : tokens.slice(0, -1).join(" ");
  return credentialDescriptorPattern.test(prefix) ? "not_location" : "ambiguous";
}

const resumeDateAtom = [
  "(?:present|current|ongoing|now)",
  "(?:(?:19|20)\\d{2})",
  "(?:(?:19|20)\\d{2}[-/.]\\d{1,2}(?:[-/.]\\d{1,2})?)",
  "(?:\\d{1,2}[-/.](?:19|20)\\d{2})",
  "(?:\\d{1,2}[-/.]\\d{1,2}(?:[-/.](?:\\d{2}|\\d{4}))?)",
  "(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+)?(?:19|20)\\d{2})",
  "(?:(?:q[1-4]|spring|summer|fall|autumn|winter)\\s+(?:19|20)\\d{2})"
].join("|");
const resumeDatePattern = new RegExp(
  `^(?:(?:issued|expires?|expiration|completed|graduated|expected|anticipated)[:\\s]+)?(?:${resumeDateAtom})(?:\\s*(?:-|–|—|to|through)\\s*(?:${resumeDateAtom}))?$`,
  "i"
);
function assertResumeDate(
  value: string | null,
  section: string,
  semanticLabel = `${section} date`,
  fieldPath?: string
) {
  if (value === null || resumeDatePattern.test(value)) return;
  throw new PublicApiError(
    `Resume parsing returned an invalid ${semanticLabel} that could conceal a merged record. No master resume was changed.`,
    422,
    { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, ...(fieldPath ? { fieldPath } : {}), retryable: false }
  );
}

function hasExactDelimitedProjectHeader(item: ResumeProjectItem) {
  if (!item.description || !item.date) return false;
  const firstLine = item.sourceText.split(/\r?\n/, 1)[0] ?? "";
  const parts = firstLine.split(" | ");
  return parts.length === 3 &&
    parts[0] === item.name &&
    parts[1] === item.description &&
    parts[2] === item.date;
}

function assertProjectStructure(item: ResumeProjectItem, fieldPath: string) {
  const exactDelimitedHeader = hasExactDelimitedProjectHeader(item);
  const firstLineParts = (item.sourceText.split(/\r?\n/, 1)[0] ?? "").split(" | ");
  if (
    !item.date &&
    firstLineParts.length === 3 &&
    firstLineParts[0] === item.name &&
    resumeDatePattern.test(firstLineParts[2] ?? "")
  ) {
    throw new PublicApiError(
      "Resume parsing omitted a project date present in the source header. No master resume was changed.",
      422,
      {
        code: "RESUME_PARSE_INCOMPLETE",
        section: "projects",
        fieldPath: `${fieldPath}.date`,
        retryable: false
      }
    );
  }
  if (item.description && !isUnambiguousNarrativeEntry(item.description) && !exactDelimitedHeader) {
    throw new PublicApiError(
      "Resume parsing returned an ambiguous projects detail that could be a merged record boundary. No master resume was changed.",
      422,
      {
        code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
        section: "projects",
        fieldPath: `${fieldPath}.description`,
        retryable: false
      }
    );
  }

  if (item.date) {
    const nameEnd = item.sourceText.indexOf(item.name) + item.name.length;
    const dateIndex = item.sourceText.indexOf(item.date, nameEnd);
    const firstDetailIndex = firstFactIndex(
      item.sourceText,
      [item.description, ...item.technologies, ...item.bullets]
    );
    if (!exactDelimitedHeader && !(dateIndex >= nameEnd && dateIndex < firstDetailIndex)) {
      throw new PublicApiError(
        "Resume parsing returned an invalid projects date position that could conceal a merged record. No master resume was changed.",
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          section: "projects",
          fieldPath: `${fieldPath}.date`,
          retryable: false
        }
      );
    }
  }

  item.sourceText.split(/\r?\n/).forEach((line, lineIndex) => {
    const parts = line.split(" | ");
    const finalPart = parts.at(-1) ?? "";
    const looksLikeDatedProjectHeader = parts.length >= 3 && resumeDatePattern.test(finalPart);
    if (looksLikeDatedProjectHeader && !(lineIndex === 0 && exactDelimitedHeader)) {
      throw new PublicApiError(
        "Resume parsing returned a projects source block containing an adjacent project header. No master resume was changed.",
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          section: "projects",
          fieldPath: `${fieldPath}.sourceText`,
          retryable: false
        }
      );
    }
  });
}

function firstFactIndex(sourceText: string, values: Array<string | null>) {
  let first = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const index = sourceText.indexOf(value);
    if (index >= 0) first = Math.min(first, index);
  }
  return first;
}

function isUnambiguousStandaloneWorkLocation(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^(?:remote|hybrid|on[- ]?site|in[- ]person|usa|uk)$/i.test(normalized) ||
    englishRegionNames.has(normalized);
}

function assertWorkLocationSemantics(item: ResumeWorkHistoryItem) {
  if (!item.location) return;
  const locationIndex = item.sourceText.indexOf(item.location);
  const coreEnd = Math.max(
    item.sourceText.indexOf(item.company) + item.company.length,
    item.sourceText.indexOf(item.title) + item.title.length
  );
  const firstNarrativeIndex = firstFactIndex(item.sourceText, item.bullets);
  const appearsInRecordHeader =
    locationIndex >= coreEnd &&
    locationIndex < firstNarrativeIndex;
  const explicitlyLabeled = item.sourceText.split(/\r?\n/).some((line) =>
    line.includes(item.location!) && /^\s*(?:location\s*:|based\s+in\b)/i.test(line)
  );
  if (appearsInRecordHeader && (explicitlyLabeled || isUnambiguousStandaloneWorkLocation(item.location))) return;
  throw new PublicApiError(
    "Resume parsing returned an invalid workHistory date or location that could conceal a merged record. No master resume was changed.",
    422,
    { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section: "workHistory", retryable: false }
  );
}

function hasSectionHeading(source: string, section: keyof ParsedResume["sectionStatus"]) {
  return hasResumeSectionHeading(source, section as ResumeTypedSectionName);
}

function assertTypedContactCompleteness(contactBlock: string, contactInfo: ParsedResume["contactInfo"]) {
  const lines = contactBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const phonePattern = /\+?\d(?:[ \t().-]*\d){6,}/;
  const urlPattern = /(?:https?:\/\/|www\.)?\b[A-Z0-9.-]+\.[A-Z]{2,}(?:\/[^\s]*)?/i;
  const usedLines = new Set<number>();
  const requireLineValue = (
    line: string,
    value: string | null,
    field: keyof ParsedResume["contactInfo"]
  ) => {
    if (!value || !line.includes(value)) {
      throw new PublicApiError(
        `Resume parsing omitted or changed contactInfo.${field} from the contact/header block. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", retryable: false }
      );
    }
  };

  const firstLine = lines[0];
  if (firstLine && !emailPattern.test(firstLine) && !phonePattern.test(firstLine) && !urlPattern.test(firstLine)) {
    if (contactInfo.name !== firstLine) {
      throw new PublicApiError(
        "Resume parsing omitted or changed the candidate name in the contact/header block. No master resume was changed.",
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", retryable: false }
      );
    }
    usedLines.add(0);
  } else if (contactInfo.name !== null) {
    throw new PublicApiError(
      "Resume parsing returned a candidate name without a supported name line. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_UNSUPPORTED_FACT", section: "contactInfo", retryable: false }
    );
  }

  lines.forEach((line, index) => {
    if (emailPattern.test(line)) {
      requireLineValue(line, contactInfo.email, "email");
      usedLines.add(index);
    }
    if (phonePattern.test(line)) {
      requireLineValue(line, contactInfo.phone, "phone");
      usedLines.add(index);
    }
    if (/linkedin/i.test(line)) {
      requireLineValue(line, contactInfo.linkedin, "linkedin");
      usedLines.add(index);
    } else if (/github/i.test(line)) {
      requireLineValue(line, contactInfo.github, "github");
      usedLines.add(index);
    } else if (!emailPattern.test(line) && urlPattern.test(line)) {
      requireLineValue(line, contactInfo.portfolio, "portfolio");
      usedLines.add(index);
    }
    if (!emailPattern.test(line) && !phonePattern.test(line) && !urlPattern.test(line)) {
      const locationClassification = classifyContactLocation(line);
      if (locationClassification === "ambiguous") {
        throw new PublicApiError(
          "Resume parsing returned an ambiguous contact/header line between a professional headline and location. No master resume was changed.",
          422,
          { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section: "contactInfo", retryable: false }
        );
      }
      if (locationClassification === "location") {
        requireLineValue(line, contactInfo.location, "location");
        usedLines.add(index);
      }
    }
  });

  const headlineLines = lines.filter((line, index) => {
    if (usedLines.has(index)) return false;
    const withoutLabel = line.replace(
      /\b(?:name|headline|title|email|e-mail|phone|mobile|tel|location|address|linkedin|github|portfolio|website|web|profile)\b/gi,
      ""
    );
    return /[\p{L}\p{N}]/u.test(withoutLabel);
  });
  if (headlineLines.length > 1) {
    throw new PublicApiError(
      "Resume contact/header facts cannot be mapped to one professional headline safely. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section: "contactInfo", retryable: false }
    );
  }
  if (headlineLines.length === 1 && contactInfo.headline !== headlineLines[0]) {
    throw new PublicApiError(
      "Resume parsing omitted or changed the professional headline in the contact/header block. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", retryable: false }
    );
  }
  if (headlineLines.length === 0 && contactInfo.headline !== null) {
    throw new PublicApiError(
      "Resume parsing returned a professional headline without a supported headline line. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_UNSUPPORTED_FACT", section: "contactInfo", retryable: false }
    );
  }
}

function zodFieldPath(path: Array<string | number>) {
  return path.reduce<string>((result, part) =>
    typeof part === "number" ? `${result}[${part}]` : result ? `${result}.${String(part)}` : String(part), "");
}

const legacyParsedResumeSchema: z.ZodType<LegacyParsedResume, z.ZodTypeDef, unknown> = z.object({
  contractVersion: z.literal("3"),
  contactInfo: z.object({
    sourceText: z.string().trim().max(20_000),
    name: nullableContactSourceString,
    headline: nullableContactSourceString,
    email: nullableContactSourceString,
    phone: nullableContactSourceString,
    location: nullableContactSourceString,
    linkedin: nullableContactSourceString,
    github: nullableContactSourceString,
    portfolio: nullableContactSourceString
  }).strict(),
  summary: z.string().trim().max(2_000),
  skills: sourceStringList,
  workHistory: z.array(z.object({
    sourceText: boundedSourceBlock,
    company: boundedSourceString,
    title: boundedSourceString,
    location: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    bullets: sourceStringList
  }).strict()).max(50),
  projects: z.array(z.object({
    sourceText: boundedSourceBlock,
    name: boundedSourceString,
    description: nullableSourceString,
    date: nullableSourceString.optional(),
    technologies: sourceStringList,
    bullets: sourceStringList
  }).strict()).max(50),
  education: z.array(z.object({
    sourceText: boundedSourceBlock,
    institution: boundedSourceString,
    credential: nullableSourceString,
    fieldOfStudy: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    details: sourceStringList
  }).strict()).max(30),
  certifications: z.array(z.object({
    sourceText: boundedSourceBlock,
    name: boundedSourceString,
    issuer: nullableSourceString,
    date: nullableSourceString,
    expirationDate: nullableSourceString,
    details: sourceStringList.optional()
  }).strict()).max(50),
  achievements: sourceStringList,
  sectionStatus: z.object({
    summary: sectionStatusSchema,
    skills: sectionStatusSchema,
    workHistory: sectionStatusSchema,
    projects: sectionStatusSchema,
    education: sectionStatusSchema,
    certifications: sectionStatusSchema,
    achievements: sectionStatusSchema
  }).strict(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20)
}).strict();

function lineBreakUnitsBefore(lines: string[], index: number) {
  if (index <= 0) return 0;
  let units = 1;
  for (let cursor = index - 1; cursor >= 0 && !lines[cursor]!.trim(); cursor -= 1) units += 1;
  return units;
}

function paragraphBreakUnit(lines: string[]) {
  const units = lines.flatMap((line, index) =>
    line.trim() && index > 0 ? [lineBreakUnitsBefore(lines, index)] : []
  );
  return Math.min(...units.filter((value) => value > 0));
}

function expectedSourceSections(source: string): Array<Omit<ResumeSourceSection, "recordBlocks">> {
  return buildResumeSourceCatalog(source).sections.map((section) => ({
    section: section.section,
    heading: section.heading,
    sourceText: section.sourceText
  }));
}

function splitProjectPipeRecordBlocks(block: string) {
  const lines = block.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => {
    const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
    return parts.length >= 3 && resumeDatePattern.test(parts.at(-1)!) ? [index] : [];
  });
  if (starts.length < 2) return [block];
  const blocks: string[] = [];
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? lines.length;
    const record = lines.slice(start, end).join("\n").trim();
    if (record) blocks.push(record);
  }
  return blocks;
}

function splitStructuralRecordBlocks(
  section: ResumeSourceSectionName,
  sourceText: string,
  paragraphUnit: number
) {
  if (!Number.isFinite(paragraphUnit)) return [sourceText];
  const blocks: string[] = [];
  let cursor = 0;
  for (const match of sourceText.matchAll(/(?:\r?\n)+/g)) {
    const newlineCount = (match[0].match(/\n/g) ?? []).length;
    if (newlineCount < paragraphUnit * 2 || match.index === undefined) continue;
    const block = sourceText.slice(cursor, match.index).trim();
    if (block) blocks.push(block);
    cursor = match.index + match[0].length;
  }
  const finalBlock = sourceText.slice(cursor).trim();
  if (finalBlock) blocks.push(finalBlock);
  return section === "projects"
    ? blocks.flatMap(splitProjectPipeRecordBlocks)
    : blocks;
}

function jsonEscapedByteLength(value: string) {
  return Math.max(0, Buffer.byteLength(JSON.stringify(value), "utf8") - 2);
}

const structuralRecordLimits: Partial<Record<ResumeSourceSectionName, number>> = {
  workHistory: 50,
  projects: 50,
  education: 30,
  certifications: 50
};

function structuralRecordCounts(
  section: ResumeSourceSectionName,
  sourceText: string,
  paragraphUnit: number
) {
  const splitBlocks = splitStructuralRecordBlocks(section, sourceText, paragraphUnit);
  const splitCount = splitBlocks.length;
  const dateCount = sourceText.split(/\r?\n/).filter((line) =>
    resumeDatePattern.test(line.trim())
  ).length;
  const pipeHeaderCount = sourceText.split(/\r?\n/).filter((line) => {
    const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
    if (isExplicitResumeListEntry(line.trim())) return false;
    return section === "projects"
      ? parts.length >= 3 && resumeDatePattern.test(parts.at(-1)!)
      : section === "workHistory" && parts.length >= 2;
  }).length;
  const declaredBlockCount = splitBlocks.filter((block) => {
    const firstLine = block.split(/\r?\n/, 1)[0]!.trim();
    if (
      isExplicitResumeListEntry(firstLine) ||
      resumeDatePattern.test(firstLine) ||
      /^(?:location|technologies?(?: used)?|tools|methods|platforms?|credential id|details?)\s*:/i.test(firstLine)
    ) return false;
    if (firstLine.includes(" | ")) return true;
    return !isUnambiguousNarrativeEntry(firstLine);
  }).length;
  const definite = Math.max(1, dateCount, pipeHeaderCount, declaredBlockCount);
  return {
    definite,
    estimated: Math.max(definite, splitCount)
  };
}

function emptyStrings(count: number) {
  return Array.from({ length: count }, () => "");
}

function expectedNonStructuralRecordBlocks(
  section: ResumeSourceSectionName,
  sourceText: string
) {
  if (section === "contactInfo" || section === "summary") return [sourceText];
  return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resumeSourceStructureFitsContract(
  sections: Array<Omit<ResumeSourceSection, "recordBlocks">>,
  paragraphUnit: number
) {
  if (sections.length > RESUME_PARSE_SOURCE_SECTION_LIMIT) return false;
  const structuralTotals = new Map<ResumeSourceSectionName, number>();
  for (const section of sections) {
    const structuralLimit = structuralRecordLimits[section.section];
    const recordCount = structuralLimit
      ? structuralRecordCounts(section.section, section.sourceText, paragraphUnit).definite
      : expectedNonStructuralRecordBlocks(section.section, section.sourceText).length;
    if (recordCount > RESUME_PARSE_RECORD_BLOCK_LIMIT) return false;
    if (structuralLimit) {
      const total = (structuralTotals.get(section.section) ?? 0) + recordCount;
      if (total > structuralLimit) return false;
      structuralTotals.set(section.section, total);
    }
  }
  return true;
}

function estimateResumeParseEnvelopeBytes(
  sections: Array<Omit<ResumeSourceSection, "recordBlocks">>,
  paragraphUnit: number
) {
  const structuralCounts = sections.map((section) => ({
    section: section.section,
    counts: structuralRecordLimits[section.section]
      ? structuralRecordCounts(section.section, section.sourceText, paragraphUnit)
      : null
  }));
  const remainingStructuralRecords = new Map<ResumeSourceSectionName, number>();
  for (const [section, limit] of Object.entries(structuralRecordLimits) as Array<
    [ResumeSourceSectionName, number]
  >) {
    const definite = structuralCounts.reduce((total, item) =>
      item.section === section ? total + (item.counts?.definite ?? 0) : total, 0);
    remainingStructuralRecords.set(section, Math.max(0, limit - definite));
  }
  const sectionMetrics = sections.map((section) => {
    const counts = structuralRecordLimits[section.section]
      ? structuralRecordCounts(section.section, section.sourceText, paragraphUnit)
      : null;
    const remaining = remainingStructuralRecords.get(section.section) ?? 0;
    const extra = counts ? Math.min(remaining, counts.estimated - counts.definite) : 0;
    const recordCount = counts
      ? counts.definite + extra
      : expectedNonStructuralRecordBlocks(section.section, section.sourceText).length;
    if (counts) remainingStructuralRecords.set(section.section, remaining - extra);
    return { ...section, recordCount };
  });
  const metricsFor = (section: ResumeSourceSectionName) =>
    sectionMetrics.filter((item) => item.section === section);
  const structuralMetricsFor = (section: ResumeSourceSectionName) => {
    const items = metricsFor(section);
    const recordCount = items.reduce((total, item) => total + item.recordCount, 0);
    return { recordCount };
  };
  const work = structuralMetricsFor("workHistory");
  const projects = structuralMetricsFor("projects");
  const education = structuralMetricsFor("education");
  const certifications = structuralMetricsFor("certifications");
  const status = (section: keyof ParsedResumeCore["sectionStatus"]) =>
    metricsFor(section).length > 0 ? "present" : "absent";
  const envelope = {
    contractVersion: "5",
    sourceSections: sectionMetrics.map((section) => ({
      section: section.section,
      heading: section.heading,
      sourceText: "",
      recordBlocks: emptyStrings(section.recordCount)
    })),
    contactInfo: {
      sourceText: "",
      name: null,
      headline: null,
      email: null,
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "",
    skills: metricsFor("skills").length > 0 ? emptyStrings(100) : [],
    workHistory: Array.from({ length: work.recordCount }, () => ({
      sourceText: "",
      company: "",
      title: "",
      location: null,
      startDate: null,
      endDate: null,
      bullets: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    projects: Array.from({ length: projects.recordCount }, () => ({
      sourceText: "",
      name: "",
      description: null,
      date: null,
      technologies: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS),
      bullets: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    education: Array.from({ length: education.recordCount }, () => ({
      sourceText: "",
      institution: "",
      credential: null,
      fieldOfStudy: null,
      startDate: null,
      endDate: null,
      details: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    certifications: Array.from({ length: certifications.recordCount }, () => ({
      sourceText: "",
      name: "",
      issuer: null,
      date: null,
      expirationDate: null,
      details: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    achievements: metricsFor("achievements").length > 0 ? emptyStrings(100) : [],
    sectionStatus: {
      summary: status("summary"),
      skills: status("skills"),
      workHistory: status("workHistory"),
      projects: status("projects"),
      education: status("education"),
      certifications: status("certifications"),
      achievements: status("achievements")
    },
    warnings: emptyStrings(5)
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") +
    RESUME_PARSE_WARNING_CONTENT_BYTES;
}

function estimateResumeParseProviderEnvelopeBytes(
  sections: Array<Omit<ResumeSourceSection, "recordBlocks">>,
  paragraphUnit: number
) {
  const countsFor = (sectionName: ResumeSourceSectionName) => Math.min(
    structuralRecordLimits[sectionName] ?? 0,
    sections
      .filter((section) => section.section === sectionName)
      .reduce((total, section) => total + (
        structuralRecordLimits[sectionName]
          ? structuralRecordCounts(sectionName, section.sourceText, paragraphUnit).estimated
          : 0
      ), 0)
  );
  const workCount = countsFor("workHistory");
  const projectCount = countsFor("projects");
  const educationCount = countsFor("education");
  const certificationCount = countsFor("certifications");
  const spanCount = workCount + projectCount + educationCount + certificationCount;
  const status = (section: keyof ParsedResumeCore["sectionStatus"]) =>
    sections.some((item) => item.section === section) ? "present" : "absent";
  const spanIndex = RESUME_PARSE_RECORD_SPAN_LIMIT - 1;
  const envelope = {
    contractVersion: "6",
    recordSpans: Array.from({ length: spanCount }, () => ({
      sectionId: "section-100",
      startLineId: "section-100-line-10000",
      endLineId: "section-100-line-10000"
    })),
    contactInfo: {
      name: null,
      headline: null,
      email: null,
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "",
    skills: sections.some((item) => item.section === "skills") ? emptyStrings(100) : [],
    workHistory: Array.from({ length: workCount }, () => ({
      spanIndex,
      company: "",
      title: "",
      location: null,
      startDate: null,
      endDate: null,
      bullets: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    projects: Array.from({ length: projectCount }, () => ({
      spanIndex,
      name: "",
      description: null,
      date: null,
      technologies: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS),
      bullets: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    education: Array.from({ length: educationCount }, () => ({
      spanIndex,
      institution: "",
      credential: null,
      fieldOfStudy: null,
      startDate: null,
      endDate: null,
      details: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    certifications: Array.from({ length: certificationCount }, () => ({
      spanIndex,
      name: "",
      issuer: null,
      date: null,
      expirationDate: null,
      details: emptyStrings(RESUME_PARSE_RECORD_PROJECTION_ITEMS)
    })),
    achievements: sections.some((item) => item.section === "achievements")
      ? emptyStrings(100)
      : [],
    sectionStatus: {
      summary: status("summary"),
      skills: status("skills"),
      workHistory: status("workHistory"),
      projects: status("projects"),
      education: status("education"),
      certifications: status("certifications"),
      achievements: status("achievements")
    },
    warnings: emptyStrings(5)
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") +
    RESUME_PARSE_WARNING_CONTENT_BYTES;
}

export function estimateResumeParseMaximumOutputBytes(source: string) {
  const normalizedSource = normalizeResumeLineEndings(source);
  const sections = expectedSourceSections(normalizedSource);
  const paragraphUnit = paragraphBreakUnit(normalizedSource.split("\n"));
  if (!resumeSourceStructureFitsContract(sections, paragraphUnit)) {
    return RESUME_PARSE_PLANNED_JSON_BYTES + 1;
  }
  const requiredContentBytes = sections.reduce((total, section) =>
    total + jsonEscapedByteLength(section.sourceText) *
      RESUME_PARSE_REQUIRED_CONTENT_COPIES[section.section], 0);
  return requiredContentBytes + estimateResumeParseEnvelopeBytes(sections, paragraphUnit);
}

export function estimateResumeParseAnnotatedInputBytes(source: string) {
  return Buffer.byteLength(JSON.stringify(buildResumeProviderSourceInput(source)), "utf8");
}

function estimateProviderProjectionContentBytes(section: Omit<ResumeSourceSection, "recordBlocks">) {
  const sourceBytes = jsonEscapedByteLength(section.sourceText);
  const maximumLineBytes = Math.max(0, ...section.sourceText
    .split(/\r?\n/u)
    .map((line) => jsonEscapedByteLength(line.trim())));
  if (section.section === "contactInfo") return maximumLineBytes * 8;
  if (["summary", "skills", "achievements"].includes(section.section)) return sourceBytes;
  if (section.section === "workHistory") return sourceBytes + maximumLineBytes * 5;
  if (section.section === "projects") return sourceBytes * 2 + maximumLineBytes * 3;
  if (section.section === "education") return sourceBytes + maximumLineBytes * 5;
  if (section.section === "certifications") return sourceBytes + maximumLineBytes * 4;
  return 0;
}

export function estimateResumeParseMaximumProviderOutputBytes(source: string) {
  const normalizedSource = normalizeResumeLineEndings(source);
  const sections = expectedSourceSections(normalizedSource);
  const paragraphUnit = paragraphBreakUnit(normalizedSource.split("\n"));
  if (!resumeSourceStructureFitsContract(sections, paragraphUnit)) {
    return RESUME_PARSE_PLANNED_JSON_BYTES + 1;
  }
  const projectedContentBytes = sections.reduce((total, section) =>
    total + estimateProviderProjectionContentBytes(section), 0);
  return projectedContentBytes + estimateResumeParseProviderEnvelopeBytes(sections, paragraphUnit);
}

function resumeParseOutputTokenLimit(provider: AiProviderName) {
  return provider === "gemini"
    ? AI_FEATURE_POLICIES.RESUME_PARSE.maxOutputTokens
    : OPENAI_RESUME_PARSE_OUTPUT_TOKENS;
}

function assertResumeParseOutputCapacity(source: string, provider: AiProviderName) {
  if (forbiddenResumeControlCharacters.test(source)) {
    throw new PublicApiError(
      "Resume text contains unsupported control characters and cannot be parsed safely.",
      422,
      {
        code: "RESUME_PARSE_UNSUPPORTED_CONTROL_CHARACTERS",
        fieldPath: "rawText",
        retryable: false
      }
    );
  }
  const maximumOutputBytes = estimateResumeParseMaximumProviderOutputBytes(source);
  if (maximumOutputBytes <= RESUME_PARSE_PLANNED_JSON_BYTES) return;
  throw new PublicApiError(
    "Resume text is too large or escape-heavy to preserve losslessly within the configured structured-response limit.",
    413,
    {
      code: "RESUME_PARSE_SOURCE_TOO_LARGE_FOR_LOSSLESS_OUTPUT",
      estimatedMaximumOutputBytes: maximumOutputBytes,
      structuredOutputPlanningTokens: RESUME_PARSE_PLANNED_JSON_TOKENS,
      providerTotalOutputTokenLimit: resumeParseOutputTokenLimit(provider),
      provider,
      retryable: false
    }
  );
}

function legacyRecordBlocks(
  section: ResumeSourceSectionName,
  sourceText: string,
  output: LegacyParsedResume
) {
  if (section === "contactInfo") return [sourceText];
  if (section === "summary") return [sourceText];
  if (section === "skills") {
    return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (section === "workHistory") return output.workHistory.map((item) => item.sourceText).filter((record) => sourceText.includes(record));
  if (section === "projects") return output.projects.map((item) => item.sourceText).filter((record) => sourceText.includes(record));
  if (section === "education") return output.education.map((item) => item.sourceText).filter((record) => sourceText.includes(record));
  if (section === "certifications") return output.certifications.map((item) => item.sourceText).filter((record) => sourceText.includes(record));
  if (section === "achievements") {
    return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeParsedResumeLineEndings(output: ParsedResumeV5): ParsedResumeV5 {
  return {
    ...output,
    sourceSections: output.sourceSections.map((section) => ({
      ...section,
      sourceText: normalizeResumeLineEndings(section.sourceText),
      recordBlocks: section.recordBlocks.map(normalizeResumeLineEndings)
    })),
    contactInfo: {
      ...output.contactInfo,
      sourceText: normalizeResumeLineEndings(output.contactInfo.sourceText)
    },
    summary: normalizeResumeLineEndings(output.summary),
    workHistory: output.workHistory.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    projects: output.projects.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    education: output.education.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    certifications: output.certifications.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    }))
  };
}

function normalizeLegacyResumeLineEndings(output: LegacyParsedResume): LegacyParsedResume {
  return {
    ...output,
    contactInfo: {
      ...output.contactInfo,
      sourceText: normalizeResumeLineEndings(output.contactInfo.sourceText)
    },
    summary: normalizeResumeLineEndings(output.summary),
    workHistory: output.workHistory.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    projects: output.projects.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    education: output.education.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    })),
    certifications: output.certifications.map((item) => ({
      ...item,
      sourceText: normalizeResumeLineEndings(item.sourceText)
    }))
  };
}

function decodeParsedResume(source: string, value: unknown, allowLegacy: boolean): ParsedResumeV5 {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).contractVersion === "3") {
    if (!allowLegacy) {
      throw new PublicApiError("Resume parsing returned an obsolete structured result. No master resume was changed.", 422, {
        code: "RESUME_PARSE_INVALID_OUTPUT",
        fieldPath: "contractVersion",
        retryable: false
      });
    }
    const legacy = legacyParsedResumeSchema.safeParse(value);
    if (!legacy.success) {
      const fieldPath = zodFieldPath(legacy.error.issues[0]?.path ?? []);
      throw new PublicApiError("Resume parsing returned an invalid structured result. No master resume was changed.", 422, {
        code: "RESUME_PARSE_INVALID_OUTPUT",
        ...(fieldPath ? { fieldPath } : {}),
        retryable: false
      });
    }
    const output = normalizeLegacyResumeLineEndings(legacy.data);
    const sourceSections = expectedSourceSections(source).map((section) => ({
      ...section,
      recordBlocks: legacyRecordBlocks(section.section, section.sourceText, output)
    }));
    return normalizeParsedResumeLineEndings({
      ...output,
      contractVersion: "5",
      sourceSections,
      projects: output.projects.map((project) => ({ ...project, date: project.date ?? null })),
      certifications: output.certifications.map((item) => ({ ...item, details: item.details ?? [] }))
    });
  }
  const current = parsedResumeSchema.safeParse(value);
  if (current.success) return normalizeParsedResumeLineEndings(current.data);
  const fieldPath = zodFieldPath(current.error.issues[0]?.path ?? []);
  throw new PublicApiError("Resume parsing returned an invalid structured result. No master resume was changed.", 422, {
    code: "RESUME_PARSE_INVALID_OUTPUT",
    ...(fieldPath ? { fieldPath } : {}),
    retryable: false
  });
}

function factsForSection(output: ParsedResumeV5, section: ResumeSourceSectionName) {
  if (section === "summary") return output.summary ? [output.summary] : [];
  if (section === "skills") return output.skills;
  if (section === "achievements") return output.achievements;
  if (section === "workHistory") return output.workHistory.map((item) => item.sourceText);
  if (section === "projects") return output.projects.map((item) => item.sourceText);
  if (section === "education") return output.education.map((item) => item.sourceText);
  if (section === "certifications") return output.certifications.map((item) => item.sourceText);
  return [];
}

function recordHasDateLine(record: string) {
  return record.split(/\r?\n/).some((line) => resumeDatePattern.test(line.trim()));
}

function hasDeclaredRecordBoundary(
  section: ResumeSourceSectionName,
  separator: string,
  previousRecord: string,
  nextRecord: string,
  paragraphUnit: number
) {
  const newlineCount = (separator.match(/\n/g) ?? []).length;
  if (Number.isFinite(paragraphUnit) && newlineCount >= paragraphUnit * 2) return true;
  if (recordHasDateLine(previousRecord) && recordHasDateLine(nextRecord)) return true;
  const firstLine = nextRecord.split(/\r?\n/, 1)[0]!.trim();
  if (isExplicitResumeListEntry(firstLine)) return false;
  const pipeParts = firstLine.split("|").map((part) => part.trim()).filter(Boolean);
  if (section === "projects") {
    return pipeParts.length >= 3 && resumeDatePattern.test(pipeParts.at(-1)!);
  }
  return section === "workHistory" && pipeParts.length >= 2;
}

function assertLosslessSourceAuthority(source: string, output: ParsedResumeV5) {
  const expected = expectedSourceSections(source);
  const paragraphUnit = paragraphBreakUnit(source.split(/\r?\n/));
  const recordCursors = new Map<ResumeSourceSectionName, number>();
  if (output.sourceSections.length !== expected.length) {
    throw new PublicApiError(
      "Resume parsing omitted or invented a source section. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", fieldPath: "sourceSections", retryable: false }
    );
  }
  output.sourceSections.forEach((section, sectionIndex) => {
    const expectedSection = expected[sectionIndex]!;
    const basePath = `sourceSections[${sectionIndex}]`;
    if (
      section.section !== expectedSection.section ||
      section.heading !== expectedSection.heading ||
      section.sourceText !== expectedSection.sourceText
    ) {
      throw new PublicApiError(
        "Resume parsing changed source section order or boundaries. No master resume was changed.",
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", fieldPath: basePath, retryable: false }
      );
    }

    const canonicalRecords = ["workHistory", "projects", "education", "certifications"].includes(section.section)
      ? factsForSection(output, section.section)
      : null;
    const canonicalCursor = recordCursors.get(section.section) ?? 0;
    const sectionCanonicalRecords = canonicalRecords?.slice(
      canonicalCursor,
      canonicalCursor + section.recordBlocks.length
    ) ?? null;
    if (!canonicalRecords) {
      const expectedBlocks = expectedNonStructuralRecordBlocks(
        section.section,
        section.sourceText
      );
      const exactBlocks = section.recordBlocks.length === expectedBlocks.length &&
        section.recordBlocks.every((record, index) => record === expectedBlocks[index]);
      if (!exactBlocks) {
        let expectedCursor = 0;
        const orderedSubset = section.recordBlocks.every((record) => {
          const index = expectedBlocks.indexOf(record, expectedCursor);
          if (index < 0) return false;
          expectedCursor = index + 1;
          return true;
        });
        const omittedBlock = orderedSubset && section.recordBlocks.length < expectedBlocks.length;
        throw new PublicApiError(
          omittedBlock
            ? "Resume parsing omitted a non-structural source record. No master resume was changed."
            : "Resume parsing invented a non-structural record boundary. No master resume was changed.",
          422,
          {
            code: omittedBlock ? "RESUME_PARSE_INCOMPLETE" : "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
            section: section.section,
            fieldPath: `${basePath}.recordBlocks`,
            retryable: false
          }
        );
      }
    }
    if (canonicalRecords && (
      sectionCanonicalRecords!.length !== section.recordBlocks.length ||
      sectionCanonicalRecords!.some((record, index) => record !== section.recordBlocks[index])
    )) {
      const mismatch = section.recordBlocks.findIndex((record, index) => record !== sectionCanonicalRecords![index]);
      throw new PublicApiError(
        "Resume parsing changed record order or merged adjacent records. No master resume was changed.",
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          section: section.section,
          fieldPath: `${basePath}.recordBlocks[${Math.max(0, mismatch)}]`,
          retryable: false
        }
      );
    }
    if (canonicalRecords) {
      recordCursors.set(section.section, canonicalCursor + section.recordBlocks.length);
    }

    let cursor = 0;
    const characters = section.sourceText.split("");
    section.recordBlocks.forEach((record, recordIndex) => {
      const start = section.sourceText.indexOf(record, cursor);
      if (start < 0) {
        throw new PublicApiError(
          "Resume parsing changed source record order or boundaries. No master resume was changed.",
          422,
          {
            code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
            section: section.section,
            fieldPath: `${basePath}.recordBlocks[${recordIndex}]`,
            retryable: false
          }
        );
      }
      if (
        canonicalRecords &&
        recordIndex > 0 &&
        !hasDeclaredRecordBoundary(
          section.section,
          section.sourceText.slice(cursor, start),
          section.recordBlocks[recordIndex - 1]!,
          record,
          paragraphUnit
        )
      ) {
        throw new PublicApiError(
          "Resume parsing invented a record boundary that is not declared by the source. No master resume was changed.",
          422,
          {
            code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
            section: section.section,
            fieldPath: `${basePath}.recordBlocks[${recordIndex}]`,
            retryable: false
          }
        );
      }
      characters.fill(" ", start, start + record.length);
      cursor = start + record.length;
      if (["workHistory", "education", "certifications"].includes(section.section)) {
        const dateLines = record.split(/\r?\n/).filter((line) => resumeDatePattern.test(line.trim()));
        if (dateLines.length > 1) {
          throw new PublicApiError(
            `Resume parsing returned an ambiguous ${section.section} detail that could be a merged record boundary. No master resume was changed.`,
            422,
            {
              code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
              section: section.section,
              fieldPath: `${basePath}.recordBlocks[${recordIndex}]`,
              retryable: false
            }
          );
        }
      }
    });
    if (/\S/u.test(characters.join(""))) {
      throw new PublicApiError(
        `Resume parsing is incomplete for ${section.section === "workHistory" ? "work history" : section.section}; source content was not represented. No master resume was changed.`,
        422,
        {
          code: "RESUME_PARSE_INCOMPLETE",
          section: section.section,
          fieldPath: `${basePath}.recordBlocks`,
          retryable: false
        }
      );
    }
  });
  for (const section of ["workHistory", "projects", "education", "certifications"] as const) {
    if ((recordCursors.get(section) ?? 0) !== factsForSection(output, section).length) {
      throw new PublicApiError(
        "Resume parsing omitted or invented a canonical source record. No master resume was changed.",
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section, fieldPath: "sourceSections", retryable: false }
      );
    }
  }
}

function sourceForTypedSection(output: ParsedResumeV5, section: ResumeSourceSectionName) {
  return output.sourceSections
    .filter((item) => item.section === section)
    .map((item) => item.sourceText)
    .join("\n");
}

function assertTypedContactProjections(output: ParsedResumeV5) {
  const contactSections = output.sourceSections.filter((item) => item.section === "contactInfo");
  if (contactSections.length !== 1 || output.contactInfo.sourceText !== contactSections[0]!.sourceText) {
    throw new PublicApiError(
      "Resume parsing did not preserve the complete contact/header source block. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", fieldPath: "contactInfo.sourceText", retryable: false }
    );
  }
  const sourceText = contactSections[0]!.sourceText;
  for (const [key, item] of Object.entries(output.contactInfo)) {
    if (key !== "sourceText") assertSourceSupported(sourceText, item, `contactInfo.${key}`);
  }
  const requireDetected = (value: string | null, matches: string[], fieldPath: string) => {
    if (matches.length > 0 && (!value || !matches.includes(value))) {
      throw new PublicApiError(
        `Resume parsing omitted or changed ${fieldPath} from the contact/header block. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", fieldPath, retryable: false }
      );
    }
  };
  requireDetected(
    output.contactInfo.email,
    [...sourceText.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0]),
    "contactInfo.email"
  );
  requireDetected(
    output.contactInfo.phone,
    [...sourceText.matchAll(/\+?\d(?:[ \t().-]*\d){6,}/g)].map((match) => match[0].trim()),
    "contactInfo.phone"
  );
  const locations = [...sourceText.matchAll(/(?:^|[|•])\s*(?:location|address)\s*:\s*([^|\n]+)/gim)]
    .map((match) => match[1]!.trim());
  requireDetected(output.contactInfo.location, locations, "contactInfo.location");
  assertTypedContactCompleteness(sourceText, output.contactInfo);
  const plainLines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) =>
    !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line) &&
    !/\+?\d(?:[ \t().-]*\d){6,}/.test(line) &&
    !/(?:https?:\/\/|www\.|linkedin|github)/i.test(line) &&
    !/^\s*(?:location|address)\s*:/i.test(line)
  );
  if (plainLines[0] && output.contactInfo.name !== plainLines[0]) {
    throw new PublicApiError(
      "Resume parsing omitted or changed the candidate name in the contact/header block. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", fieldPath: "contactInfo.name", retryable: false }
    );
  }
  if (plainLines[1] && output.contactInfo.headline !== plainLines[1]) {
    throw new PublicApiError(
      "Resume parsing omitted or changed the professional headline in the contact/header block. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", fieldPath: "contactInfo.headline", retryable: false }
    );
  }
}

function assertNoUndeclaredRecordHeaderAfterNarrative(
  sourceText: string,
  values: string[],
  section: string,
  fieldPath: string
) {
  if (values.length === 0) return;
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const value of values) {
    const start = sourceText.indexOf(value, cursor);
    if (start < 0) return;
    ranges.push({ start, end: start + value.length });
    cursor = start + value.length;
  }
  const gaps = [
    ...ranges.slice(1).map((range, index) =>
      sourceText.slice(ranges[index]!.end, range.start)
    ),
    sourceText.slice(ranges.at(-1)!.end)
  ];
  const boundaryText = (value: string) =>
    value.replace(/[^\S\r\n]+(?=\r?\n)/gu, "");
  const newlineRuns = [...boundaryText(sourceText).matchAll(/(?:\r?\n)+/g)].map((match) =>
    (match[0].match(/\n/g) ?? []).length
  );
  const paragraphUnit = Math.min(...newlineRuns.filter((length) => length > 0));
  const hasHeaderPair = gaps.some((gap) => {
    const hasMajorBoundary = Number.isFinite(paragraphUnit) &&
      [...boundaryText(gap).matchAll(/(?:\r?\n)+/g)].some((match) =>
        (match[0].match(/\n/g) ?? []).length >= paragraphUnit * 2
    );
    const lines = gap.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.some((line) =>
      line.split("|").map((part) => part.trim()).filter(Boolean).length >= 2 &&
      !isExplicitResumeListEntry(line)
    )) {
      return true;
    }
    const looksLikeHeader = (candidate: string) =>
      /[\p{L}\p{N}]/u.test(candidate) &&
      !/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(candidate) &&
      !candidate.includes(":") &&
      !/[.!?…]$/u.test(candidate);
    const looksLikePossibleHeaderValue = (candidate: string) =>
      /[\p{L}\p{N}]/u.test(candidate) &&
      !/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(candidate) &&
      (!candidate.includes(":") ||
        /^(?:title|role|position|company|employer|organization)\s*:\s*\S/iu.test(candidate));
    const metadataLabel = /^(?:technologies?(?: used)?|tools|methods|platforms?)$/i.test(lines[0] ?? "");
    if (metadataLabel) {
      const labelStart = gap.indexOf(lines[0]!);
      const metadataTail = gap.slice(labelStart + lines[0]!.length);
      const crossesInternalMajorBoundary = Number.isFinite(paragraphUnit) &&
        [...boundaryText(metadataTail).matchAll(/(?:\r?\n)+/g)].some((match) =>
          (match[0].match(/\n/g) ?? []).length >= paragraphUnit * 2
        );
      if (crossesInternalMajorBoundary) return true;
      const values = lines.slice(1);
      const isListItem = (line: string) =>
        /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(line);
      if (values.length <= 1 || values.every(isListItem)) return false;
      const firstBulletIndex = values.findIndex(isListItem);
      if (firstBulletIndex === 1 && values.slice(1).every(isListItem)) return false;
      return true;
    }
    const recognizedTrailingEmploymentMetadata = lines.length === 2 &&
        /^(?:full[- ]time|part[- ]time|contract|contractor|temporary|internship|freelance|self-employed)$/i.test(lines[0]!) &&
        /^(?:revenue |business |customer |people |product |sales |marketing |finance |data |research |software |platform |service )?(?:operations|engineering|support|success|analytics|design|legal|hr|human resources|department|division|team)$/i.test(lines[1]!);
    if (recognizedTrailingEmploymentMetadata) return false;
    const hasAdjacentHeaderPair = lines.some((line, index) => {
      const next = lines[index + 1];
      if (!next) return false;
      return (looksLikeHeader(line) && looksLikeHeader(next)) ||
        (hasMajorBoundary &&
          looksLikePossibleHeaderValue(line) &&
          looksLikePossibleHeaderValue(next));
    });
    const hasMinimalRecord = hasMajorBoundary &&
      looksLikeHeader(lines[0] ?? "") &&
      lines.slice(1).some((line) => /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(line));
    return hasAdjacentHeaderPair || hasMinimalRecord ||
      (hasMajorBoundary && lines.length === 1 && looksLikeHeader(lines[0]!));
  });
  if (hasHeaderPair) {
    throw new PublicApiError(
      `Resume parsing returned a ${section} source block containing an undeclared adjacent record header. No master resume was changed.`,
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, fieldPath, retryable: false }
    );
  }
}

function assertNoUnprojectedHeaderPairBeforeNarrative(
  sourceText: string,
  narrativeValues: string[],
  projectedHeaderValues: Array<string | null>,
  section: string,
  fieldPath: string
) {
  const narrativeIndex = firstFactIndex(sourceText, narrativeValues);
  const header = sourceText.slice(0, narrativeIndex);
  const projectedValues = projectedHeaderValues
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim());
  const headerLines = header.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeledCoreLine = headerLines.find((line) =>
    /^(?:company|employer|organization|role|title|institution|school|university|college|project|certification|certificate|license|issuer)\s*:/i.test(line) &&
    !projectedValues.some((value) => line.includes(value))
  );
  if (labeledCoreLine) {
    throw new PublicApiError(
      `Resume parsing returned a ${section} source block containing an unprojected labeled record header. No master resume was changed.`,
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, fieldPath, retryable: false }
    );
  }
  const unexplained = headerLines.filter((line) =>
    Boolean(line) &&
    !projectedValues.some((value) => line.includes(value)) &&
    !resumeDatePattern.test(line) &&
    !line.includes(":") &&
    !/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(line) &&
    !/[.!?…]$/u.test(line)
  );
  const recognizedEmploymentMetadata = unexplained.length === 2 &&
    /^(?:full[- ]time|part[- ]time|contract|contractor|temporary|internship|freelance|self-employed)$/i.test(
      unexplained[0]!
    ) &&
    /^(?:revenue |business |customer |people |product |sales |marketing |finance |data |research |software |platform |service )?(?:operations|engineering|support|success|analytics|design|legal|hr|human resources|department|division|team)$/i.test(
      unexplained[1]!
    );
  const recognizedSingleMetadata = unexplained.length === 1 && (
    /^(?:full[- ]time|part[- ]time|contract|contractor|temporary|internship|freelance|self-employed)$/i.test(
      unexplained[0]!
    ) ||
    /^(?:revenue |business |customer |people |product |sales |marketing |finance |data |research |software |platform |service )?(?:operations|engineering|support|success|analytics|design|legal|hr|human resources|department|division|team)$/i.test(
      unexplained[0]!
    )
  );
  const unexplainedLimit = section === "workHistory" ? 1 : 2;
  if (
    unexplained.length >= unexplainedLimit &&
    !recognizedSingleMetadata &&
    !recognizedEmploymentMetadata
  ) {
    throw new PublicApiError(
      `Resume parsing returned a ${section} source block containing unexplained header text. No master resume was changed.`,
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, fieldPath, retryable: false }
    );
  }
}

function assertWorkHeaderSemantics(item: ResumeWorkHistoryItem, fieldPath: string) {
  const firstLine = item.sourceText.split(/\r?\n/, 1)[0]!.trim();
  if (isExplicitResumeListEntry(firstLine)) {
    throw new PublicApiError(
      "Resume parsing returned a work-history record whose source header is a narrative list item. No master resume was changed.",
      422,
      {
        code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
        section: "workHistory",
        fieldPath: `${fieldPath}.sourceText`,
        retryable: false
      }
    );
  }
  const firstNarrative = firstFactIndex(item.sourceText, item.bullets);
  for (const [field, value] of [["title", item.title], ["company", item.company]] as const) {
    const position = item.sourceText.indexOf(value);
    if (
      position < 0 ||
      position >= firstNarrative ||
      /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(value)
    ) {
      throw new PublicApiError(
        "Resume parsing returned a work-history record whose title or company is not in its header. No master resume was changed.",
        422,
        {
          code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
          section: "workHistory",
          fieldPath: `${fieldPath}.${field}`,
          retryable: false
        }
      );
    }
  }
}

function recordBoundaryAnchors(
  sourceText: string,
  narrativeValues: string[],
  headerValues: Array<string | null>
) {
  if (narrativeValues.length > 0) return narrativeValues;
  const lastHeader = headerValues
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, index: sourceText.lastIndexOf(value) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => right.index - left.index)[0];
  return lastHeader ? [lastHeader.value] : [];
}

export function validateParsedResumeOutput(
  rawSource: string,
  value: unknown,
  options: { allowLegacy?: boolean } = {}
): ParsedResumeV5 {
  const source = normalizeResumeLineEndings(rawSource);
  const output = decodeParsedResume(source, value, options.allowLegacy !== false);
  assertLosslessSourceAuthority(source, output);
  const sections: Array<[keyof ParsedResume["sectionStatus"], unknown[]]> = [
    ["summary", output.summary ? [output.summary] : []],
    ["skills", output.skills],
    ["workHistory", output.workHistory],
    ["projects", output.projects],
    ["education", output.education],
    ["certifications", output.certifications],
    ["achievements", output.achievements]
  ];
  for (const [section, items] of sections) {
    const label = section === "workHistory" ? "work history" : section;
    if (output.sectionStatus[section] === "present" && items.length === 0) {
      throw new PublicApiError(`Resume parsing is incomplete for ${label}. No master resume was changed.`, 422, {
        code: "RESUME_PARSE_INCOMPLETE",
        section,
        retryable: false
      });
    }
    if (output.sectionStatus[section] === "absent" && items.length > 0) {
      throw new PublicApiError(`Resume parsing returned an inconsistent ${label} section. No master resume was changed.`, 422, {
        code: "RESUME_PARSE_INVALID_OUTPUT",
        section,
        retryable: false
      });
    }
    if (hasSectionHeading(source, section) && items.length === 0) {
      throw new PublicApiError(`Resume parsing is incomplete for ${label}. No master resume was changed.`, 422, {
        code: "RESUME_PARSE_INCOMPLETE",
        section,
        retryable: false
      });
    }
  }

  assertTypedContactProjections(output);
  assertSourceSupported(sourceForTypedSection(output, "summary"), output.summary, "summary");
  output.skills.forEach((item, index) => assertSourceSupported(sourceForTypedSection(output, "skills"), item, `skills[${index}]`));
  output.achievements.forEach((item, index) => assertSourceSupported(sourceForTypedSection(output, "achievements"), item, `achievements[${index}]`));
  assertOrderedSourceProjectionList(sourceForTypedSection(output, "skills"), output.skills, "skills");
  assertOrderedSourceProjectionList(
    sourceForTypedSection(output, "achievements"), output.achievements, "achievements"
  );
  output.workHistory.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `workHistory[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.company, `workHistory[${index}].company`);
    assertSourceSupported(item.sourceText, item.title, `workHistory[${index}].title`);
    assertSourceSupported(item.sourceText, item.location, `workHistory[${index}].location`);
    assertSourceSupported(item.sourceText, item.startDate, `workHistory[${index}].startDate`);
    assertSourceSupported(item.sourceText, item.endDate, `workHistory[${index}].endDate`);
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `workHistory[${index}].bullets[${entryIndex}]`));
    assertOrderedSourceProjectionList(item.sourceText, item.bullets, `workHistory[${index}].bullets`);
    assertResumeDate(item.startDate, "workHistory", "workHistory date or location", `workHistory[${index}].startDate`);
    assertResumeDate(item.endDate, "workHistory", "workHistory date or location", `workHistory[${index}].endDate`);
    assertWorkHeaderSemantics(item, `workHistory[${index}]`);
    assertWorkLocationSemantics(item);
    assertUnambiguousNarrativeEntries(item.bullets, "workHistory", `workHistory[${index}].bullets`);
    assertNoUnprojectedHeaderPairBeforeNarrative(
      item.sourceText,
      item.bullets,
      [item.company, item.title, item.location, item.startDate, item.endDate],
      "workHistory",
      `workHistory[${index}].sourceText`
    );
    assertNoUndeclaredRecordHeaderAfterNarrative(
      item.sourceText,
      recordBoundaryAnchors(
        item.sourceText,
        item.bullets,
        [item.company, item.title, item.location, item.startDate, item.endDate]
      ),
      "workHistory",
      `workHistory[${index}].sourceText`
    );
  });
  output.projects.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `projects[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `projects[${index}].name`);
    assertSourceSupported(item.sourceText, item.description, `projects[${index}].description`);
    assertSourceSupported(item.sourceText, item.date, `projects[${index}].date`);
    item.technologies.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].technologies[${entryIndex}]`));
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].bullets[${entryIndex}]`));
    assertOrderedSourceProjectionList(item.sourceText, item.technologies, `projects[${index}].technologies`);
    assertOrderedSourceProjectionList(item.sourceText, item.bullets, `projects[${index}].bullets`);
    assertResumeDate(item.date, "projects", "projects date", `projects[${index}].date`);
    assertProjectStructure(item, `projects[${index}]`);
    assertUnambiguousNarrativeEntries(item.bullets, "projects", `projects[${index}].bullets`);
    assertNoUnprojectedHeaderPairBeforeNarrative(
      item.sourceText,
      item.bullets,
      [item.name, item.description, item.date, ...item.technologies],
      "projects",
      `projects[${index}].sourceText`
    );
    assertNoUndeclaredRecordHeaderAfterNarrative(
      item.sourceText,
      recordBoundaryAnchors(
        item.sourceText,
        item.bullets,
        [item.name, item.description, item.date, ...item.technologies]
      ),
      "projects",
      `projects[${index}].sourceText`
    );
  });
  output.education.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `education[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.institution, `education[${index}].institution`);
    assertSourceSupported(item.sourceText, item.credential, `education[${index}].credential`);
    assertSourceSupported(item.sourceText, item.fieldOfStudy, `education[${index}].fieldOfStudy`);
    assertSourceSupported(item.sourceText, item.startDate, `education[${index}].startDate`);
    assertSourceSupported(item.sourceText, item.endDate, `education[${index}].endDate`);
    item.details.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `education[${index}].details[${entryIndex}]`));
    assertOrderedSourceProjectionList(item.sourceText, item.details, `education[${index}].details`);
    assertResumeDate(item.startDate, "education", "education date", `education[${index}].startDate`);
    assertResumeDate(item.endDate, "education", "education date", `education[${index}].endDate`);
    assertUnambiguousNarrativeEntries(item.details, "education", `education[${index}].details`);
    assertNoUnprojectedHeaderPairBeforeNarrative(
      item.sourceText,
      item.details,
      [item.institution, item.credential, item.fieldOfStudy, item.startDate, item.endDate],
      "education",
      `education[${index}].sourceText`
    );
    assertNoUndeclaredRecordHeaderAfterNarrative(
      item.sourceText,
      recordBoundaryAnchors(
        item.sourceText,
        item.details,
        [item.institution, item.credential, item.fieldOfStudy, item.startDate, item.endDate]
      ),
      "education",
      `education[${index}].sourceText`
    );
  });
  output.certifications.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `certifications[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `certifications[${index}].name`);
    assertSourceSupported(item.sourceText, item.issuer, `certifications[${index}].issuer`);
    assertSourceSupported(item.sourceText, item.date, `certifications[${index}].date`);
    assertSourceSupported(item.sourceText, item.expirationDate, `certifications[${index}].expirationDate`);
    item.details.forEach((entry, entryIndex) =>
      assertSourceSupported(item.sourceText, entry, `certifications[${index}].details[${entryIndex}]`));
    assertOrderedSourceProjectionList(item.sourceText, item.details, `certifications[${index}].details`);
    assertResumeDate(item.date, "certifications", "certification date", `certifications[${index}].date`);
    assertResumeDate(item.expirationDate, "certifications", "certification date", `certifications[${index}].expirationDate`);
    assertNoUnprojectedHeaderPairBeforeNarrative(
      item.sourceText,
      item.details,
      [item.name, item.issuer, item.date, item.expirationDate],
      "certifications",
      `certifications[${index}].sourceText`
    );
    assertNoUndeclaredRecordHeaderAfterNarrative(
      item.sourceText,
      recordBoundaryAnchors(
        item.sourceText,
        item.details,
        [item.name, item.issuer, item.date, item.expirationDate]
      ),
      "certifications",
      `certifications[${index}].sourceText`
    );
  });
  return output;
}

export function assembleAndValidateResumeV6(
  rawSource: string,
  value: unknown
): ParsedResumeV6 {
  const parsed = resumeParseProviderV6Schema.safeParse(value);
  if (!parsed.success) {
    const fieldPath = zodFieldPath(parsed.error.issues[0]?.path ?? []);
    throw new PublicApiError(
      "Resume parsing returned an invalid structured result. No master resume was changed.",
      422,
      {
        code: "RESUME_PARSE_INVALID_OUTPUT",
        ...(fieldPath ? { fieldPath } : {}),
        retryable: false
      }
    );
  }
  const assembled = assembleParsedResumeFromSpans(rawSource, parsed.data);
  const validated = validateParsedResumeOutput(
    rawSource,
    { ...assembled, contractVersion: "5" },
    { allowLegacy: false }
  );
  return { ...validated, contractVersion: "6" };
}

export function decodeStoredParsedResume(rawSource: string, value: unknown): ParsedResumeV6 | ParsedResumeV5 {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).contractVersion === "6"
  ) {
    const validated = validateParsedResumeOutput(
      rawSource,
      { ...(value as Record<string, unknown>), contractVersion: "5" },
      { allowLegacy: false }
    );
    return { ...validated, contractVersion: "6" };
  }
  return validateParsedResumeOutput(rawSource, value, { allowLegacy: true });
}

const resumeValidationErrorCodes = new Set([
  "RESUME_PARSE_INCOMPLETE",
  "RESUME_PARSE_INVALID_OUTPUT",
  "RESUME_PARSE_STRUCTURE_AMBIGUOUS",
  "RESUME_PARSE_UNSUPPORTED_FACT"
]);

const resumeSourceSectionNames = new Set<ResumeSourceSectionName>([
  "contactInfo",
  "summary",
  "skills",
  "workHistory",
  "projects",
  "education",
  "certifications",
  "achievements",
  "additional"
]);

function resumeValidationErrorDetails(error: unknown) {
  if (!error || typeof error !== "object" || !("details" in error)) return null;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object"
    ? details as Record<string, unknown>
    : null;
}

function safeResumeValidationErrorCode(details: Record<string, unknown> | null) {
  const code = details?.code;
  return typeof code === "string" && resumeValidationErrorCodes.has(code) ? code : null;
}

function safeResumeValidationSection(value: unknown): ResumeSourceSectionName | null {
  return typeof value === "string" && resumeSourceSectionNames.has(value as ResumeSourceSectionName)
    ? value as ResumeSourceSectionName
    : null;
}

function sourceSectionIndexFromFieldPath(fieldPath: unknown) {
  if (typeof fieldPath !== "string") return null;
  const match = /^sourceSections\[([0-9]+)\](?:\.|$)/u.exec(fieldPath);
  return match ? Number(match[1]) : null;
}

function diagnosticStringMeasure(value: string, fingerprintKey: string) {
  return {
    unit: "utf8_bytes" as const,
    count: Buffer.byteLength(value, "utf8"),
    fingerprint: createHmac("sha256", fingerprintKey).update(value).digest("hex")
  };
}

function diagnosticFieldComponent(fieldPath: unknown) {
  if (typeof fieldPath !== "string") return null;
  const lastComponent = fieldPath.match(/(?:^|\.)([A-Za-z][A-Za-z0-9]*)(?:\[[0-9]+\])?$/u)?.[1];
  return lastComponent ?? null;
}

function resumeSectionFromFieldPath(fieldPath: unknown) {
  if (typeof fieldPath !== "string") return null;
  const sectionStatus = /^sectionStatus\.([A-Za-z][A-Za-z0-9]*)$/u.exec(fieldPath)?.[1];
  if (sectionStatus) return safeResumeValidationSection(sectionStatus);
  const root = /^[A-Za-z][A-Za-z0-9]*/u.exec(fieldPath)?.[0];
  return safeResumeValidationSection(root);
}

/**
 * Reduces a resume validation failure to bounded, non-content diagnostics.
 * Fingerprints are keyed so low-entropy resume fragments cannot be recovered
 * with an offline dictionary. The key and compared values are never returned.
 */
export function classifyResumeValidationFailure(
  rawSource: string,
  value: unknown,
  error: unknown,
  fingerprintKey: string
): ResumeValidationDiagnostic {
  const details = resumeValidationErrorDetails(error);
  const internalErrorCode = safeResumeValidationErrorCode(details);
  const fieldPath = details?.fieldPath;
  const sectionIndex = sourceSectionIndexFromFieldPath(fieldPath);
  const fieldPathSection = resumeSectionFromFieldPath(fieldPath);
  const normalizedSource = normalizeResumeLineEndings(rawSource);
  let expectedSections: Array<Omit<ResumeSourceSection, "recordBlocks">> = [];
  try {
    expectedSections = expectedSourceSections(normalizedSource);
  } catch {
    // Diagnostics must never replace the original validation failure.
  }

  const providerV6 = value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).contractVersion === "6";
  if (providerV6) {
    const providerResult = resumeParseProviderV6Schema.safeParse(value);
    if (!providerResult.success) {
      const firstIssue = providerResult.error.issues[0];
      const spanIndex = firstIssue?.path[0] === "recordSpans" &&
        typeof firstIssue.path[1] === "number"
        ? firstIssue.path[1]
        : null;
      const rawSpans = (value as { recordSpans?: unknown }).recordSpans;
      const rawSpan = Array.isArray(rawSpans) && spanIndex !== null ? rawSpans[spanIndex] : null;
      const rawSectionId = rawSpan && typeof rawSpan === "object" && !Array.isArray(rawSpan)
        ? (rawSpan as { sectionId?: unknown }).sectionId
        : null;
      const spanSectionIndex = typeof rawSectionId === "string"
        ? /^section-([1-9][0-9]*)$/u.exec(rawSectionId)
        : null;
      const spanSection = spanSectionIndex
        ? expectedSections[Number(spanSectionIndex[1]) - 1]?.section ?? null
        : null;
      const issueAtSpanObject = spanIndex !== null && firstIssue?.path.length === 2;
      if (issueAtSpanObject && rawSpan && typeof rawSpan === "object" && !Array.isArray(rawSpan)) {
        return {
          validationStage: "resume_schema",
          internalErrorCode,
          section: spanSection,
          mismatchComponent: "objectShape",
          expected: { unit: "properties", count: 3, fingerprint: null },
          actual: {
            unit: "properties",
            count: Object.keys(rawSpan as Record<string, unknown>).length,
            fingerprint: null
          },
          fingerprintAlgorithm: null
        };
      }
      const issueComponent = firstIssue?.path.at(-1);
      return {
        validationStage: "resume_schema",
        internalErrorCode,
        section: spanSection
          ?? safeResumeValidationSection(details?.section)
          ?? fieldPathSection,
        mismatchComponent: typeof issueComponent === "string" ? issueComponent : null,
        expected: null,
        actual: null,
        fingerprintAlgorithm: null
      };
    }
    return {
      validationStage: typeof fieldPath === "string" && (
        fieldPath.startsWith("recordSpans") || /^section-[0-9]+\.lines/u.test(fieldPath)
      ) ? "lossless_source_authority" : "typed_projection",
      internalErrorCode,
      section: safeResumeValidationSection(details?.section) ?? fieldPathSection,
      mismatchComponent: diagnosticFieldComponent(fieldPath),
      expected: null,
      actual: null,
      fingerprintAlgorithm: null
    };
  }

  const schemaResult = parsedResumeSchema.safeParse(value);
  if (!schemaResult.success) {
    const expectedSection = sectionIndex === null ? null : expectedSections[sectionIndex] ?? null;
    const actualSection = sectionIndex === null || !value || typeof value !== "object"
      ? null
      : (value as { sourceSections?: unknown }).sourceSections;
    const actualItem = Array.isArray(actualSection) && sectionIndex !== null
      ? actualSection[sectionIndex]
      : null;
    const firstIssue = schemaResult.error.issues[0];
    const issueAtSectionObject = sectionIndex !== null
      && firstIssue?.path.length === 2
      && firstIssue.path[0] === "sourceSections"
      && firstIssue.path[1] === sectionIndex;
    const actualIsObject = actualItem !== null
      && typeof actualItem === "object"
      && !Array.isArray(actualItem);

    if (expectedSection && issueAtSectionObject && actualIsObject) {
      return {
        validationStage: "resume_schema",
        internalErrorCode,
        section: expectedSection.section,
        mismatchComponent: "objectShape",
        expected: { unit: "properties", count: 4, fingerprint: null },
        actual: {
          unit: "properties",
          count: Object.keys(actualItem as Record<string, unknown>).length,
          fingerprint: null
        },
        fingerprintAlgorithm: null
      };
    }

    const issueComponent = firstIssue?.path.at(-1);
    return {
      validationStage: "resume_schema",
      internalErrorCode,
      section: expectedSection?.section
        ?? safeResumeValidationSection(details?.section)
        ?? fieldPathSection,
      mismatchComponent: typeof issueComponent === "string" ? issueComponent : null,
      expected: null,
      actual: null,
      fingerprintAlgorithm: null
    };
  }

  const output = normalizeParsedResumeLineEndings(schemaResult.data);
  const expectedSection = sectionIndex === null ? null : expectedSections[sectionIndex] ?? null;
  const actualSection = sectionIndex === null ? null : output.sourceSections[sectionIndex] ?? null;
  if (expectedSection && actualSection) {
    const differingComponent = (["section", "heading", "sourceText"] as const)
      .find((component) => actualSection[component] !== expectedSection[component]);
    if (differingComponent) {
      const expectedValue = expectedSection[differingComponent] ?? "";
      const actualValue = actualSection[differingComponent] ?? "";
      return {
        validationStage: "lossless_source_authority",
        internalErrorCode,
        section: expectedSection.section,
        mismatchComponent: differingComponent,
        expected: diagnosticStringMeasure(expectedValue, fingerprintKey),
        actual: diagnosticStringMeasure(actualValue, fingerprintKey),
        fingerprintAlgorithm: "HMAC-SHA256"
      };
    }
  }

  const detailsSection = safeResumeValidationSection(details?.section);
  return {
    validationStage: fieldPath === "sourceSections" || sectionIndex !== null
      ? "lossless_source_authority"
      : "typed_projection",
    internalErrorCode,
    section: expectedSection?.section ?? detailsSection ?? fieldPathSection,
    mismatchComponent: diagnosticFieldComponent(fieldPath),
    expected: null,
    actual: null,
    fingerprintAlgorithm: null
  };
}

type ProviderUsage = Pick<GeminiUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">;

class ResumeProviderError extends Error {
  usage: ProviderUsage | null;
  billingDisposition: "known" | "not_charged" | "uncertain";

  constructor(message: string, options: {
    usage?: ProviderUsage | null;
    billingDisposition?: "known" | "not_charged" | "uncertain";
  }) {
    super(message);
    this.name = "ResumeProviderError";
    this.usage = options.usage ?? null;
    this.billingDisposition = options.billingDisposition ?? (this.usage ? "known" : "uncertain");
  }
}

async function callOpenAiResumeProvider(input: {
  model: string;
  payload: ReturnType<typeof buildResumeProviderSourceInput>;
  maxOutputTokens: number;
}) {
  const client = getOpenAIClient();
  if (!client) throw new LocalAiUnavailableError();
  let response;
  try {
    response = await client.chat.completions.create({
      model: input.model,
      temperature: 0,
      max_tokens: input.maxOutputTokens,
      response_format: zodResponseFormat(resumeParseProviderV6Schema, "resume_parse_v6"),
      messages: [
        { role: "system", content: resumeParsePromptV6 },
        { role: "user", content: JSON.stringify(input.payload) }
      ]
    });
  } catch (error) {
    if (
      error instanceof OpenAI.APIError &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500
    ) {
      throw new ResumeProviderError("OpenAI rejected resume parsing before completion.", {
        billingDisposition: "not_charged"
      });
    }
    throw new ResumeProviderError("OpenAI resume parsing outcome is uncertain.", {});
  }
  const usage = response.usage;
  if (!usage) {
    throw new ResumeProviderError("OpenAI returned no usage metadata.", {});
  }
  const providerUsage: ProviderUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0
  };
  const choice = response.choices[0];
  if (choice?.finish_reason !== "stop") {
    throw new ResumeProviderError(
      `OpenAI did not complete the structured response (finish reason: ${String(choice?.finish_reason ?? "missing")}).`,
      { usage: providerUsage }
    );
  }
  const content = choice.message.content;
  if (!content) {
    throw new ResumeProviderError("OpenAI returned an empty structured response.", {
      usage: providerUsage
    });
  }
  try {
    return { value: JSON.parse(content) as unknown, usage: providerUsage };
  } catch {
    throw new ResumeProviderError("OpenAI returned invalid structured JSON.", {
      usage: providerUsage
    });
  }
}

function providerUsageFromError(error: unknown) {
  if (error instanceof GeminiProviderError || error instanceof ResumeProviderError) return error.usage;
  return null;
}

function providerBillingDisposition(error: unknown, fallbackUsage: ProviderUsage | null) {
  if (error instanceof GeminiProviderError || error instanceof ResumeProviderError) return error.billingDisposition;
  return fallbackUsage ? "known" as const : "uncertain" as const;
}

function providerFailureCode(error: unknown) {
  if (error instanceof GeminiProviderError) {
    return error.providerCode ?? (error.httpStatus ? `HTTP_${error.httpStatus}` : error.name);
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function publicProviderError(error: unknown, visibility: {
  provider: string;
  billingStatus: "known" | "not_charged" | "uncertain";
  actualCostMicros: number | null;
}) {
  const safeDetails = {
    provider: visibility.provider,
    billingStatus: visibility.billingStatus,
    actualCostMicros: visibility.actualCostMicros,
    ...(error instanceof GeminiProviderError
      ? {
          providerHttpStatus: error.httpStatus,
          providerCode: error.providerCode,
          providerRequestId: error.requestId
        }
      : {})
  };
  if (error instanceof PublicApiError) {
    return new PublicApiError(error.message, error.status, {
      ...error.details,
      ...safeDetails
    });
  }
  if (!(error instanceof GeminiProviderError || error instanceof ResumeProviderError)) return error;
  if (error.billingDisposition === "not_charged") {
    return new PublicApiError("The configured AI provider rejected resume parsing before completion. No master resume was changed.", 502, {
      code: "RESUME_PARSE_PROVIDER_REJECTED",
      retryable: true,
      ...safeDetails
    });
  }
  if (error.billingDisposition === "uncertain") {
    return new PublicApiError("Resume parsing reached the configured AI provider, but the outcome is uncertain. No master resume was changed; review AI usage before retrying.", 503, {
      code: "RESUME_PARSE_PROVIDER_UNCERTAIN",
      retryable: false,
      ...safeDetails
    });
  }
  return new PublicApiError("The configured AI provider returned a resume result that could not be accepted. No master resume was changed.", 502, {
    code: "RESUME_PARSE_PROVIDER_INVALID",
    retryable: false,
    ...safeDetails
  });
}

export async function parseResumeTextWithMeta(
  text: string,
  userId?: string,
  options: AiInvocationOptions = {}
) {
  if (!text.trim()) {
    throw new PublicApiError("Resume text is empty.", 422, { code: "RESUME_TEXT_EMPTY" });
  }
  const normalizedText = normalizeResumeLineEndings(text);
  const provider = getAiProviderForFeature("RESUME_PARSE");
  assertResumeParseOutputCapacity(normalizedText, provider);
  const outputTokenLimit = resumeParseOutputTokenLimit(provider);
  if (getAiRuntimeMode(provider) !== provider) throw new LocalAiUnavailableError();
  if (!userId) {
    throw new PublicApiError("Resume parsing requires an authenticated budget owner.", 503, {
      code: "AI_BUDGET_OWNER_REQUIRED"
    });
  }
  const settings = await getOrCreateAiSettings(userId);
  const model = getAiModel("RESUME_PARSE", settings);
  if (getModelPricing(model).provider !== provider) {
    throw new PublicApiError("Resume parsing requires pricing registered for its configured provider.", 503, {
      code: "AI_MODEL_PRICING_UNKNOWN"
    });
  }
  const payload = buildResumeProviderSourceInput(normalizedText);
  const { policy } = assertAiInputWithinLimits("RESUME_PARSE", resumeParsePromptV6, {
    payload,
    responseJsonSchema: RESUME_PARSE_PROVIDER_V6_JSON_SCHEMA
  });
  const requestHash = hashAiInput("resumeParsePrompt", RESUME_PARSE_CACHE_VERSION, payload);
  const cached = await findCachedAiResponse({
    userId,
    provider,
    model,
    promptName: "resumeParsePrompt",
    promptVersion: RESUME_PARSE_CACHE_VERSION,
    requestHash
  });
  if (cached) {
    return {
      data: decodeStoredParsedResume(normalizedText, cached.output),
      meta: {
        provider,
        model,
        promptVersion: RESUME_PARSE_PROMPT_VERSION,
        requestHash,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 0,
        mocked: false
      }
    };
  }

  const maximumCostMicros = estimateAiCostMicros({
    model,
    inputTokens: policy.maxInputTokens,
    outputTokens: outputTokenLimit
  });
  const financial = getAiFinancialPolicy();
  if (maximumCostMicros > financial.maximumRequestCents * 10_000) {
    throw new PublicApiError("This request exceeds the configured per-request AI limit.", 429, {
      code: "AI_REQUEST_COST_LIMIT",
      maximumCostMicros
    });
  }
  if (!options.highCostConfirmed || !options.dataSharingConfirmed) {
    throw new PublicApiError("Confirm sending the complete resume text and this AI request's maximum cost before continuing.", 428, {
      code: "AI_COST_CONFIRMATION_REQUIRED",
      maximumCostMicros,
      provider,
      dataType: "resume_text"
    });
  }

  await reconcileStaleAiReservations(userId);
  const activePriorAttempt = await prisma.aIBudgetReservation.findFirst({
    where: {
      userId,
      provider,
      model,
      feature: "RESUME_PARSE",
      promptName: "resumeParsePrompt",
      promptVersion: RESUME_PARSE_CACHE_VERSION,
      requestHash,
      status: { in: ["RESERVED", "UNCERTAIN"] }
    },
    select: { id: true, status: true }
  });
  if (activePriorAttempt?.status === "UNCERTAIN") {
    throw new PublicApiError(
      "An identical resume parse already reached the configured AI provider with an uncertain outcome. No master resume was changed; review AI usage instead of retrying.",
      409,
      { code: "RESUME_PARSE_PRIOR_OUTCOME_UNCERTAIN", retryable: false }
    );
  }
  if (activePriorAttempt) {
    throw new PublicApiError(
      "An identical resume parse is still reserved or running. No second provider call was started.",
      409,
      { code: "AI_DUPLICATE_IN_PROGRESS", retryable: true }
    );
  }

  const reservation = await reserveAiBudget({
    userId,
    provider,
    model,
    feature: "RESUME_PARSE",
    promptName: "resumeParsePrompt",
    promptVersion: RESUME_PARSE_CACHE_VERSION,
    requestHash,
    maximumCostMicros,
    automation: false
  });
  let usage: ProviderUsage | null = null;
  let actualCostMicros: number | undefined;
  let requestDispatched = false;
  let reconciled = false;
  try {
    requestDispatched = true;
    const response = provider === "gemini"
      ? await callGeminiJsonProvider({
          apiKey: process.env.GEMINI_API_KEY!.trim(),
          model,
          systemPrompt: resumeParsePromptV6,
          payload,
          responseJsonSchema: RESUME_PARSE_GEMINI_PROVIDER_V6_JSON_SCHEMA,
          maxOutputTokens: outputTokenLimit,
          thinkingLevel: "LOW"
        })
      : provider === "openai"
        ? await callOpenAiResumeProvider({ model, payload, maxOutputTokens: outputTokenLimit })
        : (() => { throw new PublicApiError(`Unsupported resume parsing provider: ${provider}.`, 503); })();
    usage = response.usage;
    actualCostMicros = estimateAiCostMicros({
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens
    });
    if (
      usage.inputTokens > policy.maxInputTokens ||
      usage.outputTokens > outputTokenLimit ||
      actualCostMicros > reservation.maximumCostMicros
    ) {
      throw new ResumeProviderError("Resume parsing usage exceeded its reserved bounds.", {
        usage
      });
    }
    const data = assembleAndValidateResumeV6(normalizedText, response.value);
    try {
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: "SUCCEEDED",
        actualCostMicros,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheOutput: data
      });
    } catch {
      throw new ResumeProviderError(
        "The validated resume result could not be recorded durably, so an identical paid retry is blocked.",
        { usage, billingDisposition: "uncertain" }
      );
    }
    reconciled = true;
    return {
      data,
      meta: {
        provider,
        model,
        promptVersion: RESUME_PARSE_PROMPT_VERSION,
        requestHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        estimatedCostMicros: actualCostMicros,
        mocked: false
      }
    };
  } catch (error) {
    const providerUsage = providerUsageFromError(error) ?? usage;
    const knownCost = providerUsage ? estimateAiCostMicros({
      model,
      inputTokens: providerUsage.inputTokens,
      outputTokens: providerUsage.outputTokens,
      cachedInputTokens: providerUsage.cachedInputTokens
    }) : undefined;
    const billingDisposition = providerBillingDisposition(error, providerUsage);
    const uncertain = requestDispatched && (
      billingDisposition === "uncertain" ||
      (knownCost !== undefined && knownCost > reservation.maximumCostMicros)
    );
    if (!reconciled) {
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: uncertain ? "UNCERTAIN" : "FAILED",
        actualCostMicros: billingDisposition === "not_charged" ? 0 : uncertain ? undefined : knownCost,
        inputTokens: providerUsage?.inputTokens,
        outputTokens: providerUsage?.outputTokens,
        cachedInputTokens: providerUsage?.cachedInputTokens,
        errorCode: providerFailureCode(error)
      }).catch(() => undefined);
    }
    throw publicProviderError(error, {
      provider,
      billingStatus: uncertain ? "uncertain" : billingDisposition,
      actualCostMicros: billingDisposition === "not_charged" ? 0 : uncertain ? null : knownCost ?? null
    });
  }
}

export async function parseResumeText(text: string, userId?: string, options: AiInvocationOptions = {}) {
  return (await parseResumeTextWithMeta(text, userId, options)).data;
}

export async function tailorResume(payload: unknown, _fallbackText: string, userId?: string) {
  const generated = await generateJson<TailoredResumeOutput>({
    promptName: "resumeTailorPrompt",
    systemPrompt: resumeTailorPrompt,
    payload,
    schema: tailoredResumeSchema,
    context: userId ? { userId, feature: "RESUME_TAILOR", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
