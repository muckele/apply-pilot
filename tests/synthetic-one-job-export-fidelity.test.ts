import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { SYNTHETIC_ONE_JOB_FIXTURE } from "@/evaluation/synthetic-one-job-fixture";
import {
  buildSyntheticOneJobExportFidelityEvidence,
  type SyntheticExportFidelityArtifact
} from "@/evaluation/synthetic-one-job-export-fidelity";

function nonBlankLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertExactRoundTrip(artifact: SyntheticExportFidelityArtifact) {
  assert.equal(artifact.bytes.subarray(0, 2).toString("utf8"), "PK");
  assert.equal(artifact.extractedContent, artifact.previewContent);
  assert.equal(artifact.extractedContentHash, artifact.previewContentHash);
  assert.deepEqual(nonBlankLines(artifact.productionExtractedText), nonBlankLines(artifact.previewContent));
  assert.deepEqual(artifact.missingCriticalFacts, []);
}

test("synthetic application documents survive canonical DOCX export and re-extraction exactly", async () => {
  const evidence = await buildSyntheticOneJobExportFidelityEvidence(SYNTHETIC_ONE_JOB_FIXTURE);

  assert.deepEqual(evidence.artifacts.map((artifact) => artifact.fileName), [
    "synthetic-one-job-resume.docx",
    "synthetic-one-job-cover-letter.docx",
    "synthetic-one-job-long-unicode-resume.docx"
  ]);
  for (const artifact of evidence.artifacts) assertExactRoundTrip(artifact);

  const resume = evidence.artifacts[0];
  for (const fact of [
    "Built source-backed workflows with TypeScript and SQL.",
    "PROJECTS",
    "Bachelor of Arts in Business Administration — Example University",
    "Synthetic Technical Program — 480 hours"
  ]) {
    assert.match(resume.extractedContent, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const coverLetter = evidence.artifacts[1];
  assert.match(coverLetter.extractedContent, /Sincerely,\nSynthetic Candidate$/);

  const longUnicode = evidence.artifacts[2];
  assert.ok(longUnicode.previewPageCount >= 2);
  assert.match(longUnicode.extractedContent, /Café résumé · naïve validation · São Paulo/);
  assert.match(longUnicode.extractedContent, /Continuation evidence 48/);

  const outputDirectory = process.env.SYNTHETIC_EXPORT_FIDELITY_DIR;
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    for (const artifact of evidence.artifacts) {
      await writeFile(path.join(outputDirectory, artifact.fileName), artifact.bytes);
    }
    await writeFile(
      path.join(outputDirectory, "synthetic-one-job-export-fidelity.json"),
      `${JSON.stringify(evidence.manifest, null, 2)}\n`,
      "utf8"
    );
  }
});
