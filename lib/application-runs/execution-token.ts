import { createHash, randomBytes } from "node:crypto";

import type { ApplicationExecutionScope, ApplicationRunState, Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  assertExecutionHostAllowed,
  canonicalizePolicyHostEntry,
  parseExecutionTargetUrl
} from "@/lib/application-runs/host-policy";
import { assertAutomationCapability, type AutomationEnv } from "@/lib/application-runs/policy";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// ApplicationExecutionToken service (Commit 3).
//
// Controlled-application-automation execution credentials. There is NO SUBMIT scope and no
// employer-form submission behavior anywhere in this service. A token is a run-scoped,
// host-bound, single-ApplicationExecutionScope credential persisted ONLY as a SHA-256 hash;
// the plaintext token is returned exactly once, at issuance.
//
// Invariants (approved Commit 3 plan):
//   - Issuance receives authoritative identifiers (userId/runId/scope), never caller-supplied
//     run/policy objects; authoritative policy and run state are re-read INSIDE the issuance
//     transaction. Lock ordering is policy -> ApplicationRun (identical to Commit 2's TX1).
//   - The ApplicationRun FOR UPDATE row lock is the replacement serialization point (no
//     advisory locks). Re-issuing APPLICATION_READ for the same userId+runId+host+scope+
//     singleUse slot revokes every unconsumed/unrevoked predecessor (revokedAt), including
//     expired predecessors, then creates the replacement while the lock is held. Superseded
//     rows are retained, never deleted.
//   - The canonical execution host is derived from the authoritative locked run via
//     parseExecutionTargetUrl (never from caller-supplied host text) and must agree with the
//     run's stored applyHost.
//   - Only APPLICATION_READ is issued in Commit 3: TTL = exactly 15 minutes, singleUse=false.
//     No TTL/issuance policy is invented for APPLICATION_FILL or APPLICATION_EVENT_WRITE.
//   - There is NO public general-purpose verify function. Reusable authorization and
//     single-use consumption are structurally separate; each is authorized SOLELY by a single
//     guarded updateMany whose predicate carries the full tokenHash+userId+runId+host+scope+
//     singleUse+liveness bindings. count === 1 is success; count === 0 fails closed.
//   - Real PostgreSQL isolation/concurrency proof is deferred to Commit 5.
// ---------------------------------------------------------------------------

export const EXECUTION_TOKEN_PREFIX = "aet_";
export const EXECUTION_TOKEN_PATTERN = /^aet_[A-Za-z0-9_-]{43}$/;

export const APPLICATION_EXECUTION_SCOPES = [
  "APPLICATION_READ",
  "APPLICATION_FILL",
  "APPLICATION_EVENT_WRITE"
] as const satisfies readonly ApplicationExecutionScope[];

export const READ_TOKEN_ISSUABLE_RUN_STATES = ["READY", "REVIEW_REQUIRED"] as const satisfies readonly ApplicationRunState[];

// Exactly fifteen minutes. Hard constant, deliberately NOT derived from configuration so a
// longer lifetime cannot be silently introduced. The exact boundary is asserted by tests.
export const READ_TOKEN_TTL_MS = 15 * 60 * 1000;

// The authoritative persisted/derived shape of an execution token as used by the pure
// predicates below. Mirrors the ApplicationExecutionToken model without the display prefix.
export type ExecutionTokenSnapshot = {
  userId: string;
  runId: string;
  host: string;
  scope: ApplicationExecutionScope;
  singleUse: boolean;
  consumedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
};

// The binding a caller asserts a presented token must match. The expected host must be the
// canonical host produced by parseExecutionTargetUrl (exact string equality is used; no
// subdomain widening, trailing-dot, port, or scheme ambiguity).
export type ExpectedTokenBinding = {
  userId: string;
  runId: string;
  host: string;
  scope: ApplicationExecutionScope;
};

// The replacement slot: one run, one canonical execution host, one scope.
export type TokenSlot = {
  userId: string;
  runId: string;
  host: string;
  scope: ApplicationExecutionScope;
  singleUse: boolean;
};

// The single named error type for this module, following the RunTransitionError convention
// in state-machine.ts: a PublicApiError subclass that stamps a stable machine-readable code
// into details and sets a distinct name. Every failure raised directly by this service uses it.
export class ExecutionTokenError extends PublicApiError {
  constructor(message: string, status: number, code: string, details?: Record<string, unknown>) {
    super(message, status, { code, ...details });
    this.name = "ExecutionTokenError";
  }
}

// Single fail-closed credential error. A generic 401 with no state detail avoids leaking
// whether a token exists, is expired, is revoked, is already consumed, or mismatches the
// asserted binding.
function invalidExecutionToken(): ExecutionTokenError {
  return new ExecutionTokenError("This execution token is invalid, expired, or revoked.", 401, "EXECUTION_TOKEN_INVALID");
}

