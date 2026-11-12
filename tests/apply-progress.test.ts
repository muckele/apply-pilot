import assert from "node:assert/strict";
import test from "node:test";
import { deriveApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";

const base: ApplyProgressInput = {
  hasMasterResume: true, hasCurrentMatch: true, reviewSaved: true,
  resumeAttached: true, coverAttached: true, coverRequired: true,
  automationAvailable: true, run: null, applied: false,
};
const derive = (o: Partial<ApplyProgressInput>) => deriveApplyProgress({ ...base, ...o });

test("unscored job is step 1", () => {
  const p = derive({ hasCurrentMatch: false, reviewSaved: false });
  assert.equal(p.current, 1);
  assert.equal(p.now, "Check my match");
  assert.equal(p.next, "Your experience");
  assert.deepEqual(p.steps.map((s) => s.state), ["now", ...Array(9).fill("later")]);
});

test("missing master resume holds step 1 with a prompt", () => {
  const p = derive({ hasMasterResume: false, hasCurrentMatch: false });
  assert.equal(p.current, 1);
  assert.equal(p.now, "Add your master résumé first, so Apply Pilot can check your match.");
});

test("scored but unreviewed is step 2", () => {
  const p = derive({ reviewSaved: false });
  assert.equal(p.current, 2);
  assert.equal(p.steps[0].state, "done");
});

test("saved review without documents is step 3", () => {
  const p = derive({ resumeAttached: false, coverAttached: false });
  assert.equal(p.current, 3);
  assert.equal(p.now, "Write my résumé and cover letter, review them");
  assert.equal(p.next, "Prepare");
});

test("cover letter only blocks step 3 when required", () => {
  assert.equal(derive({ coverAttached: false, coverRequired: true }).current, 3);
  assert.equal(derive({ coverAttached: false, coverRequired: false }).current, 4);
});

test("documents attached waits at step 4 until the run is ready", () => {
  assert.equal(derive({}).current, 4);
  assert.equal(derive({ run: { state: "PREPARING", companionState: null } }).current, 4);
});

test("ready run is step 5", () => {
  const p = derive({ run: { state: "READY", companionState: null } });
  assert.equal(p.current, 5);
  assert.equal(p.now, "Continue in the Apply Pilot browser window.");
  assert.equal(p.next, "Open and read the form");
  assert.deepEqual(p.steps.map((s) => s.state), ["done", "done", "done", "done", "now", "later", "later", "later", "later", "later"]);
});

test("a run prepared with things to check is step 5 too", () => {
  // Prepare commits REVIEW_REQUIRED whenever the plan has evidence gaps; the form opens from it.
  assert.equal(derive({ run: { state: "REVIEW_REQUIRED", companionState: null } }).current, 5);
  for (const state of ["DRAFT", "BLOCKED", "FAILED"]) assert.equal(derive({ run: { state, companionState: null } }).current, 4, state);
});

test("applied marks all ten done", () => {
  const p = derive({ applied: true });
  assert.equal(p.current, 10);
  assert.equal(p.next, null);
  assert.equal(p.now, "You applied. Nothing left to do.");
  assert.ok(p.steps.every((s) => s.state === "done"));
  assert.equal(p.steps.length, 10);
});
