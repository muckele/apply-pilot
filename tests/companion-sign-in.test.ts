import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

import { PublicApiError } from "@/lib/api-errors";
import {
  COMPANION_SESSION_MAX_AGE_MS,
  COMPANION_SIGN_IN_CODE_TTL_MS,
  companionControlPath,
  exchangeCompanionSignInCode,
  generateCompanionSignInCode,
  issueCompanionSignInCode,
  loginPageTitle,
  normalizeCompanionSignInCode,
  runIdFromCompanionCallback,
  sessionCookieName,
  type CompanionSignInStore
} from "@/lib/companion-sign-in";
import {
  createCompanionSignInExchangeRoute,
  createIssueCompanionSignInCodeRoute
} from "@/lib/companion-sign-in-routes";
import { proxy } from "@/proxy";

const OWNER = "user_owner";
const OTHER = "user_other";
const RUN = "clz8w7m9a0004qwer1234tyui";
const OTHER_RUN = "clz8w7m9a0005qwer1234tyui";
const ALLOWED_EMAIL = "owner@example.com";
const T0 = new Date("2026-11-10T12:00:00.000Z");

type Run = { id: string; userId: string; state: string; email: string | null };

function fakeStore(runs: Run[] = [{ id: RUN, userId: OWNER, state: "READY", email: ALLOWED_EMAIL }]) {
  const codes = new Map<string, { token: string; expires: Date }>();
  const sessions: Array<{ userId: string; sessionToken: string; expires: Date }> = [];
  const store: CompanionSignInStore = {
    async findOwnedRun(userId, runId) {
      const run = runs.find((item) => item.id === runId && item.userId === userId);
      return run ? { id: run.id, state: run.state } : null;
    },
    async replaceCode(identifier, token, expires) {
      codes.set(identifier, { token, expires });
    },
    async consumeCode(identifier, token, now) {
      const entry = codes.get(identifier);
      if (!entry || entry.token !== token || entry.expires <= now) return false;
      codes.delete(identifier);
      return true;
    },
    async findRunOwner(runId) {
      const run = runs.find((item) => item.id === runId);
      return run ? { userId: run.userId, state: run.state, email: run.email } : null;
    },
    async createSession(userId, sessionToken, expires) {
      sessions.push({ userId, sessionToken, expires });
    }
  };
  return { store, codes, sessions };
}

let counter = 0;
function bytes(length: number) {
  counter += 1;
  return Uint8Array.from({ length }, (_, i) => (i * 7 + counter * 13) % 256);
}

function deps(store: CompanionSignInStore, overrides: { now?: Date; isEmailAllowed?: (email: string | null) => boolean } = {}) {
  return {
    store,
    now: () => overrides.now ?? T0,
    randomBytes: bytes,
    isEmailAllowed: overrides.isEmailAllowed ?? ((email: string | null) => email === ALLOWED_EMAIL)
  };
}

async function rejectsAs(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PublicApiError, `expected PublicApiError, got ${String(error)}`);
    assert.equal(error.status, status);
    return true;
  });
}

// --- Code format -----------------------------------------------------------------------

