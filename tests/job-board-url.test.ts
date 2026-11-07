import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardApiUrl,
  boardPageUrl,
  isValidBoardToken,
  resolveBoardUrl,
  type BoardUrlResolution
} from "@/lib/job-sources/board-url";

function resolved(input: unknown) {
  const result = resolveBoardUrl(input);
  assert.equal(result.ok, true, `expected ${String(input)} to resolve: ${result.ok ? "" : result.reason}`);
  return result as Extract<BoardUrlResolution, { ok: true }>;
}

function rejected(input: unknown) {
  const result = resolveBoardUrl(input);
  assert.equal(result.ok, false, `expected ${String(input)} to be rejected`);
  const failure = result as Extract<BoardUrlResolution, { ok: false }>;
  assert.ok(failure.reason.length > 0);
  return failure;
}

test("Greenhouse board and job URLs on both board hosts resolve to the board token", () => {
  const cases: Array<[string, "board" | "job"]> = [
    ["https://boards.greenhouse.io/stripe", "board"],
    ["https://boards.greenhouse.io/stripe/", "board"],
    ["https://boards.greenhouse.io/stripe?gh_src=abc123", "board"],
    ["https://boards.greenhouse.io/stripe/jobs/6312345", "job"],
    ["https://boards.greenhouse.io/stripe/jobs/6312345?gh_jid=6312345#app", "job"],
    ["https://job-boards.greenhouse.io/stripe", "board"],
    ["https://job-boards.greenhouse.io/stripe/jobs/6312345", "job"],
    ["http://boards.greenhouse.io/stripe", "board"],
    ["boards.greenhouse.io/stripe/jobs/1", "job"],
    ["  https://boards.greenhouse.io/stripe  ", "board"],
    ["https://BOARDS.GREENHOUSE.IO/Stripe", "board"]
  ];

  for (const [url, kind] of cases) {
    const result = resolved(url);
    assert.equal(result.ats, "GREENHOUSE", url);
    assert.equal(result.token, "stripe", url);
    assert.equal(result.kind, kind, url);
    assert.equal(result.region, "global", url);
  }
});

test("Greenhouse embed and API URLs resolve from their documented token positions", () => {
  assert.deepEqual(
    pick(resolved("https://boards.greenhouse.io/embed/job_board?for=airbnb")),
    { ats: "GREENHOUSE", token: "airbnb", kind: "board" }
  );
  assert.deepEqual(
    pick(resolved("https://boards.greenhouse.io/embed/job_board/js?for=airbnb")),
    { ats: "GREENHOUSE", token: "airbnb", kind: "board" }
  );
  assert.deepEqual(
    pick(resolved("https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=7012345")),
    { ats: "GREENHOUSE", token: "airbnb", kind: "job" }
  );
  assert.deepEqual(
    pick(resolved("https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true")),
    { ats: "GREENHOUSE", token: "airbnb", kind: "board" }
  );
  assert.deepEqual(
    pick(resolved("https://boards-api.greenhouse.io/v1/boards/airbnb/jobs/7012345")),
    { ats: "GREENHOUSE", token: "airbnb", kind: "job" }
  );
});

