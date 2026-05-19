import OpenAI from "openai";

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
};

export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback
}: GenerateJsonInput<T>): Promise<T> {
  const client = getOpenAIClient();

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    return fallback;
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

  return JSON.parse(content) as T;
}
