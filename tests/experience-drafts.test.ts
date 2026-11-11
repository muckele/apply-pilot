import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAllExperienceDrafts,
  clearExperienceDrafts,
  experienceDraftKey,
  readExperienceDrafts,
  writeExperienceDrafts
} from "@/lib/jobs/experience-drafts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear()
  } as Storage;
}

const throwing = {
  get length(): number { throw new Error("blocked"); },
  key: () => { throw new Error("blocked"); },
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
  clear: () => { throw new Error("blocked"); }
} as unknown as Storage;

const drafts = { "Led a team": { line: "I led four engineers.", resumeLine: "Led four engineers" } };

test("key format", () => {
  assert.equal(experienceDraftKey("abcd", "job-1"), "apply-pilot:experience:abcd:job-1");
});

test("round trip", () => {
  const storage = memoryStorage();
  const key = experienceDraftKey("u1", "job-1");
  assert.equal(writeExperienceDrafts(key, drafts, storage), true);
  assert.deepEqual(readExperienceDrafts(key, storage), { drafts, available: true });
  assert.equal(storage.getItem(key), JSON.stringify({ v: 1, drafts }));
  clearExperienceDrafts(key, storage);
  assert.deepEqual(readExperienceDrafts(key, storage), { drafts: {}, available: true });
});

test("throwing storage is unavailable and never throws", () => {
  assert.deepEqual(readExperienceDrafts("k", throwing), { drafts: {}, available: false });
  assert.equal(writeExperienceDrafts("k", drafts, throwing), false);
  clearExperienceDrafts("k", throwing);
  clearAllExperienceDrafts(throwing);
});

test("null storage means none", () => {
  assert.deepEqual(readExperienceDrafts("k", null), { drafts: {}, available: false });
  assert.equal(writeExperienceDrafts("k", drafts, null), false);
  clearAllExperienceDrafts(null);
});

test("unknown version or bad JSON reads as empty", () => {
  const storage = memoryStorage({ a: JSON.stringify({ v: 2, drafts }), b: "{nope" });
  assert.deepEqual(readExperienceDrafts("a", storage), { drafts: {}, available: true });
  assert.deepEqual(readExperienceDrafts("b", storage), { drafts: {}, available: true });
  assert.deepEqual(readExperienceDrafts("missing", storage), { drafts: {}, available: true });
});

test("clearAll removes every draft key and leaves others alone", () => {
  const storage = memoryStorage({
    "apply-pilot:experience:u1:job-1": "x",
    "apply-pilot:experience:u1:job-2": "x",
    "apply-pilot:experience:u2:job-1": "x",
    "apply-pilot:theme": "dark",
    other: "keep"
  });
  clearAllExperienceDrafts(storage);
  assert.equal(storage.length, 2);
  assert.equal(storage.getItem("other"), "keep");
  assert.equal(storage.getItem("apply-pilot:theme"), "dark");
});
