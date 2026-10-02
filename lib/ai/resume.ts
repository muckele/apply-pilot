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
  company: string;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  bullets: string[];
};

type ResumeProjectItem = {
  name: string;
  description: string | null;
  technologies: string[];
  bullets: string[];
};

type ResumeEducationItem = {
  institution: string;
  credential: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  details: string[];
};

type ResumeCertificationItem = {
  name: string;
  issuer: string | null;
  date: string | null;
  expirationDate: string | null;
};

export type ParsedResume = {
  contractVersion: "3";
  contactInfo: {
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
const boundedSourceString = z.string().trim().min(1).max(2_000);
const nullableSourceString = z.union([boundedSourceString, z.null()]);
const sourceStringList = z.array(boundedSourceString).max(100);
const sectionStatusSchema = z.enum(["present", "absent"]);

export const parsedResumeSchema: z.ZodType<ParsedResume, z.ZodTypeDef, unknown> = z.object({
  contractVersion: z.literal("3"),
  contactInfo: z.object({
    email: nullableSourceString,
    phone: nullableSourceString,
    location: nullableSourceString,
    linkedin: nullableSourceString,
    github: nullableSourceString,
    portfolio: nullableSourceString
  }).strict(),
  summary: z.string().trim().max(2_000),
  skills: sourceStringList,
  workHistory: z.array(z.object({
    company: boundedSourceString,
    title: boundedSourceString,
    location: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    bullets: sourceStringList
  }).strict()).max(50),
  projects: z.array(z.object({
    name: boundedSourceString,
    description: nullableSourceString,
    technologies: sourceStringList,
    bullets: sourceStringList
  }).strict()).max(50),
  education: z.array(z.object({
    institution: boundedSourceString,
    credential: nullableSourceString,
    fieldOfStudy: nullableSourceString,
    startDate: nullableSourceString,
    endDate: nullableSourceString,
    details: sourceStringList
  }).strict()).max(30),
  certifications: z.array(z.object({
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
        email: nullableJsonString,
        phone: nullableJsonString,
        location: nullableJsonString,
        linkedin: nullableJsonString,
        github: nullableJsonString,
        portfolio: nullableJsonString
      },
      required: ["email", "phone", "location", "linkedin", "github", "portfolio"]
    },
    summary: jsonString,
    skills: jsonStringArray,
    workHistory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          company: jsonString,
          title: jsonString,
          location: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          bullets: jsonStringArray
        },
        required: ["company", "title", "location", "startDate", "endDate", "bullets"]
      }
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: jsonString,
          description: nullableJsonString,
          technologies: jsonStringArray,
          bullets: jsonStringArray
        },
        required: ["name", "description", "technologies", "bullets"]
      }
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          institution: jsonString,
          credential: nullableJsonString,
          fieldOfStudy: nullableJsonString,
          startDate: nullableJsonString,
          endDate: nullableJsonString,
          details: jsonStringArray
        },
        required: ["institution", "credential", "fieldOfStudy", "startDate", "endDate", "details"]
      }
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: jsonString,
          issuer: nullableJsonString,
          date: nullableJsonString,
          expirationDate: nullableJsonString
        },
        required: ["name", "issuer", "date", "expirationDate"]
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

function sectionFacts(output: ParsedResume, section: keyof ParsedResume["sectionStatus"]): string[] {
  const present = (values: Array<string | null>) => values.filter((value): value is string => Boolean(value));
  if (section === "summary") return output.summary ? [output.summary] : [];
  if (section === "skills") return output.skills;
  if (section === "achievements") return output.achievements;
  if (section === "workHistory") {
    return output.workHistory.flatMap((item) => present([
      item.company, item.title, item.location, item.startDate, item.endDate, ...item.bullets
    ]));
  }
  if (section === "projects") {
    return output.projects.flatMap((item) => present([
      item.name, item.description, ...item.technologies, ...item.bullets
    ]));
  }
  if (section === "education") {
    return output.education.flatMap((item) => present([
      item.institution, item.credential, item.fieldOfStudy, item.startDate, item.endDate, ...item.details
    ]));
  }
  return output.certifications.flatMap((item) => present([
    item.name, item.issuer, item.date, item.expirationDate
  ]));
}