test("sign-in codes are 12 unambiguous characters grouped in fours", () => {
  for (let i = 0; i < 50; i += 1) {
    const code = generateCompanionSignInCode(bytes);
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
});

test("typed codes are normalized, and malformed ones are refused", () => {
  assert.equal(normalizeCompanionSignInCode(" abcd-efgh-jkmn "), "ABCDEFGHJKMN");
  assert.equal(normalizeCompanionSignInCode("ABCD EFGH JKMN"), "ABCDEFGHJKMN");
  assert.equal(normalizeCompanionSignInCode("ABCD-EFGH-JKM"), null);
  assert.equal(normalizeCompanionSignInCode("ABCD-EFGH-JKM0"), null);
  assert.equal(normalizeCompanionSignInCode("ABCD-EFGH-JKMI"), null);
  assert.equal(normalizeCompanionSignInCode(42 as never), null);
});

test("only an exact run control path is accepted as the place to go after sign-in", () => {
  assert.equal(companionControlPath(RUN), `/application-runs/${RUN}/browser`);
  assert.equal(runIdFromCompanionCallback(`/application-runs/${RUN}/browser`), RUN);
  assert.equal(runIdFromCompanionCallback(`/application-runs/${RUN}/browser?x=1`), null);
  assert.equal(runIdFromCompanionCallback(`https://evil.example/application-runs/${RUN}/browser`), null);
  assert.equal(runIdFromCompanionCallback(`//evil.example/application-runs/${RUN}/browser`), null);
  assert.equal(runIdFromCompanionCallback("/dashboard"), null);
  assert.equal(runIdFromCompanionCallback(`/application-runs/not-a-cuid/browser`), null);
  assert.equal(runIdFromCompanionCallback(undefined), null);
});

test("the session cookie name matches Auth.js for secure and local origins", () => {
  assert.equal(sessionCookieName(true), "__Secure-authjs.session-token");
  assert.equal(sessionCookieName(false), "authjs.session-token");
});

// --- Issuing ---------------------------------------------------------------------------

test("issuing a code for an owned, open run stores only a hash that expires in 5 minutes", async () => {
  const { store, codes } = fakeStore();
  const issued = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));

  assert.match(issued.code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$/);
  assert.equal(issued.expiresAt.getTime(), T0.getTime() + COMPANION_SIGN_IN_CODE_TTL_MS);
  assert.equal(COMPANION_SIGN_IN_CODE_TTL_MS, 5 * 60_000);
  assert.equal(codes.size, 1);
  const [stored] = [...codes.values()];
  assert.match(stored.token, /^[0-9a-f]{64}$/);
  assert.equal(stored.token.includes(normalizeCompanionSignInCode(issued.code) ?? "?"), false);
});

test("a new code replaces the previous one for the same run", async () => {
  const { store } = fakeStore();
  const first = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));
  await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));
  await rejectsAs(exchangeCompanionSignInCode({ code: first.code, callbackUrl: companionControlPath(RUN) }, deps(store)), 400);
});

test("no code is issued for another user's run, a missing run or a finished run", async () => {
  const runs: Run[] = [
    { id: RUN, userId: OWNER, state: "COMPLETED_BY_USER", email: ALLOWED_EMAIL },
    { id: OTHER_RUN, userId: OTHER, state: "READY", email: "other@example.com" }
  ];
  const { store, codes } = fakeStore(runs);
  await rejectsAs(issueCompanionSignInCode({ userId: OWNER, runId: OTHER_RUN }, deps(store)), 404);
  await rejectsAs(issueCompanionSignInCode({ userId: OWNER, runId: "clz8w7m9a0009qwer1234tyui" }, deps(store)), 404);
  await rejectsAs(issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store)), 404);
  assert.equal(codes.size, 0);
});

// --- Exchanging ------------------------------------------------------------------------

test("a valid code signs the run owner in once and sends them to the run's control page", async () => {
  const { store, sessions } = fakeStore();
  const issued = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));
  const typed = issued.code.toLowerCase().replace(/-/g, " ");

  const result = await exchangeCompanionSignInCode(
    { code: typed, callbackUrl: companionControlPath(RUN) },
    deps(store, { now: new Date(T0.getTime() + 60_000) })
  );

  assert.equal(result.userId, OWNER);
  assert.equal(result.redirectTo, `/application-runs/${RUN}/browser`);
  assert.match(result.sessionToken, /^[0-9a-f]{64}$/);
  assert.equal(result.expires.getTime(), T0.getTime() + 60_000 + COMPANION_SESSION_MAX_AGE_MS);
  assert.deepEqual(sessions, [{ userId: OWNER, sessionToken: result.sessionToken, expires: result.expires }]);

  await rejectsAs(exchangeCompanionSignInCode({ code: issued.code, callbackUrl: companionControlPath(RUN) }, deps(store)), 400);
  assert.equal(sessions.length, 1);
});