test("Lever global and EU board and job URLs resolve to the site name and region", () => {
  assert.deepEqual(pick(resolved("https://jobs.lever.co/palantir")), { ats: "LEVER", token: "palantir", kind: "board" });
  assert.deepEqual(
    pick(resolved("https://jobs.lever.co/palantir/3f1b2c4d-1111-2222-3333-444455556666")),
    { ats: "LEVER", token: "palantir", kind: "job" }
  );
  assert.deepEqual(
    pick(resolved("https://jobs.lever.co/palantir/3f1b2c4d-1111-2222-3333-444455556666/apply?lever-source=x")),
    { ats: "LEVER", token: "palantir", kind: "job" }
  );
  assert.deepEqual(
    pick(resolved("https://jobs.lever.co/palantir?department=Engineering&team=Backend")),
    { ats: "LEVER", token: "palantir", kind: "board" }
  );
  assert.deepEqual(
    pick(resolved("https://api.lever.co/v0/postings/palantir?mode=json")),
    { ats: "LEVER", token: "palantir", kind: "board" }
  );

  const eu = resolved("https://jobs.eu.lever.co/example-eu/3f1b2c4d-1111-2222-3333-444455556666");
  assert.equal(eu.ats, "LEVER");
  assert.equal(eu.token, "example-eu");
  assert.equal(eu.region, "eu");
  assert.equal(eu.kind, "job");
  assert.equal(resolved("https://api.eu.lever.co/v0/postings/example-eu").region, "eu");
  assert.equal(resolved("https://jobs.lever.co/palantir").region, "global");
});

test("Ashby board, job, application and API URLs resolve to the board name", () => {
  assert.deepEqual(pick(resolved("https://jobs.ashbyhq.com/openai")), { ats: "ASHBY", token: "openai", kind: "board" });
  assert.deepEqual(
    pick(resolved("https://jobs.ashbyhq.com/openai/0b1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff")),
    { ats: "ASHBY", token: "openai", kind: "job" }
  );
  assert.deepEqual(
    pick(resolved("https://jobs.ashbyhq.com/openai/0b1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff/application")),
    { ats: "ASHBY", token: "openai", kind: "job" }
  );
  assert.deepEqual(
    pick(resolved("https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true")),
    { ats: "ASHBY", token: "ramp", kind: "board" }
  );
  assert.equal(resolved("https://jobs.ashbyhq.com/Kraken.com").token, "Kraken.com", "Ashby names keep their case and dots");
});

test("hostile and malformed inputs are rejected with a reason", () => {
  const hostile: unknown[] = [
    undefined,
    null,
    42,
    { href: "https://boards.greenhouse.io/stripe" },
    "",
    "   ",
    `https://boards.greenhouse.io/${"a".repeat(3000)}`,
    "javascript:alert(1)//boards.greenhouse.io/stripe",
    "data:text/html,boards.greenhouse.io/stripe",
    "file:///boards.greenhouse.io/stripe",
    "ftp://boards.greenhouse.io/stripe",
    "https://boards.greenhouse.io.evil.example/stripe",
    "https://evil.example/boards.greenhouse.io/stripe",
    "https://evil.example/?next=https://boards.greenhouse.io/stripe",
    "https://boards.greenhouse.io@evil.example/stripe",
    "https://user:secret@boards.greenhouse.io/stripe",
    "https://boards.greenhouse.io:8443/stripe",
    "https://boards.greenhouse.io./stripe",
    "https://xn--boards-greenhouse-io.example/stripe",
    "https://boards.greenhouse.іo/stripe",
    "https://greenhouse.io/stripe",
    "https://www.lever.co/palantir",
    "https://lever.co/palantir",
    "https://ashbyhq.com/openai",
    "https://jobs.ashbyhq.com.attacker.example/openai",
    "https://boards.greenhouse.io/",
    "https://boards.greenhouse.io/embed/job_board",
    "https://boards.greenhouse.io/embed/job_board?for=",
    "https://boards.greenhouse.io/embed/job_board?for=../../v1",
    "https://boards.greenhouse.io/%2e%2e%2fv1",
    "https://boards.greenhouse.io/stripe%2Fjobs%3Fx%3D1",
    "https://boards.greenhouse.io/stripe%00",
    "https://boards.greenhouse.io/str ipe",
    "https://boards.greenhouse.io/str\nipe",
    "https://boards.greenhouse.io/<script>",
    `https://boards.greenhouse.io/${"a".repeat(101)}`,
    "https://boards-api.greenhouse.io/v2/boards/stripe/jobs",
    "https://boards-api.greenhouse.io/v1/stripe",
    "https://jobs.lever.co/",
    "https://api.lever.co/v1/postings/palantir",
    "https://api.lever.co/v0/palantir",
    "https://jobs.ashbyhq.com/",
    "https://api.ashbyhq.com/posting-api/openai",
    "https://jobs.ashbyhq.com/-leading-dash",
    "https://stripe.com/jobs/listing/solutions-engineer/6312345?gh_jid=6312345",
    "https://www.linkedin.com/jobs/view/123",
    "not a url at all"
  ];

  for (const input of hostile) {
    rejected(input);
  }
});

