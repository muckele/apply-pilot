import assert from "node:assert/strict";
import { test } from "node:test";

import { matchDirectoryBoards, selectBoardsForRun, type JobBoardDirectoryEntry } from "@/lib/job-sources/board-directory";
import { selectBoardImports } from "@/lib/job-sources/board-import-selection";
import { acceptedCountries, locationCountries } from "@/lib/job-sources/location-match";
import { evaluateForImport } from "@/lib/job-sources/prefilter";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import type { NormalizedJob } from "@/lib/job-sources/types";

/**
 * Job-feed relevance (2026-11-05 audit): titles are scored against the user's own roles and
 * target searches, remote/hybrid wording no longer skips the location check, industry tags rank
 * directory boards instead of excluding them, and the per-board cap prefers jobs the user has
 * not seen yet.
 */

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    title: "Product Manager",
    company: "Example Co",
    location: "New York, NY",
    remoteStatus: "Hybrid",
    sourceUrl: "https://example.com/jobs/1",
    description:
      "As a product manager you will own the roadmap, run experimentation with SQL and analytics, partner with stakeholders and customers, and lead user research for our B2B SaaS platform.",
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: [],
    sourceType: "GREENHOUSE",
    datePosted: new Date(),
    ...overrides
  };
}

const productManager = {
  preferredRoles: ["Product Manager", "Senior Product Manager"],
  preferredLocations: ["New York, NY"],
  location: "New York, NY",
  remotePreference: "HYBRID",
  skillsToEmphasize: ["Roadmap", "SQL", "Experimentation", "User research", "Analytics", "Stakeholder management"],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as never;

const remoteEngineer = {
  preferredRoles: ["Software Engineer", "Backend Engineer"],
  preferredLocations: ["Remote"],
  location: "Columbus, OH",
  remotePreference: "REMOTE",
  skillsToEmphasize: ["TypeScript", "React", "Node", "Python", "PostgreSQL", "AWS"],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as never;

const engineeringJob = (overrides: Partial<NormalizedJob>) =>
  job({
    title: "Software Engineer",
    location: "Remote - US",
    remoteStatus: "Remote",
    description:
      "Build backend services in TypeScript, Node and PostgreSQL on AWS, ship React features, design REST APIs, and work with product and customers.",
    ...overrides
  });

function passes(posting: NormalizedJob, profile: never, queries: string[] = []) {
  return evaluateForImport({ job: posting, profile, queries }).passed;
}

// ---- 1. role relevance comes from the user's own roles and searches ----

test("a product manager's feed passes PM titles and drops the old hard-coded sales-engineering roles", () => {
  assert.equal(passes(job({}), productManager, ["product manager"]), true);
  assert.equal(passes(job({ title: "Senior Product Manager, Payments" }), productManager, ["product manager"]), true);
  assert.equal(passes(job({ title: "Group Product Manager" }), productManager, ["product manager"]), true);

  const salesEngineer = job({
    title: "Solutions Engineer",
    description:
      "Partner with customers on technical discovery, demos, API integrations, onboarding and implementation. Work with the product manager on SaaS workflows."
  });
  assert.equal(passes(salesEngineer, productManager, ["product manager"]), false);
  assert.ok(
    scoreJobRelevance({ job: salesEngineer, profile: productManager }).breakdown.roleTitleScore < 45,
    "a title outside the user's roles scores low"
  );
});

test("title scoring needs the role itself, not just a shared generic word", () => {
  const score = (title: string) =>
    scoreJobRelevance({ job: job({ title }), profile: productManager }).breakdown.roleTitleScore;

  assert.ok(score("Product Manager, Growth") >= 90);
  assert.ok(score("Account Manager") < 45, "manager alone is not a product-management title");
  assert.ok(score("Renewals Manager") < 45, "an org word like manager earns no same-kind credit");
  assert.ok(score("Product Partner Manager") < 45, "partner names a different function");
  assert.ok(score("Product Designer") < 45, "product alone is not a product-management title");
});

test("target searches count as roles when the profile lists none", () => {
  const noRoles = { ...(productManager as object), preferredRoles: [] } as never;

  const withSearch = scoreJobRelevance({ job: job({ title: "Customer Success Manager" }), profile: noRoles, queries: ["customer success"] });
  const withoutMatch = scoreJobRelevance({ job: job({ title: "Customer Success Manager" }), profile: noRoles, queries: ["data scientist"] });

  assert.ok(withSearch.breakdown.roleTitleScore >= 90);
  assert.ok(withoutMatch.breakdown.roleTitleScore < 45);
});

test("senior and leadership titles pass only when the user's roles ask for that level", () => {
  const director = job({ title: "Director of Product Management" });
  assert.equal(passes(director, productManager, ["product manager"]), false, "a PM search does not pull in directors");

  const productLeader = { ...(productManager as object), preferredRoles: ["Director of Product", "Head of Product"] } as never;
  assert.equal(passes(director, productLeader, ["director of product"]), true);
  assert.equal(passes(job({ title: "Head of Product" }), productLeader, ["head of product"]), true);

  const staff = engineeringJob({ title: "Staff Software Engineer" });
  assert.equal(passes(staff, remoteEngineer, ["software engineer"]), false, "mid-level search skips staff roles");
  const staffEngineer = { ...(remoteEngineer as object), preferredRoles: ["Staff Software Engineer"] } as never;
  assert.equal(passes(staff, staffEngineer, ["staff software engineer"]), true);

  const manager = engineeringJob({ title: "Engineering Manager, Platform" });
  assert.equal(passes(manager, remoteEngineer, ["software engineer"]), false);
  assert.ok(
    scoreJobRelevance({ job: engineeringJob({ title: "Manager, Software Engineering" }), profile: remoteEngineer }).breakdown.roleTitleScore < 45,
    "a people-manager title is not an individual-contributor match"
  );
  const engineeringManager = { ...(remoteEngineer as object), preferredRoles: ["Engineering Manager"] } as never;
  assert.equal(passes(manager, engineeringManager, ["engineering manager"]), true);

  assert.equal(passes(engineeringJob({ title: "Senior Software Engineer" }), remoteEngineer, ["software engineer"]), true);
});

// ---- 2. remote/hybrid wording no longer skips the location check ----

test("a description that mentions remote or hybrid work does not make a foreign posting pass", () => {
  const remoteFriendly = "We are a remote-friendly team with hybrid flexibility.";

  assert.equal(passes(job({ location: "London, UK", remoteStatus: "", description: `${job({}).description} ${remoteFriendly}` }), productManager), false);
  assert.equal(passes(job({ location: "Toronto, ON", remoteStatus: "On-site", description: `${job({}).description} ${remoteFriendly}` }), productManager), false);
  assert.equal(
    passes(engineeringJob({ location: "Bengaluru, India", remoteStatus: "", description: `${engineeringJob({}).description} ${remoteFriendly}` }), remoteEngineer),
    false
  );
});

test("a remote posting passes only when it is remote in a country the user accepts", () => {
  assert.equal(passes(engineeringJob({ location: "Remote - US" }), remoteEngineer), true);
  assert.equal(passes(engineeringJob({ location: "Remote (United States | Canada)" }), remoteEngineer), true);
  assert.equal(passes(engineeringJob({ location: "Remote" }), remoteEngineer), true, "no country stated: kept");
  assert.equal(passes(engineeringJob({ location: "Remote - Canada" }), remoteEngineer), false);
  assert.equal(passes(engineeringJob({ location: "London", remoteStatus: "Remote" }), remoteEngineer), false);
  assert.equal(passes(engineeringJob({ location: "Remote - United Kingdom" }), remoteEngineer), false);
  assert.equal(passes(engineeringJob({ location: "Remote, Global" }), remoteEngineer), true, "worldwide remote includes the US");

  assert.equal(passes(job({ location: "San Francisco, CA; Remote - Canada", remoteStatus: "" }), productManager), false);
  assert.equal(passes(job({ location: "San Francisco, CA; Remote - US", remoteStatus: "" }), productManager), true);
});

test("hybrid and onsite postings must be in the user's own city or state", () => {
  assert.equal(passes(job({ location: "New York, NY; London, UK" }), productManager), true);
  assert.equal(passes(job({ location: "Hybrid - San Francisco" }), productManager), false);
  assert.equal(passes(job({ location: "Costa Mesa, California, United States", remoteStatus: "" }), productManager), false);
  assert.equal(passes(job({ location: "United States", remoteStatus: "" }), productManager), true, "country-wide posting in the user's country");
  assert.equal(passes(job({ location: "Hybrid", remoteStatus: "" }), productManager), true, "no place named: kept");
});

test("country detection reads states, country names and well-known cities", () => {
  assert.deepEqual([...locationCountries("Austin, TX")], ["US"]);
  assert.deepEqual([...locationCountries("New York, New York, United States")], ["US"]);
  assert.deepEqual([...locationCountries("Bengaluru, IN")], ["IN"], "IN after an Indian city is India, not Indiana");
  assert.deepEqual([...locationCountries("Dublin, CA")], ["US"]);
  assert.deepEqual([...locationCountries("Dublin")], ["IE"]);
  assert.deepEqual([...locationCountries("Toronto, Ontario, Canada")], ["CA"]);
  assert.deepEqual([...locationCountries("San Francisco")], [], "a city the table does not know stays unknown");
  assert.deepEqual([...acceptedCountries(["Remote", "Columbus, OH"])], ["US"]);
  assert.deepEqual([...acceptedCountries(["Remote"])], [], "no country known: no country restriction");
});

// ---- 3. industry tags rank boards instead of excluding them ----

function entry(overrides: Partial<JobBoardDirectoryEntry>): JobBoardDirectoryEntry {
  return {
    company: "Company",
    ats: "GREENHOUSE",
    token: "company",
    industries: ["Hardware"],
    locations: ["Austin, TX"],
    remote: false,
    verifiedAt: "2026-11-03T18:00:00.000Z",
    ...overrides
  };
}

test("boards whose tags miss the user's industries are still matched, ranked after tagged boards", () => {
  const boards = [
    entry({ company: "Hardware Co", token: "hardware" }),
    entry({ company: "SaaS Co", token: "saas", industries: ["SaaS"] })
  ];

  const matches = matchDirectoryBoards(boards, { industries: ["SaaS"], locations: [], remote: false, remoteOnly: false });

  assert.deepEqual(matches.map((match) => [match.entry.company, match.score]), [["SaaS Co", 2], ["Hardware Co", 0]]);
});

test("a capped run visits tag-matched boards first and rotates untagged boards through the remaining slots", () => {
  const ranked = [
    { name: "tagged-1", score: 2 },
    { name: "tagged-2", score: 1 },
    { name: "untagged-1", score: 0 },
    { name: "untagged-2", score: 0 },
    { name: "untagged-3", score: 0 }
  ];
  const visited = new Set<string>();

  for (let day = 0; day < 3; day++) {
    const selection = selectBoardsForRun({
      followed: [],
      directory: ranked,
      maxBoards: 3,
      now: new Date(Date.UTC(2026, 10, 5 + day)),
      priority: (board) => (board.score > 0 ? 1 : 0)
    });
    const names = selection.directory.map((board) => board.name);
    assert.ok(names.includes("tagged-1") && names.includes("tagged-2"), `day ${day}: tagged boards always run`);
    names.forEach((name) => visited.add(name));
  }

  assert.equal(visited.size, 5, "untagged boards are reached across days");
});

// ---- 4. the per-board cap prefers jobs the user has not seen ----

test("already-imported jobs never take the per-board slots from unseen jobs", () => {
  const day = 86_400_000;
  const candidate = (id: string, score: number, ageDays: number, decision = score >= 80 ? "strong" : "review") => ({
    job: job({ sourceUrl: `https://example.com/jobs/${id}`, datePosted: new Date(Date.now() - ageDays * day) }),
    score,
    decision,
    order: Number(id.replace(/\D/g, ""))
  });
  const candidates = [
    candidate("seen1", 95, 20),
    candidate("seen2", 94, 20),
    candidate("new3", 70, 25),
    candidate("new4", 72, 2),
    candidate("new5", 85, 15),
    candidate("new6", 65, 1)
  ];
  const seen = new Set(["https://example.com/jobs/seen1", "https://example.com/jobs/seen2"]);

  const selected = selectBoardImports({ candidates, alreadyImported: (posting) => seen.has(posting.sourceUrl), cap: 3 });
  const urls = selected.map((entry) => entry.job.sourceUrl.split("/").pop());

  assert.deepEqual(
    urls,
    ["seen1", "seen2", "new5", "new4", "new6"],
    "known jobs are refreshed outside the cap; new slots go strong first, then this week's postings, then score"
  );
});

test("a same-kind title in another specialty gets partial credit unless it names another function", () => {
  const score = (title: string) =>
    scoreJobRelevance({ job: engineeringJob({ title }), profile: remoteEngineer }).breakdown.roleTitleScore;

  assert.ok(score("Platform Engineer") >= 45, "an engineering specialty is near a software-engineering search");
  assert.ok(score("Sales Engineer") < 45, "sales names a different function");
  assert.ok(score("Senior Customer Engineer, Strategic") < 45, "customer engineering is a customer-facing function");
  assert.equal(passes(engineeringJob({ location: "NAMER; EMEA" }), remoteEngineer), true, "NAMER covers the US");
});

test("an exact-title posting whose body names two of the user's own skills is not capped for weak evidence", () => {
  const posting = engineeringJob({
    title: "Software Engineer, Payments",
    location: "Remote, USA",
    description:
      "Build and operate scalable payment systems. You have shipped backend services in Python and TypeScript, own them end to end, and coach other engineers."
  });

  assert.equal(passes(posting, remoteEngineer, ["software engineer"]), true);

  const unrelatedBody = engineeringJob({
    title: "Software Engineer",
    description: "Mature ransomware recovery governance. Develop risk heat maps and executive reporting."
  });
  assert.equal(passes(unrelatedBody, remoteEngineer, ["software engineer"]), false, "a title alone still cannot carry a posting");
});
