import { z } from "zod";

import { coverLetterPrompt } from "@/prompts/coverLetterPrompt";
import { generateJson } from "@/lib/ai/client";
import type { AiInvocationOptions } from "@/lib/ai/client";
import { deferredAiFeatureError } from "@/lib/ai/deferred-features";
import { APPLICATION_DOCUMENT_PROMPT_VERSION } from "@/lib/ai/application-document-version";
import {
  buildApplicationDocumentCitationJsonSchema,
  buildApplicationDocumentSystemPrompt,
  getCoverLetterUncitedLines,
  validateCoverLetterClaims,
  type ApplicationDocumentClaimEvidence,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";

const applicationDocumentCitationSchema = z.object({
  ref: z.string().min(1),
  excerpt: z.string().min(1)
}).strict();

export const coverLetterSchema = z.object({
  title: z.string(),
  coverLetter: z.string(),
  angle: z.string(),
  claimsUsed: z.array(z.object({
    claim: z.string().min(1),
    citations: z.array(applicationDocumentCitationSchema).min(1)
  }).strict())
}).strict();

const strictStringObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});

export function buildCoverLetterSystemPrompt(payload: ApplicationDocumentPayload) {
  return buildApplicationDocumentSystemPrompt(
    `${coverLetterPrompt.trim()}\n\n` +
      `Allowed uncited cover-letter lines (exact strings only): ${JSON.stringify(getCoverLetterUncitedLines(payload))}\n` +
      "Do not write any other uncited line or sentence.",
    payload
  );
}

export function buildCoverLetterGeminiJsonSchema(payload: ApplicationDocumentPayload) {
  return strictStringObject({
    title: { type: "string" },
    coverLetter: { type: "string" },
    angle: { type: "string" },
    claimsUsed: {
      type: "array",
      items: strictStringObject({
        claim: { type: "string" },
        citations: {
          type: "array",
          minItems: 1,
          items: buildApplicationDocumentCitationJsonSchema(payload)
        }
      }, ["claim", "citations"])
    }
  }, ["title", "coverLetter", "angle", "claimsUsed"]);
}

export async function draftCoverLetter(
  payload: ApplicationDocumentPayload,
  userId?: string,
  options: AiInvocationOptions = {}
) {
  const company = typeof payload.job?.company === "string" ? payload.job.company : "the employer";
  const jobTitle = typeof payload.job?.title === "string" ? payload.job.title : "the role";
  const fallback = {
    title: `${company} ${jobTitle} cover letter`,
    coverLetter: `Dear ${company} Hiring Team,\n\nI am writing about the ${jobTitle} position. I am interested in learning more about the role and how I might contribute to your team.\n\nThank you for your time and consideration.\n\nSincerely,\n[Your name]`,
    angle: "Generic draft requiring applicant personalization and review before use.",
    claimsUsed: [] as ApplicationDocumentClaimEvidence[]
  };
  const systemPrompt = buildCoverLetterSystemPrompt(payload);
  const responseJsonSchema = buildCoverLetterGeminiJsonSchema(payload);

  const generated = await generateJson({
    promptName: "coverLetterPrompt",
    systemPrompt,
    payload,
    fallback,
    schema: coverLetterSchema,
    responseJsonSchema,
    context: userId ? {
      userId,
      feature: "COVER_LETTER",
      promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
      ...options
    } : undefined,
    validate: (value) => validateCoverLetterClaims(payload, value)
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}

export async function draftEmailReply(payload: {
  emailText: string;
  tone: string;
  job?: unknown;
}, userId?: string) {
  void payload;
  void userId;
  throw deferredAiFeatureError("EMAIL_REPLY");
}

export async function generateInterviewPrep(payload: unknown, userId?: string) {
  void payload;
  void userId;
  throw deferredAiFeatureError("INTERVIEW_PREP");
}

export async function generateInterviewFeedback(payload: unknown, userId?: string) {
  void payload;
  void userId;
  throw deferredAiFeatureError("INTERVIEW_FEEDBACK");
}
