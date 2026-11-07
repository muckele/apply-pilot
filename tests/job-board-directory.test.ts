import assert from "node:assert/strict";
import { test } from "node:test";

import {
  directoryPreferencesFrom,
  loadJobBoardDirectory,
  matchDirectoryBoards,
  parseJobBoardDirectory,
  selectBoardsForRun,
  type JobBoardDirectoryEntry
} from "@/lib/job-sources/board-directory";
import { isValidBoardToken } from "@/lib/job-sources/board-url";

function entry(overrides: Partial<JobBoardDirectoryEntry> = {}): JobBoardDirectoryEntry {
  return {
    company: "Example Co",
    ats: "GREENHOUSE",
    token: "exampleco",
    industries: ["SaaS"],
    locations: ["San Francisco, CA"],
    remote: false,
    verifiedAt: "2026-11-03T18:00:00.000Z",
    ...overrides
  };
}

function file(boards: unknown[]) {
  return { version: 1, boards };
}

test("the committed directory is valid, verified and spread across Greenhouse, Lever and Ashby", () => {
  const directory = loadJobBoardDirectory();

  assert.ok(directory.length >= 40 && directory.length <= 60, `expected 40-60 boards, found ${directory.length}`);
  for (const ats of ["GREENHOUSE", "LEVER", "ASHBY"] as const) {
    assert.ok(directory.filter((board) => board.ats === ats).length >= 5, `${ats} is under-represented`);
  }

  const keys = new Set<string>();
  for (const board of directory) {
    assert.ok(isValidBoardToken(board.ats, board.token), `${board.company} has an invalid token`);
    assert.ok(board.industries.length > 0, `${board.company} has no industries`);
    const verifiedAt = Date.parse(board.verifiedAt);
    assert.ok(Number.isFinite(verifiedAt), `${board.company} has no verification time`);
    assert.ok(verifiedAt <= Date.now(), `${board.company} was verified in the future`);
    const key = `${board.ats}:${board.token.toLowerCase()}`;
    assert.ok(!keys.has(key), `${key} is duplicated`);
    keys.add(key);
  }
});

test("directory parsing rejects duplicates, invalid tokens, unknown fields and missing verification", () => {
  assert.equal(parseJobBoardDirectory(file([entry()])).length, 1);

  const invalid: unknown[] = [
    file([entry(), entry({ company: "Other", token: "EXAMPLECO" })]),
    file([entry({ ats: "ASHBY", token: "Example" }), entry({ ats: "ASHBY", token: "example", company: "Other" })]),
    file([entry({ token: "a/b" })]),
    file([entry({ token: "../v1" })]),
    file([entry({ ats: "WORKABLE" as never })]),
    file([{ ...entry(), recruiterEmail: "someone@example.com" }]),
    file([{ ...entry(), verifiedAt: undefined }]),
    file([entry({ verifiedAt: "yesterday" })]),
    file([entry({ industries: [] })]),
    file([]),
    { version: 2, boards: [entry()] },
    [entry()],
    null
  ];

  for (const value of invalid) {
    assert.throws(() => parseJobBoardDirectory(value), Error, JSON.stringify(value));
  }
});

test("preferences are derived from the profile and saved discovery settings", () => {
  const preferences = directoryPreferencesFrom({
    profile: {
      industriesOfInterest: ["Health tech", " SaaS "],
      preferredLocations: ["Los Angeles, CA", "Remote", "Hybrid"],
      location: "Fontana, CA",
      remotePreference: "FLEXIBLE"
    },
    location: "Pasadena, CA",
    remoteOnly: false
  });

  assert.deepEqual(preferences.industries, ["Health tech", "SaaS"]);
  assert.deepEqual(preferences.locations, ["Pasadena, CA", "Los Angeles, CA", "Fontana, CA"]);
  assert.equal(preferences.remote, true, "a Remote preferred location asks for remote boards");
  assert.equal(preferences.remoteOnly, false);

  const remoteOnly = directoryPreferencesFrom({ profile: null, location: "", remoteOnly: true });
  assert.equal(remoteOnly.remote, true);
  assert.equal(remoteOnly.remoteOnly, true);
});