test("an expired code, a wrong code or a code for another run signs nobody in", async () => {
  const runs: Run[] = [
    { id: RUN, userId: OWNER, state: "READY", email: ALLOWED_EMAIL },
    { id: OTHER_RUN, userId: OWNER, state: "READY", email: ALLOWED_EMAIL }
  ];
  const { store, sessions } = fakeStore(runs);
  const issued = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));

  await rejectsAs(exchangeCompanionSignInCode({ code: issued.code, callbackUrl: companionControlPath(OTHER_RUN) }, deps(store)), 400);
  await rejectsAs(exchangeCompanionSignInCode({ code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) }, deps(store)), 400);
  await rejectsAs(exchangeCompanionSignInCode(
    { code: issued.code, callbackUrl: companionControlPath(RUN) },
    deps(store, { now: new Date(T0.getTime() + COMPANION_SIGN_IN_CODE_TTL_MS) })
  ), 400);
  assert.equal(sessions.length, 0);
});

test("a malformed code or a non-control destination is refused without using up the code", async () => {
  const { store, sessions } = fakeStore();
  const issued = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));

  await rejectsAs(exchangeCompanionSignInCode({ code: issued.code, callbackUrl: "/dashboard" }, deps(store)), 400);
  await rejectsAs(exchangeCompanionSignInCode({ code: "nope", callbackUrl: companionControlPath(RUN) }, deps(store)), 400);
  const result = await exchangeCompanionSignInCode({ code: issued.code, callbackUrl: companionControlPath(RUN) }, deps(store));
  assert.equal(result.userId, OWNER);
  assert.equal(sessions.length, 1);
});

test("an owner whose email is no longer allowed, or whose run has finished, is not signed in", async () => {
  const run: Run = { id: RUN, userId: OWNER, state: "READY", email: ALLOWED_EMAIL };
  const { store, sessions } = fakeStore([run]);

  const first = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));
  await rejectsAs(exchangeCompanionSignInCode(
    { code: first.code, callbackUrl: companionControlPath(RUN) },
    deps(store, { isEmailAllowed: () => false })
  ), 400);

  const second = await issueCompanionSignInCode({ userId: OWNER, runId: RUN }, deps(store));
  run.state = "CANCELLED";
  await rejectsAs(exchangeCompanionSignInCode({ code: second.code, callbackUrl: companionControlPath(RUN) }, deps(store)), 400);
  assert.equal(sessions.length, 0);
});

// --- Routes ----------------------------------------------------------------------------

function routeDeps() {
  const calls = { rateLimits: [] as string[], audits: [] as Array<{ action: string; resourceId?: string; userId?: string }> };
  return {
    calls,
    base: {
      checkRateLimit: async (key: string) => { calls.rateLimits.push(key); },
      writeAuditLog: async (input: { userId?: string; action: string; resourceId?: string }) => {
        calls.audits.push({ action: input.action, resourceId: input.resourceId, userId: input.userId });
      }
    }
  };
}

test("issuing a code requires sign-in and returns the code once with no-store", async () => {
  const { calls, base } = routeDeps();
  const route = createIssueCompanionSignInCodeRoute({
    ...base,
    requireUserId: async () => OWNER,
    issue: async (input) => {
      assert.deepEqual(input, { userId: OWNER, runId: RUN });
      return { code: "ABCD-EFGH-JKMN", expiresAt: new Date(T0.getTime() + COMPANION_SIGN_IN_CODE_TTL_MS) };
    }
  });
  const response = await route.POST(
    new NextRequest(`https://app.example.com/api/application-runs/${RUN}/companion-sign-in-code`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ id: RUN }) }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "ABCD-EFGH-JKMN", expiresAt: "2026-11-10T12:05:00.000Z" });
  assert.deepEqual(calls.audits, [{ action: "companion.sign_in_code.issued", resourceId: RUN, userId: OWNER }]);
  assert.equal(calls.rateLimits.length, 1);

  const { UnauthorizedError } = await import("@/lib/user-context");
  const signedOut = createIssueCompanionSignInCodeRoute({
    ...base,
    requireUserId: async () => { throw new UnauthorizedError(); },
    issue: async () => { throw new Error("must not issue"); }
  });
  const denied = await signedOut.POST(
    new NextRequest(`https://app.example.com/api/application-runs/${RUN}/companion-sign-in-code`, { method: "POST", body: "{}" }),
    { params: Promise.resolve({ id: RUN }) }
  );
  assert.equal(denied.status, 401);
});

