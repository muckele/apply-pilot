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

test("production readiness supports launch without an OpenAI API key", () => {
  const result = checkDeploymentReadiness(productionEnv(), productionOrigin);

  assert.equal(result.ready, true);
  assert.equal(result.aiMode, "heuristic-local");
  assert.equal(result.directAudioUploads, false);
  assert.deepEqual(result.issues, []);
});

test("production readiness reports mock mode as local even when a key exists", () => {
  const result = checkDeploymentReadiness(
    productionEnv({ OPENAI_API_KEY: "configured-key", OPENAI_MOCK_MODE: "true" }),
    productionOrigin
  );

  assert.equal(result.ready, true);
  assert.equal(result.aiMode, "heuristic-local");
});

test("production readiness recognizes enabled Gemini and requires its server key", () => {
  const enabled = checkDeploymentReadiness(
    productionEnv({
      AI_ENABLED: "true",
      AI_PROVIDER: "gemini",
      AI_MOCK_MODE: "false",
      GEMINI_API_KEY: "configured-gemini-key"
    }),
    productionOrigin
  );
  assert.equal(enabled.ready, true);
  assert.equal(enabled.aiMode, "gemini");

  const missingKey = checkDeploymentReadiness(
    productionEnv({ AI_ENABLED: "true", AI_PROVIDER: "gemini", AI_MOCK_MODE: "false" }),
    productionOrigin
  );
  assert.equal(missingKey.ready, false);
  assert.ok(missingKey.issues.includes("missing_gemini_api_key"));
});

test("production readiness rejects AI limits above the compiled ceilings", () => {
  const result = checkDeploymentReadiness(
    productionEnv({ AI_HARD_CAP_CENTS: "501", AI_AUTOMATION_CAP_CENTS: "151" }),
    productionOrigin
  );
  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("invalid_ai_limit:AI_HARD_CAP_CENTS"));
  assert.ok(result.issues.includes("invalid_ai_limit:AI_AUTOMATION_CAP_CENTS"));
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
