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

export const RESUME_PARSE_PROMPT_VERSION = "3";

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
};

export type ParsedResume = {
  contractVersion: "3";
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

export const parsedResumeSchema: z.ZodType<ParsedResume, z.ZodTypeDef, unknown> = z.object({
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
    expirationDate: nullableSourceString
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
    contractVersion: { type: "string", enum: ["3"] },
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
          technologies: jsonStringArray,
          bullets: jsonStringArray
        },
        required: ["sourceText", "name", "description", "technologies", "bullets"]
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
          expirationDate: nullableJsonString
        },
        required: ["sourceText", "name", "issuer", "date", "expirationDate"]
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
    "contractVersion", "contactInfo", "summary", "skills", "workHistory", "projects",
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
      { code: "RESUME_PARSE_UNSUPPORTED_FACT", retryable: false }
    );
  }
}

function assertCompleteFactCoverage(
  sourceText: string,
  values: Array<string | null>,
  section: string,
  allowedLabels: RegExp
) {
  const occupied = Array.from({ length: sourceText.length }, () => false);
  const facts = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const fact of facts) {
    let offset = 0;
    let match = -1;
    while (offset <= sourceText.length - fact.length) {
      const candidate = sourceText.indexOf(fact, offset);
      if (candidate < 0) break;
      if (occupied.slice(candidate, candidate + fact.length).every((used) => !used)) {
        match = candidate;
        break;
      }
      offset = candidate + 1;
    }
    if (match < 0) {
      throw new PublicApiError(
        `Resume parsing returned overlapping or unsupported ${section} facts. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_UNSUPPORTED_FACT", section, retryable: false }
      );
    }
    occupied.fill(true, match, match + fact.length);
  }
  const remaining = sourceText
    .split("")
    .map((character, index) => occupied[index] ? " " : character)
    .join("")
    .replace(allowedLabels, "");
  if (/[\p{L}\p{N}]/u.test(remaining)) {
    throw new PublicApiError(
      `Resume parsing did not represent every factual line in ${section}. No master resume was changed.`,
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section, retryable: false }
    );
  }
}

function assertUnambiguousNarrativeEntries(entries: string[], section: string) {
  for (const entry of entries) {
    const explicitBullet = /^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(entry);
    const completeStatement = !/[\r\n]/.test(entry) && /[.!?…]$/u.test(entry);
    if (!explicitBullet && !completeStatement) {
      throw new PublicApiError(
        `Resume parsing returned an ambiguous ${section} detail that could be a merged record boundary. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, retryable: false }
      );
    }
  }
}

