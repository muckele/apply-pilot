import type { z } from "zod";

import {
  APPLICATION_DOCUMENT_MODEL,
  APPLICATION_DOCUMENT_THINKING_LEVEL
} from "@/lib/ai/application-document-version";
import {
  assertConservativeGeminiWireBound,
  generateGuardedGeminiJson,
  type AiInvocationOptions,
  type GeneratedJsonResult
} from "@/lib/ai/guarded-gemini";
import type { AiFeature } from "@/lib/ai/policy";

// Gemini is the single MVP AI provider (decision D029). The legacy OpenAI chat path,
// its soft budget check, and its local template fallbacks were removed: every AI
// feature now runs through lib/ai/guarded-gemini.ts and the hard budget ledger.
export {
  LocalAiUnavailableError,
  type AiInvocationOptions,
  type GeneratedJsonMeta,
  type GeneratedJsonResult
} from "@/lib/ai/guarded-gemini";

export type AiCallContext = AiInvocationOptions & {
  userId: string;
  feature: AiFeature;
  promptVersion: string;
};

type GenerateJsonInput<T> = {
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  providerSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  decodeProvider?: (value: unknown) => T;
  responseJsonSchema?: Record<string, unknown>;
  // Required: there is no anonymous or no-budget-owner AI path.
  context: AiCallContext;
  validate?: (value: T) => T;
};

// Application-document entry (resume tailoring and cover letters) pinned to the
// document model and thinking level. Other features call generateGuardedGeminiJson.
export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  schema,
  providerSchema,
  decodeProvider,
  responseJsonSchema,
  context,
  validate
}: GenerateJsonInput<T>): Promise<GeneratedJsonResult<T>> {
  const { userId, feature, promptVersion, ...options } = context;
  return generateGuardedGeminiJson({
    feature,
    userId,
    promptName,
    promptVersion,
    systemPrompt,
    payload,
    responseJsonSchema,
    schema,
    providerSchema,
    decodeProvider,
    validate,
    options,
    model: APPLICATION_DOCUMENT_MODEL,
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
  });
}

export function assertConservativeApplicationDocumentWireBound(
  feature: "RESUME_TAILOR" | "COVER_LETTER",
  maxInputTokens: number,
  requestBody: unknown
) {
  assertConservativeGeminiWireBound(feature, maxInputTokens, requestBody);
}
