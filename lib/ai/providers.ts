import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import type { AiProviderName } from "@/lib/ai/pricing";

export type ProviderJsonResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  usageReported: boolean;
};

type ProviderJsonRequest<T> = {
  provider: AiProviderName;
  model: string;
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxOutputTokens: number;
};

let openaiClient: OpenAI | null = null;

function getClient(provider: AiProviderName) {
  if (provider === "gemini") return null;
  if (!process.env.OPENAI_API_KEY) return null;
  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60_000 });
  return openaiClient;
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
};

function geminiResponseSchema<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, promptName: string) {
  const format = zodResponseFormat(schema, promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64));
  const jsonSchema = { ...(format.json_schema.schema as Record<string, unknown>) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

async function callGeminiJsonProvider<T>({
  model,
  promptName,
  systemPrompt,
  payload,
  schema,
  maxOutputTokens
}: Omit<ProviderJsonRequest<T>, "provider">): Promise<ProviderJsonResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("gemini is enabled but its API key is unavailable.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          maxOutputTokens,
          responseMimeType: "application/json",
          ...(schema ? { responseJsonSchema: geminiResponseSchema(schema, promptName) } : {}),
          thinkingConfig: { thinkingLevel: "MINIMAL" }
        }
      }),
      signal: AbortSignal.timeout(60_000)
    }
  );
  const result = (await response.json()) as GeminiGenerateContentResponse;
  if (!response.ok) {
    const detail = result.error?.message?.trim();
    const error = new Error(
      `Gemini request failed with status ${response.status}${detail ? `: ${detail}` : "."}`
    );
    error.name = "GeminiApiError";
    throw error;
  }

  const content = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!content) throw new Error(`${promptName} returned an empty response.`);

  const usage = result.usageMetadata;
  return {
    content,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    usageReported: Boolean(usage)
  };
}

export async function callJsonProvider<T>({
  provider,
  model,
  promptName,
  systemPrompt,
  payload,
  schema,
  maxOutputTokens
}: ProviderJsonRequest<T>): Promise<ProviderJsonResult> {
  if (provider === "gemini") {
    return callGeminiJsonProvider({
      model,
      promptName,
      systemPrompt,
      payload,
      schema,
      maxOutputTokens
    });
  }

  const client = getClient(provider);
  if (!client) throw new Error(`${provider} is enabled but its API key is unavailable.`);

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: maxOutputTokens,
    response_format: schema
      ? zodResponseFormat(schema, promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64))
      : { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) }
    ]
  });
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error(`${promptName} returned an empty response.`);

  return {
    content,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    usageReported: Boolean(response.usage)
  };
}
