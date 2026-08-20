import assert from "node:assert/strict";
import test from "node:test";

import {
  type JobDiscoveryPreferences,
  resolveDiscoveryLocation,
  resolveDiscoveryQueries,
  resolveInitialJobDiscoveryPreferences
} from "@/lib/job-sources/discovery-preferences";
import { automatedJobDiscoverySchema } from "@/lib/validators";

function preference(overrides: Partial<JobDiscoveryPreferences> = {}): JobDiscoveryPreferences {
  return {
    targetSearches: ["Customer Success Manager"],
    location: "Remote",
    limitPerQuery: 11,
    remoteOnly: true,
    scoreImported: true,
    ...overrides
  };
}

test("saved discovery preferences beat profile defaults", () => {
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: preference(),
    profile: {
      preferredRoles: ["Backend Engineer"],
      preferredLocations: ["Austin, TX"],
      location: "Portland, OR"
    }
  });

  assert.deepEqual(result, preference());
});

test("empty saved searches remain authoritative", () => {
  const savedPreference = preference({ targetSearches: [] });

  assert.deepEqual(
    resolveInitialJobDiscoveryPreferences({
      savedPreference,
      profile: { preferredRoles: ["Backend Engineer"] }
    }).targetSearches,
    []
  );
  assert.deepEqual(
    resolveDiscoveryQueries({
      savedPreference,
      profilePreferredRoles: ["Backend Engineer"]
    }),
    []
  );
});

test("blank saved location remains authoritative", () => {
  const savedPreference = preference({ location: "" });
  const profile = {
    preferredLocations: ["Austin, TX"],
    location: "Portland, OR"
  };

  assert.equal(
    resolveInitialJobDiscoveryPreferences({ savedPreference, profile }).location,
    ""
  );
  assert.equal(
    resolveDiscoveryLocation({ savedPreference, profile }),
    ""
  );
});

test("new users fall back to their profile roles and preferred location", () => {
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: null,
    profile: {
      preferredRoles: [" Backend Engineer ", "Backend Engineer", "Solutions Architect"],
      preferredLocations: [" Austin, TX "],
      location: "Portland, OR"
    }
  });

  assert.deepEqual(result, {
    targetSearches: ["Backend Engineer", "Solutions Architect"],
    location: "Austin, TX",
    limitPerQuery: 8,
    remoteOnly: false,
    scoreImported: false
  });
});

test("new users fall back to their primary profile location", () => {
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: null,
    profile: {
      preferredRoles: [],
      preferredLocations: [],
      location: " Portland, OR "
    }
  });

  assert.equal(result.location, "Portland, OR");
});

test("new users without a profile receive neutral preferences", () => {
  assert.deepEqual(
    resolveInitialJobDiscoveryPreferences({
      savedPreference: null,
      profile: null
    }),
    {
      targetSearches: [],
      location: "",
      limitPerQuery: 8,
      remoteOnly: false,
      scoreImported: false
    }
  );
});

test("explicit supplied queries beat saved and profile queries", () => {
  assert.deepEqual(
    resolveDiscoveryQueries({
      suppliedQueries: [" Solutions Consultant ", "Solutions Consultant", "solutions consultant"],
      savedPreference: preference(),
      profilePreferredRoles: ["Backend Engineer"]
    }),
    ["Solutions Consultant", "solutions consultant"]
  );
});

test("an explicit empty query list remains empty", () => {
  assert.deepEqual(
    resolveDiscoveryQueries({
      suppliedQueries: [],
      savedPreference: preference(),
      profilePreferredRoles: ["Backend Engineer"]
    }),
    []
  );
});

test("explicit supplied location beats saved and profile locations", () => {
  assert.equal(
    resolveDiscoveryLocation({
      suppliedLocation: " Seattle, WA ",
      savedPreference: preference({ location: "Austin, TX" }),
      profile: {
        preferredLocations: ["Portland, OR"],
        location: "Denver, CO"
      }
    }),
    "Seattle, WA"
  );
});

test("an explicit blank location remains blank", () => {
  assert.equal(
    resolveDiscoveryLocation({
      suppliedLocation: "",
      savedPreference: preference({ location: "Austin, TX" }),
      profile: {
        preferredLocations: ["Portland, OR"],
        location: "Denver, CO"
      }
    }),
    ""
  );
});

test("saved initial strings are trimmed and exact duplicates are removed", () => {
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: preference({
      targetSearches: [" Sales Engineer ", "Sales Engineer", "sales engineer"],
      location: " Austin, TX "
    }),
    profile: null
  });

  assert.deepEqual(result.targetSearches, ["Sales Engineer", "sales engineer"]);
  assert.equal(result.location, "Austin, TX");
});

test("profile-derived initial searches are capped at sixteen", () => {
  const preferredRoles = Array.from({ length: 18 }, (_, index) => `Profile Role ${index + 1}`);
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: null,
    profile: { preferredRoles }
  });

  assert.deepEqual(result.targetSearches, preferredRoles.slice(0, 16));
});

test("legacy saved initial searches are capped at sixteen without profile fallback", () => {
  const targetSearches = Array.from({ length: 18 }, (_, index) => `Saved Role ${index + 1}`);
  const result = resolveInitialJobDiscoveryPreferences({
    savedPreference: preference({ targetSearches }),
    profile: { preferredRoles: ["Profile Role"] }
  });

  assert.deepEqual(result.targetSearches, targetSearches.slice(0, 16));
});

test("the discovery validator rejects an empty query list with the intended message", () => {
  const result = automatedJobDiscoverySchema.safeParse({
    queries: [],
    location: "",
    remoteOnly: false,
    limitPerQuery: 8,
    scoreImported: false,
    maxJobsToScore: 6
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => issue.message === "Enter at least one target search."));
  }
});

test("the discovery validator trims strings, preserves blank location, and applies defaults", () => {
  const result = automatedJobDiscoverySchema.parse({
    queries: ["  Solutions Engineer  "],
    location: "   "
  });

  assert.deepEqual(result, {
    queries: ["Solutions Engineer"],
    location: "",
    remoteOnly: false,
    limitPerQuery: 8,
    scoreImported: false,
    maxJobsToScore: 6
  });
});

test("the discovery validator rejects more than sixteen queries", () => {
  const queries = Array.from({ length: 17 }, (_, index) => `Role ${index + 1}`);

  assert.equal(automatedJobDiscoverySchema.safeParse({ queries }).success, false);
});

test("the discovery validator rejects invalid query lengths", () => {
  assert.equal(automatedJobDiscoverySchema.safeParse({ queries: [" a "] }).success, false);
  assert.equal(automatedJobDiscoverySchema.safeParse({ queries: ["a".repeat(121)] }).success, false);
});

test("the discovery validator rejects invalid per-search limits", () => {
  assert.equal(
    automatedJobDiscoverySchema.safeParse({ queries: ["Valid Role"], limitPerQuery: 0 }).success,
    false
  );
  assert.equal(
    automatedJobDiscoverySchema.safeParse({ queries: ["Valid Role"], limitPerQuery: 26 }).success,
    false
  );
  assert.equal(
    automatedJobDiscoverySchema.safeParse({ queries: ["Valid Role"], limitPerQuery: 1.5 }).success,
    false
  );
});
