import assert from "node:assert/strict";
import test from "node:test";

import { feedHref, feedWhere, parseFeedFilters, sortFeedItems } from "@/lib/jobs/feed-query";

test("filters parse from the URL and ignore values the feed does not offer", () => {
  assert.deepEqual(parseFeedFilters({}), {
    q: "", location: "", workStyle: "", salary: false, seniority: "", postedWithin: 0, sort: "relevant",
    source: "", status: "", company: "", roleType: "", minFitScore: 0, job: ""
  });
  const parsed = parseFeedFilters({
    q: " operations ", location: "Seattle", workStyle: "Remote", salary: "listed", seniority: "Director",
    datePosted: "7", sort: "newest", source: "GREENHOUSE", status: "ACTIVE", minFitScore: "60", job: "job-9"
  });
  assert.equal(parsed.q, "operations");
  assert.equal(parsed.salary, true);
  assert.equal(parsed.postedWithin, 7);
  assert.equal(parsed.sort, "newest");
  assert.equal(parsed.minFitScore, 60);
  assert.equal(parsed.job, "job-9");
  const rejected = parseFeedFilters({ workStyle: "Moon", seniority: "Wizard", datePosted: "-3", sort: "random", source: "LINKEDIN", minFitScore: "500" });
  assert.equal(rejected.workStyle, "");
  assert.equal(rejected.seniority, "");
  assert.equal(rejected.postedWithin, 0);
  assert.equal(rejected.sort, "relevant");
  assert.equal(rejected.source, "");
  assert.equal(rejected.minFitScore, 0);
});

test("chip links toggle one filter, keep the others, and drop the selected job", () => {
  const filters = parseFeedFilters({ q: "operations", workStyle: "Remote", job: "job-1" });
  assert.equal(feedHref(filters, { workStyle: "" }), "/jobs?q=operations");
  assert.equal(feedHref(filters, { salary: true }), "/jobs?q=operations&workStyle=Remote&salary=listed");
  assert.equal(feedHref(filters, { sort: "relevant" }), "/jobs?q=operations&workStyle=Remote");
  assert.equal(feedHref(filters, { postedWithin: 3 }), "/jobs?q=operations&workStyle=Remote&datePosted=3");
});

test("selecting a job keeps every filter", () => {
  const filters = parseFeedFilters({ q: "operations", sort: "salary" });
  assert.equal(feedHref(filters, { job: "job-2" }, { keepJob: true }), "/jobs?q=operations&sort=salary&job=job-2");
});

test("the where clause stays scoped to the user and covers the new filters", () => {
  const where = feedWhere("user-1", parseFeedFilters({ location: "Seattle", salary: "listed", seniority: "Senior", datePosted: "3", workStyle: "Remote" }), new Date("2026-11-05T00:00:00.000Z"));
  assert.equal(where.userId, "user-1");
  const text = JSON.stringify(where);
  assert.match(text, /"location":\{"contains":"Seattle","mode":"insensitive"\}/u);
  assert.match(text, /"salaryMin":\{"not":null\}/u);
  assert.match(text, /"seniorityLevel":\{"contains":"Senior","mode":"insensitive"\}/u);
  assert.match(text, /"datePosted":\{"gte":"2026-11-02T00:00:00.000Z"\}/u);
  assert.match(text, /"remoteStatus":\{"contains":"Remote","mode":"insensitive"\}/u);
});

test("most relevant puts Apply Pilot's estimates first, then newer jobs", () => {
  const items = [
    { id: "a", score: null, posted: new Date("2026-11-04"), salaryTop: null },
    { id: "b", score: 54, posted: new Date("2026-10-01"), salaryTop: 125_000 },
    { id: "c", score: 81, posted: new Date("2026-10-30"), salaryTop: 180_000 },
    { id: "d", score: null, posted: new Date("2026-11-05"), salaryTop: 155_000 }
  ];
  assert.deepEqual(sortFeedItems(items, "relevant").map((item) => item.id), ["c", "b", "d", "a"]);
  assert.deepEqual(sortFeedItems(items, "newest").map((item) => item.id), ["d", "a", "c", "b"]);
  assert.deepEqual(sortFeedItems(items, "salary").map((item) => item.id), ["c", "d", "b", "a"]);
});
