import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

const ORIGIN = "https://applypilot.test";

function request(path: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "GET",
    headers: cookie ? { cookie } : undefined
  });
}

function assertPassThrough(path: string, cookie?: string) {
  const response = proxy(request(path, cookie));

  assert.equal(response.status, 200, `${path} should pass through`);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(response.headers.get("location"), null);
}

function assertLoginRedirect(path: string) {
  const response = proxy(request(path));
  const location = response.headers.get("location");

  assert.equal(response.status, 307, `${path} should redirect to login`);
  assert.ok(location);

  const loginUrl = new URL(location);
  assert.equal(loginUrl.origin, ORIGIN);
  assert.equal(loginUrl.pathname, "/login");
  assert.equal(loginUrl.searchParams.get("callbackUrl"), path);
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    Reflect.set(process.env, name, value);
  }
}

for (const path of ["/", "/login", "/signup", "/signup?source=landing"]) {
  test(`anonymous requests pass through for the exact public page ${path}`, () => {
    assertPassThrough(path);
  });
}

test("public-page descendants remain protected", () => {
  for (const path of ["/login/", "/login/anything", "/signup/", "/signup/anything"]) {
    assertLoginRedirect(path);
  }
});

test("anonymous requests to product pages redirect with the original callback path", () => {
  for (const path of [
    "/dashboard",
    "/jobs?status=saved",
    "/applications",
    "/settings/profile",
    "/application-runs/example/browser"
  ]) {
    assertLoginRedirect(path);
  }
});

test("public API exceptions pass through without exposing protected or lookalike APIs", async () => {
  for (const path of [
    "/api/auth/session",
    "/api/health/readiness",
    "/api/gmail/callback",
    "/api/cron/job-discovery",
    "/api/interviews/example/audio/upload"
  ]) {
    assertPassThrough(path);
  }

  for (const path of ["/api/profile", "/api/authz"]) {
    const response = proxy(request(path));

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  }
});

test("each accepted session cookie passes through for a protected product page", () => {
  for (const cookieName of [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token"
  ]) {
    assertPassThrough("/dashboard", `${cookieName}=session-token`);
  }
});

test("demo-user behavior remains limited to nonproduction environments", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowDemoUser = process.env.ALLOW_DEMO_USER;

  try {
    Reflect.set(process.env, "NODE_ENV", "development");
    Reflect.set(process.env, "ALLOW_DEMO_USER", "true");
    assertPassThrough("/dashboard");
    assertPassThrough("/api/profile");

    Reflect.set(process.env, "NODE_ENV", "production");
    assertLoginRedirect("/dashboard");

    const response = proxy(request("/api/profile"));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  } finally {
    restoreEnvironment("NODE_ENV", previousNodeEnv);
    restoreEnvironment("ALLOW_DEMO_USER", previousAllowDemoUser);
  }
});
