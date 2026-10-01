import { getAllowedAuthEmails, requiresEmailAllowlist } from "@/lib/auth-access";

type DeploymentEnv = Record<string, string | undefined>;

export type DeploymentReadiness = {
  ready: boolean;
  issues: string[];
  aiMode: "gemini" | "openai" | "mixed" | "heuristic-local";
  aiProviderStatus: "disabled" | "not_configured" | "configured_unverified" | "invalid_configuration";
  directAudioUploads: boolean;
};

type AiCapability = Pick<DeploymentReadiness, "aiMode" | "aiProviderStatus"> & {
  issue?: "invalid_ai_provider";
};

function aiCapability(env: DeploymentEnv): AiCapability {
  const configuredProvider = env.AI_PROVIDER?.trim();
  if (configuredProvider && configuredProvider !== "gemini" && configuredProvider !== "openai") {
    return {
      aiMode: "heuristic-local",
      aiProviderStatus: "invalid_configuration",
      issue: "invalid_ai_provider"
    };
  }

  // Legacy OpenAI features predate the guarded provider switch and still use
  // their own key/mock gate. JOB_MATCH uses the guarded Gemini runtime. Report
  // both when configured, but never infer provider reachability from key presence.
  const openAiConfigured = Boolean(env.OPENAI_API_KEY?.trim()) && env.OPENAI_MOCK_MODE !== "true";
  const geminiConfigured =
    env.AI_ENABLED === "true" &&
    env.AI_MOCK_MODE !== "true" &&
    Boolean(env.GEMINI_API_KEY?.trim());

  if (openAiConfigured || geminiConfigured) {
    return {
      aiMode: openAiConfigured && geminiConfigured
        ? "mixed"
        : geminiConfigured ? "gemini" : "openai",
      aiProviderStatus: "configured_unverified"
    };
  }

  const selectedProviderDisabled =
    env.AI_ENABLED !== "true" ||
    env.AI_MOCK_MODE === "true" ||
    (configuredProvider === "openai" && env.OPENAI_MOCK_MODE === "true");
  return {
    aiMode: "heuristic-local",
    aiProviderStatus: selectedProviderDisabled ? "disabled" : "not_configured"
  };
}

function productionOrigin(env: DeploymentEnv, requestOrigin: string) {
  const vercelProductionUrl = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const candidate = vercelProductionUrl
    ? vercelProductionUrl.startsWith("http")
      ? vercelProductionUrl
      : `https://${vercelProductionUrl}`
    : requestOrigin;

  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

function canonicalAppUrl(value: string | undefined) {
  if (!value?.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isValidEncryptionKey(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    return Buffer.from(value, "base64").byteLength === 32;
  } catch {
    return false;
  }
}

function exceedsVercelFunctionUploadLimit(value: string | undefined) {
  if (!value) {
    return false;
  }

  const parsed = Number(value);
  return !Number.isFinite(parsed) || parsed <= 0 || parsed > 4;
}

export function checkDeploymentReadiness(
  env: DeploymentEnv = process.env,
  requestOrigin = "http://localhost:3000"
): DeploymentReadiness {
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  const issues: string[] = [];
  const { issue: aiIssue, ...ai } = aiCapability(env);
  if (aiIssue) issues.push(aiIssue);

  if (production) {
    const expectedOrigin = productionOrigin(env, requestOrigin);

    if (!env.AUTH_SECRET?.trim()) {
      issues.push("missing_auth_secret");
    }
    if (!env.GOOGLE_CLIENT_ID?.trim() || !env.GOOGLE_CLIENT_SECRET?.trim()) {
      issues.push("missing_google_oauth");
    }
    if (requiresEmailAllowlist(env) && getAllowedAuthEmails(env).length === 0) {
      issues.push("missing_private_auth_allowlist");
    }
    if (!isValidEncryptionKey(env.TOKEN_ENCRYPTION_KEY)) {
      issues.push("invalid_token_encryption_key");
    }
    if (!env.CRON_SECRET?.trim()) {
      issues.push("missing_cron_secret");
    }

    for (const name of ["AUTH_URL", "NEXTAUTH_URL", "APP_BASE_URL"] as const) {
      const configuredOrigin = canonicalAppUrl(env[name]);
      if (!configuredOrigin) {
        issues.push(`invalid_app_url:${name}`);
      } else if (expectedOrigin && configuredOrigin !== expectedOrigin) {
        issues.push(`canonical_url_mismatch:${name}`);
      }
    }

    const expectedGmailRedirect = expectedOrigin ? `${expectedOrigin}/api/gmail/callback` : null;
    if (!expectedGmailRedirect || env.GMAIL_REDIRECT_URI !== expectedGmailRedirect) {
      issues.push("gmail_redirect_mismatch");
    }
    if (exceedsVercelFunctionUploadLimit(env.MAX_UPLOAD_MB)) {
      issues.push("resume_upload_limit_exceeds_4mb");
    }
    if (exceedsVercelFunctionUploadLimit(env.MAX_AUDIO_UPLOAD_MB)) {
      issues.push("audio_upload_limit_exceeds_4mb");
    }
  }

  return {
    ready: issues.length === 0,
    issues,
    ...ai,
    directAudioUploads: Boolean(env.BLOB_READ_WRITE_TOKEN?.trim())
  };
}
