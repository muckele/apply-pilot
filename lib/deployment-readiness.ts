import { getAllowedAuthEmails, requiresEmailAllowlist } from "@/lib/auth-access";

type DeploymentEnv = Record<string, string | undefined>;

export type DeploymentReadiness = {
  ready: boolean;
  issues: string[];
  aiMode: "gemini" | "openai" | "heuristic-local";
  directAudioUploads: boolean;
};

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
  const configuredAiProvider = env.AI_PROVIDER?.trim();
  if (configuredAiProvider && configuredAiProvider !== "gemini" && configuredAiProvider !== "openai") {
    issues.push("invalid_ai_provider");
  }
  const aiProvider = env.AI_PROVIDER === "openai" ? "openai" : "gemini";
  const aiEnabled =
    env.AI_ENABLED === "true" &&
    env.AI_MOCK_MODE !== "true" &&
    !(aiProvider === "openai" && env.OPENAI_MOCK_MODE === "true");

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
    if (aiEnabled && aiProvider === "gemini" && !env.GEMINI_API_KEY?.trim()) {
      issues.push("missing_gemini_api_key");
    }
    if (aiEnabled && aiProvider === "openai" && !env.OPENAI_API_KEY?.trim()) {
      issues.push("missing_openai_api_key");
    }
    const aiLimits = [
      ["AI_HARD_CAP_CENTS", 500],
      ["AI_AUTOMATION_CAP_CENTS", 150],
      ["AI_MAX_REQUEST_COST_CENTS", 10],
      ["AI_CONFIRMATION_THRESHOLD_CENTS", 5]
    ] as const;
    for (const [name, maximum] of aiLimits) {
      if (!env[name]) continue;
      const value = Number(env[name]);
      if (!Number.isInteger(value) || value <= 0 || value > maximum) issues.push(`invalid_ai_limit:${name}`);
    }
  }

  return {
    ready: issues.length === 0,
    issues,
    aiMode: aiEnabled
      ? aiProvider === "gemini" && env.GEMINI_API_KEY?.trim()
        ? "gemini"
        : aiProvider === "openai" && env.OPENAI_API_KEY?.trim()
          ? "openai"
          : "heuristic-local"
      : "heuristic-local",
    directAudioUploads: Boolean(env.BLOB_READ_WRITE_TOKEN?.trim())
  };
}
