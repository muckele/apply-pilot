import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { resumeParsePrompt } from "@/prompts/resumeParsePrompt";
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
import { assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

export const RESUME_PARSE_PROMPT_VERSION = "5";
export const RESUME_PARSE_CACHE_VERSION = "5";

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

export type ResumeSourceSectionName =
  | "contactInfo"
  | "summary"
  | "skills"
  | "workHistory"
  | "projects"
  | "education"
  | "certifications"
  | "achievements"
  | "additional";

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

export type LegacyParsedResume = Omit<ParsedResumeCore, "certifications" | "projects"> & {
  contractVersion: "3";
  projects: Array<Omit<ResumeProjectItem, "date"> & { date?: string | null }>;
  certifications: Array<Omit<ResumeCertificationItem, "details"> & { details?: string[] }>;
};

export type ParsedResume = ParsedResumeV5 | LegacyParsedResume;

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
const boundedSourceString = z.string().trim().min(1).max(2_000).refine((value) => !/[\r\n]/.test(value));
const boundedSourceBlock = z.string().trim().min(1).max(20_000);
const nullableSourceString = z.union([boundedSourceString, z.null()]);
const nullableContactSourceString = z.union([
  boundedSourceString.refine((value) => !/[\r\n]/.test(value)),
  z.null()
]);
const sourceStringList = z.array(boundedSourceString).max(100);
const sectionStatusSchema = z.enum(["present", "absent"]);

const sourceSectionSchema = z.object({
  section: z.enum([
    "contactInfo", "summary", "skills", "workHistory", "projects", "education",
    "certifications", "achievements", "additional"
  ]),
  heading: nullableSourceString,
  sourceText: boundedSourceBlock,
  recordBlocks: z.array(boundedSourceBlock).min(1).max(100)
}).strict();

export const parsedResumeSchema: z.ZodType<ParsedResumeV5, z.ZodTypeDef, unknown> = z.object({
  contractVersion: z.literal("5"),
  sourceSections: z.array(sourceSectionSchema).min(1).max(100),
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
    date: nullableSourceString,
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
    details: sourceStringList
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

const nullableJsonString = { type: ["string", "null"] } as const;
const jsonString = { type: "string" } as const;
const jsonStringArray = { type: "array", items: jsonString } as const;

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
          sourceText: jsonString,
          recordBlocks: jsonStringArray
        },
        required: ["section", "heading", "sourceText", "recordBlocks"]
      }
    },
    contactInfo: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceText: jsonString,
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
    summary: jsonString,
    skills: jsonStringArray,
    workHistory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonString,
          company: jsonString,
          title: jsonString,
          location: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          bullets: jsonStringArray
        },
        required: ["sourceText", "company", "title", "location", "startDate", "endDate", "bullets"]
      }
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonString,
          name: jsonString,
          description: nullableJsonString,
          date: nullableJsonString,
          technologies: jsonStringArray,
          bullets: jsonStringArray
        },
        required: ["sourceText", "name", "description", "date", "technologies", "bullets"]
      }
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonString,
          institution: jsonString,
          credential: nullableJsonString,
          fieldOfStudy: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          details: jsonStringArray
        },
        required: ["sourceText", "institution", "credential", "fieldOfStudy", "startDate", "endDate", "details"]
      }
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceText: jsonString,
          name: jsonString,
          issuer: nullableJsonString,
          date: nullableJsonString,
          expirationDate: nullableJsonString,
          details: jsonStringArray
        },
        required: ["sourceText", "name", "issuer", "date", "expirationDate", "details"]
      }
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
    warnings: jsonStringArray
  },
  required: [
    "contractVersion", "sourceSections", "contactInfo", "summary", "skills", "workHistory", "projects",
    "education", "certifications", "achievements", "sectionStatus", "warnings"
  ]
} as const;

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

function isUnambiguousNarrativeEntry(entry: string) {
  const explicitBullet = /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(entry);
  const completeStatement = !/[\r\n]/.test(entry) && /[.!?…]$/u.test(entry);
  return explicitBullet || completeStatement;
}

