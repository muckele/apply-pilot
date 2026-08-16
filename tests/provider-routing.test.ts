import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getAiModel,
  getAiProviderForFeature,
  getAiProviderName,
  getKimiReasoningEffort,
  parseAiProviderOverrides,
  resolveKimiApiKey
} from "@/lib/ai/config";
import { AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { getModelPricing } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";
import { checkDeploymentReadiness } from "@/lib/deployment-readiness";

const trackedEnvironment = [
  "AI_PROVIDER",
  "AI_PROVIDER_OVERRIDES",
  "AI_ALLOWED_MODELS",
  "OPENAI_ALLOWED_MODELS",
  "OPENAI_MODEL",
  "GEMINI_FAST_MODEL",
  "GEMINI_QUALITY_MODEL",
  "KIMI_MODEL",
  "KIMI_REASONING_EFFORT",
  "MOONSHOT_API_KEY"
] as const;
const originalEnvironment = Object.fromEntries(trackedEnvironment.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of trackedEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

const ALL_FEATURES = Object.keys(AI_FEATURE_POLICIES) as AiFeature[];

function clearModelEnvironment() {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER_OVERRIDES;
  delete process.env.AI_ALLOWED_MODELS;
  delete process.env.OPENAI_ALLOWED_MODELS;
  delete process.env.OPENAI_MODEL;
  delete process.env.GEMINI_FAST_MODEL;
  delete process.env.GEMINI_QUALITY_MODEL;
  delete process.env.KIMI_MODEL;
}

test("no overrides preserve existing Gemini routing for every feature", () => {
  clearModelEnvironment();

  assert.equal(getAiProviderName(), "gemini");
  for (const feature of ALL_FEATURES) {
    assert.equal(getAiProviderForFeature(feature), "gemini");
    assert.equal(getAiModel(feature), "gemini-3.5-flash-lite");
  }
});

test("only APPLICATION_PLAN routes to Kimi when the override is configured", () => {
  clearModelEnvironment();
  process.env.AI_PROVIDER_OVERRIDES = "APPLICATION_PLAN:kimi";

  assert.equal(getAiProviderForFeature("APPLICATION_PLAN"), "kimi");
  assert.equal(getAiModel("APPLICATION_PLAN"), "kimi-k3");

  for (const feature of ALL_FEATURES.filter((feature) => feature !== "APPLICATION_PLAN")) {
    assert.equal(getAiProviderForFeature(feature), "gemini");
    assert.equal(getAiModel(feature), "gemini-3.5-flash-lite");
  }
});

test("provider and model provenance flows through the pricing registry", () => {
  clearModelEnvironment();
  process.env.AI_PROVIDER_OVERRIDES = "APPLICATION_PLAN:kimi";

  const kimiModel = getAiModel("APPLICATION_PLAN");
  assert.equal(kimiModel, "kimi-k3");
  assert.equal(getModelPricing(kimiModel).provider, "kimi");
  assert.equal(getModelPricing(getAiModel("JOB_MATCH")).provider, "gemini");
});

test("malformed, duplicate, ineligible, and unknown-provider overrides fail closed", () => {
  const invalid = [
    "APPLICATION_PLAN",
    "APPLICATION_PLAN:",
    ":kimi",
    "APPLICATION_PLAN:kimi:extra",
    "JOB_MATCH:kimi",
    "RESUME_TAILOR:kimi",
    "NOT_A_FEATURE:kimi",
    "APPLICATION_PLAN:unknown-provider",
    "APPLICATION_PLAN:kimi,APPLICATION_PLAN:openai"
  ];

  for (const value of invalid) {
    assert.throws(
      () => parseAiProviderOverrides(value),
      (error) => error instanceof PublicApiError && error.details?.code === "AI_PROVIDER_OVERRIDE_INVALID",
      `expected override to fail closed: ${value}`
    );
  }

  assert.deepEqual(parseAiProviderOverrides(""), {});
  assert.deepEqual(parseAiProviderOverrides("  "), {});
  assert.deepEqual(parseAiProviderOverrides("APPLICATION_PLAN:kimi"), { APPLICATION_PLAN: "kimi" });
});

test("kimi is not accepted as the global AI provider", () => {
  clearModelEnvironment();
  process.env.AI_PROVIDER = "kimi";

  assert.throws(
    () => getAiProviderName(),
    (error) => error instanceof PublicApiError && error.details?.code === "AI_PROVIDER_UNKNOWN"
  );
});

test("model overrides are honored only within the provider routed for the feature", () => {
  clearModelEnvironment();
  process.env.AI_PROVIDER_OVERRIDES = "APPLICATION_PLAN:kimi";
  process.env.AI_ALLOWED_MODELS = "gemini-3.5-flash-lite,gemini-3.5-flash,kimi-k3";

  // A Gemini model cannot be used for a Kimi-routed feature.
  assert.equal(getAiModel("APPLICATION_PLAN", { modelOverride: "gemini-3.5-flash" }), "kimi-k3");
  // A Kimi model is honored for the Kimi-routed feature.
  assert.equal(getAiModel("APPLICATION_PLAN", { modelOverride: "kimi-k3" }), "kimi-k3");
  // A Kimi model cannot be used for a Gemini-routed feature.
  assert.equal(getAiModel("JOB_MATCH", { modelOverride: "kimi-k3" }), "gemini-3.5-flash-lite");
  // A same-provider override still works on Gemini features.
  assert.equal(getAiModel("JOB_MATCH", { modelOverride: "gemini-3.5-flash" }), "gemini-3.5-flash");
});

test("KIMI_REASONING_EFFORT accepts only the documented allowlist", () => {
  delete process.env.KIMI_REASONING_EFFORT;
  assert.equal(getKimiReasoningEffort(), "low");

  process.env.KIMI_REASONING_EFFORT = "high";
  assert.equal(getKimiReasoningEffort(), "high");
  process.env.KIMI_REASONING_EFFORT = "max";
  assert.equal(getKimiReasoningEffort(), "max");

  for (const invalid of ["turbo", "LOW", "", "medium", "minimal"]) {
    process.env.KIMI_REASONING_EFFORT = invalid;
    if (invalid === "") {
      // Empty falls back to the default, matching other optional env configuration.
      assert.equal(getKimiReasoningEffort(), "low");
      continue;
    }
    assert.throws(
      () => getKimiReasoningEffort(),
      (error) => error instanceof PublicApiError && error.details?.code === "AI_REASONING_EFFORT_INVALID",
      `expected reasoning effort to fail closed: ${invalid}`
    );
  }
});

test("KIMI_MODEL is honored but unregistered Kimi models fail closed at pricing", () => {
  clearModelEnvironment();
  process.env.AI_PROVIDER_OVERRIDES = "APPLICATION_PLAN:kimi";

  process.env.KIMI_MODEL = "kimi-k3";
  assert.equal(getAiModel("APPLICATION_PLAN"), "kimi-k3");

  process.env.KIMI_MODEL = "kimi-k2-0905-preview";
  const selected = getAiModel("APPLICATION_PLAN");
  assert.equal(selected, "kimi-k2-0905-preview");
  assert.throws(
    () => getModelPricing(selected),
    (error) => error instanceof PublicApiError && error.details?.code === "AI_MODEL_PRICING_UNKNOWN"
  );
});

test("MOONSHOT_API_KEY is the only Kimi credential source", () => {
  delete process.env.MOONSHOT_API_KEY;
  assert.equal(resolveKimiApiKey(), null);

  process.env.MOONSHOT_API_KEY = "  test-key  ";
  assert.equal(resolveKimiApiKey(), "test-key");
});

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

test("readiness flags a missing Moonshot key when APPLICATION_PLAN routes to Kimi", () => {
  const result = checkDeploymentReadiness(
    productionEnv({
      AI_ENABLED: "true",
      AI_MOCK_MODE: "false",
      GEMINI_API_KEY: "configured-gemini-key",
      AI_PROVIDER_OVERRIDES: "APPLICATION_PLAN:kimi"
    }),
    productionOrigin
  );

  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("missing_kimi_api_key"));
});

test("readiness flags invalid Kimi reasoning effort and malformed overrides", () => {
  const badEffort = checkDeploymentReadiness(
    productionEnv({ KIMI_REASONING_EFFORT: "turbo" }),
    productionOrigin
  );
  assert.equal(badEffort.ready, false);
  assert.ok(badEffort.issues.includes("invalid_kimi_reasoning_effort"));

  const badOverride = checkDeploymentReadiness(
    productionEnv({ AI_PROVIDER_OVERRIDES: "JOB_MATCH:kimi" }),
    productionOrigin
  );
  assert.equal(badOverride.ready, false);
  assert.ok(badOverride.issues.includes("invalid_ai_provider_override"));
});

test("readiness stays ready when Kimi routing is fully configured", () => {
  const result = checkDeploymentReadiness(
    productionEnv({
      AI_ENABLED: "true",
      AI_MOCK_MODE: "false",
      GEMINI_API_KEY: "configured-gemini-key",
      AI_PROVIDER_OVERRIDES: "APPLICATION_PLAN:kimi",
      MOONSHOT_API_KEY: "configured-moonshot-key",
      KIMI_REASONING_EFFORT: "low"
    }),
    productionOrigin
  );

  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
});