function assertUnambiguousTechnologyEntries(entries: string[], section: string) {
  for (const entry of entries) {
    if (!/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/u.test(entry) && !/[,/|]/.test(entry)) {
      throw new PublicApiError(
        `Resume parsing returned an ambiguous ${section} technology line that could be a merged record boundary. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, retryable: false }
      );
    }
  }
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

const professionalDescriptorPattern = /\b(?:accountant|administrator|analyst|architect|attorney|chief|consultant|coordinator|designer|developer|director|engineer|executive|founder|leader|manager|officer|owner|president|recruiter|scientist|specialist|staff|strategist|cpa|cfa|mba|ph\.?d\.?|rn|esq)\b/i;
const credentialDescriptorPattern = /^(?:cpa|cfa|mba|ph\.?d\.?|rn|esq)$/i;

function looksLikeProfessionalDescriptor(line: string) {
  return professionalDescriptorPattern.test(line);
}

function classifyContactLocation(line: string): "location" | "not_location" | "ambiguous" {
  if (/^\s*(?:location|address)\s*:/i.test(line)) return "location";
  const tokens = line.trim().split(/\s+/);
  const trailingToken = tokens.at(-1);
  if (!line.includes(",") && tokens.length > 1 && trailingToken && commonRegionAbbreviations.has(trailingToken)) {
    return "ambiguous";
  }
  const suffix = line.split(",").at(-1)?.trim();
  const hasCountryOrRemote = /\b(?:remote|united states|usa|canada|united kingdom|uk)\b/i.test(line);
  const hasRegionSuffix = Boolean(
    suffix &&
    suffix !== line.trim() &&
    (commonRegionAbbreviations.has(suffix) || englishRegionNames.has(suffix.toLowerCase()))
  );
  if (!hasCountryOrRemote && !hasRegionSuffix) return "not_location";
  const prefix = hasRegionSuffix ? line.slice(0, line.lastIndexOf(",")).trim() : line.trim();
  if (looksLikeProfessionalDescriptor(prefix)) {
    return credentialDescriptorPattern.test(prefix) ? "not_location" : "ambiguous";
  }
  return "location";
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

function assertResumeDate(value: string | null, section: string, semanticLabel = `${section} date`) {
  if (value === null || resumeDatePattern.test(value)) return;
  throw new PublicApiError(
    `Resume parsing returned an invalid ${semanticLabel} that could conceal a merged record. No master resume was changed.`,
    422,
    { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, retryable: false }
  );
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

function contactSourceBlock(source: string) {
  const lines = source.split(/\r?\n/);
  const boundaries = lines.flatMap((line, index) => {
    const heading = line.trim().replace(/:$/, "");
    return sectionForHeading(line) || otherSectionHeading.test(heading)
      ? [{ index, contact: /^CONTACT$/i.test(heading) }]
      : [];
  });
  if (boundaries.length === 0) {
    throw new PublicApiError(
      "Resume structure could not be validated because no supported section headings were found. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", retryable: false }
    );
  }
  const blocks: string[] = [];
  const preambleEnd = boundaries[0]?.index ?? lines.length;
  const preamble = lines.slice(0, preambleEnd).join("\n").trim();
  if (preamble) blocks.push(preamble);
  boundaries.forEach((boundary, boundaryIndex) => {
    if (!boundary.contact) return;
    const end = boundaries[boundaryIndex + 1]?.index ?? lines.length;
    const body = lines.slice(boundary.index + 1, end).join("\n").trim();
    if (body) blocks.push(body);
  });
  if (blocks.length > 1) {
    throw new PublicApiError(
      "Resume contact structure is split across multiple source blocks and cannot be validated safely. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section: "contactInfo", retryable: false }
    );
  }
  return blocks[0] ?? "";
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

function sectionBlocks(output: ParsedResume, section: keyof ParsedResume["sectionStatus"]): string[] {
  if (section === "summary") return output.summary ? [output.summary] : [];
  if (section === "skills") return output.skills;
  if (section === "achievements") return output.achievements;
  if (section === "workHistory") return output.workHistory.map((item) => item.sourceText);
  if (section === "projects") return output.projects.map((item) => item.sourceText);
  if (section === "education") return output.education.map((item) => item.sourceText);
  return output.certifications.map((item) => item.sourceText);
}

function assertRecognizedSectionCoverage(source: string, output: ParsedResume) {
  const lines = source.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const section = sectionForHeading(line);
    const heading = line.trim().replace(/:$/, "");
    return section || otherSectionHeading.test(heading) ? [{ index, section }] : [];
  });
  if (!headings.some((heading) => heading.section !== null)) {
    throw new PublicApiError(
      "Resume structure could not be validated because no supported section headings were found. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", retryable: false }
    );
  }
  const bodyLines = new Map<keyof ParsedResume["sectionStatus"], string[]>();
  headings.forEach((heading, headingIndex) => {
    if (!heading.section) return;
    const end = headings[headingIndex + 1]?.index ?? lines.length;
    const existing = bodyLines.get(heading.section) ?? [];
    existing.push(...lines.slice(heading.index + 1, end));
    bodyLines.set(heading.section, existing);
  });

  for (const [section, sourceLines] of bodyLines) {
    const body = sourceLines.join("\n").trim();
    const blocks = sectionBlocks(output, section);
    let cursor = 0;
    const coveredRanges: Array<{ start: number; end: number }> = [];
    for (const block of blocks) {
      const start = body.indexOf(block, cursor);
      if (start < 0) {
        const label = section === "workHistory" ? "work history" : section;
        throw new PublicApiError(
          `Resume parsing returned ${label} content outside its source section. No master resume was changed.`,
          422,
          { code: "RESUME_PARSE_INVALID_OUTPUT", section, retryable: false }
        );
      }
      coveredRanges.push({ start, end: start + block.length });
      cursor = start + block.length;
    }
    const characters = body.split("");
    for (const range of coveredRanges) {
      characters.fill(" ", range.start, range.end);
    }
    let remaining = characters.join("");
    if (section === "skills") {
      remaining = remaining.replace(/\b(?:and|with|tools?|technologies|proficient|in)\b/gi, "");
    }
    if (/[\p{L}\p{N}]/u.test(remaining)) {
      const label = section === "workHistory" ? "work history" : section;
      throw new PublicApiError(
        `Resume parsing is incomplete for ${label}; source content was not represented. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_INCOMPLETE", section, retryable: false }
      );
    }
  }

  for (const section of Object.keys(sectionHeadings) as Array<keyof ParsedResume["sectionStatus"]>) {
    if (sectionBlocks(output, section).length > 0 && !bodyLines.has(section)) {
      const label = section === "workHistory" ? "work history" : section;
      throw new PublicApiError(
        `Resume parsing returned ${label} content without a supported source heading. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_STRUCTURE_AMBIGUOUS", section, retryable: false }
      );
    }
  }
}

export function validateParsedResumeOutput(source: string, value: unknown): ParsedResume {
  const parsed = parsedResumeSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublicApiError("Resume parsing returned an invalid structured result. No master resume was changed.", 422, {
      code: "RESUME_PARSE_INVALID_OUTPUT",
      retryable: false
    });
  }
  const output = parsed.data;
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

  const contactBlock = contactSourceBlock(source);
  if (output.contactInfo.sourceText !== contactBlock) {
    throw new PublicApiError(
      "Resume parsing did not preserve the complete contact/header source block. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", retryable: false }
    );
  }
  for (const [key, item] of Object.entries(output.contactInfo)) {
    if (key === "sourceText") continue;
    assertSourceSupported(contactBlock, item, `contactInfo.${key}`);
  }
  assertTypedContactCompleteness(contactBlock, output.contactInfo);
  const sourceEmails = [...source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0]);
  if (sourceEmails.length > 0 && (!output.contactInfo.email || !sourceEmails.includes(output.contactInfo.email))) {
    throw new PublicApiError(
      "Resume parsing omitted or changed an email address present in the source. No master resume was changed.",
      422,
      { code: "RESUME_PARSE_INCOMPLETE", section: "contactInfo", retryable: false }
    );
  }
  assertCompleteFactCoverage(
    contactBlock,
    [
      output.contactInfo.name,
      output.contactInfo.headline,
      output.contactInfo.email,
      output.contactInfo.phone,
      output.contactInfo.location,
      output.contactInfo.linkedin,
      output.contactInfo.github,
      output.contactInfo.portfolio
    ],
    "contactInfo",
    /\b(?:name|headline|title|email|e-mail|phone|mobile|tel|location|address|linkedin|github|portfolio|website|web|profile)\b/gi
  );
  assertSourceSupported(source, output.summary, "summary");
  output.skills.forEach((item, index) => assertSourceSupported(source, item, `skills[${index}]`));
  output.achievements.forEach((item, index) => assertSourceSupported(source, item, `achievements[${index}]`));
  output.workHistory.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `workHistory[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.company, `workHistory[${index}].company`);
    assertSourceSupported(item.sourceText, item.title, `workHistory[${index}].title`);
    assertSourceSupported(item.sourceText, item.location, `workHistory[${index}].location`);
    assertSourceSupported(item.sourceText, item.startDate, `workHistory[${index}].startDate`);
    assertSourceSupported(item.sourceText, item.endDate, `workHistory[${index}].endDate`);
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `workHistory[${index}].bullets[${entryIndex}]`));
    assertResumeDate(item.startDate, "workHistory", "workHistory date or location");
    assertResumeDate(item.endDate, "workHistory", "workHistory date or location");
    assertWorkLocationSemantics(item);
    assertUnambiguousNarrativeEntries(item.bullets, "workHistory");
    assertCompleteFactCoverage(
      item.sourceText,
      [item.company, item.title, item.location, item.startDate, item.endDate, ...item.bullets],
      "workHistory",
      /\b(?:(?:based\s+in)|company|employer|title|role|location|dates?|from|to|at|for|responsibilities|achievements)\b/gi
    );
  });
  output.projects.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `projects[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `projects[${index}].name`);
    assertSourceSupported(item.sourceText, item.description, `projects[${index}].description`);
    item.technologies.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].technologies[${entryIndex}]`));
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(item.sourceText, entry, `projects[${index}].bullets[${entryIndex}]`));
    if (item.description) assertUnambiguousNarrativeEntries([item.description], "projects");
    assertUnambiguousTechnologyEntries(item.technologies, "projects");
    assertUnambiguousNarrativeEntries(item.bullets, "projects");
    assertCompleteFactCoverage(
      item.sourceText,
      [item.name, item.description, ...item.technologies, ...item.bullets],
      "projects",
      /\b(?:project|name|description|technologies|technology|tech|tools?|details)\b/gi
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
    assertResumeDate(item.startDate, "education");
    assertResumeDate(item.endDate, "education");
    assertUnambiguousNarrativeEntries(item.details, "education");
    assertCompleteFactCoverage(
      item.sourceText,
      [item.institution, item.credential, item.fieldOfStudy, item.startDate, item.endDate, ...item.details],
      "education",
      /\b(?:institution|school|university|college|credential|degree|field|major|dates?|from|to|details)\b/gi
    );
  });
  output.certifications.forEach((item, index) => {
    assertSourceSupported(source, item.sourceText, `certifications[${index}].sourceText`);
    assertSourceSupported(item.sourceText, item.name, `certifications[${index}].name`);
    assertSourceSupported(item.sourceText, item.issuer, `certifications[${index}].issuer`);
    assertSourceSupported(item.sourceText, item.date, `certifications[${index}].date`);
    assertSourceSupported(item.sourceText, item.expirationDate, `certifications[${index}].expirationDate`);
    assertResumeDate(item.date, "certifications", "certification date");
    assertResumeDate(item.expirationDate, "certifications", "certification date");
    assertCompleteFactCoverage(
      item.sourceText,
      [item.name, item.issuer, item.date, item.expirationDate],
      "certifications",
      /\b(?:certification|certificate|license|name|issuer|issued|date|expires?|expiration)\b/gi
    );
  });
  assertRecognizedSectionCoverage(source, output);
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
      response_format: zodResponseFormat(parsedResumeSchema, "resume_parse_v3"),
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

