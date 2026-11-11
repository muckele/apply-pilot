import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { PublicApiError } from "@/lib/api-errors";
import { cuidPathIdSchema } from "@/lib/application-runs/contracts";
import { isTerminalRunState } from "@/lib/application-runs/state-machine";
import { COMPANION_CODE_ALPHABET, COMPANION_CODE_LENGTH } from "@/lib/companion-sign-in-code-format";
import type { ApplicationRunState } from "@prisma/client";

// Companion sign-in: Google refuses sign-in inside an automated browser, so the local
// companion's window cannot use Google. Instead the owner, already signed in in their own
// browser, asks for a short one-time code for one browser run and types it into the
// companion window. The code is single-use, lives five minutes, is bound to that run, is
// stored only as a hash (in Auth.js's VerificationToken table, so no migration), and is
// exchanged for an ordinary Auth.js database session that opens that run's control page.

export const COMPANION_SIGN_IN_CODE_TTL_MS = 5 * 60_000;
// Matches Auth.js's default database-session maxAge; Auth.js extends a session to this on
// use anyway. The companion's browser profile is temporary, so the cookie is discarded
// when the companion closes.
export const COMPANION_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

// 32 symbols without I, O, 0 or 1, so a typed code is never ambiguous. 12 symbols = 60 bits.
// Shared with the code box in the browser, which flags characters codes never use.
const ALPHABET = COMPANION_CODE_ALPHABET;
const CODE_LENGTH = COMPANION_CODE_LENGTH;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const IDENTIFIER_PREFIX = "companion-sign-in:";

export type RandomBytes = (length: number) => Uint8Array;

export type CompanionSignInStore = {
  findOwnedRun(userId: string, runId: string): Promise<{ id: string; state: string } | null>;
  // Removes any earlier code for this identifier, then stores the new hashed code.
  replaceCode(identifier: string, tokenHash: string, expires: Date): Promise<void>;
  // Deletes the matching, unexpired code and reports whether exactly one was used up.
  consumeCode(identifier: string, tokenHash: string, now: Date): Promise<boolean>;
  findRunOwner(runId: string): Promise<{ userId: string; state: string; email: string | null } | null>;
  createSession(userId: string, sessionToken: string, expires: Date): Promise<void>;
};

export type CompanionSignInDependencies = {
  store: CompanionSignInStore;
  now: () => Date;
  randomBytes: RandomBytes;
  isEmailAllowed: (email: string | null) => boolean;
};

export function generateCompanionSignInCode(randomBytes: RandomBytes = nodeRandomBytes): string {
  const bytes = randomBytes(CODE_LENGTH);
  // 256 is a multiple of 32, so the low five bits pick each symbol uniformly.
  const raw = Array.from(bytes, (byte) => ALPHABET[byte & 31]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normalizeCompanionSignInCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = input.toUpperCase().replace(/[\s-]/g, "");
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

export function companionControlPath(runId: string): string {
  return `/application-runs/${runId}/browser`;
}

// Only an exact, same-origin run control path is a valid destination after sign-in.
export function runIdFromCompanionCallback(callbackUrl: unknown): string | null {
  if (typeof callbackUrl !== "string") return null;
  const match = /^\/application-runs\/([^/?#]+)\/browser$/.exec(callbackUrl);
  if (!match) return null;
  return cuidPathIdSchema.safeParse(match[1]).success ? match[1] : null;
}

// The login page leads with the code form only on the way to a run's control page, which
// only the companion's window opens signed out.
export function companionCallbackForLogin(callbackUrl: unknown): string | null {
  return runIdFromCompanionCallback(callbackUrl) ? (callbackUrl as string) : null;
}

// The Apply Pilot browser's terminal line tells the owner to look for a window titled
// "Apply Pilot browser"; its sign-in page carries that name too.
export function loginPageTitle(callbackUrl: unknown): string {
  return companionCallbackForLogin(callbackUrl) ? "Apply Pilot browser — Sign in" : "Sign in — Apply Pilot";
}

// The former code-only page now sends people to the login page, which leads with the code.
export function companionLoginPath(callbackUrl: unknown): string {
  const callback = companionCallbackForLogin(callbackUrl);
  return callback ? `/login?callbackUrl=${encodeURIComponent(callback)}` : "/login";
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

function identifierFor(runId: string) {
  return `${IDENTIFIER_PREFIX}${runId}`;
}

function hashCode(runId: string, normalizedCode: string) {
  return createHash("sha256").update(`companion-sign-in:v1:${runId}:${normalizedCode}`).digest("hex");
}

function isOpenRun(state: string) {
  return !isTerminalRunState(state as ApplicationRunState);
}

export async function issueCompanionSignInCode(
  input: { userId: string; runId: string },
  dependencies: CompanionSignInDependencies
): Promise<{ code: string; expiresAt: Date }> {
  const run = await dependencies.store.findOwnedRun(input.userId, input.runId);
  if (!run || !isOpenRun(run.state)) {
    throw new PublicApiError("Browser run not found.", 404, { code: "RUN_NOT_FOUND" });
  }
  const code = generateCompanionSignInCode(dependencies.randomBytes);
  const expiresAt = new Date(dependencies.now().getTime() + COMPANION_SIGN_IN_CODE_TTL_MS);
  await dependencies.store.replaceCode(
    identifierFor(run.id),
    hashCode(run.id, normalizeCompanionSignInCode(code) as string),
    expiresAt
  );
  return { code, expiresAt };
}

function signInFailed(): PublicApiError {
  return new PublicApiError(
    "That code didn't work. Codes work once, for 5 minutes, for one browser run.",
    400,
    { code: "COMPANION_SIGN_IN_FAILED" }
  );
}

export async function exchangeCompanionSignInCode(
  input: { code: unknown; callbackUrl: unknown },
  dependencies: CompanionSignInDependencies
): Promise<{ userId: string; runId: string; sessionToken: string; expires: Date; redirectTo: string }> {
  const runId = runIdFromCompanionCallback(input.callbackUrl);
  const code = normalizeCompanionSignInCode(input.code);
  if (!runId || !code) throw signInFailed();

  const now = dependencies.now();
  const consumed = await dependencies.store.consumeCode(identifierFor(runId), hashCode(runId, code), now);
  if (!consumed) throw signInFailed();

  const owner = await dependencies.store.findRunOwner(runId);
  if (!owner || !isOpenRun(owner.state) || !dependencies.isEmailAllowed(owner.email)) throw signInFailed();

  const sessionToken = Buffer.from(dependencies.randomBytes(32)).toString("hex");
  const expires = new Date(now.getTime() + COMPANION_SESSION_MAX_AGE_MS);
  await dependencies.store.createSession(owner.userId, sessionToken, expires);
  return { userId: owner.userId, runId, sessionToken, expires, redirectTo: companionControlPath(runId) };
}