function executionTokenNotFound(): ExecutionTokenError {
  return new ExecutionTokenError("This execution token was not found.", 404, "EXECUTION_TOKEN_NOT_FOUND");
}

function runNotFound(): ExecutionTokenError {
  return new ExecutionTokenError("This application run was not found.", 404, "RUN_NOT_FOUND");
}

function invalidRunState(): ExecutionTokenError {
  return new ExecutionTokenError(
    "This application run is not available for execution.",
    409,
    "RUN_INVALID_STATE"
  );
}

function unavailableScope(): ExecutionTokenError {
  return new ExecutionTokenError(
    "Issuing this execution-token scope is not available in this milestone.",
    409,
    "EXECUTION_TOKEN_SCOPE_UNAVAILABLE"
  );
}

function invalidTokenData(): ExecutionTokenError {
  return new ExecutionTokenError("Invalid execution-token data.", 400, "EXECUTION_TOKEN_DATA_INVALID");
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isNullableValidDate(value: unknown): value is Date | null {
  return value === null || isValidDate(value);
}

function isExecutionScope(value: unknown): value is ApplicationExecutionScope {
  return APPLICATION_EXECUTION_SCOPES.includes(value as ApplicationExecutionScope);
}

function isCanonicalExecutionHost(value: unknown): value is string {
  return typeof value === "string" && canonicalizePolicyHostEntry(value) === value;
}

function isExpectedTokenBinding(value: unknown): value is ExpectedTokenBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlankString(candidate.userId) &&
    isNonBlankString(candidate.runId) &&
    isCanonicalExecutionHost(candidate.host) &&
    isExecutionScope(candidate.scope)
  );
}

function isTokenSlot(value: unknown): value is TokenSlot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlankString(candidate.userId) &&
    isNonBlankString(candidate.runId) &&
    isCanonicalExecutionHost(candidate.host) &&
    isExecutionScope(candidate.scope) &&
    typeof candidate.singleUse === "boolean"
  );
}

function isExecutionTokenSnapshot(value: unknown): value is ExecutionTokenSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonBlankString(candidate.userId) &&
    isNonBlankString(candidate.runId) &&
    isCanonicalExecutionHost(candidate.host) &&
    isExecutionScope(candidate.scope) &&
    typeof candidate.singleUse === "boolean" &&
    isNullableValidDate(candidate.consumedAt) &&
    isNullableValidDate(candidate.revokedAt) &&
    isValidDate(candidate.expiresAt)
  );
}

function validateBindingInput(value: unknown): ExecutionTokenBindingInput {
  if (!value || typeof value !== "object") throw invalidExecutionToken();
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.rawToken !== "string" ||
    !EXECUTION_TOKEN_PATTERN.test(candidate.rawToken) ||
    !isExpectedTokenBinding(candidate.expected)
  ) {
    throw invalidExecutionToken();
  }
  return {
    rawToken: candidate.rawToken,
    expected: candidate.expected
  };
}

function validateIssueInput(value: unknown): IssueExecutionTokenInput {
  if (!value || typeof value !== "object") throw runNotFound();
  const candidate = value as Record<string, unknown>;
  if (!isNonBlankString(candidate.userId) || !isNonBlankString(candidate.runId)) throw runNotFound();
  if (!isExecutionScope(candidate.scope) || candidate.scope !== "APPLICATION_READ") throw unavailableScope();
  return {
    userId: candidate.userId,
    runId: candidate.runId,
    scope: candidate.scope
  };
}

function validateRevokeInput(value: unknown): RevokeExecutionTokenInput {
  if (!value || typeof value !== "object") throw executionTokenNotFound();
  const candidate = value as Record<string, unknown>;
  if (!isNonBlankString(candidate.userId) || !isNonBlankString(candidate.tokenId)) {
    throw executionTokenNotFound();
  }
  return {
    userId: candidate.userId,
    tokenId: candidate.tokenId
  };
}

function validateRunBoundRevokeInput(value: unknown): RevokeExecutionTokenForRunInput {
  const input = validateRevokeInput(value);
  const candidate = value as Record<string, unknown>;
  if (!isNonBlankString(candidate.runId)) throw executionTokenNotFound();
  return { ...input, runId: candidate.runId };
}

// ---------------------------------------------------------------------------
// Token generation and hashing (Node built-in crypto only)
// ---------------------------------------------------------------------------