function assertUnambiguousNarrativeEntries(entries: string[], section: string, fieldPath: string) {
  entries.forEach((entry, index) => {
    if (!isUnambiguousNarrativeEntry(entry)) {
      throw new PublicApiError(
        `Resume parsing returned an ambiguous ${section} detail that could be a merged record boundary. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, fieldPath: `${fieldPath}[${index}]`, retryable: false }
      );
    }
  });
}

const sectionHeadings: Record<keyof ParsedResume["sectionStatus"], RegExp> = {
  summary: /^(?:(?:PROFESSIONAL\s+|CAREER\s+)?(?:SUMMARY|PROFILE)|OBJECTIVE|ABOUT\s+ME)$/i,
  skills: /^(?:(?:TECHNICAL\s+|KEY\s+)?SKILLS(?:\s+(?:AND|&)\s+TOOLS)?|CORE\s+COMPETENCIES)$/i,
  workHistory: /^(?:WORK|PROFESSIONAL|EMPLOYMENT|CAREER)?\s*(?:EXPERIENCE|HISTORY)$/i,
  projects: /^(?:SELECTED\s+|PROFESSIONAL\s+)?PROJECTS?$/i,
  education: /^(?:EDUCATION|ACADEMIC\s+(?:BACKGROUND|HISTORY))$/i,
  certifications: /^(?:CERTIFICATIONS?|LICENSES?|CERTIFICATIONS?\s+(?:AND|&)\s+LICENSES?)$/i,
  achievements: /^(?:ACHIEVEMENTS?|ACCOMPLISHMENTS?|AWARDS?|HONORS?)$/i
};

const otherSectionHeading = /^(?:CONTACT|LANGUAGES?|INTERESTS?|VOLUNTEER(?:ING)?|PUBLICATIONS?|REFERENCES?|ADDITIONAL\s+INFORMATION)$/i;

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

function sectionForHeading(line: string): keyof ParsedResume["sectionStatus"] | null {
  const heading = line.trim().replace(/:$/, "");
  for (const [section, pattern] of Object.entries(sectionHeadings)) {
    if (pattern.test(heading)) return section as keyof ParsedResume["sectionStatus"];
  }
  return null;
}

function hasSectionHeading(source: string, section: keyof ParsedResume["sectionStatus"]) {
  return source.split(/\r?\n/).some((line) => sectionHeadings[section].test(line.trim().replace(/:$/, "")));
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

function sourceSectionNameForHeading(line: string): ResumeSourceSectionName | null {
  const recognized = sectionForHeading(line);
  if (recognized) return recognized;
  const heading = line.trim().replace(/:$/, "");
  if (/^CONTACT$/i.test(heading)) return "contactInfo";
  return otherSectionHeading.test(heading) ? "additional" : null;
}

function expectedSourceSections(source: string): Array<Omit<ResumeSourceSection, "recordBlocks">> {
  const lines = source.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const section = sourceSectionNameForHeading(line);
    return section ? [{ index, section, heading: line.trim() }] : [];
  });
  if (!headings.some((item) => item.section !== "additional")) {
    throw new PublicApiError(
      "Resume structure could not be validated because no supported section headings were found. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", retryable: false }
    );
  }

  const result: Array<Omit<ResumeSourceSection, "recordBlocks">> = [];
  const preambleEnd = headings[0]?.index ?? lines.length;
  const preamble = lines.slice(0, preambleEnd).join("\n").trim();
  if (preamble) result.push({ section: "contactInfo", heading: null, sourceText: preamble });
  headings.forEach((item, index) => {
    const end = headings[index + 1]?.index ?? lines.length;
    const sourceText = lines.slice(item.index + 1, end).join("\n").trim();
    if (!sourceText) {
      throw new PublicApiError(
        `Resume parsing is incomplete for ${item.section}. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section: item.section, fieldPath: `sourceSections[${result.length}].sourceText`, retryable: false }
      );
    }
    result.push({ section: item.section, heading: item.heading, sourceText });
  });
  return result;
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
  if (section === "workHistory") return output.workHistory.map((item) => item.sourceText);
  if (section === "projects") return output.projects.map((item) => item.sourceText);
  if (section === "education") return output.education.map((item) => item.sourceText);
  if (section === "certifications") return output.certifications.map((item) => item.sourceText);
  if (section === "achievements") {
    return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
    const output = legacy.data;
    const sourceSections = expectedSourceSections(source).map((section) => ({
      ...section,
      recordBlocks: legacyRecordBlocks(section.section, section.sourceText, output)
    }));
    return {
      ...output,
      contractVersion: "5",
      sourceSections,
      projects: output.projects.map((project) => ({ ...project, date: project.date ?? null })),
      certifications: output.certifications.map((item) => ({ ...item, details: item.details ?? [] }))
    };
  }
  const current = parsedResumeSchema.safeParse(value);
  if (current.success) return current.data;
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

