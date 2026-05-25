import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { getAllowedAuthEmails, isEmailAllowedForAuth, requiresEmailAllowlist } from "@/lib/auth-access";
import { apiErrorResponse, isDemoUserFallbackEnabled } from "@/lib/user-context";

test("production auth requires an allowlist unless public signups are explicitly enabled", () => {
  const env = { NODE_ENV: "production", AUTH_ALLOWED_EMAILS: "", AUTH_ALLOW_PUBLIC_SIGNUPS: "false" };

  assert.equal(requiresEmailAllowlist(env), true);
  assert.equal(isEmailAllowedForAuth("person@example.com", env), false);
});

test("private auth allows multiple configured Google accounts", () => {
  const env = {
    NODE_ENV: "production",
    AUTH_ALLOWED_EMAILS: "first@example.com, SECOND@example.com",
    AUTH_ALLOW_PUBLIC_SIGNUPS: "false"
  };

  assert.deepEqual(getAllowedAuthEmails(env), ["first@example.com", "second@example.com"]);
  assert.equal(isEmailAllowedForAuth("second@example.com", env), true);
  assert.equal(isEmailAllowedForAuth("other@example.com", env), false);
});

test("demo fallback is never enabled in production", () => {
  assert.equal(isDemoUserFallbackEnabled({ NODE_ENV: "production", ALLOW_DEMO_USER: "true" }), false);
  assert.equal(isDemoUserFallbackEnabled({ NODE_ENV: "development", ALLOW_DEMO_USER: "true" }), true);
});

test("production API errors hide raw internal messages", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLogLevel = process.env.LOG_LEVEL;
  Reflect.set(process.env, "NODE_ENV", "production");
  Reflect.set(process.env, "LOG_LEVEL", "error");

  try {
    const response = apiErrorResponse(new Error("Prisma failed with internal details"));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "The request could not be completed." });
  } finally {
    if (previousNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    }

    if (previousLogLevel === undefined) {
      Reflect.deleteProperty(process.env, "LOG_LEVEL");
    } else {
      Reflect.set(process.env, "LOG_LEVEL", previousLogLevel);
    }
  }
});

test("production API errors keep explicit client-safe messages", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLogLevel = process.env.LOG_LEVEL;
  Reflect.set(process.env, "NODE_ENV", "production");
  Reflect.set(process.env, "LOG_LEVEL", "error");

  try {
    const response = apiErrorResponse(new PublicApiError("Rate limit exceeded. Try again shortly.", 429));

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "Rate limit exceeded. Try again shortly." });
  } finally {
    if (previousNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    }

    if (previousLogLevel === undefined) {
      Reflect.deleteProperty(process.env, "LOG_LEVEL");
    } else {
      Reflect.set(process.env, "LOG_LEVEL", previousLogLevel);
    }
  }
});
