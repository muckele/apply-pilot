import { z } from "zod";

import { generateGuardedGeminiJson, type AiInvocationOptions } from "@/lib/ai/guarded-gemini";
import {
  ADD_A_NUMBER_PLACEHOLDER,
  APPLICANT_SOURCE_OF_TRUTH_CONTRACT,
  boundedString,
  boundedStringList,
  buildMasterResumeFactCatalog,
  factIdEnum,
  groundedNumbers,
  jobContextText,
  projectJobContext,
  replaceUnsupportedNumbers,
  type ApplicantFact,
  type JobContextInput,
  type MasterResumeFacts,
  type ProjectedJob
} from "@/lib/ai/grounded-text";

export const INTERVIEW_PREP_PROMPT_NAME = "interviewPrepPrompt";
export const INTERVIEW_PREP_PROMPT_VERSION = "3";

export const interviewPrepSystemPrompt = `
You are Apply Pilot's interview preparation coach. You help the applicant prepare before an interview; you never assist during one.

Produce:
- prepBrief: a concise brief connecting the job's stated needs to the applicant's documented history, naming honest gaps.
- likelyQuestions: questions this interview type and job are likely to include, each with the basis it came from.
- starStories: STAR stories (situation, task, action, result) drafted only from applicantFacts. Every story cites the factIds it uses. Do not add employers, projects, tools, scope, or results the cited facts do not state.
- STAR metrics: never invent a metric. If a result would be stronger with a number the cited facts do not contain, write "[add a number here]" in its place so the applicant can supply a verified value.
- questionsToAsk: thoughtful questions the applicant can ask the interviewer.
- risksToPrepareFor: requirements the applicant's facts do not show, framed as honest gaps to prepare for, never as claims.

${APPLICANT_SOURCE_OF_TRUTH_CONTRACT}
`.trim();

export type InterviewPrepInput = {
  interview: { type: string };
  job: JobContextInput;
  resume: MasterResumeFacts | null;
  profile: { careerGoals?: unknown; skillsNotToExaggerate?: unknown } | null;
};

export type InterviewPrepPayload = {
  interviewType: string;
  job: ProjectedJob | null;
  applicantFacts: ApplicantFact[];
  careerGoals: string | null;
  doNotExaggerate: string[];
};

// Allowlisted projection: contact details, raw resume text, work-authorization notes,
// interviewer names, and any other profile field are never sent to Gemini.
export function buildInterviewPrepPayload(input: InterviewPrepInput): InterviewPrepPayload {
  return {
    interviewType: boundedString(input.interview.type, 40) ?? "OTHER",
    job: projectJobContext(input.job),
    applicantFacts: buildMasterResumeFactCatalog(input.resume),
    careerGoals: boundedString(input.profile?.careerGoals, 600),
    doNotExaggerate: boundedStringList(input.profile?.skillsNotToExaggerate, 12, 60)
  };
}

const LIKELY_QUESTION_BASES = ["job_post", "applicant_history", "interview_type"] as const;

const stringSchema = { type: "string" } as const;
const stringArray = (maxItems: number) => ({ type: "array", maxItems, items: stringSchema });

export function buildInterviewPrepResponseJsonSchema(payload: InterviewPrepPayload) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      prepBrief: stringSchema,
      likelyQuestions: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: stringSchema,
            basis: { type: "string", enum: [...LIKELY_QUESTION_BASES] }
          },
          required: ["question", "basis"]
        }
      },
      starStories: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            theme: stringSchema,
            situation: stringSchema,
            task: stringSchema,
            action: stringSchema,
            result: stringSchema,
            factIds: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: { type: "string", enum: factIdEnum(payload.applicantFacts) }
            }
          },
          required: ["theme", "situation", "task", "action", "result", "factIds"]
        }
      },
      questionsToAsk: stringArray(8),
      risksToPrepareFor: stringArray(8)
    },
    required: ["prepBrief", "likelyQuestions", "starStories", "questionsToAsk", "risksToPrepareFor"]
  };
}

const providerSchema = z.object({
  prepBrief: z.string().max(4_000),
  likelyQuestions: z.array(z.object({
    question: z.string().min(1).max(400),
    basis: z.enum(LIKELY_QUESTION_BASES)
  }).strict()).max(12),
  starStories: z.array(z.object({
    theme: z.string().max(200),
    situation: z.string().max(1_000),
    task: z.string().max(1_000),
    action: z.string().max(1_500),
    result: z.string().max(1_000),
    factIds: z.array(z.string().min(1).max(64)).min(1).max(6)
  }).strict()).max(6),
  questionsToAsk: z.array(z.string().max(400)).max(8),
  risksToPrepareFor: z.array(z.string().max(500)).max(8)
}).strict();