function exchangeRequest(origin: string | null, body: unknown, url = "https://app.example.com/api/companion-sign-in") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers });
}

test("the exchange refuses requests from other sites before touching any code", async () => {
  const { base } = routeDeps();
  let exchanged = 0;
  const route = createCompanionSignInExchangeRoute({
    ...base,
    exchange: async () => { exchanged += 1; throw new Error("must not run"); }
  });
  const body = { code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) };
  assert.equal((await route.POST(exchangeRequest("https://evil.example", body))).status, 403);
  assert.equal((await route.POST(exchangeRequest(null, body))).status, 403);
  assert.equal(exchanged, 0);
});

test("a successful exchange sets the Auth.js session cookie and returns only where to go", async () => {
  const { calls, base } = routeDeps();
  const expires = new Date(T0.getTime() + COMPANION_SESSION_MAX_AGE_MS);
  const route = createCompanionSignInExchangeRoute({
    ...base,
    exchange: async (input) => {
      assert.deepEqual(input, { code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) });
      return { userId: OWNER, runId: RUN, sessionToken: "a".repeat(64), expires, redirectTo: companionControlPath(RUN) };
    }
  });

  const secure = await route.POST(exchangeRequest("https://app.example.com", { code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) }));
  assert.equal(secure.status, 200);
  assert.deepEqual(await secure.json(), { redirectTo: companionControlPath(RUN) });
  const cookie = secure.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^__Secure-authjs\.session-token=a{64};/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /Path=\//);
  assert.equal(secure.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.audits, [{ action: "companion.sign_in.completed", resourceId: RUN, userId: OWNER }]);
  assert.ok(calls.rateLimits.some((key) => key.includes(RUN)), "the run's attempts are rate limited");

  const local = await route.POST(exchangeRequest("http://localhost:3000", { code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) }, "http://localhost:3000/api/companion-sign-in"));
  const localCookie = local.headers.get("set-cookie") ?? "";
  assert.match(localCookie, /^authjs\.session-token=/);
  assert.doesNotMatch(localCookie, /;\s*Secure/i);
});

test("a failed exchange returns one generic message and sets no cookie", async () => {
  const { base } = routeDeps();
  const route = createCompanionSignInExchangeRoute({
    ...base,
    exchange: async () => { throw new PublicApiError("That code didn't work.", 400, { code: "COMPANION_SIGN_IN_FAILED" }); }
  });
  const response = await route.POST(exchangeRequest("https://app.example.com", { code: "ABCD-EFGH-JKMN", callbackUrl: companionControlPath(RUN) }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("set-cookie"), null);
});

// --- Proxy -----------------------------------------------------------------------------

test("the companion sign-in page and exchange are public; issuing a code still needs a session", () => {
  const open = (path: string) => proxy(new NextRequest(`https://app.example.com${path}`));
  assert.equal(open("/companion-sign-in").headers.get("x-middleware-next"), "1");
  assert.equal(open("/api/companion-sign-in").headers.get("x-middleware-next"), "1");
  assert.equal(open(`/api/application-runs/${RUN}/companion-sign-in-code`).status, 401);
});

test("the login page on the way to a control page is titled like the Apply Pilot browser", () => {
  const control = "/application-runs/cm12345678901234567890123/browser";
  assert.equal(loginPageTitle(control), "Apply Pilot browser — Sign in");
  assert.equal(loginPageTitle(undefined), "Sign in — Apply Pilot");
  assert.equal(loginPageTitle("/dashboard"), "Sign in — Apply Pilot");
  assert.equal(loginPageTitle([control]), "Sign in — Apply Pilot");
});