// SHA-256 of the raw token, hex-encoded. Deterministic: the same raw token always produces
// the same hash, which is exactly how issuance stores it and verification looks it up.
export function hashExecutionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// Generates a fresh execution token: `aet_` + 256 bits of CSPRNG secret (base64url, 43
// chars). The raw token is returned ONLY here (issuance); the database stores only the hash
// and a display prefix. Two calls never produce the same secret. The stored prefix is
// display-only and matches the browser-capture convention (slice(0, 12) + "...").
export function generateExecutionToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `${EXECUTION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashExecutionToken(token),
    tokenPrefix: `${token.slice(0, 12)}...`
  };
}

// ---------------------------------------------------------------------------
// Pure predicates (explicit `now`; offline-testable)
// ---------------------------------------------------------------------------

// Expiry fails CLOSED at the exact boundary: expiresAt === now is expired (<=). A token with
// expiresAt strictly greater than now is not yet expired.
export function isTokenExpired(record: Pick<ExecutionTokenSnapshot, "expiresAt">, now: Date): boolean {
  if (!isValidDate(record?.expiresAt) || !isValidDate(now)) return true;
  return record.expiresAt.getTime() <= now.getTime();
}

export function isTokenRevoked(record: Pick<ExecutionTokenSnapshot, "revokedAt">): boolean {
  if (!record || typeof record !== "object") return true;
  return (record as { revokedAt?: unknown }).revokedAt !== null;
}

export function isTokenConsumed(record: Pick<ExecutionTokenSnapshot, "consumedAt">): boolean {
  if (!record || typeof record !== "object") return true;
  return (record as { consumedAt?: unknown }).consumedAt !== null;
}

// A token is live only when not revoked, not expired, and (for single-use tokens) not yet
// consumed. Reusable tokens may be authorized repeatedly within their TTL.
export function isTokenLive(record: ExecutionTokenSnapshot, now: Date): boolean {
  if (!isExecutionTokenSnapshot(record) || !isValidDate(now)) return false;
  if (isTokenRevoked(record)) return false;
  if (isTokenExpired(record, now)) return false;
  if (record.singleUse && isTokenConsumed(record)) return false;
  return true;
}

// Only single-use tokens are consumable. A reusable (APPLICATION_READ) token is never
// consumable, even while live.
export function canConsumeToken(record: ExecutionTokenSnapshot, now: Date): boolean {
  return isExecutionTokenSnapshot(record) && record.singleUse === true && isTokenLive(record, now);
}

// Pure mirror of the authorizeReusableExecutionToken guarded predicate. Requires
// singleUse=false so a single-use token can NEVER be authorized here.
export function isReusableAuthorizable(
  record: ExecutionTokenSnapshot,
  expected: ExpectedTokenBinding,
  now: Date
): boolean {
  if (!isExecutionTokenSnapshot(record) || !isExpectedTokenBinding(expected) || !isValidDate(now)) return false;
  return (
    record.singleUse === false &&
    record.revokedAt === null &&
    record.expiresAt.getTime() > now.getTime() &&
    record.userId === expected.userId &&
    record.runId === expected.runId &&
    record.host === expected.host &&
    record.scope === expected.scope
  );
}

// Pure mirror of the consumeSingleUseExecutionToken guarded predicate. Requires
// singleUse=true and consumedAt=null so a reusable token can NEVER be consumed and a
// single-use token can be claimed at most once.
export function isSingleUseConsumable(
  record: ExecutionTokenSnapshot,
  expected: ExpectedTokenBinding,
  now: Date
): boolean {
  if (!isExecutionTokenSnapshot(record) || !isExpectedTokenBinding(expected) || !isValidDate(now)) return false;
  return (
    record.singleUse === true &&
    record.consumedAt === null &&
    record.revokedAt === null &&
    record.expiresAt.getTime() > now.getTime() &&
    record.userId === expected.userId &&
    record.runId === expected.runId &&
    record.host === expected.host &&
    record.scope === expected.scope
  );
}

// Pure mirror of the replacement-revoke predicate: every equivalent predecessor for the
// exact userId+runId+host+scope+singleUse slot is superseded unless already consumed or
// revoked. Expired equivalents are intentionally eligible for cleanup. Superseded rows are
// retained (revokedAt), never deleted.
export function isReplacementCandidate(record: ExecutionTokenSnapshot, slot: TokenSlot): boolean {
  if (!isExecutionTokenSnapshot(record) || !isTokenSlot(slot)) return false;
  return (
    record.userId === slot.userId &&
    record.runId === slot.runId &&
    record.host === slot.host &&
    record.scope === slot.scope &&
    record.singleUse === slot.singleUse &&
    record.revokedAt === null &&
    record.consumedAt === null
  );
}

// ---------------------------------------------------------------------------
// Pure builders (mirror the exact DB predicates/data; the DB layer must not diverge)
// ---------------------------------------------------------------------------

// Builds the ApplicationExecutionToken create payload. Persists ONLY the hash + display
// prefix; the raw token is NEVER persisted. Explicitly writes singleUse=false and
// expiresAt = now + READ_TOKEN_TTL_MS for APPLICATION_READ. Rejects any other scope so no
// TTL is invented for APPLICATION_FILL / APPLICATION_EVENT_WRITE in this commit.
export function buildExecutionTokenCreateData(
  input: {
    userId: string;
    runId: string;
    host: string;
    scope: ApplicationExecutionScope;
    tokenHash: string;
    tokenPrefix: string;
  },
  now: Date
): Prisma.ApplicationExecutionTokenUncheckedCreateInput {
  if (
    !isNonBlankString(input?.userId) ||
    !isNonBlankString(input?.runId) ||
    !isCanonicalExecutionHost(input?.host) ||
    !isExecutionScope(input?.scope) ||
    typeof input?.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.tokenHash) ||
    typeof input?.tokenPrefix !== "string" ||
    !/^aet_[A-Za-z0-9_-]{8}\.\.\.$/.test(input.tokenPrefix) ||
    !isValidDate(now)
  ) {
    throw invalidTokenData();
  }
  if (input.scope !== "APPLICATION_READ") {
    throw unavailableScope();
  }
  return {
    userId: input.userId,
    runId: input.runId,
    tokenHash: input.tokenHash,
    tokenPrefix: input.tokenPrefix,
    host: input.host,
    scope: input.scope,
    singleUse: false,
    expiresAt: new Date(now.getTime() + READ_TOKEN_TTL_MS)
  };
}

// The replacement-revoke predicate for equivalent predecessors. Expiry is deliberately not
// included: expired equivalents are still marked revoked as supersession cleanup.
export function buildReplacementRevokeWhere(slot: TokenSlot): Prisma.ApplicationExecutionTokenWhereInput {
  if (!isTokenSlot(slot)) throw invalidTokenData();
  return {
    userId: slot.userId,
    runId: slot.runId,
    host: slot.host,
    scope: slot.scope,
    singleUse: slot.singleUse,
    revokedAt: null,
    consumedAt: null
  };
}

// The ownership-scoped revocation predicate. revokedAt:null makes revocation idempotent: a
// second revoke matches zero rows, which the service reports as alreadyRevoked (not an error).
export function buildRevokeWhere(input: { userId: string; tokenId: string }): Prisma.ApplicationExecutionTokenWhereInput {
  if (!isNonBlankString(input?.userId) || !isNonBlankString(input?.tokenId)) throw executionTokenNotFound();
  return { id: input.tokenId, userId: input.userId, revokedAt: null };
}

export function buildRunBoundRevokeWhere(
  input: RevokeExecutionTokenForRunInput
): Prisma.ApplicationExecutionTokenWhereInput {
  const validated = validateRunBoundRevokeInput(input);
  return {
    id: validated.tokenId,
    userId: validated.userId,
    runId: validated.runId,
    revokedAt: null
  };
}

export type BulkExecutionTokenRevocationReason =
  | "policy_changed"
  | "run_cancelled"
  | "answer_packet_changed";

function validateBulkRevocationInput(
  input: { userId: string; runId?: string; now: Date; reason: BulkExecutionTokenRevocationReason },
  requireRun: boolean
) {
  if (
    !isNonBlankString(input?.userId) ||
    (requireRun && !isNonBlankString(input?.runId)) ||
    !isValidDate(input?.now) ||
    input?.reason !== "policy_changed" &&
    input?.reason !== "run_cancelled" &&
    input?.reason !== "answer_packet_changed"
  ) {
    throw invalidTokenData();
  }
}

function buildUsableExecutionTokenWhere(
  input: { userId: string; now: Date; reason: BulkExecutionTokenRevocationReason },
  requireRun: boolean
): Prisma.ApplicationExecutionTokenWhereInput {
  validateBulkRevocationInput(input, requireRun);
  return {
    userId: input.userId,
    revokedAt: null,
    expiresAt: { gt: input.now },
    OR: [{ singleUse: false }, { singleUse: true, consumedAt: null }]
  };
}

export function buildUsableExecutionTokenWhereForUser(input: {
  userId: string;
  now: Date;
  reason: BulkExecutionTokenRevocationReason;
}): Prisma.ApplicationExecutionTokenWhereInput {
  return buildUsableExecutionTokenWhere(input, false);
}

export function buildUsableExecutionTokenWhereForRun(input: {
  userId: string;
  runId: string;
  now: Date;
  reason: BulkExecutionTokenRevocationReason;
}): Prisma.ApplicationExecutionTokenWhereInput {
  validateBulkRevocationInput(input, true);
  return {
    ...buildUsableExecutionTokenWhere(input, false),
    runId: input.runId
  };
}

// ---------------------------------------------------------------------------
// Issuance (capability-increasing; the ONLY scope issued in Commit 3 is APPLICATION_READ)
// ---------------------------------------------------------------------------

export type IssueExecutionTokenInput = {
  userId: string; // authenticated principal
  runId: string; // requested run
  scope: ApplicationExecutionScope; // only APPLICATION_READ is issuable in this commit
};

export type ExecutionTokenRecord = {
  id: string;
  tokenPrefix: string;
  host: string;
  scope: ApplicationExecutionScope;
  singleUse: boolean;
  expiresAt: Date;
  createdAt: Date;
};

export type IssuedExecutionToken = {
  token: string; // plaintext, returned exactly once after the transaction commits
  tokenRecord: ExecutionTokenRecord;
};

export type ExecutionTokenPrismaClient = Pick<typeof prisma, "$transaction" | "applicationExecutionToken">;

export type ExecutionTokenServiceDependencies = {
  prismaClient?: ExecutionTokenPrismaClient;
  clock?: () => Date;
  tokenGenerator?: typeof generateExecutionToken;
  env?: AutomationEnv;
};

type ResolvedExecutionTokenServiceDependencies = {
  prismaClient: ExecutionTokenPrismaClient;
  clock: () => Date;
  tokenGenerator: typeof generateExecutionToken;
  env: AutomationEnv;
};

function resolveServiceNow(dependencies: ResolvedExecutionTokenServiceDependencies): Date {
  const now = dependencies.clock();
  if (!isValidDate(now)) throw invalidTokenData();
  return now;
}

function validateGeneratedToken(generated: unknown): asserts generated is ReturnType<typeof generateExecutionToken> {
  if (!generated || typeof generated !== "object") throw invalidTokenData();
  const candidate = generated as Record<string, unknown>;
  if (
    typeof candidate.token !== "string" ||
    typeof candidate.tokenHash !== "string" ||
    typeof candidate.tokenPrefix !== "string" ||
    !EXECUTION_TOKEN_PATTERN.test(candidate.token) ||
    !/^[a-f0-9]{64}$/.test(candidate.tokenHash) ||
    candidate.tokenHash !== hashExecutionToken(candidate.token) ||
    candidate.tokenPrefix !== `${candidate.token.slice(0, 12)}...`
  ) {
    throw invalidTokenData();
  }
}

// Issues a fresh APPLICATION_READ execution token. The transaction enforces, in order
// (policy -> ApplicationRun, matching Commit 2): lock + re-read the authoritative policy and
// run the deterministic capability gate BEFORE acquiring any exclusive run lock;
// ownership-scope + FOR UPDATE lock the ApplicationRun (replacement serialization point);
// re-read the run and derive the canonical host from it; assertExecutionHostAllowed against
// the post-lock policy; supersede unconsumed/unrevoked predecessors for the exact slot;
// create the replacement;
// write the audit row. The plaintext token is returned only after the transaction commits.
async function issueExecutionTokenWithDependencies(
  unvalidatedInput: IssueExecutionTokenInput,
  dependencies: ResolvedExecutionTokenServiceDependencies
): Promise<IssuedExecutionToken> {
  const input = validateIssueInput(unvalidatedInput);
  const { userId, runId, scope } = input;

  return dependencies.prismaClient.$transaction(async (tx) => {
    // 1. Lock the per-user policy row first (policy -> ApplicationRun ordering). Absence of a
    //    policy row means automation is not enabled for this user, so issuance fails closed
    //    (this service never creates policy rows).
    const lockedPolicy = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ApplicationAutomationPolicy" WHERE "userId" = ${userId} FOR UPDATE
    `;
    if (lockedPolicy.length === 0) {
      throw new ExecutionTokenError("Application automation is disabled.", 403, "AUTOMATION_DISABLED");
    }
    const policy = await tx.applicationAutomationPolicy.findUnique({ where: { userId } });
    if (!policy) {
      throw new ExecutionTokenError("Application automation is disabled.", 403, "AUTOMATION_DISABLED");
    }

    // 2. Deterministic capability gate, run BEFORE any exclusive ApplicationRun lock so a
    //    caller with automation disabled never holds a run row lock and always receives
    //    AUTOMATION_DISABLED (never RUN_NOT_FOUND / RUN_HOST_NOT_ALLOWED).
    assertAutomationCapability(policy, dependencies.env);

    // 3. Ownership-scope and lock the target ApplicationRun. Zero rows means the run does not
    //    exist OR belongs to another user; a single 404 reveals no cross-user distinction.
    const lockedRun = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ApplicationRun" WHERE "id" = ${runId} AND "userId" = ${userId} FOR UPDATE
    `;
    if (lockedRun.length === 0) {
      throw runNotFound();
    }
    const run = await tx.applicationRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        userId: true,
        state: true,
        applicationId: true,
        jobPostingId: true,
        applyUrlSnapshot: true,
        applyHost: true,
        application: { select: { userId: true, jobPostingId: true } },
        jobPosting: { select: { userId: true } }
      }
    });
    if (
      !run ||
      run.userId !== userId ||
      run.application?.userId !== userId ||
      run.jobPosting?.userId !== userId ||
      run.application?.jobPostingId !== run.jobPostingId
    ) {
      throw runNotFound();
    }

    if (!READ_TOKEN_ISSUABLE_RUN_STATES.includes(run.state as (typeof READ_TOKEN_ISSUABLE_RUN_STATES)[number])) {
      throw invalidRunState();
    }

    // 4. Derive the canonical execution host from the authoritative locked run (never from
    //    caller-supplied host text). Fail closed if the snapshot's canonical host disagrees
    //    with the run's stored applyHost.
    const target = parseExecutionTargetUrl(run.applyUrlSnapshot);
    if (!target || target.host !== run.applyHost) {
      throw new ExecutionTokenError(
        "This host is not allowed for browser execution by the automation policy.",
        403,
        "RUN_HOST_NOT_ALLOWED"
      );
    }
    const host = target.host;

    // 5. Execution-host policy against the authoritative post-lock policy (blocked precedence,
    //    deny-by-default-when-empty, private/IP-literal rejection).
    assertExecutionHostAllowed(host, policy);

    // 6. Obtain the effective issuance time only after all authoritative locks/checks.
    //    Expiry therefore grants exactly fifteen minutes from this mutation boundary.
    const issuanceNow = resolveServiceNow(dependencies);
    const generated = dependencies.tokenGenerator();
    validateGeneratedToken(generated);

    // 7. Supersede every equivalent unconsumed/unrevoked predecessor. Expired equivalent
    //    predecessors are intentionally included as cleanup. The run lock serializes slots.
    const superseded = await tx.applicationExecutionToken.updateMany({
      where: buildReplacementRevokeWhere({ userId, runId, host, scope, singleUse: false }),
      data: { revokedAt: issuanceNow }
    });

    // 8. Create the replacement token (singleUse=false, issuanceNow + 15 minutes).
    const created = await tx.applicationExecutionToken.create({
      data: buildExecutionTokenCreateData(
        { userId, runId, host, scope, tokenHash: generated.tokenHash, tokenPrefix: generated.tokenPrefix },
        issuanceNow
      ),
      select: { id: true, tokenPrefix: true, host: true, scope: true, singleUse: true, expiresAt: true, createdAt: true }
    });

    // 9. Audit inside the same transaction. Only durable nonsecret lifecycle context is
    //    recorded; neither plaintext token nor tokenHash enters audit metadata.
    await tx.auditLog.create({
      data: {
        userId,
        action: "application-execution-token.create",
        resource: "ApplicationExecutionToken",
        resourceId: created.id,
        metadata: {
          runId,
          applicationId: run.applicationId,
          jobPostingId: run.jobPostingId,
          scope,
          host,
          expiresAt: created.expiresAt.toISOString(),
          supersededCount: superseded.count
        } as Prisma.InputJsonValue
      }
    });

    return { token: generated.token, tokenRecord: created };
  });
}

// ---------------------------------------------------------------------------
// Reusable authorization (singleUse=false ONLY)
// ---------------------------------------------------------------------------

export type ExecutionTokenBinding = {
  id: string;
  userId: string;
  runId: string;
  host: string;
  scope: ApplicationExecutionScope;
  singleUse: boolean;
  expiresAt: Date;
};

export type ExecutionTokenBindingInput = {
  rawToken: string;
  expected: ExpectedTokenBinding;
};

// Authorizes a REUSABLE execution token (singleUse=false). The single guarded updateMany is
// the ONLY authorization decision: its predicate carries the full binding (tokenHash +
// userId + runId + host + scope) plus singleUse=false and liveness (revokedAt=null,
// expiresAt>now), and folds lastUsedAt telemetry into the same guarded mutation. count===1
// authorizes; count===0 fails closed with EXECUTION_TOKEN_INVALID. singleUse=false in the
// predicate guarantees a single-use token can never be authorized here. The post-success
// read returns only stable, immutable binding metadata and does NOT re-decide authorization.
async function authorizeReusableExecutionTokenWithDependencies(
  unvalidatedInput: ExecutionTokenBindingInput,
  dependencies: ResolvedExecutionTokenServiceDependencies
): Promise<ExecutionTokenBinding> {
  const input = validateBindingInput(unvalidatedInput);
  // The server-global gate is an authorization-time emergency pause. Input validation stays
  // first, while this check stays before the clock and every database authorization/mutation.
  // Passing an enabled policy value intentionally checks only the global half of the existing
  // capability helper; user-policy changes are enforced by atomic persistent token revocation.
  assertAutomationCapability({ enabled: true }, dependencies.env);
  const now = resolveServiceNow(dependencies);
  const tokenHash = hashExecutionToken(input.rawToken);

  const result = await dependencies.prismaClient.applicationExecutionToken.updateMany({
    where: {
      tokenHash,
      userId: input.expected.userId,
      runId: input.expected.runId,
      host: input.expected.host,
      scope: input.expected.scope,
      singleUse: false,
      revokedAt: null,
      expiresAt: { gt: now }
    },
    data: { lastUsedAt: now }
  });
  if (result.count !== 1) {
    throw invalidExecutionToken();
  }

  const record = await dependencies.prismaClient.applicationExecutionToken.findUnique({ where: { tokenHash } });
  if (!record) {
    throw invalidExecutionToken();
  }
  return {
    id: record.id,
    userId: record.userId,
    runId: record.runId,
    host: record.host,
    scope: record.scope,
    singleUse: record.singleUse,
    expiresAt: record.expiresAt
  };
}

// ---------------------------------------------------------------------------
// Single-use consumption (singleUse=true ONLY; atomic claim)
// ---------------------------------------------------------------------------

// Atomically claims a SINGLE-USE execution token (singleUse=true). The single guarded
// updateMany is the ONLY claim decision: its predicate carries the full binding plus
// singleUse=true, consumedAt=null, revokedAt=null, expiresAt>now, and sets
// consumedAt=lastUsedAt=now. count===1 claims; count===0 fails closed. The consumedAt=null
// predicate makes concurrent claims mutually exclusive at the PostgreSQL row level, so at
// most one caller can win. singleUse=true in the predicate guarantees a reusable token can
// never be consumed.
async function consumeSingleUseExecutionTokenWithDependencies(
  unvalidatedInput: ExecutionTokenBindingInput,
  dependencies: ResolvedExecutionTokenServiceDependencies
): Promise<ExecutionTokenBinding> {
  const input = validateBindingInput(unvalidatedInput);
  // Match reusable authorization: validate first, then apply the global emergency pause before
  // hashing, clock access, transaction creation, or any capability-side database mutation.
  assertAutomationCapability({ enabled: true }, dependencies.env);
  const tokenHash = hashExecutionToken(input.rawToken);

  return dependencies.prismaClient.$transaction(async (tx) => {
    const now = resolveServiceNow(dependencies);
    const result = await tx.applicationExecutionToken.updateMany({
      where: {
        tokenHash,
        userId: input.expected.userId,
        runId: input.expected.runId,
        host: input.expected.host,
        scope: input.expected.scope,
        singleUse: true,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now }
      },
      data: { consumedAt: now, lastUsedAt: now }
    });
    if (result.count !== 1) {
      throw invalidExecutionToken();
    }

    const record = await tx.applicationExecutionToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        runId: true,
        host: true,
        scope: true,
        singleUse: true,
        expiresAt: true,
        run: { select: { applicationId: true, jobPostingId: true } }
      }
    });
    if (!record) {
      throw invalidExecutionToken();
    }

    await tx.auditLog.create({
      data: {
        userId: record.userId,
        action: "application-execution-token.consume",
        resource: "ApplicationExecutionToken",
        resourceId: record.id,
        metadata: {
          tokenId: record.id,
          runId: record.runId,
          applicationId: record.run.applicationId,
          jobPostingId: record.run.jobPostingId,
          scope: record.scope,
          host: record.host,
          consumedAt: now.toISOString()
        } as Prisma.InputJsonValue
      }
    });

    return {
      id: record.id,
      userId: record.userId,
      runId: record.runId,
      host: record.host,
      scope: record.scope,
      singleUse: record.singleUse,
      expiresAt: record.expiresAt
    };
  });
}

// ---------------------------------------------------------------------------
// Revocation (ownership-scoped, idempotent, available while automation is disabled)
// ---------------------------------------------------------------------------

export type RevokeExecutionTokenInput = {
  userId: string; // authenticated principal
  tokenId: string;
};

export type RevokeExecutionTokenForRunInput = RevokeExecutionTokenInput & {
  runId: string;
};

export type RevokeExecutionTokenResult = {
  revoked: boolean;
  alreadyRevoked: boolean;
};

// Revokes a token by id for the owning user. A single 404 is returned for both "does not
// exist" and "belongs to another user" (no cross-user existence leak). Revocation sets
// revokedAt (never deletes), is NOT capability-gated, and is idempotent: a second revoke
// matches zero rows and reports alreadyRevoked=true rather than erroring. A revoked token
// fails both reusable authorization and single-use consumption (their predicates require
// revokedAt=null).
async function revokeExecutionTokenWithDependencies(
  unvalidatedInput: RevokeExecutionTokenInput | RevokeExecutionTokenForRunInput,
  dependencies: ResolvedExecutionTokenServiceDependencies,
  runBound: boolean
): Promise<RevokeExecutionTokenResult> {
  const input = validateRevokeInput(unvalidatedInput);
  const runId = runBound ? validateRunBoundRevokeInput(unvalidatedInput).runId : undefined;

  return dependencies.prismaClient.$transaction(async (tx) => {
    const existing = await tx.applicationExecutionToken.findFirst({
      where: { id: input.tokenId, userId: input.userId, ...(runId ? { runId } : {}) },
      select: {
        id: true,
        userId: true,
        runId: true,
        host: true,
        scope: true,
        revokedAt: true,
        run: { select: { applicationId: true, jobPostingId: true } }
      }
    });
    if (!existing) throw executionTokenNotFound();
    if (existing.revokedAt !== null) return { revoked: false, alreadyRevoked: true };

    const now = resolveServiceNow(dependencies);
    const result = await tx.applicationExecutionToken.updateMany({
      where: runId
        ? buildRunBoundRevokeWhere({ userId: input.userId, runId, tokenId: input.tokenId })
        : buildRevokeWhere({ userId: input.userId, tokenId: input.tokenId }),
      data: { revokedAt: now }
    });
    if (result.count === 0) return { revoked: false, alreadyRevoked: true };
    if (result.count !== 1) throw invalidTokenData();

    await tx.auditLog.create({
      data: {
        userId: existing.userId,
        action: "application-execution-token.revoke",
        resource: "ApplicationExecutionToken",
        resourceId: existing.id,
        metadata: {
          tokenId: existing.id,
          runId: existing.runId,
          applicationId: existing.run.applicationId,
          jobPostingId: existing.run.jobPostingId,
          scope: existing.scope,
          host: existing.host,
          revokedAt: now.toISOString()
        } as Prisma.InputJsonValue
      }
    });

    return { revoked: true, alreadyRevoked: false };
  });
}

export type ExecutionTokenRevocationTransaction = Pick<
  Prisma.TransactionClient,
  "applicationExecutionToken" | "auditLog"
>;

async function revokeUsableExecutionTokensInTransaction(
  tx: ExecutionTokenRevocationTransaction,
  input: {
    userId: string;
    now: Date;
    reason: BulkExecutionTokenRevocationReason;
  },
  where: Prisma.ApplicationExecutionTokenWhereInput,
  resource: { name: "User" | "ApplicationRun"; id: string; runId?: string }
): Promise<number> {
  const revoked = await tx.applicationExecutionToken.updateMany({
    where,
    data: { revokedAt: input.now }
  });

  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: "application-execution-token.revoke-bulk",
      resource: resource.name,
      resourceId: resource.id,
      metadata: {
        ...(resource.runId ? { runId: resource.runId } : {}),
        reason: input.reason,
        revokedCount: revoked.count,
        revokedAt: input.now.toISOString()
      } as Prisma.InputJsonValue
    }
  });

  return revoked.count;
}

export function revokeUsableExecutionTokensForUserInTransaction(
  tx: ExecutionTokenRevocationTransaction,
  input: { userId: string; now: Date; reason: "policy_changed" }
): Promise<number> {
  return revokeUsableExecutionTokensInTransaction(
    tx,
    input,
    buildUsableExecutionTokenWhereForUser(input),
    { name: "User", id: input.userId }
  );
}

export function revokeUsableExecutionTokensForRunInTransaction(
  tx: ExecutionTokenRevocationTransaction,
  input: {
    userId: string;
    runId: string;
    now: Date;
    reason: "run_cancelled" | "answer_packet_changed";
  }
): Promise<number> {
  return revokeUsableExecutionTokensInTransaction(
    tx,
    input,
    buildUsableExecutionTokenWhereForRun(input),
    { name: "ApplicationRun", id: input.runId, runId: input.runId }
  );
}

export function createExecutionTokenService(dependencies: ExecutionTokenServiceDependencies = {}) {
  const resolved: ResolvedExecutionTokenServiceDependencies = {
    prismaClient: dependencies.prismaClient ?? prisma,
    clock: dependencies.clock ?? (() => new Date()),
    tokenGenerator: dependencies.tokenGenerator ?? generateExecutionToken,
    env: dependencies.env ?? process.env
  };

  return {
    issueExecutionToken: (input: IssueExecutionTokenInput) => issueExecutionTokenWithDependencies(input, resolved),
    authorizeReusableExecutionToken: (input: ExecutionTokenBindingInput) =>
      authorizeReusableExecutionTokenWithDependencies(input, resolved),
    consumeSingleUseExecutionToken: (input: ExecutionTokenBindingInput) =>
      consumeSingleUseExecutionTokenWithDependencies(input, resolved),
    revokeExecutionToken: (input: RevokeExecutionTokenInput) =>
      revokeExecutionTokenWithDependencies(input, resolved, false),
    revokeExecutionTokenForRun: (input: RevokeExecutionTokenForRunInput) =>
      revokeExecutionTokenWithDependencies(input, resolved, true)
  };
}

const defaultExecutionTokenService = createExecutionTokenService();

export function issueExecutionToken(input: IssueExecutionTokenInput): Promise<IssuedExecutionToken> {
  return defaultExecutionTokenService.issueExecutionToken(input);
}

export function authorizeReusableExecutionToken(input: ExecutionTokenBindingInput): Promise<ExecutionTokenBinding> {
  return defaultExecutionTokenService.authorizeReusableExecutionToken(input);
}

export function consumeSingleUseExecutionToken(input: ExecutionTokenBindingInput): Promise<ExecutionTokenBinding> {
  return defaultExecutionTokenService.consumeSingleUseExecutionToken(input);
}

export function revokeExecutionToken(input: RevokeExecutionTokenInput): Promise<RevokeExecutionTokenResult> {
  return defaultExecutionTokenService.revokeExecutionToken(input);
}

export function revokeExecutionTokenForRun(
  input: RevokeExecutionTokenForRunInput
): Promise<RevokeExecutionTokenResult> {
  return defaultExecutionTokenService.revokeExecutionTokenForRun(input);
}
