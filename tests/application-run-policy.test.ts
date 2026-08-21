import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  canonicalizePolicyHostEntry,
  hostMatchesPolicyEntry,
  isHostAllowedForExecution,
  isHostBlocked,
  isHostInPolicyList,
  isIpLiteral,
  isPrivateOrLocalHost,
  parseExecutionTargetUrl
} from "@/lib/application-runs/host-policy";
import {
  applicationAutomationPolicyPatchSchema,
  assertAutomationCapability,
  AUTOMATION_POLICY_DEFAULTS,
  isApplicationAutomationEnabled,
  isAutomationAllowed,
  parseAutomationPolicyPatch
} from "@/lib/application-runs/policy";
import { derivePlanReviewReasons, planCommitState } from "@/lib/application-runs/review-reasons";

test("only the exact string 'true' enables the global automation flag", () => {
  assert.equal(isApplicationAutomationEnabled({ APPLICATION_AUTOMATION_ENABLED: "true" }), true);
  for (const value of [undefined, "false", "1", "TRUE", "yes", " true ", "on", "0"]) {
    assert.equal(isApplicationAutomationEnabled({ APPLICATION_AUTOMATION_ENABLED: value }), false, `expected ${String(value)} to fail closed`);
  }
});

test("effective capability requires both the global flag and the per-user policy", () => {
  const enabled = { APPLICATION_AUTOMATION_ENABLED: "true" };
  const disabled = { APPLICATION_AUTOMATION_ENABLED: "false" };

  assert.equal(isAutomationAllowed({ enabled: true }, enabled), true);
  assert.equal(isAutomationAllowed({ enabled: false }, enabled), false);
  assert.equal(isAutomationAllowed({ enabled: true }, disabled), false);
  assert.equal(isAutomationAllowed({ enabled: false }, disabled), false);

  assert.doesNotThrow(() => assertAutomationCapability({ enabled: true }, enabled));
  assert.throws(
    () => assertAutomationCapability({ enabled: false }, enabled),
    (error) => error instanceof PublicApiError && error.status === 403 && error.details?.code === "AUTOMATION_DISABLED"
  );
  assert.throws(
    () => assertAutomationCapability({ enabled: true }, disabled),
    (error) => error instanceof PublicApiError && error.details?.code === "AUTOMATION_DISABLED"
  );
});

test("policy defaults mirror the Prisma schema fail-closed values", () => {
  assert.deepEqual(AUTOMATION_POLICY_DEFAULTS, {
    enabled: false,
    mode: "PREPARE_ONLY",
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    dailyApplicationCap: 5,
    allowedHosts: [],
    blockedHosts: [],
    permittedAdapters: [],
    coverLetterRequired: true,
    sensitiveAnswerPolicy: "EXCLUDE",
    finalReviewRequired: true
  });
});

test("policy validation accepts approved values and canonicalizes hosts", () => {
  const patch = parseAutomationPolicyPatch({
    enabled: true,
    minimumFitScore: 90,
    minimumConfidenceScore: 80,
    dailyApplicationCap: 3,
    allowedHosts: ["Jobs.Example.COM.", "example.com", "example.com"],
    blockedHosts: ["evil.example"],
    permittedAdapters: ["greenhouse"],
    coverLetterRequired: false,
    finalReviewRequired: true
  });

  assert.equal(patch.enabled, true);
  assert.deepEqual(patch.allowedHosts, ["jobs.example.com", "example.com"]);
  assert.deepEqual(patch.blockedHosts, ["evil.example"]);
  assert.equal(patch.finalReviewRequired, true);
});

test("policy validation rejects invalid score, cap, mode, sensitive policy, and review values", () => {
  const invalid = [
    { minimumFitScore: -1 },
    { minimumFitScore: 101 },
    { minimumConfidenceScore: 1.5 },
    { dailyApplicationCap: -1 },
    { dailyApplicationCap: 26 },
    { dailyApplicationCap: 2.5 },
    { mode: "FILL_AND_REVIEW" },
    { sensitiveAnswerPolicy: "ALLOW" },
    { finalReviewRequired: false },
    { unknownField: true }
  ];
  for (const value of invalid) {
    assert.throws(() => applicationAutomationPolicyPatchSchema.parse(value), `expected rejection: ${JSON.stringify(value)}`);
  }
});