function assertRecognizedSectionCoverage(source: string, output: ParsedResume) {
  const lines = source.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const section = sectionForHeading(line);
    const heading = line.trim().replace(/:$/, "");
    return section || otherSectionHeading.test(heading) ? [{ index, section }] : [];
  });
  const bodyLines = new Map<keyof ParsedResume["sectionStatus"], string[]>();
  headings.forEach((heading, headingIndex) => {
    if (!heading.section) return;
    const end = headings[headingIndex + 1]?.index ?? lines.length;
    const existing = bodyLines.get(heading.section) ?? [];
    existing.push(...lines.slice(heading.index + 1, end));
    bodyLines.set(heading.section, existing);
  });

  for (const [section, sourceLines] of bodyLines) {
    const fragments = sectionFacts(output, section)
      .flatMap((fact) => fact.split(/\r?\n/))
      .map((fact) => fact.trim())
      .filter(Boolean);
    for (const sourceLine of sourceLines) {
      let remaining = sourceLine.trim();
      while (remaining && fragments.length) {
        let matchIndex = -1;
        for (let index = 0; index < fragments.length; index += 1) {
          if (
            remaining.includes(fragments[index]) &&
            (matchIndex < 0 || fragments[index].length > fragments[matchIndex].length)
          ) {
            matchIndex = index;
          }
        }
        if (matchIndex < 0) break;
        const [fragment] = fragments.splice(matchIndex, 1);
        remaining = remaining.replace(fragment, "");
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
    if (fragments.length) {
      const label = section === "workHistory" ? "work history" : section;
      throw new PublicApiError(
        `Resume parsing returned ${label} facts outside that source section. No master resume was changed.`,
        422,
        { code: "RESUME_PARSE_INVALID_OUTPUT", section, retryable: false }
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

  for (const [key, item] of Object.entries(output.contactInfo)) {
    assertSourceSupported(source, item, `contactInfo.${key}`);
  }
  assertSourceSupported(source, output.summary, "summary");
  output.skills.forEach((item, index) => assertSourceSupported(source, item, `skills[${index}]`));
  output.achievements.forEach((item, index) => assertSourceSupported(source, item, `achievements[${index}]`));
  output.workHistory.forEach((item, index) => {
    assertSourceSupported(source, item.company, `workHistory[${index}].company`);
    assertSourceSupported(source, item.title, `workHistory[${index}].title`);
    assertSourceSupported(source, item.location, `workHistory[${index}].location`);
    assertSourceSupported(source, item.startDate, `workHistory[${index}].startDate`);
    assertSourceSupported(source, item.endDate, `workHistory[${index}].endDate`);
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(source, entry, `workHistory[${index}].bullets[${entryIndex}]`));
  });
  output.projects.forEach((item, index) => {
    assertSourceSupported(source, item.name, `projects[${index}].name`);
    assertSourceSupported(source, item.description, `projects[${index}].description`);
    item.technologies.forEach((entry, entryIndex) => assertSourceSupported(source, entry, `projects[${index}].technologies[${entryIndex}]`));
    item.bullets.forEach((entry, entryIndex) => assertSourceSupported(source, entry, `projects[${index}].bullets[${entryIndex}]`));
  });
  output.education.forEach((item, index) => {
    assertSourceSupported(source, item.institution, `education[${index}].institution`);
    assertSourceSupported(source, item.credential, `education[${index}].credential`);
    assertSourceSupported(source, item.fieldOfStudy, `education[${index}].fieldOfStudy`);
    assertSourceSupported(source, item.startDate, `education[${index}].startDate`);
    assertSourceSupported(source, item.endDate, `education[${index}].endDate`);
    item.details.forEach((entry, entryIndex) => assertSourceSupported(source, entry, `education[${index}].details[${entryIndex}]`));
  });
  output.certifications.forEach((item, index) => {
    assertSourceSupported(source, item.name, `certifications[${index}].name`);
    assertSourceSupported(source, item.issuer, `certifications[${index}].issuer`);
    assertSourceSupported(source, item.date, `certifications[${index}].date`);
    assertSourceSupported(source, item.expirationDate, `certifications[${index}].expirationDate`);
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
