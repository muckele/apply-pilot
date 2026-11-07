import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";
import type { NextRequest } from "next/server";

import { readApplyReturnRecord } from "@/lib/applications/apply-return";
import { loadApplyReturnReminders } from "@/lib/applications/apply-return-reminders";
import { loadApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

// "Did you apply?" end to end on the disposable PostgreSQL database: the real apply-return route
// and "I applied" route, the JSON-path timeline reads behind the Apply Kit and the dashboard
// reminder, and owner isolation. Synthetic users, companies and URLs only.

async function invokeRoute(path: string, handler: () => Promise<Response>) {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: path } as never, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "action", headers: new Headers(), cookies: {} } as never, handler));
}

function jobData(userId: string, key: string) {
  const url = `https://jobs.example.test/apply/${key}`;
  return {
    userId,
    title: "Synthetic Support Engineer",
    normalizedTitle: `synthetic-support-engineer-${key}`,
    company: "Synthetic Example Co",
    normalizedCompany: `synthetic-example-co-${key}`,
    location: "Remote",
    normalizedLocation: `remote-${key}`,
    sourceUrl: url,
    applyUrl: url,
    normalizedApplyUrl: url,
    description: "Disposable Did you apply? fixture.",
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: [],
    missingKeywords: [],
    supportedKeywords: [],
    concerns: [],
    sourceType: "MANUAL" as const
  };
}

test("'Did you apply?' records, reminds, archives, undoes and closes through the real routes and database", { timeout: 60_000 }, async () => {
  const config = validatePostgresTestEnvironment(process.env);
  assertPostgresTestMajorVersion(await verifyLivePostgresTestDatabase(config));
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const owner = await client.user.create({ data: { email: `apply-return-${randomUUID()}@example.test`, name: "Synthetic Apply Return Owner" } });
  const other = await client.user.create({ data: { email: `apply-return-other-${randomUUID()}@example.test`, name: "Synthetic Other User" } });
  const priorEnv = {
    ALLOW_DEMO_USER: process.env.ALLOW_DEMO_USER,
    DEFAULT_DEMO_USER_ID: process.env.DEFAULT_DEMO_USER_ID,
    AUTH_SECRET: process.env.AUTH_SECRET
  };
  const priorAsyncLocalStorage = globalThis.AsyncLocalStorage;
  Object.assign(process.env, { ALLOW_DEMO_USER: "true", DEFAULT_DEMO_USER_ID: owner.id, AUTH_SECRET: "synthetic-apply-return-local-secret" });
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  try {
    const key = randomUUID();
    const job = await client.jobPosting.create({ data: jobData(owner.id, key) });
    const second = await client.jobPosting.create({ data: { ...jobData(owner.id, `second-${key}`), company: "Synthetic Second Co" } });
    const otherJob = await client.jobPosting.create({ data: jobData(other.id, `other-${key}`) });
    const { POST: applyReturn } = await import("../../app/api/jobs/[id]/apply-return/route");
    const { POST: recordApplication } = await import("../../app/api/applications/route");
    const act = (jobId: string, action: string) => invokeRoute(`/api/jobs/${jobId}/apply-return`, () => applyReturn(new Request(`http://localhost/api/jobs/${jobId}/apply-return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    }) as NextRequest, { params: Promise.resolve({ id: jobId }) }));
    const kit = (jobId: string, userId = owner.id) => loadApplyKitView(client, { userId, jobId, aiGenerationAvailable: false });

    // Opening an unsaved job's application saves it as Saved (never Applied) with the opened moment.
    const opened = await act(job.id, "OPENED");
    assert.equal(opened.status, 200, await opened.clone().text());
    const openedBody = await opened.json();
    const application = await client.application.findUniqueOrThrow({
      where: { userId_jobPostingId: { userId: owner.id, jobPostingId: job.id } },
      include: { events: true }
    });
    assert.equal(application.status, "SAVED");
    assert.equal(application.dateApplied, null);
    assert.equal(readApplyReturnRecord(application.events[0]?.metadata)?.kind, "OPENED");
    assert.equal(openedBody.opened.eventId, application.events[0]?.id);

    // The JSON-path reads find the open question for the owner only.
    assert.equal((await kit(job.id))?.applyReturn.pending?.openedEventId, application.events[0]?.id);
    assert.equal(await kit(job.id, other.id), null);
    assert.equal((await act(second.id, "OPENED")).status, 200);
    const reminders = await loadApplyReturnReminders(client, { userId: owner.id });
    assert.equal(reminders.count, 2);
    assert.deepEqual(reminders.items.map((item) => item.jobId).sort(), [job.id, second.id].sort());
    assert.deepEqual(await loadApplyReturnReminders(client, { userId: other.id }), { count: 0, items: [] });

    // Another user cannot touch the owner's job, and the owner cannot touch theirs.
    assert.equal((await act(otherJob.id, "OPENED")).status, 404);
    assert.equal(await client.application.count({ where: { jobPostingId: otherJob.id } }), 0);

    // "Not applying" archives application and posting; undo restores both and reopens the question.
    assert.equal((await act(job.id, "NOT_APPLYING")).status, 200);
    assert.equal((await client.application.findUniqueOrThrow({ where: { id: application.id } })).status, "ARCHIVED");
    assert.equal((await client.jobPosting.findUniqueOrThrow({ where: { id: job.id } })).status, "ARCHIVED");
    const declinedKit = await kit(job.id);
    assert.equal(declinedKit?.applyReturn.pending, null);
    assert.ok(declinedKit?.applyReturn.declined);
    assert.equal((await loadApplyReturnReminders(client, { userId: owner.id })).count, 1);
    assert.equal((await act(job.id, "UNDO_NOT_APPLYING")).status, 200);
    assert.equal((await client.application.findUniqueOrThrow({ where: { id: application.id } })).status, "SAVED");
    assert.equal((await client.jobPosting.findUniqueOrThrow({ where: { id: job.id } })).status, "ACTIVE");
    assert.ok((await kit(job.id))?.applyReturn.pending);

    // "Yes" is the unchanged "I applied" route; afterwards the question is closed everywhere.
    const applied = await invokeRoute("/api/applications", () => recordApplication(new Request("http://localhost/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobPostingId: job.id, status: "APPLIED", effortMinutes: 23 })
    }) as NextRequest));
    assert.equal(applied.status, 200, await applied.clone().text());
    assert.equal((await client.application.findUniqueOrThrow({ where: { id: application.id } })).status, "APPLIED");
    assert.equal((await kit(job.id))?.applyReturn.pending, null);
    const after = await loadApplyReturnReminders(client, { userId: owner.id });
    assert.deepEqual(after.items.map((item) => item.jobId), [second.id]);
    assert.equal((await act(job.id, "NOT_APPLYING")).status, 409);
  } finally {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.AsyncLocalStorage = priorAsyncLocalStorage;
    await client.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await client.$disconnect();
  }
});
