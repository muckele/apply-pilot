import { PublicApiError } from "@/lib/api-errors";

export type AiFeature =
  | "RESUME_PARSE"
  | "JOB_PARSE"
  | "JOB_MATCH"
  | "EMAIL_CLASSIFICATION"
  | "RESUME_TAILOR"
  | "COVER_LETTER"
  | "EMAIL_REPLY"
  | "INTERVIEW_PREP"
  | "INTERVIEW_FEEDBACK"
  | "APPLICATION_PLAN";

export type AiModelTier = "fast" | "quality";

export type AiFeaturePolicy = {
  maxOutputTokens: number;
  maxInputTokens: number;
  modelTier: AiModelTier;
};

export const AI_FEATURE_POLICIES: Record<AiFeature, AiFeaturePolicy> = {
  RESUME_PARSE: { maxOutputTokens: 4_000, maxInputTokens: 31_000, modelTier: "fast" },
  JOB_PARSE: { maxOutputTokens: 2_500, maxInputTokens: 21_000, modelTier: "fast" },
  JOB_MATCH: { maxOutputTokens: 2_500, maxInputTokens: 56_000, modelTier: "fast" },
  EMAIL_CLASSIFICATION: { maxOutputTokens: 800, maxInputTokens: 11_000, modelTier: "fast" },
  RESUME_TAILOR: { maxOutputTokens: 6_000, maxInputTokens: 56_000, modelTier: "quality" },
  COVER_LETTER: { maxOutputTokens: 1_500, maxInputTokens: 56_000, modelTier: "quality" },
  EMAIL_REPLY: { maxOutputTokens: 1_000, maxInputTokens: 32_000, modelTier: "fast" },
  INTERVIEW_PREP: { maxOutputTokens: 4_000, maxInputTokens: 56_000, modelTier: "quality" },
  INTERVIEW_FEEDBACK: { maxOutputTokens: 5_000, maxInputTokens: 42_000, modelTier: "quality" },
  // Advisory application planning only. Bounded so the worst-case Kimi K3 request
  // (12,000 uncached input + 4,000 output = $0.096) stays under the compiled
  // ten-cent per-request ceiling. Do not raise these limits without re-pricing.
  APPLICATION_PLAN: { maxOutputTokens: 4_000, maxInputTokens: 12_000, modelTier: "quality" }
};

const FIELD_LIMITS = {
  resume: 30_000,
  job: 20_000,
  email: 10_000,
  transcriptSection: 8_000
} as const;

function estimateTokens(text: string) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function assertFieldLimit(path: string, value: string) {
  const key = path.split(".").at(-1)?.toLowerCase() ?? "";
  const tokens = estimateTokens(value);

  if ((key === "resumetext" || key === "rawtext") && tokens > FIELD_LIMITS.resume) {
    throw new PublicApiError("Resume text exceeds the 30,000-token AI input limit.", 413, {
      code: "AI_INPUT_TOO_LARGE"
    });
  }
  if ((key === "jobdescription" || key === "description") && tokens > FIELD_LIMITS.job) {
    throw new PublicApiError("Job description exceeds the 20,000-token AI input limit.", 413, {
      code: "AI_INPUT_TOO_LARGE"
    });
  }
  if ((key === "emailtext" || key === "emailbody") && tokens > FIELD_LIMITS.email) {
    throw new PublicApiError("Email text exceeds the 10,000-token AI input limit.", 413, {
      code: "AI_INPUT_TOO_LARGE"
    });
  }
  if ((key === "transcript" || path.toLowerCase().includes("transcriptsections")) && tokens > FIELD_LIMITS.transcriptSection) {
    throw new PublicApiError("An interview transcript section exceeds the 8,000-token section limit.", 413, {
      code: "AI_INPUT_TOO_LARGE"
    });
  }
}

function walkStrings(value: unknown, path: string, visitor: (path: string, value: string) => void) {
  if (typeof value === "string") {
    visitor(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}.${index}`, visitor));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walkStrings(item, path ? `${path}.${key}` : key, visitor));
  }
}

export function assertAiInputWithinLimits(feature: AiFeature, systemPrompt: string, payload: unknown) {
  const policy = AI_FEATURE_POLICIES[feature];
  let totalTokens = estimateTokens(systemPrompt);
  let stringBytes = 0;

  walkStrings(payload, "", (path, value) => {
    assertFieldLimit(path, value);
    totalTokens += estimateTokens(value);
    stringBytes += Buffer.byteLength(value, "utf8");
  });

  // Account for JSON field names and chat framing without relying on a provider tokenizer.
  const jsonBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  totalTokens += Math.ceil(Math.max(0, jsonBytes - stringBytes) / 3) + 1_024;
  if (totalTokens > policy.maxInputTokens) {
    throw new PublicApiError(
      `This ${feature.toLowerCase().replaceAll("_", " ")} request exceeds its ${policy.maxInputTokens.toLocaleString()}-token input limit.`,
      413,
      { code: "AI_INPUT_TOO_LARGE" }
    );
  }

  return { estimatedInputTokens: totalTokens, policy };
}

export function splitTranscriptSections(text: string, maxSections = 4) {
  const maxChars = FIELD_LIMITS.transcriptSection * 3;
  const normalized = text.trim();
  if (!normalized) return { sections: [] as string[], truncated: false };

  const sections: string[] = [];
  let remaining = normalized;
  while (remaining && sections.length < maxSections) {
    if (remaining.length <= maxChars) {
      sections.push(remaining);
      remaining = "";
      break;
    }
    const candidate = remaining.slice(0, maxChars);
    const breakAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(". "));
    const end = breakAt > maxChars * 0.7 ? breakAt + 1 : maxChars;
    sections.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  return { sections, truncated: Boolean(remaining) };
}

export function isAiFeature(value: string): value is AiFeature {
  return Object.hasOwn(AI_FEATURE_POLICIES, value);
}
