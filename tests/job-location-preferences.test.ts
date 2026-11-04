import assert from "node:assert/strict";
import { test } from "node:test";

import { getPreImportRejectionReason } from "@/lib/job-sources/discovery";
import {
  extractUsStateCodes,
  locationPreferenceMatch,
  preferredLocationsFromProfile
} from "@/lib/job-sources/location-match";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import type { NormalizedJob } from "@/lib/job-sources/types";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    title: "Solutions Engineer",
    company: "Example Co",
    location: "Austin, TX",
    remoteStatus: "On-site",
    sourceUrl: "https://example.com/jobs/1",
    description: "Partner with customers on technical discovery, demos, API integrations, onboarding, SaaS workflows, and training. Requires React, SQL, and AWS.",
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: ["React", "SQL"],
    sourceType: "MANUAL",
    ...overrides
  };
}

function profile(preferredLocations: string[], location = "") {
  return { preferredLocations, location, remotePreference: "FLEXIBLE", preferredRoles: [], skillsToEmphasize: [], dealBreakers: [] } as never;
}

function locationRejected(posting: NormalizedJob, userProfile: never) {
  const relevance = scoreJobRelevance({ job: posting, profile: userProfile });
  return /Location does not match/.test(getPreImportRejectionReason({ job: posting, profile: userProfile, relevance }) ?? "");
}

test("US state codes come from comma-separated segments and full state names", () => {
  assert.deepEqual([...extractUsStateCodes("San Diego, CA")], ["CA"]);
  assert.deepEqual([...extractUsStateCodes("Austin, Texas, United States")], ["TX"]);
  assert.deepEqual([...extractUsStateCodes("Remote in US")], []);
  assert.deepEqual([...extractUsStateCodes("Bengaluru, India")], []);
  assert.deepEqual([...extractUsStateCodes("Seattle, WA; New York, NY")].sort(), ["NY", "WA"]);
  assert.deepEqual([...extractUsStateCodes("Washington, DC")], ["DC"], "Washington DC is not Washington state");
  assert.deepEqual([...extractUsStateCodes("Washington, District of Columbia, United States")], ["DC"]);
});

test("preferred locations come from the profile and exclude work-style words", () => {
  assert.deepEqual(
    preferredLocationsFromProfile({ preferredLocations: ["Austin, TX", "Remote", "Hybrid", "austin, tx"], location: "Round Rock, TX" }),
    ["Austin, TX", "Round Rock, TX"]
  );
  assert.deepEqual(preferredLocationsFromProfile(null), []);
});

test("location matches are exact by city, regional by state, otherwise none", () => {
  assert.equal(locationPreferenceMatch("Austin, TX", ["Austin, TX"]), "exact");
  assert.equal(locationPreferenceMatch("Austin, Texas, United States", ["Austin, TX"]), "exact");
  assert.equal(locationPreferenceMatch("San Francisco, CA; Austin, TX", ["Austin, TX"]), "exact");
  assert.equal(locationPreferenceMatch("Dallas, TX", ["Austin, TX"]), "state");
  assert.equal(locationPreferenceMatch("Texas", ["Austin, TX"]), "state");
  assert.equal(locationPreferenceMatch("Fontana, CA", ["Austin, TX"]), "none");
  assert.equal(locationPreferenceMatch("Toronto, ON", ["Austin, TX"]), "none");
  assert.equal(locationPreferenceMatch("Seattle, WA", ["Washington, DC"]), "none");
  assert.equal(locationPreferenceMatch("CA", ["Los Angeles, CA"]), "state", "a bare state code is regional, not a city match");
});

test("the discovery prefilter follows each user's own locations, not a hard-coded metro", () => {
  const austinUser = profile(["Austin, TX"]);

  assert.equal(locationRejected(job({ location: "Fontana, CA" }), austinUser), true, "no built-in California pass");
  assert.equal(locationRejected(job({ location: "Pasadena, CA" }), austinUser), true);
  assert.equal(locationRejected(job({ location: "Austin, TX" }), austinUser), false);
  assert.equal(locationRejected(job({ location: "Dallas, TX" }), austinUser), false, "same state passes");
  assert.equal(locationRejected(job({ location: "Remote", remoteStatus: "Remote" }), austinUser), false);
  assert.equal(locationRejected(job({ location: "United States" }), austinUser), false);

  const losAngelesUser = profile(["Los Angeles, CA"]);
  assert.equal(locationRejected(job({ location: "San Diego, CA" }), losAngelesUser), false);
  assert.equal(locationRejected(job({ location: "New York, NY" }), losAngelesUser), true);

  const homeOnly = profile([], "Denver, CO");
  assert.equal(locationRejected(job({ location: "Boulder, CO" }), homeOnly), false, "profile home location counts");
  assert.equal(locationRejected(job({ location: "Fontana, CA" }), homeOnly), true);

  assert.equal(locationRejected(job({ location: "Fontana, CA" }), profile([])), false, "no preference never rejects by location");
});

test("relevance location scoring is driven by the user's preferences", () => {
  const score = (location: string, userProfile: never | null) =>
    scoreJobRelevance({ job: job({ location }), profile: userProfile }).breakdown.locationScore;

  const austinUser = profile(["Austin, TX"]);
  assert.equal(score("Austin, TX", austinUser), 100);
  assert.equal(score("Dallas, TX", austinUser), 70);
  assert.equal(score("Fontana, CA", austinUser), 35);
  assert.equal(score("Los Angeles, CA", austinUser), 35, "the owner's metro gets no special treatment");

  assert.equal(score("Fontana, CA", null), 80);
  assert.equal(score("New York, NY", null), 80, "without preferences every location is treated alike");
  assert.equal(score("Remote", austinUser), 100);
});