test("numeric policy fields fail closed on non-number JSON values (no coercion)", () => {
  const nonNumbers = [null, false, "", "85"];
  for (const value of nonNumbers) {
    for (const field of ["minimumFitScore", "minimumConfidenceScore", "dailyApplicationCap"]) {
      assert.throws(
        () => applicationAutomationPolicyPatchSchema.parse({ [field]: value }),
        `expected ${field} to reject non-number JSON value ${JSON.stringify(value)}`
      );
    }
  }
});

test("policy validation rejects non-canonical host entries and wildcard semantics", () => {
  const invalidHosts = [
    "*.example.com",
    "https://example.com",
    "example.com/path",
    "example.com?q=1",
    "user@example.com",
    "example.com:8443",
    "127.0.0.1",
    "localhost",
    "192.168.1.10",
    "not a host",
    ""
  ];
  for (const host of invalidHosts) {
    assert.throws(
      () => parseAutomationPolicyPatch({ allowedHosts: [host] }),
      (error) => error instanceof PublicApiError && error.status === 422 && error.details?.code === "AUTOMATION_POLICY_INVALID",
      `expected host entry to fail closed: ${JSON.stringify(host)}`
    );
  }
});

test("policy host entries canonicalize case and trailing dot", () => {
  assert.equal(canonicalizePolicyHostEntry("Example.COM"), "example.com");
  assert.equal(canonicalizePolicyHostEntry("example.com."), "example.com");
  assert.equal(canonicalizePolicyHostEntry("  Jobs.Example.com  "), "jobs.example.com");
  assert.equal(canonicalizePolicyHostEntry("*.example.com"), null);
  assert.equal(canonicalizePolicyHostEntry("https://example.com"), null);
});

test("host matching is exact or DNS-label-boundary only", () => {
  assert.equal(hostMatchesPolicyEntry("jobs.example.com", "example.com"), true);
  assert.equal(hostMatchesPolicyEntry("example.com", "example.com"), true);
  assert.equal(hostMatchesPolicyEntry("deep.jobs.example.com", "example.com"), true);
  assert.equal(hostMatchesPolicyEntry("notexample.com", "example.com"), false);
  assert.equal(hostMatchesPolicyEntry("example.com.evil.com", "example.com"), false);
  assert.equal(hostMatchesPolicyEntry("example.com", "ample.com"), false);
  assert.equal(isHostInPolicyList("jobs.example.com", ["other.com", "example.com"]), true);
  assert.equal(isHostInPolicyList("jobs.example.com", ["*"]), false);
});

test("blocked hosts always win over the allowlist", () => {
  const policy = { allowedHosts: ["example.com"], blockedHosts: ["jobs.example.com"] };
  assert.equal(isHostBlocked("jobs.example.com", policy), true);
  assert.equal(isHostAllowedForExecution("jobs.example.com", policy), false);
  assert.equal(isHostAllowedForExecution("www.example.com", policy), true);
});

test("empty allowedHosts denies all execution", () => {
  assert.equal(isHostAllowedForExecution("example.com", { allowedHosts: [], blockedHosts: [] }), false);
  assert.equal(isHostBlocked("anything.example", { blockedHosts: [] }), false);
});

test("execution targets require absolute HTTPS URLs with no userinfo", () => {
  assert.equal(parseExecutionTargetUrl("https://jobs.example.com/apply?id=1")?.host, "jobs.example.com");
  assert.equal(parseExecutionTargetUrl("http://example.com"), null);
  assert.equal(parseExecutionTargetUrl("ftp://example.com"), null);
  assert.equal(parseExecutionTargetUrl("file:///etc/passwd"), null);
  assert.equal(parseExecutionTargetUrl("javascript:alert(1)"), null);
  assert.equal(parseExecutionTargetUrl("data:text/html,<h1>"), null);
  assert.equal(parseExecutionTargetUrl("/relative/path"), null);
  assert.equal(parseExecutionTargetUrl("example.com"), null);
  assert.equal(parseExecutionTargetUrl("https://user:pw@example.com/"), null);
});

