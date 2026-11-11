import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The technical reference is what people and agents read before touching Fill, so it must say
// where the Assisted Fill switch is now (D035 D-B), not where the removed application-page panels had it.
test("the automation reference says where the Assisted Fill switch lives now", () => {
  const doc = readFileSync(new URL("../docs/CONTROLLED_APPLICATION_AUTOMATION.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc, /Pretrial setup panel|switch on the application page/u);
  const start = doc.indexOf("### Assisted Fill switch");
  const section = doc.slice(start, doc.indexOf("\n### ", start + 1));
  assert.match(section, /step 8/u, "turned on at the control page's step 8");
  assert.match(section, /Settings ▸ Answer Vault/u, "turned off in Settings");
  assert.match(section, /turns off automatically when a run is completed or cancelled/u);
});
