import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalAiUnavailableError } from "@/lib/ai/client";
import { scoreJobMatch } from "@/lib/ai/job-match";
import { evaluatePreparationGates } from "@/lib/application-runs/preparation";

test("main's unscored local match cannot unlock Human-Submit preparation", async () => {
  const priorMockMode = process.env.OPENAI_MOCK_MODE;
  process.env.OPENAI_MOCK_MODE = "true";
  let fitScore: number | null = null;
  const matchConfidence: number | null = null;
  try {
    await assert.rejects(
      scoreJobMatch({
        job: {
          title: "Synthetic Engineer",
          company: "Synthetic Employer",
          description: "Local synthetic role for preparation-gate verification."
        }
      }),
      LocalAiUnavailableError
    );
  } finally {
    if (priorMockMode === undefined) delete process.env.OPENAI_MOCK_MODE;
    else process.env.OPENAI_MOCK_MODE = priorMockMode;
  }

  const gates = {
    hostBlocked: false,
    fitScore,
    matchConfidence,
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    resumeSelectable: true,
    coverLetterRequired: false,
    coverLetterSelectable: false
  };
  assert.equal(evaluatePreparationGates(gates), "fit_below_threshold");
  fitScore = 90;
  assert.equal(
    evaluatePreparationGates({ ...gates, fitScore, matchConfidence }),
    "match_confidence_below_threshold"
  );
});
