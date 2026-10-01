import assert from "node:assert/strict";
import test from "node:test";

import { checkDeploymentReadiness } from "@/lib/deployment-readiness";

const productionOrigin = "https://apply-pilot-sepia.vercel.app";
const encryptionKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "apply-pilot-sepia.vercel.app",
    AUTH_SECRET: "production-auth-secret",
    AUTH_URL: productionOrigin,
    NEXTAUTH_URL: productionOrigin,
    APP_BASE_URL: productionOrigin,
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    AUTH_ALLOWED_EMAILS: "approved@example.com",
    AUTH_ALLOW_PUBLIC_SIGNUPS: "false",
    GMAIL_REDIRECT_URI: `${productionOrigin}/api/gmail/callback`,
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    CRON_SECRET: "production-cron-secret",
    MAX_UPLOAD_MB: "4",
    MAX_AUDIO_UPLOAD_MB: "4",
    ...overrides
  };
}

test("production readiness supports launch with provider execution disabled", () => {
  const result = checkDeploymentReadiness(productionEnv(), productionOrigin);

  assert.equal(result.ready, true);
  assert.equal(result.aiMode, "heuristic-local");
  assert.equal(result.aiProviderStatus, "disabled");
  assert.equal(result.directAudioUploads, false);
  assert.deepEqual(result.issues, []);
});

test("production readiness reports the provider configuration matrix without claiming reachability", () => {
  const matrix = [
    {
      name: "disabled Gemini with a stored key",
      overrides: {
        AI_ENABLED: "false", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false",
        GEMINI_API_KEY: "synthetic-gemini-secret"
      },
      aiMode: "heuristic-local",
      aiProviderStatus: "disabled"
    },
    {
      name: "globally mocked Gemini with a stored key",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "true",
        GEMINI_API_KEY: "synthetic-gemini-secret"
      },
      aiMode: "heuristic-local",
      aiProviderStatus: "disabled"
    },
    {
      name: "enabled Gemini without a key",
      overrides: { AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false" },
      aiMode: "heuristic-local",
      aiProviderStatus: "not_configured"
    },
    {
      name: "enabled Gemini with only whitespace",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false", GEMINI_API_KEY: "   "
      },
      aiMode: "heuristic-local",
      aiProviderStatus: "not_configured"
    },
    {
      name: "enabled configured Gemini",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false",
        GEMINI_API_KEY: "synthetic-gemini-secret"
      },
      aiMode: "gemini",
      aiProviderStatus: "configured_unverified"
    },
    {
      name: "enabled configured OpenAI",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "openai", AI_MOCK_MODE: "false",
        OPENAI_MOCK_MODE: "false", OPENAI_API_KEY: "synthetic-openai-secret"
      },
      aiMode: "openai",
      aiProviderStatus: "configured_unverified"
    },
    {
      name: "legacy OpenAI remains configured when the guarded provider gate is disabled",
      overrides: {
        AI_ENABLED: "false", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false",
        OPENAI_MOCK_MODE: "false", OPENAI_API_KEY: "synthetic-openai-secret"
      },
      aiMode: "openai",
      aiProviderStatus: "configured_unverified"
    },
    {
      name: "configured Gemini and legacy OpenAI are both visible",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false",
        GEMINI_API_KEY: "synthetic-gemini-secret",
        OPENAI_MOCK_MODE: "false", OPENAI_API_KEY: "synthetic-openai-secret"
      },
      aiMode: "mixed",
      aiProviderStatus: "configured_unverified"
    },
    {
      name: "global provider mock does not hide independently active legacy OpenAI",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "true",
        GEMINI_API_KEY: "synthetic-gemini-secret",
        OPENAI_MOCK_MODE: "false", OPENAI_API_KEY: "synthetic-openai-secret"
      },
      aiMode: "openai",
      aiProviderStatus: "configured_unverified"
    },
    {
      name: "OpenAI-specific mock mode",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "openai", AI_MOCK_MODE: "false",
        OPENAI_MOCK_MODE: "true", OPENAI_API_KEY: "synthetic-openai-secret"
      },
      aiMode: "heuristic-local",
      aiProviderStatus: "disabled"
    },
    {
      name: "invalid provider selection",
      overrides: {
        AI_ENABLED: "true", AI_PROVIDER: "typo", AI_MOCK_MODE: "false",
        GEMINI_API_KEY: "synthetic-gemini-secret"
      },
      aiMode: "heuristic-local",
      aiProviderStatus: "invalid_configuration"
    }
  ] as const;

  for (const entry of matrix) {
    const result = checkDeploymentReadiness(productionEnv(entry.overrides), productionOrigin);
    const invalid = entry.aiProviderStatus === "invalid_configuration";
    assert.equal(result.ready, !invalid, entry.name);
    assert.equal(result.aiMode, entry.aiMode, entry.name);
    assert.equal(result.aiProviderStatus, entry.aiProviderStatus, entry.name);
    assert.equal(result.issues.includes("invalid_ai_provider"), invalid, entry.name);
  }
});

test("readiness configuration inspection performs no provider probe and exposes no credential", (t) => {
  let providerCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    providerCalls += 1;
    throw new Error("readiness must not probe a provider");
  });
  const result = checkDeploymentReadiness(productionEnv({
    AI_ENABLED: "true",
    AI_PROVIDER: "gemini",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: "synthetic-gemini-secret"
  }), productionOrigin);

  assert.equal(providerCalls, 0);
  assert.equal(result.aiMode, "gemini");
  assert.equal(result.aiProviderStatus, "configured_unverified");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-gemini-secret|GEMINI_API_KEY/);
});

test("production readiness detects canonical and Gmail callback mismatches", () => {
  const wrongOrigin = "https://apply-pilot.vercel.app";
  const result = checkDeploymentReadiness(
    productionEnv({
      AUTH_URL: wrongOrigin,
      APP_BASE_URL: wrongOrigin,
      GMAIL_REDIRECT_URI: `${wrongOrigin}/api/gmail/callback`
    }),
    productionOrigin
  );

  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("canonical_url_mismatch:AUTH_URL"));
  assert.ok(result.issues.includes("canonical_url_mismatch:APP_BASE_URL"));
  assert.ok(result.issues.includes("gmail_redirect_mismatch"));
});

test("production readiness rejects missing security configuration and oversized function uploads", () => {
  const result = checkDeploymentReadiness(
    productionEnv({
      AUTH_SECRET: undefined,
      TOKEN_ENCRYPTION_KEY: "invalid",
      CRON_SECRET: undefined,
      MAX_UPLOAD_MB: "5",
      MAX_AUDIO_UPLOAD_MB: "invalid"
    }),
    productionOrigin
  );

  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("missing_auth_secret"));
  assert.ok(result.issues.includes("invalid_token_encryption_key"));
  assert.ok(result.issues.includes("missing_cron_secret"));
  assert.ok(result.issues.includes("resume_upload_limit_exceeds_4mb"));
  assert.ok(result.issues.includes("audio_upload_limit_exceeds_4mb"));
});