test("EU-hosted Greenhouse boards are rejected with an explicit unsupported reason", () => {
  const failure = rejected("https://job-boards.eu.greenhouse.io/example/jobs/1");
  assert.match(failure.reason, /EU/);
});

test("a careers page that only carries gh_jid explains how to find the board link", () => {
  const failure = rejected("https://example.com/careers?gh_jid=6312345");
  assert.match(failure.reason, /boards\.greenhouse\.io/);
});

test("token validation is per ATS and rejects path and query characters", () => {
  assert.equal(isValidBoardToken("GREENHOUSE", "stripe"), true);
  assert.equal(isValidBoardToken("GREENHOUSE", "andurilindustries"), true);
  assert.equal(isValidBoardToken("GREENHOUSE", "Stripe"), false, "Greenhouse tokens are stored lowercase");
  assert.equal(isValidBoardToken("LEVER", "shield-ai"), true);
  assert.equal(isValidBoardToken("ASHBY", "Kraken.com"), true);
  for (const ats of ["GREENHOUSE", "LEVER", "ASHBY"] as const) {
    for (const bad of ["", "a/b", "a?b", "a#b", "..", ".", "a b", "a%2fb", "-a", "a".repeat(101), "embed"]) {
      assert.equal(isValidBoardToken(ats, bad), false, `${ats} ${bad}`);
    }
  }
});

test("API and page URLs are built only from validated tokens", () => {
  assert.equal(
    boardApiUrl({ ats: "GREENHOUSE", token: "stripe" }),
    "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true"
  );
  assert.equal(boardApiUrl({ ats: "LEVER", token: "palantir" }), "https://api.lever.co/v0/postings/palantir?mode=json");
  assert.equal(
    boardApiUrl({ ats: "LEVER", token: "example-eu", region: "eu" }),
    "https://api.eu.lever.co/v0/postings/example-eu?mode=json"
  );
  assert.equal(
    boardApiUrl({ ats: "ASHBY", token: "openai" }),
    "https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true"
  );
  assert.equal(boardPageUrl({ ats: "GREENHOUSE", token: "stripe" }), "https://boards.greenhouse.io/stripe");
  assert.equal(boardPageUrl({ ats: "LEVER", token: "example-eu", region: "eu" }), "https://jobs.eu.lever.co/example-eu");
  assert.equal(boardPageUrl({ ats: "ASHBY", token: "openai" }), "https://jobs.ashbyhq.com/openai");
  assert.throws(() => boardApiUrl({ ats: "GREENHOUSE", token: "../v1/boards/x" }), /token/i);
  assert.throws(() => boardApiUrl({ ats: "ASHBY", token: "a/b" }), /token/i);
});

test("a resolved board page URL round-trips through the resolver", () => {
  for (const reference of [
    { ats: "GREENHOUSE", token: "stripe" },
    { ats: "LEVER", token: "palantir" },
    { ats: "LEVER", token: "example-eu", region: "eu" },
    { ats: "ASHBY", token: "Kraken.com" }
  ] as const) {
    const result = resolved(boardPageUrl(reference));
    assert.equal(result.ats, reference.ats);
    assert.equal(result.token, reference.token);
    assert.equal(result.region, "region" in reference ? reference.region : "global");
  }
});

function pick(result: Extract<BoardUrlResolution, { ok: true }>) {
  return { ats: result.ats, token: result.token, kind: result.kind };
}
