import OpenAI from "openai";
import type { z } from "zod";

let openai: OpenAI | null = null;

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export function getOpenAIModel() {
  return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}

type GenerateJsonInput<T> = {
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  fallback: T;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
};

export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback,
  schema
}: GenerateJsonInput<T>): Promise<T> {
  const client = getOpenAIClient();

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    return validateGeneratedJson(fallback, schema, promptName);
  }

  const response = await client.chat.completions.create({
    model: getOpenAIModel(),
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) }
    ]
  });

  const content = response.choices[0]?.message.content;

  if (!content) {
    throw new Error(`${promptName} returned an empty response.`);
  }

  return validateGeneratedJson(JSON.parse(content), schema, promptName);
}

function validateGeneratedJson<T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
  promptName: string
) {
  if (!schema) {
    return value as T;
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${promptName} returned JSON that did not match the expected schema.`);
  }

  return parsed.data;
}
