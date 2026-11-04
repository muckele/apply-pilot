/**
 * Pure resolver that turns a public Greenhouse, Lever or Ashby board or job URL into the
 * board reference (`ats` + `token`) the public job-board APIs use. It never fetches anything.
 *
 * Only exact, known board hosts are accepted. Tokens are validated per ATS before they are
 * interpolated into an API URL, so a pasted URL can never steer a request to another host
 * or path.
 */

export const boardAtsTypes = ["GREENHOUSE", "LEVER", "ASHBY"] as const;

export type BoardAts = (typeof boardAtsTypes)[number];
export type BoardRegion = "global" | "eu";

export type BoardReference = {
  ats: BoardAts;
  token: string;
  region?: BoardRegion;
};

export type BoardUrlResolution =
  | { ok: true; ats: BoardAts; token: string; region: BoardRegion; kind: "board" | "job" }
  | { ok: false; reason: string };

type HostRule =
  | { ats: BoardAts; region: BoardRegion; layout: "greenhouse-board" | "greenhouse-api" | "lever-board" | "lever-api" | "ashby-board" | "ashby-api" }
  | { unsupported: string };

const maxInputLength = 2048;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const explicitScheme = /^[a-z][a-z0-9+.-]*:/i;

const hostRules: Record<string, HostRule> = {
  "boards.greenhouse.io": { ats: "GREENHOUSE", region: "global", layout: "greenhouse-board" },
  "job-boards.greenhouse.io": { ats: "GREENHOUSE", region: "global", layout: "greenhouse-board" },
  "boards-api.greenhouse.io": { ats: "GREENHOUSE", region: "global", layout: "greenhouse-api" },
  "boards.eu.greenhouse.io": { unsupported: "EU-hosted Greenhouse boards are not supported yet." },
  "job-boards.eu.greenhouse.io": { unsupported: "EU-hosted Greenhouse boards are not supported yet." },
  "jobs.lever.co": { ats: "LEVER", region: "global", layout: "lever-board" },
  "jobs.eu.lever.co": { ats: "LEVER", region: "eu", layout: "lever-board" },
  "api.lever.co": { ats: "LEVER", region: "global", layout: "lever-api" },
  "api.eu.lever.co": { ats: "LEVER", region: "eu", layout: "lever-api" },
  "jobs.ashbyhq.com": { ats: "ASHBY", region: "global", layout: "ashby-board" },
  "api.ashbyhq.com": { ats: "ASHBY", region: "global", layout: "ashby-api" }
};

const tokenPatterns: Record<BoardAts, RegExp> = {
  // Greenhouse and Lever slugs are lowercase; the resolver lowercases them before validation.
  GREENHOUSE: /^[a-z0-9][a-z0-9_-]{0,99}$/,
  LEVER: /^[a-z0-9][a-z0-9_.-]{0,99}$/,
  // Ashby board names keep their case and may contain dots (for example "Kraken.com").
  ASHBY: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
};

const reservedTokens: Record<BoardAts, Set<string>> = {
  GREENHOUSE: new Set(["embed", "v1"]),
  LEVER: new Set(["embed", "v0"]),
  ASHBY: new Set(["embed", "api"])
};

const unsupportedLinkReason =
  "Paste a public Greenhouse (boards.greenhouse.io), Lever (jobs.lever.co) or Ashby (jobs.ashbyhq.com) board or job link.";

function fail(reason: string): BoardUrlResolution {
  return { ok: false, reason };
}

export function isValidBoardToken(ats: BoardAts, token: string) {
  return typeof token === "string" && tokenPatterns[ats].test(token) && !reservedTokens[ats].has(token.toLowerCase());
}