test("execution rejects localhost, loopback, private networks, and all IP literals", () => {
  assert.equal(isPrivateOrLocalHost("localhost"), true);
  assert.equal(isPrivateOrLocalHost("app.localhost"), true);
  assert.equal(isPrivateOrLocalHost("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("10.1.2.3"), true);
  assert.equal(isPrivateOrLocalHost("172.16.0.5"), true);
  assert.equal(isPrivateOrLocalHost("172.31.255.255"), true);
  assert.equal(isPrivateOrLocalHost("172.15.0.1"), false);
  assert.equal(isPrivateOrLocalHost("192.168.1.1"), true);
  assert.equal(isPrivateOrLocalHost("169.254.1.1"), true);
  assert.equal(isPrivateOrLocalHost("0.0.0.0"), true);
  assert.equal(isPrivateOrLocalHost("::1"), true);

  assert.equal(isIpLiteral("127.0.0.1"), true);
  assert.equal(isIpLiteral("[::1]"), true);
  assert.equal(isIpLiteral("example.com"), false);

  assert.equal(parseExecutionTargetUrl("https://127.0.0.1/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://[::1]/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://localhost/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://192.168.0.5/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://intranet/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://printer.local/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://metadata.google.internal/apply"), null);
  assert.equal(parseExecutionTargetUrl("https://printer.home.arpa/apply"), null);

  for (const host of ["jobs.example.com", "notlocal.example", "local.example", "internal.example", "home.arpa.attacker.test"]) {
    assert.equal(parseExecutionTargetUrl(`https://${host}/apply`)?.host, host);
  }

  // IP literals stay rejected for execution even when explicitly allowlisted.
  assert.equal(
    isHostAllowedForExecution("127.0.0.1", { allowedHosts: ["127.0.0.1"], blockedHosts: [] }),
    false
  );
});

test("policy hosts reject structurally local DNS names without substring overblocking", () => {
  for (const host of ["intranet", "printer.local", "metadata.google.internal", "printer.home.arpa"]) {
    assert.equal(canonicalizePolicyHostEntry(host), null, host);
  }
  for (const host of ["jobs.example.com", "notlocal.example", "local.example", "internal.example", "home.arpa.attacker.test"]) {
    assert.equal(canonicalizePolicyHostEntry(host), host);
  }
});

test("preparation enforces blocked hosts only and never requires the execution allowlist", () => {
  const policy = { allowedHosts: [], blockedHosts: ["blocked.example"] };
  assert.equal(isHostBlocked("blocked.example", policy), true);
  assert.equal(isHostBlocked("other.example", policy), false);
  // Preparation semantics: not blocked == allowed for preparation purposes.
  assert.equal(isHostInPolicyList("other.example", policy.blockedHosts), false);
});

function reviewSignals(overrides: Partial<Parameters<typeof derivePlanReviewReasons>[0]> = {}) {
  return {
    unknownRequirementIds: [] as string[],
    unknownEvidenceIds: [] as string[],
    exaggeratedEvidenceIds: [] as string[],
    inventedNumericClaims: [] as string[],
    hasEvidenceGaps: false,
    plannerConfidence: 90,
    minimumConfidenceScore: 85,
    ...overrides
  };
}

test("a clean enforced plan produces no review reasons and commits READY", () => {
  assert.deepEqual(derivePlanReviewReasons(reviewSignals()), []);
  assert.equal(planCommitState([]), "READY");
  assert.equal(planCommitState(["evidence_gaps_present"]), "REVIEW_REQUIRED");
});

test("each enforcement signal maps to its deterministic review reason", () => {
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ unknownRequirementIds: ["req-9"] })), ["unknown_requirement_ids"]);
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ unknownEvidenceIds: ["skill-9"] })), ["unknown_evidence_ids"]);
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ exaggeratedEvidenceIds: ["skill-3"] })), ["exaggerated_evidence_removed"]);
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ inventedNumericClaims: ["73%"] })), ["invented_numeric_claims"]);
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ plannerConfidence: 84 })), ["planner_confidence_below_threshold"]);
  assert.deepEqual(derivePlanReviewReasons(reviewSignals({ hasEvidenceGaps: true })), ["evidence_gaps_present"]);
});

test("multiple review reasons are returned in deterministic order", () => {
  const reasons = derivePlanReviewReasons(
    reviewSignals({
      hasEvidenceGaps: true,
      unknownRequirementIds: ["req-9"],
      plannerConfidence: 10,
      inventedNumericClaims: ["73%"],
      unknownEvidenceIds: ["skill-9"],
      exaggeratedEvidenceIds: ["skill-3"]
    })
  );
  assert.deepEqual(reasons, [
    "unknown_requirement_ids",
    "unknown_evidence_ids",
    "exaggerated_evidence_removed",
    "invented_numeric_claims",
    "planner_confidence_below_threshold",
    "evidence_gaps_present"
  ]);
});

test("missing or malformed planner confidence is rejected, never converted to a review reason", () => {
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.throws(
      () => derivePlanReviewReasons(reviewSignals({ plannerConfidence: bad as unknown as number })),
      (error) => error instanceof PublicApiError && error.details?.code === "PLAN_CONFIDENCE_INVALID",
      `expected unusable-confidence rejection for ${String(bad)}`
    );
  }
});
