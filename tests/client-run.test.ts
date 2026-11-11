import assert from "node:assert/strict";
import test from "node:test";

import { ensureApplicationRun } from "@/lib/application-runs/client-run";
import { PREPARE_BLOCKER_COPY, PREPARE_FAILURE_COPY } from "@/lib/application-runs/blocker-copy";

const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";

function createdResponse(state = "DRAFT", id = RUN_ID) {
  return new Response(JSON.stringify({
    run: { id, applicationId: APPLICATION_ID, state }, replayed: false
  }), { status: 201, headers: { "content-type": "application/json" } });
}

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("ensureApplicationRun keeps its request key until a confirmed run, then clears it", async () => {
  const storage = new MemoryStorage();
  const bodies: Array<{ applicationId: string; idempotencyKey: string }> = [];
  let calls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) throw new Error("connection dropped");
    if (calls === 2) return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
    return createdResponse();
  }) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), (error: Error & { kind?: string }) => error.kind === "uncertain");
  const key = storage.getItem(`application-run-create:${APPLICATION_ID}`);
  assert.match(key ?? "", /^[a-f0-9-]{36}$/);
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), (error: Error & { kind?: string }) => error.kind === "refused");
  assert.deepEqual(await ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), { id: RUN_ID, state: "DRAFT", applyHost: null });
  assert.deepEqual(bodies.map((body) => body.idempotencyKey), [key, key, key]);
  assert.deepEqual(bodies.map((body) => Object.keys(body).sort()), Array(3).fill(["applicationId", "idempotencyKey"]));
  assert.equal(storage.getItem(`application-run-create:${APPLICATION_ID}`), null);
});

test("ensureApplicationRun sends nothing without session storage, and refuses another application's run", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return createdResponse(); }) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage: null }), (error: Error & { kind?: string }) => error.kind === "storage");
  assert.equal(calls, 0);

  const other = (async () => new Response(JSON.stringify({
    run: { id: RUN_ID, applicationId: "clz8w7m9a0009qwer1234tyui", state: "DRAFT" }, replayed: false
  }), { status: 201 })) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: other, storage: new MemoryStorage() }), (error: Error & { kind?: string }) => error.kind === "uncertain");

  // A replay of a run that has since ended is not a run to use: its key is dropped for a fresh request.
  for (const state of ["CANCELLED", "COMPLETED_BY_USER"]) {
    const storage = new MemoryStorage();
    const ended = (async () => createdResponse(state)) as typeof fetch;
    await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: ended, storage }), (error: Error & { kind?: string }) => error.kind === "ended");
    assert.equal(storage.getItem(`application-run-create:${APPLICATION_ID}`), null, state);
  }

  for (const [status, kind] of [[409, "conflict"], [401, "unauthorized"], [403, "unauthorized"]] as const) {
    const refused = (async () => new Response(JSON.stringify({ error: "no" }), { status })) as typeof fetch;
    await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: refused, storage: new MemoryStorage() }), (error: Error & { kind?: string }) => error.kind === kind);
  }
});

test("every blocker and failure category has plain copy, and cost confirmation sends nothing more", () => {
  const reasons = [
    "automation_disabled", "automation_disabled_during_preparation", "host_blocked", "fit_below_threshold",
    "match_confidence_below_threshold", "resume_required", "cover_letter_required",
    "daily_application_cap_reached", "ai_budget_exceeded", "ai_request_cost_limit",
    "ai_cost_confirmation_required", "ai_duplicate_in_progress"
  ] as const;
  for (const reason of reasons) {
    const copy = PREPARE_BLOCKER_COPY[reason];
    assert.ok(copy.text.length > 0, reason);
    assert.doesNotMatch(copy.text, /undefined|unknown error/i, reason);
  }
  assert.match(PREPARE_BLOCKER_COPY.ai_cost_confirmation_required.text, /separate AI cost confirmation\. No additional planner request was sent\./);
  assert.equal(PREPARE_BLOCKER_COPY.ai_cost_confirmation_required.fix, null);
  assert.equal(PREPARE_BLOCKER_COPY.resume_required.fix?.target, "step-3");
  assert.equal(PREPARE_BLOCKER_COPY.cover_letter_required.fix?.target, "step-3");
  for (const text of Object.values(PREPARE_FAILURE_COPY)) assert.doesNotMatch(text, /stack|exception|undefined/i);
  assert.match(PREPARE_FAILURE_COPY.planner_provider_failure, /building the application plan/);
});
