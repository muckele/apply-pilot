import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

const repositoryRoot = process.cwd();
const publicAuthComponentPath = path.join(
  repositoryRoot,
  "components/public-auth/public-auth-page.tsx"
);

async function renderPublicAuthPage(
  mode: "signup" | "login",
  authState: "available" | "denied" | "unavailable"
) {
  assert.equal(existsSync(publicAuthComponentPath), true, "shared public auth presentation must exist");
  const { PublicAuthPage } = await import("@/components/public-auth/public-auth-page");
  return renderToStaticMarkup(
    React.createElement(PublicAuthPage, {
      mode,
      authState,
      googleAction: React.createElement("button", null, "Continue with Google"),
      deniedAction: React.createElement("button", null, "Sign out")
    })
  );
}

test("signup presents the approved new-user acquisition surface", async () => {
  const html = await renderPublicAuthPage("signup", "available");

  assert.match(html, /Your next opportunity starts here\./);
  assert.match(html, /Create your account\./);
  assert.match(html, /Continue with Google to start using Apply Pilot\./);
  assert.match(html, /Already have an account\?/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /Gmail permissions are separate and are not requested here\./);
  assert.doesNotMatch(html, /password|free trial|billing/i);
});

test("login presents the approved returning-user surface", async () => {
  const html = await renderPublicAuthPage("login", "available");

  assert.match(html, /Welcome back\./);
  assert.match(html, /Continue your job search with Apply Pilot\./);
  assert.match(html, /Sign in to Apply Pilot\./);
  assert.match(html, /Continue with Google to return to your workspace\./);
  assert.match(html, /New to Apply Pilot\?/);
  assert.match(html, /href="\/signup"/);
});

test("denied and unavailable auth states are safe and disclose no deployment configuration", async () => {
  const deniedHtml = await renderPublicAuthPage("login", "denied");
  const unavailableHtml = await renderPublicAuthPage("login", "unavailable");
  const rendered = `${deniedHtml}${unavailableHtml}`;

  assert.match(deniedHtml, /Access not available\./);
  assert.match(deniedHtml, /This Google account is not approved for this deployment\./);
  assert.match(deniedHtml, /Sign out/);
  assert.match(unavailableHtml, /Google sign-in is temporarily unavailable\./);
  assert.doesNotMatch(
    rendered,
    /AUTH_ALLOWED_EMAILS|AUTH_ALLOW_PUBLIC_SIGNUPS|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|\.env/i
  );
});

test("signup and login preserve approved-session redirects and the existing Google OAuth action", () => {
  const signupPath = path.join(repositoryRoot, "app/(public)/signup/page.tsx");
  const loginPath = path.join(repositoryRoot, "app/(public)/login/page.tsx");
  const googleButtonPath = path.join(repositoryRoot, "components/google-sign-in-button.tsx");

  assert.equal(existsSync(signupPath), true, "signup route must exist");

  for (const routePath of [signupPath, loginPath]) {
    const source = readFileSync(routePath, "utf8");
    assert.match(source, /await auth\(\)/);
    assert.match(source, /isEmailAllowedForAuth/);
    assert.match(source, /redirect\("\/dashboard"\)/);
  }

  const googleButtonSource = readFileSync(googleButtonPath, "utf8");
  assert.match(
    googleButtonSource,
    /await signIn\("google", \{ redirectTo: "\/dashboard" \}\);/
  );
});