function normalizeToken(ats: BoardAts, token: string) {
  return ats === "ASHBY" ? token : token.toLowerCase();
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function extractToken(
  rule: Extract<HostRule, { ats: BoardAts }>,
  segments: string[],
  searchParams: URLSearchParams
): { token: string | null; kind: "board" | "job" } | null {
  switch (rule.layout) {
    case "greenhouse-board": {
      if (segments[0] === "embed") {
        if (segments[1] !== "job_board" && segments[1] !== "job_app") {
          return null;
        }
        return { token: searchParams.get("for"), kind: segments[1] === "job_app" ? "job" : "board" };
      }
      return { token: segments[0] ?? null, kind: segments[1] === "jobs" && segments[2] ? "job" : "board" };
    }
    case "greenhouse-api": {
      if (segments[0] !== "v1" || segments[1] !== "boards") {
        return null;
      }
      return { token: segments[2] ?? null, kind: segments[3] === "jobs" && segments[4] ? "job" : "board" };
    }
    case "lever-board":
      return { token: segments[0] ?? null, kind: segments[1] ? "job" : "board" };
    case "lever-api": {
      if (segments[0] !== "v0" || segments[1] !== "postings") {
        return null;
      }
      return { token: segments[2] ?? null, kind: segments[3] ? "job" : "board" };
    }
    case "ashby-board":
      return { token: segments[0] ?? null, kind: segments[1] && segments[1] !== "embed" ? "job" : "board" };
    case "ashby-api": {
      if (segments[0] !== "posting-api" || segments[1] !== "job-board") {
        return null;
      }
      return { token: segments[2] ?? null, kind: "board" };
    }
  }
}

export function resolveBoardUrl(input: unknown): BoardUrlResolution {
  if (typeof input !== "string") {
    return fail("Enter a job board URL.");
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return fail("Enter a job board URL.");
  }
  if (trimmed.length > maxInputLength) {
    return fail("That URL is too long to be a job board link.");
  }
  if (controlCharacters.test(trimmed)) {
    return fail("That URL contains invalid characters.");
  }

  let url: URL;
  try {
    url = new URL(explicitScheme.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return fail("That is not a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("Only http and https job board links are supported.");
  }
  if (url.username || url.password) {
    return fail("Job board links must not contain credentials.");
  }
  if (url.port) {
    return fail("Job board links must use the default port.");
  }

  const rule = Object.prototype.hasOwnProperty.call(hostRules, url.hostname) ? hostRules[url.hostname] : undefined;
  if (!rule) {
    if (url.searchParams.has("gh_jid")) {
      return fail(
        "This careers page embeds a Greenhouse board. Open the job's application link and paste the boards.greenhouse.io or job-boards.greenhouse.io URL instead."
      );
    }
    return fail(unsupportedLinkReason);
  }
  if ("unsupported" in rule) {
    return fail(rule.unsupported);
  }

  const segments: string[] = [];
  for (const raw of url.pathname.split("/").filter(Boolean)) {
    const decoded = decodeSegment(raw);
    if (decoded === null) {
      return fail("That URL has an invalid path.");
    }
    segments.push(decoded);
  }

  const extracted = extractToken(rule, segments, url.searchParams);
  if (!extracted?.token) {
    return fail(`That ${rule.ats.toLowerCase()} link does not include a company board name.`);
  }

  const token = normalizeToken(rule.ats, extracted.token.trim());
  if (!isValidBoardToken(rule.ats, token)) {
    return fail("That link does not contain a valid company board name.");
  }

  return { ok: true, ats: rule.ats, token, region: rule.region, kind: extracted.kind };
}

function assertValidReference(reference: BoardReference) {
  if (!boardAtsTypes.includes(reference.ats) || !isValidBoardToken(reference.ats, reference.token)) {
    throw new Error("Invalid job board token.");
  }
}

export function boardApiUrl(reference: BoardReference) {
  assertValidReference(reference);
  const token = encodeURIComponent(reference.token);

  switch (reference.ats) {
    case "GREENHOUSE":
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
    case "LEVER":
      return `https://${reference.region === "eu" ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${token}?mode=json`;
    case "ASHBY":
      return `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`;
  }
}

export function boardPageUrl(reference: BoardReference) {
  assertValidReference(reference);
  const token = encodeURIComponent(reference.token);

  switch (reference.ats) {
    case "GREENHOUSE":
      return `https://boards.greenhouse.io/${token}`;
    case "LEVER":
      return `https://${reference.region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co"}/${token}`;
    case "ASHBY":
      return `https://jobs.ashbyhq.com/${token}`;
  }
}

export function isBoardAts(value: unknown): value is BoardAts {
  return typeof value === "string" && (boardAtsTypes as readonly string[]).includes(value);
}

/** Lever's EU data center is the only regional variant; it is recorded in the source's base URL. */
export function boardRegionFromBaseUrl(baseUrl: string | null | undefined): BoardRegion {
  if (!baseUrl) {
    return "global";
  }

  const resolution = resolveBoardUrl(baseUrl);
  return resolution.ok ? resolution.region : "global";
}
