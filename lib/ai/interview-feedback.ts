import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { generateGuardedGeminiJson, type AiInvocationOptions } from "@/lib/ai/guarded-gemini";
import {
  APPLICANT_SOURCE_OF_TRUTH_CONTRACT,
  boundedString,
  buildMasterResumeFactCatalog,
  factIdEnum,
  groundedNumbers,
  replaceUnsupportedNumbers,
  type ApplicantFact,
  type JobContextInput,
  type MasterResumeFacts
} from "@/lib/ai/grounded-text";
import { splitTranscriptSections } from "@/lib/ai/policy";

export const INTERVIEW_FEEDBACK_PROMPT_NAME = "interviewFeedbackPrompt";
export const INTERVIEW_FEEDBACK_PROMPT_VERSION = "3";

export const interviewFeedbackSystemPrompt = `
You are Apply Pilot's post-interview feedback coach. You review an interview after it happened; you never assist during one.

Inputs: the applicant's own notes, an optional transcript the applicant pasted after confirming every participant consented, the job context, and applicantFacts from the applicant's master resume.

Produce:
- summary: an honest summary of how the interview went, based only on the notes and transcript.
- questionsAsked: the questions the notes or transcript show were asked. Do not add questions that do not appear.
- strongMoments and weakAnswers: specific, evidence-based observations.
- betterAnswers: for weak answers, a stronger answer built only from applicantFacts, citing the factIds used. Never add a metric the cited facts do not contain; write "[add a number here]" instead.
- thankYouEmailDraft: a short thank-you email for the applicant to review and send themselves. Use placeholders such as [Interviewer name] and [Your name] rather than guessing names. Never say or imply the email was sent.

${APPLICANT_SOURCE_OF_TRUTH_CONTRACT}
`.trim();

export type InterviewFeedbackInput = {
  interview: { type: string };
  job: JobContextInput;
  resume: MasterResumeFacts | null;
  notes: Array<string | null | undefined>;
  transcript: string | null;
  transcriptConsentConfirmed?: boolean;
};

export type InterviewFeedbackPayload = {
  interviewType: string;
  job: { title: string | null; company: string | null; requirements: string[] } | null;
  applicantFacts: ApplicantFact[];
  notes: Array<{ noteId: string; text: string }>;
  transcriptSections: string[];
  transcriptTruncated: boolean;
};

// Bounded so notes, two transcript sections, and facts stay inside the 42,000-token policy.
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 2_000;
const MAX_TRANSCRIPT_SECTIONS = 2;
const MAX_FEEDBACK_FACTS = 120;

export function buildInterviewFeedbackPayload(input: InterviewFeedbackInput): InterviewFeedbackPayload {
  const transcript = input.transcript?.trim() ?? "";
  if (transcript && input.transcriptConsentConfirmed !== true) {
    throw new PublicApiError(
      "Confirm that every interview participant consented to the transcript before using it for AI feedback.",
      422,
      { code: "INTERVIEW_TRANSCRIPT_CONSENT_REQUIRED" }
    );
  }
  const notes = input.notes
    .map((note) => boundedString(note, MAX_NOTE_CHARS))
    .filter((note): note is string => Boolean(note))
    .slice(0, MAX_NOTES)
    .map((text, index) => ({ noteId: `note-${index + 1}`, text }));
  if (!notes.length && !transcript) {
    throw new PublicApiError(
      "Add interview notes or paste a consented transcript before generating feedback.",
      422,
      { code: "INTERVIEW_FEEDBACK_INPUT_EMPTY" }
    );
  }
  const { sections, truncated } = splitTranscriptSections(transcript, MAX_TRANSCRIPT_SECTIONS);
  const job = input.job
    ? {
        title: boundedString(input.job.title, 200),
        company: boundedString(input.job.company, 200),
        requirements: Array.isArray(input.job.requirements)
          ? input.job.requirements.map((entry) => boundedString(entry, 300)).filter((entry): entry is string => Boolean(entry)).slice(0, 20)
          : []
      }
    : null;
  return {
    interviewType: boundedString(input.interview.type, 40) ?? "OTHER",
    job,
    applicantFacts: buildMasterResumeFactCatalog(input.resume, MAX_FEEDBACK_FACTS),
    notes,
    transcriptSections: sections,
    transcriptTruncated: truncated
  };
}

const stringSchema = { type: "string" } as const;
const stringArray = (maxItems: number) => ({ type: "array", maxItems, items: stringSchema });

