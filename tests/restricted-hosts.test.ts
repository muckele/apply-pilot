import assert from "node:assert/strict";
import { test } from "node:test";

import { isHostAllowedForExecution, isHostBlocked } from "@/lib/application-runs/host-policy";
import { assertNotProhibitedHost, prohibitedJobBoardHosts } from "@/lib/job-sources/utils";
import { isProhibitedJobBoardHost } from "@/lib/security/restricted-hosts";

test("shared restricted-host policy blocks exact hosts and subdomains", () => {
  assert.equal(isProhibitedJobBoardHost("linkedin.com"), true);
  assert.equal(isProhibitedJobBoardHost("jobs.linkedin.com"), true);
  assert.equal(isProhibitedJobBoardHost("LINKEDIN.COM."), true);
  assert.equal(isProhibitedJobBoardHost("notlinkedin.com"), false);
  assert.equal(isProhibitedJobBoardHost("example.com"), false);
});

test("application automation treats static restrictions as blocked", () => {
  assert.equal(isHostBlocked("jobs.linkedin.com", { blockedHosts: [] }), true);
  assert.equal(isHostBlocked("jobs.example.com", { blockedHosts: [] }), false);
  assert.equal(
    isHostAllowedForExecution("jobs.linkedin.com", {
      allowedHosts: ["linkedin.com"],
      blockedHosts: []
    }),
    false
  );
});

test("job discovery preserves the existing prohibited-host behavior", () => {
  assert.ok(prohibitedJobBoardHosts.includes("linkedin.com"));
  assert.throws(() => assertNotProhibitedHost("https://linkedin.com/jobs/123"), /intentionally blocked/);
  assert.throws(() => assertNotProhibitedHost("https://jobs.linkedin.com/123"), /intentionally blocked/);
  assert.doesNotThrow(() => assertNotProhibitedHost("https://jobs.example.com/123"));
});
