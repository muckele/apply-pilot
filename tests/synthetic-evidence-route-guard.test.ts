import assert from "node:assert/strict";
import test from "node:test";

import SyntheticEvidenceCorrectionPage from "@/app/(synthetic)/synthetic-evidence-correction/page";

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else Reflect.set(process.env, name, value);
}

test("the correction preview returns the Next 404 boundary in production even when its preview flag is enabled", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPreviewFlag = process.env.APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW;

  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    Reflect.set(process.env, "APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW", "true");
    assert.throws(
      () => SyntheticEvidenceCorrectionPage(),
      (error: unknown) => (
        error instanceof Error &&
        Reflect.get(error, "digest") === "NEXT_HTTP_ERROR_FALLBACK;404"
      )
    );
  } finally {
    restoreEnvironment("NODE_ENV", previousNodeEnv);
    restoreEnvironment("APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW", previousPreviewFlag);
  }
});
