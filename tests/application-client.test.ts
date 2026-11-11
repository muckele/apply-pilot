import assert from "node:assert/strict";
import { test } from "node:test";

import { attachDocuments, ensureApplication } from "@/lib/applications/client";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("ensureApplication posts SAVED", async () => {
  const calls: Call[] = [];
  const result = await ensureApplication("job-1", fakeFetch(200, { application: { id: "app-1" } }, calls));
  assert.deepEqual(result, { id: "app-1" });
  assert.equal(calls[0].url, "/api/applications");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { jobPostingId: "job-1", status: "SAVED" });
});

test("ensureApplication throws the server message on failure", async () => {
  await assert.rejects(
    ensureApplication("job-1", fakeFetch(404, { error: "Job posting not found." }, [])),
    /Job posting not found\./u
  );
});

test("attachDocuments sends no status", async () => {
  const calls: Call[] = [];
  await attachDocuments("app-1", { resumeVersionId: "resume-1" }, fakeFetch(200, { application: {} }, calls));
  assert.equal(calls[0].url, "/api/applications/app-1");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { resumeVersionId: "resume-1" });
});

test("attachDocuments sends both documents and throws on failure", async () => {
  const calls: Call[] = [];
  await attachDocuments("app-1", { resumeVersionId: "r", coverLetterVersionId: "c" }, fakeFetch(200, {}, calls));
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { resumeVersionId: "r", coverLetterVersionId: "c" });
  await assert.rejects(attachDocuments("app-1", { resumeVersionId: "r" }, fakeFetch(500, {}, [])), /could not/iu);
});