export function buildInterviewFeedbackResponseJsonSchema(payload: InterviewFeedbackPayload) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: stringSchema,
      questionsAsked: stringArray(20),
      strongMoments: stringArray(10),
      weakAnswers: stringArray(10),
      betterAnswers: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: stringSchema,
            suggestion: stringSchema,
            factIds: {
              type: "array",
              maxItems: 6,
              items: { type: "string", enum: factIdEnum(payload.applicantFacts) }
            }
          },
          required: ["question", "suggestion", "factIds"]
        }
      },
      thankYouEmailDraft: stringSchema
    },
    required: ["summary", "questionsAsked", "strongMoments", "weakAnswers", "betterAnswers", "thankYouEmailDraft"]
  };
}

const providerSchema = z.object({
  summary: z.string().max(3_000),
  questionsAsked: z.array(z.string().max(400)).max(20),
  strongMoments: z.array(z.string().max(600)).max(10),
  weakAnswers: z.array(z.string().max(600)).max(10),
  betterAnswers: z.array(z.object({
    question: z.string().max(400),
    suggestion: z.string().max(2_000),
    factIds: z.array(z.string().min(1).max(64)).max(6)
  }).strict()).max(10),
  thankYouEmailDraft: z.string().min(1).max(3_000)
}).strict();

type InterviewFeedbackProviderOutput = z.infer<typeof providerSchema>;

export type InterviewFeedbackOutput = {
  summary: string;
  questionsAsked: string[];
  strongMoments: string[];
  weakAnswers: string[];
  betterAnswers: Array<{
    question: string;
    suggestion: string;
    sources: Array<{ factId: string; excerpt: string }>;
    metricGaps: string[];
  }>;
  thankYouEmailDraft: string;
  transcriptTruncated: boolean;
};

const outputSchema: z.ZodType<InterviewFeedbackOutput, z.ZodTypeDef, unknown> = z.object({
  summary: z.string(),
  questionsAsked: z.array(z.string()),
  strongMoments: z.array(z.string()),
  weakAnswers: z.array(z.string()),
  betterAnswers: z.array(z.object({
    question: z.string(),
    suggestion: z.string(),
    sources: z.array(z.object({ factId: z.string(), excerpt: z.string() })),
    metricGaps: z.array(z.string())
  })),
  thankYouEmailDraft: z.string(),
  transcriptTruncated: z.boolean()
});

function clean(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function groundInterviewFeedbackOutput(
  payload: InterviewFeedbackPayload,
  output: InterviewFeedbackProviderOutput
): InterviewFeedbackOutput {
  const factIndex = new Map(payload.applicantFacts.map((fact) => [fact.factId, fact]));
  return {
    summary: output.summary.trim(),
    questionsAsked: clean(output.questionsAsked),
    strongMoments: clean(output.strongMoments),
    weakAnswers: clean(output.weakAnswers),
    betterAnswers: output.betterAnswers.map((answer) => {
      const sources = [...new Set(answer.factIds)]
        .map((factId) => factIndex.get(factId))
        .filter((fact): fact is ApplicantFact => Boolean(fact))
        .map((fact) => ({ factId: fact.factId, excerpt: fact.text }));
      const { text, removed } = replaceUnsupportedNumbers(
        answer.suggestion.trim(),
        groundedNumbers(...sources.map((source) => source.excerpt))
      );
      return {
        question: answer.question.trim(),
        suggestion: text,
        sources,
        metricGaps: removed.map((token) =>
          `Removed "${token}": it is not in your cited resume facts. Add a number here only if you can verify it.`)
      };
    }),
    thankYouEmailDraft: output.thankYouEmailDraft.trim(),
    transcriptTruncated: payload.transcriptTruncated
  };
}

export async function generateInterviewFeedback(
  input: InterviewFeedbackInput,
  userId: string,
  options: AiInvocationOptions = {}
) {
  const payload = buildInterviewFeedbackPayload(input);
  const generated = await generateGuardedGeminiJson<InterviewFeedbackOutput>({
    feature: "INTERVIEW_FEEDBACK",
    userId,
    promptName: INTERVIEW_FEEDBACK_PROMPT_NAME,
    promptVersion: INTERVIEW_FEEDBACK_PROMPT_VERSION,
    systemPrompt: interviewFeedbackSystemPrompt,
    payload,
    responseJsonSchema: buildInterviewFeedbackResponseJsonSchema(payload),
    providerSchema,
    decodeProvider: (value) => groundInterviewFeedbackOutput(payload, value as InterviewFeedbackProviderOutput),
    schema: outputSchema,
    options
  });

  return {
    ...generated.data,
    requiresApprovalBeforeSending: true as const,
    provider: generated.meta.provider,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