function assertLosslessSourceAuthority(source: string, output: ParsedResumeV5) {
  const expected = expectedSourceSections(source);
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
    if (canonicalRecords && (
      canonicalRecords.length !== section.recordBlocks.length ||
      canonicalRecords.some((record, index) => record !== section.recordBlocks[index])
    )) {
      const mismatch = section.recordBlocks.findIndex((record, index) => record !== canonicalRecords[index]);
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

function assertOverlappingFactCoverage(
  sourceText: string,
  values: Array<string | null>,
  section: string,
  fieldPath: string,
  allowedLabels: RegExp
) {
  const represented = Array.from({ length: sourceText.length }, () => false);
  values.filter((value): value is string => Boolean(value)).forEach((value) => {
    let offset = 0;
    while (offset <= sourceText.length - value.length) {
      const index = sourceText.indexOf(value, offset);
      if (index < 0) break;
      represented.fill(true, index, index + value.length);
      offset = index + Math.max(1, value.length);
    }
  });
  const remaining = sourceText.split("").map((character, index) => represented[index] ? " " : character)
    .join("")
    .replace(allowedLabels, "");
  if (/[\p{L}\p{N}]/u.test(remaining)) {
    throw new PublicApiError(
      `Resume parsing did not represent every factual line in ${section}. No master resume was changed.`,
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section, fieldPath, retryable: false }
    );
  }
}

export function validateParsedResumeOutput(
  source: string,
  value: unknown,
  options: { allowLegacy?: boolean } = {}
): ParsedResumeV5 {
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
  output.workHistory.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `workHistory[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.company, `workHistory[${index}].company`);
    assertSourceSupported(item.sourceText, item.title, `workHistory[${index}].title`);
    assertSourceSupported(item.sourceText, item.location, `workHistory[${index}].location`);
    assertSourceSupported(item.sourceText, item.startDate, `workHistory[${index}].startDate`);
    assertSourceSupported(item.sourceText, item.endDate, `workHistory[${index}].endDate`);
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `workHistory[${index}].bullets[${entryIndex}]`));
    assertResumeDate(item.startDate, "workHistory", "workHistory date or location", `workHistory[${index}].startDate`);
    assertResumeDate(item.endDate, "workHistory", "workHistory date or location", `workHistory[${index}].endDate`);
    assertWorkLocationSemantics(item);
    assertUnambiguousNarrativeEntries(item.bullets, "workHistory", `workHistory[${index}].bullets`);
  });
  output.projects.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `projects[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `projects[${index}].name`);
    assertSourceSupported(item.sourceText, item.description, `projects[${index}].description`);
    assertSourceSupported(item.sourceText, item.date, `projects[${index}].date`);
    item.technologies.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].technologies[${entryIndex}]`));
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].bullets[${entryIndex}]`));
    assertResumeDate(item.date, "projects", "projects date", `projects[${index}].date`);
    assertProjectStructure(item, `projects[${index}]`);
    assertUnambiguousNarrativeEntries(item.bullets, "projects", `projects[${index}].bullets`);
  });
  output.education.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `education[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.institution, `education[${index}].institution`);
    assertSourceSupported(item.sourceText, item.credential, `education[${index}].credential`);
    assertSourceSupported(item.sourceText, item.fieldOfStudy, `education[${index}].fieldOfStudy`);
    assertSourceSupported(item.sourceText, item.startDate, `education[${index}].startDate`);
    assertSourceSupported(item.sourceText, item.endDate, `education[${index}].endDate`);
    item.details.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `education[${index}].details[${entryIndex}]`));
    assertResumeDate(item.startDate, "education", "education date", `education[${index}].startDate`);
    assertResumeDate(item.endDate, "education", "education date", `education[${index}].endDate`);
    assertUnambiguousNarrativeEntries(item.details, "education", `education[${index}].details`);
  });
  output.certifications.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `certifications[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `certifications[${index}].name`);
    assertSourceSupported(item.sourceText, item.issuer, `certifications[${index}].issuer`);
    assertSourceSupported(item.sourceText, item.date, `certifications[${index}].date`);
    assertSourceSupported(item.sourceText, item.expirationDate, `certifications[${index}].expirationDate`);
    item.details.forEach((entry, entryIndex) =>
      assertSourceSupported(item.sourceText, entry, `certifications[${index}].details[${entryIndex}]`));
    assertResumeDate(item.date, "certifications", "certification date", `certifications[${index}].date`);
    assertResumeDate(item.expirationDate, "certifications", "certification date", `certifications[${index}].expirationDate`);
    assertOverlappingFactCoverage(
      item.sourceText,
      [item.name, item.issuer, item.date, item.expirationDate, ...item.details],
      "certifications",
      `certifications[${index}].details`,
      /\b(?:certification|certificate|license|name|issuer|issued|date|credential\s+id|expires?|expiration)\b/gi
    );
  });
  return output;
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
  text: string;
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
      response_format: zodResponseFormat(parsedResumeSchema, "resume_parse_v5"),
      messages: [
        { role: "system", content: resumeParsePrompt },
        { role: "user", content: JSON.stringify({ resumeText: input.text }) }
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

function publicProviderError(error: unknown, visibility: {
  provider: string;
  billingStatus: "known" | "not_charged" | "uncertain";
  actualCostMicros: number | null;
}) {
  if (!(error instanceof GeminiProviderError || error instanceof ResumeProviderError)) return error;
  const safeDetails = {
    provider: visibility.provider,
    billingStatus: visibility.billingStatus,
    actualCostMicros: visibility.actualCostMicros
  };
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
  const provider = getAiProviderForFeature("RESUME_PARSE");
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
  const payload = { resumeText: text };
  const { policy } = assertAiInputWithinLimits("RESUME_PARSE", resumeParsePrompt, {
    payload,
    responseJsonSchema: RESUME_PARSE_RESPONSE_JSON_SCHEMA
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
      data: validateParsedResumeOutput(text, cached.output, { allowLegacy: false }),
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
    outputTokens: policy.maxOutputTokens
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
          systemPrompt: resumeParsePrompt,
          payload,
          responseJsonSchema: RESUME_PARSE_RESPONSE_JSON_SCHEMA,
          maxOutputTokens: policy.maxOutputTokens,
          thinkingLevel: "LOW"
        })
      : provider === "openai"
        ? await callOpenAiResumeProvider({ model, text, maxOutputTokens: policy.maxOutputTokens })
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
      usage.outputTokens > policy.maxOutputTokens ||
      actualCostMicros > reservation.maximumCostMicros
    ) {
      throw new ResumeProviderError("Resume parsing usage exceeded its reserved bounds.", {
        usage
      });
    }
    const data = validateParsedResumeOutput(text, response.value, { allowLegacy: false });
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
        errorCode: error instanceof Error ? error.name : "UnknownError"
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