type InterviewPrepProviderOutput = z.infer<typeof providerSchema>;

export type InterviewStarStory = {
  theme: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  sources: Array<{ factId: string; excerpt: string }>;
  metricGaps: string[];
};

export type InterviewPrepOutput = {
  prepBrief: string;
  likelyQuestions: string[];
  starStories: InterviewStarStory[];
  questionsToAsk: string[];
  risksToPrepareFor: string[];
  droppedStoryCount: number;
};

const outputSchema: z.ZodType<InterviewPrepOutput, z.ZodTypeDef, unknown> = z.object({
  prepBrief: z.string(),
  likelyQuestions: z.array(z.string()),
  starStories: z.array(z.object({
    theme: z.string(),
    situation: z.string(),
    task: z.string(),
    action: z.string(),
    result: z.string(),
    sources: z.array(z.object({ factId: z.string(), excerpt: z.string() })),
    metricGaps: z.array(z.string())
  })),
  questionsToAsk: z.array(z.string()),
  risksToPrepareFor: z.array(z.string()),
  droppedStoryCount: z.number().int().min(0)
});

const STAR_FIELDS = ["situation", "task", "action", "result"] as const;

function groundStarStory(
  story: InterviewPrepProviderOutput["starStories"][number],
  factIndex: ReadonlyMap<string, ApplicantFact>
): InterviewStarStory | null {
  const sources = [...new Set(story.factIds)]
    .map((factId) => factIndex.get(factId))
    .filter((fact): fact is ApplicantFact => Boolean(fact))
    .map((fact) => ({ factId: fact.factId, excerpt: fact.text }));
  if (!sources.length) return null;

  const allowed = groundedNumbers(...sources.map((source) => source.excerpt));
  const metricGaps: string[] = [];
  const grounded = Object.fromEntries(STAR_FIELDS.map((field) => {
    const { text, removed } = replaceUnsupportedNumbers(story[field].trim(), allowed);
    for (const token of removed) {
      metricGaps.push(
        `Removed "${token}" from the ${field}: it is not in your cited resume facts. ` +
          `Replace ${ADD_A_NUMBER_PLACEHOLDER} only with a number you can verify.`
      );
    }
    return [field, text];
  })) as Record<(typeof STAR_FIELDS)[number], string>;
  if (!/\d/u.test(grounded.result)) {
    metricGaps.push(
      `${ADD_A_NUMBER_PLACEHOLDER}: the result has no measurable outcome. Add one from your own records if you have it.`
    );
  }
  return { theme: story.theme.trim(), ...grounded, sources, metricGaps };
}

export function groundInterviewPrepOutput(
  payload: InterviewPrepPayload,
  output: InterviewPrepProviderOutput
): InterviewPrepOutput {
  const factIndex = new Map(payload.applicantFacts.map((fact) => [fact.factId, fact]));
  const stories = output.starStories.map((story) => groundStarStory(story, factIndex));
  const briefNumbers = groundedNumbers(jobContextText(payload.job), ...payload.applicantFacts.map((fact) => fact.text));
  return {
    prepBrief: replaceUnsupportedNumbers(output.prepBrief.trim(), briefNumbers).text,
    likelyQuestions: [...new Set(output.likelyQuestions.map((entry) => entry.question.trim()).filter(Boolean))],
    starStories: stories.filter((story): story is InterviewStarStory => story !== null),
    questionsToAsk: output.questionsToAsk.map((entry) => entry.trim()).filter(Boolean),
    risksToPrepareFor: output.risksToPrepareFor.map((entry) => entry.trim()).filter(Boolean),
    droppedStoryCount: stories.filter((story) => story === null).length
  };
}

export async function generateInterviewPrep(
  input: InterviewPrepInput,
  userId: string,
  options: AiInvocationOptions = {}
) {
  const payload = buildInterviewPrepPayload(input);
  const generated = await generateGuardedGeminiJson<InterviewPrepOutput>({
    feature: "INTERVIEW_PREP",
    userId,
    promptName: INTERVIEW_PREP_PROMPT_NAME,
    promptVersion: INTERVIEW_PREP_PROMPT_VERSION,
    systemPrompt: interviewPrepSystemPrompt,
    payload,
    responseJsonSchema: buildInterviewPrepResponseJsonSchema(payload),
    providerSchema,
    decodeProvider: (value) => groundInterviewPrepOutput(payload, value as InterviewPrepProviderOutput),
    schema: outputSchema,
    options
  });

  return {
    ...generated.data,
    provider: generated.meta.provider,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