test("directory boards match by industry synonym, city and remote availability", () => {
  const boards = [
    entry({ company: "Health SaaS", token: "healthsaas", industries: ["Healthcare", "SaaS"], locations: ["New York, NY"] }),
    entry({ company: "LA Payments", token: "lapayments", industries: ["Fintech"], locations: ["Los Angeles, CA"] }),
    entry({ company: "Remote AI", token: "remoteai", industries: ["AI"], locations: ["Remote"], remote: true }),
    entry({ company: "Unrelated", token: "unrelated", industries: ["Hardware"], locations: ["Austin, TX"] })
  ];

  const matches = matchDirectoryBoards(boards, {
    industries: ["health tech"],
    locations: ["Los Angeles, CA"],
    remote: true,
    remoteOnly: false
  });

  assert.deepEqual(matches.map((match) => match.entry.company), ["Health SaaS", "LA Payments", "Remote AI", "Unrelated"]);
  assert.ok(matches[0].reasons.some((reason) => /industry/i.test(reason)));
  assert.ok(matches[1].reasons.some((reason) => /location/i.test(reason)));
  assert.ok(matches[2].reasons.some((reason) => /remote/i.test(reason)));
  assert.equal(matches[3].score, 0, "an untagged board is ranked last, not excluded");

  const artificialIntelligence = matchDirectoryBoards(boards, {
    industries: ["Artificial Intelligence"], locations: [], remote: false, remoteOnly: false
  });
  assert.equal(artificialIntelligence[0].entry.company, "Remote AI");
  assert.ok(artificialIntelligence.slice(1).every((match) => match.score === 0));
});

test("remote-only searches never select boards without remote postings", () => {
  const boards = [
    entry({ company: "Onsite SaaS", token: "onsite", industries: ["SaaS"], remote: false }),
    entry({ company: "Remote SaaS", token: "remotesaas", industries: ["SaaS"], remote: true })
  ];

  const matches = matchDirectoryBoards(boards, { industries: ["SaaS"], locations: [], remote: true, remoteOnly: true });

  assert.deepEqual(matches.map((match) => match.entry.company), ["Remote SaaS"]);
});

test("a user with no industry, location or remote preference is eligible for every directory board", () => {
  const boards = [entry({ token: "one", company: "One" }), entry({ token: "two", company: "Two", ats: "LEVER" })];

  const matches = matchDirectoryBoards(boards, { industries: [], locations: [], remote: false, remoteOnly: false });

  assert.equal(matches.length, 2);
});

test("board selection puts followed boards first, caps the run and rotates the directory across days", () => {
  const followed = [
    { key: "GREENHOUSE:followed-new", lastSyncedAt: null },
    { key: "LEVER:followed-old", lastSyncedAt: new Date("2026-11-01T00:00:00.000Z") },
    { key: "ASHBY:followed-recent", lastSyncedAt: new Date("2026-11-03T00:00:00.000Z") }
  ];
  const directory = Array.from({ length: 10 }, (_, index) => ({ key: `GREENHOUSE:dir-${index}` }));
  const day = 86_400_000;
  const start = Date.parse("2026-11-03T12:00:00.000Z");

  const first = selectBoardsForRun({ followed, directory, maxBoards: 5, now: new Date(start) });
  assert.deepEqual(first.followed.map((board) => board.key), [
    "GREENHOUSE:followed-new",
    "LEVER:followed-old",
    "ASHBY:followed-recent"
  ]);
  assert.equal(first.directory.length, 2);
  assert.equal(first.deferred, 8);

  const seen = new Set<string>();
  for (let offset = 0; offset < 5; offset += 1) {
    const run = selectBoardsForRun({ followed, directory, maxBoards: 5, now: new Date(start + offset * day) });
    assert.equal(run.followed.length + run.directory.length, 5);
    run.directory.forEach((board) => seen.add(board.key));
  }
  assert.equal(seen.size, 10, "five daily runs with two directory slots cover all ten directory boards");

  const sameDay = selectBoardsForRun({ followed, directory, maxBoards: 5, now: new Date(start + 60_000) });
  assert.deepEqual(sameDay.directory.map((board) => board.key), first.directory.map((board) => board.key));

  const capped = selectBoardsForRun({ followed, directory, maxBoards: 2, now: new Date(start) });
  assert.deepEqual(capped.followed.map((board) => board.key), ["GREENHOUSE:followed-new", "LEVER:followed-old"]);
  assert.equal(capped.directory.length, 0);
  assert.equal(capped.deferred, 11);

  const small = selectBoardsForRun({ followed: [], directory: directory.slice(0, 3), maxBoards: 40, now: new Date(start) });
  assert.equal(small.directory.length, 3);
  assert.equal(small.deferred, 0);
});
