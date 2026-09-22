import { PublicApiError } from "@/lib/api-errors";
import { isProhibitedJobBoardHost } from "@/lib/security/restricted-hosts";

// ---------------------------------------------------------------------------
// Static host classification (no DNS, no network)
// ---------------------------------------------------------------------------

export function isIpLiteral(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(bare)) return true; // IPv4 literal
  return bare.includes(":"); // IPv6 literal (bracket-stripped by URL parsers or by us)
}

export function isPrivateOrLocalHost(host: string): boolean {
  const bare = (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "::" || bare === "0:0:0:0:0:0:0:1") return true;
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) {
    if (!bare.includes(".")) return true;
    return ["local", "internal", "home.arpa"].some(
      (suffix) => bare === suffix || bare.endsWith(`.${suffix}`)
    );
  }
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, loopback, 10/8
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// A. Policy host entries (hostnames only — never URLs)
// ---------------------------------------------------------------------------

// Policy entries represent hostnames. Rejects wildcard syntax, URL schemes, userinfo,
// paths/query/fragments, ports, IP literals, and localhost/local targets.
export function canonicalizePolicyHostEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) return null; // URL schemes are not valid policy entries
  if (trimmed.includes("*")) return null; // no wildcard syntax
  if (trimmed.includes("@")) return null; // no userinfo
  if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) return null;
  if (trimmed.includes(":")) return null; // no ports and no IPv6 literals
  const host = normalizeHostname(trimmed);
  if (!host) return null;
  if (isIpLiteral(host) || isPrivateOrLocalHost(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null; // require a public-style hostname
  const validLabels = labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  return validLabels ? host : null;
}

// ---------------------------------------------------------------------------
// B. Execution target URLs (absolute HTTPS required — protocol is never discarded)
// ---------------------------------------------------------------------------

export type ExecutionTarget = {
  url: URL;
  host: string;
};

// Parses an execution target. Requires an absolute HTTPS URL; http://example.com is
// never equivalent to https://example.com. Rejects other schemes (including
// javascript:/data:/file:), relative URLs, userinfo, localhost, loopback,
// private-network targets, and all IP literals.
export function parseExecutionTargetUrl(value: string): ExecutionTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null; // relative URLs and unparseable input
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = normalizeHostname(url.hostname);
  if (!host) return null;
  if (isIpLiteral(host) || isPrivateOrLocalHost(host)) return null;
  return { url, host };
}

// ---------------------------------------------------------------------------
// C. Label-boundary matching (exact or subdomain; never substring/wildcard)
// ---------------------------------------------------------------------------

export function hostMatchesPolicyEntry(host: string, policyEntry: string): boolean {
  const normalizedHost = normalizeHostname(host);
  const canonicalEntry = canonicalizePolicyHostEntry(policyEntry);
  if (!normalizedHost || canonicalEntry === null) return false;
  return normalizedHost === canonicalEntry || normalizedHost.endsWith(`.${canonicalEntry}`);
}

export function isHostInPolicyList(host: string, entries: string[]): boolean {
  return entries.some((entry) => hostMatchesPolicyEntry(host, entry));
}

// ---------------------------------------------------------------------------
// D. Policy evaluation (blocked always wins; empty allowedHosts denies all execution)
// ---------------------------------------------------------------------------

export type HostPolicy = {
  allowedHosts: string[];
  blockedHosts: string[];
};

export function isHostBlocked(host: string, policy: Pick<HostPolicy, "blockedHosts">): boolean {
  const normalizedHost = normalizeHostname(host);
  return isProhibitedJobBoardHost(normalizedHost) || isHostInPolicyList(normalizedHost, policy.blockedHosts);
}

export function isHostAllowedForExecution(host: string, policy: HostPolicy): boolean {
  const normalizedHost = normalizeHostname(host);
  if (!normalizedHost) return false;
  if (isIpLiteral(normalizedHost) || isPrivateOrLocalHost(normalizedHost)) return false;
  if (isHostBlocked(normalizedHost, policy)) return false; // blockedHosts always wins
  if (policy.allowedHosts.length === 0) return false; // deny all when empty
  return isHostInPolicyList(normalizedHost, policy.allowedHosts);
}

// Preparation is intentionally narrower than execution: it enforces blockedHosts only
// and never requires the execution allowlist. The future execution-token issuance path
// must use assertExecutionHostAllowed instead.
export function assertPreparationHostAllowed(host: string, policy: Pick<HostPolicy, "blockedHosts">): void {
  const normalizedHost = normalizeHostname(host);
  if (!normalizedHost || isHostBlocked(normalizedHost, policy)) {
    throw new PublicApiError("This application run target host is blocked by the automation policy.", 403, {
      code: "RUN_HOST_BLOCKED"
    });
  }
}

export function assertExecutionHostAllowed(host: string, policy: HostPolicy): void {
  if (!isHostAllowedForExecution(host, policy)) {
    throw new PublicApiError("This host is not allowed for browser execution by the automation policy.", 403, {
      code: "RUN_HOST_NOT_ALLOWED"
    });
  }
}
