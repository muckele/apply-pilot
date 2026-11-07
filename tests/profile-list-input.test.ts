import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { z } from "zod";

import { splitListInput } from "@/lib/profile/list-input";
import { apiErrorResponse } from "@/lib/user-context";

test("a comma or a new line separates list entries", () => {
  assert.deepEqual(
    splitListInput("SMB Account Executive, Mid-Market Account Manager,\nsales enablement\n\n , Solutions consultant", "commas"),
    ["SMB Account Executive", "Mid-Market Account Manager", "sales enablement", "Solutions consultant"]
  );
});

test("locations keep their commas and split only on new lines or semicolons", () => {
  assert.deepEqual(
    splitListInput("New York, NY\nSan Francisco, CA; Remote", "lines"),
    ["New York, NY", "San Francisco, CA", "Remote"]
  );
});

test("the profile form splits roles, industries, deal-breakers and skills on commas, but not locations", () => {
  const form = readFileSync("components/profile-settings-form.tsx", "utf8");
  for (const field of ["preferredRoles", "industriesOfInterest", "dealBreakers", "skillsToEmphasize", "skillsNotToExaggerate"]) {
    assert.match(form, new RegExp(`${field}: splitListInput\\(form\\.${field}, "commas"\\)`), field);
  }
  assert.match(form, /preferredLocations: splitListInput\(form\.preferredLocations, "lines"\)/);
  assert.match(form, /Separate with commas or new lines/);
  assert.match(form, /One per line/);
});

test("a validation error reads as plain English in every environment", async () => {
  const schema = z.object({ preferredRoles: z.array(z.string().max(120)) });
  const result = schema.safeParse({ preferredRoles: ["x".repeat(150)] });
  assert.equal(result.success, false);
  const previous = process.env.NODE_ENV;
  try {
    for (const env of ["development", "production"]) {
      Reflect.set(process.env, "NODE_ENV", env);
      const response = apiErrorResponse(result.error);
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { error: "Preferred roles #1 must be 120 characters or fewer." }, env);
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previous);
  }
});