function publicProviderError(error: unknown) {
  if (!(error instanceof GeminiProviderError || error instanceof ResumeProviderError)) return error;
  if (error.billingDisposition === "not_charged") {
    return new PublicApiError("The configured AI provider rejected resume parsing before completion. No master resume was changed.", 502, {
      code: "RESUME_PARSE_PROVIDER_REJECTED",
      retryable: true
    });
  }
  if (error.billingDisposition === "uncertain") {
    return new PublicApiError("Resume parsing reached the configured AI provider, but the outcome is uncertain. No master resume was changed; review AI usage before retrying.", 503, {
      code: "RESUME_PARSE_PROVIDER_UNCERTAIN",
      retryable: false
    });
  }
  return new PublicApiError("The configured AI provider returned a resume result that could not be accepted. No master resume was changed.", 502, {
    code: "RESUME_PARSE_PROVIDER_INVALID",
    retryable: false
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
  const requestHash = hashAiInput("resumeParsePrompt", RESUME_PARSE_PROMPT_VERSION, payload);
  const cached = await findCachedAiResponse({
    userId,
    provider,
    model,
    promptName: "resumeParsePrompt",
    promptVersion: RESUME_PARSE_PROMPT_VERSION,
    requestHash
  });
  if (cached) {
    return {
      data: validateParsedResumeOutput(text, cached.output),
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
      promptVersion: RESUME_PARSE_PROMPT_VERSION,
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
    promptVersion: RESUME_PARSE_PROMPT_VERSION,
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
    const data = validateParsedResumeOutput(text, response.value);
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
    if (!reconciled) {
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
    throw publicProviderError(error);
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
