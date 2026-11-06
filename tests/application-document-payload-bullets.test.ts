import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApplicationDocumentPayload, spaceGluedBulletMarkers } from "@/lib/ai/resume-tailoring-payload";

test("a bullet glyph glued to its text gets its space back; other text is unchanged", () => {
  assert.equal(spaceGluedBulletMarkers("Wayfair\n•Started in sales\n  ▪Led pilots\n• Already spaced\n◦◦Nested"), "Wayfair\n• Started in sales\n  ▪ Led pilots\n• Already spaced\n◦◦ Nested");
  assert.equal(spaceGluedBulletMarkers("-5% churn\n*Note\nRevenue •grew"), "-5% churn\n*Note\nRevenue •grew");
});

test("the application-document payload spaces glued bullets in every résumé text and protected excerpt", () => {
  const payload = buildApplicationDocumentPayload(
    { title: "AE" },
    {
      rawText: "Sam\nEXPERIENCE\nWayfair\n•Closed 38 accounts.",
      summary: "Seller.",
      skills: ["Gong"],
      achievements: ["•Top five of 400+ advisors."],
      workHistory: [{ sourceText: "Wayfair\n•Closed 38 accounts.", company: "Wayfair", title: "AE", bullets: ["Closed 38 accounts."] }],
      projects: [],
      education: [],
      certifications: []
    },
    null,
    null,
    { citations: [{ ref: "resume.achievements[0]", excerpt: "•Top five of 400+ advisors." }] }
  );
  assert.equal(payload.resume?.rawText, "Sam\nEXPERIENCE\nWayfair\n• Closed 38 accounts.");
  assert.deepEqual(payload.resume?.achievements, ["• Top five of 400+ advisors."]);
  assert.equal((payload.resume?.workHistory as Array<{ sourceText: string }>)[0]!.sourceText, "Wayfair\n• Closed 38 accounts.");
  assert.deepEqual(payload.protectedEvidence, { citations: [{ ref: "resume.achievements[0]", excerpt: "• Top five of 400+ advisors." }] });
});
