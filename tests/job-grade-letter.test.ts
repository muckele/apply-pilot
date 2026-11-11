import assert from "node:assert/strict";
import test from "node:test";
import { gradeLetter, GRADE_EXPLANATION } from "@/lib/jobs/grade";

test("grade letter boundaries", () => {
  const cases: Array<[number | null | undefined, string | null]> = [
    [84, "B"], [85, "A"], [69, "C"], [70, "B"], [54, "D"], [55, "C"],
    [0, "D"], [100, "A"], [101, null], [-1, null], [85.5, null],
    [Number.NaN, null], [null, null], [undefined, null],
  ];
  for (const [score, expected] of cases) {
    assert.equal(gradeLetter(score), expected, String(score));
  }
});

test("grade explanation copy", () => {
  assert.equal(GRADE_EXPLANATION, "Apply Pilot's grade of how well your résumé fits this job. Not the employer's.");
});
