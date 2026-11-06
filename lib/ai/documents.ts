import { z } from "zod";

import { coverLetterPrompt } from "@/prompts/coverLetterPrompt";
import { generateJson } from "@/lib/ai/client";
import type { AiInvocationOptions } from "@/lib/ai/client";
import { APPLICATION_DOCUMENT_PROMPT_VERSION } from "@/lib/ai/application-document-version";
import {
  NO_APPLICATION_DOCUMENT_FACT_ID,
  assembleCoverLetterProviderOutput,
  buildApplicationDocumentFactCatalog,
  type CoverLetterProviderOutput
} from "@/lib/ai/application-document-facts";
import {
  buildApplicationDocumentSystemPrompt,
  coverLetterRemovals,
  getCoverLetterUncitedLines,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import { finalizeCoverLetter } from "@/lib/ai/application-document-quality";

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

export const coverLetterProviderSchema: z.ZodType<
  CoverLetterProviderOutput,
  z.ZodTypeDef,
  unknown
> = z.object({
  title: z.string(),
  coverLetter: z.string(),
  angle: z.string(),
  claimsUsed: z.array(z.object({
    claim: z.string().min(1),
    factId: z.string().min(1)
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
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factIds = facts.length
    ? facts.map((fact) => fact.factId)
    : [NO_APPLICATION_DOCUMENT_FACT_ID];
  return strictStringObject({
    title: { type: "string" },
    coverLetter: { type: "string" },
    angle: { type: "string" },
    claimsUsed: {
      type: "array",
      items: strictStringObject({
        claim: { type: "string" },
        factId: { type: "string", enum: factIds }
      }, ["claim", "factId"])
    }
  }, ["title", "coverLetter", "angle", "claimsUsed"]);
}

export async function draftCoverLetter(
  payload: ApplicationDocumentPayload,
  userId: string,
  options: AiInvocationOptions = {}
) {
  const systemPrompt = buildCoverLetterSystemPrompt(payload);
  const responseJsonSchema = buildCoverLetterGeminiJsonSchema(payload);

  // No anonymous path and no generic template: without Gemini or a budget owner the
  // request fails closed before any cache read, reservation, or provider call.
  const generated = await generateJson({
    promptName: "coverLetterPrompt",
    systemPrompt,
    payload,
    schema: coverLetterSchema,
    providerSchema: coverLetterProviderSchema,
    decodeProvider: (value) => assembleCoverLetterProviderOutput(
      payload,
      value as CoverLetterProviderOutput
    ),
    responseJsonSchema,
    context: {
      userId,
      feature: "COVER_LETTER",
      promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
      ...options
    },
    // Unsupported or unverified sentences are removed first, the evidence is grouped by employer,
    // and the unchanged truth and structure checks then decide (finalizeCoverLetter).
    validate: (draft) => finalizeCoverLetter(payload, draft)
  });

  return {
    ...generated.data,
    removed: [...coverLetterRemovals(generated.data)],
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
