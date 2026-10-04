import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import { getJobMatchEvidenceReferences } from "@/lib/ai/job-match";
import {
  assembleAndValidateResumeV7,
  buildResumeParseGeminiProviderV7JsonSchema,
  buildResumeParseProviderV7JsonSchema,
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION,
  RESUME_PARSE_PROMPT_VERSION
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInput } from "@/lib/ai/resume-source-catalog";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { resumeParsePromptV7 } from "@/prompts/resumeParsePrompt";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV7FromCanonical } from "@/tests/fixtures/resume-v7-provider-data";

const HISTORICAL_V6_REQUEST_HASH = "de2e64078a993b8b31daf7908e6ba24b8ad72fc424c064f55566f50df77399b0";
const HISTORICAL_V6_SCHEMA_HASH = "08a6b93669e1c0ff2b5487193a5d9a69bf40cc817cbe3daa7064e2b6304c054d";
const EXPECTED_V7_REQUEST_HASH = "bd4092d4a5144ba809da86e871dbab4c612f49d991d74952fda04336eaf0710c";
const EXPECTED_V7_SCHEMA_HASH = "2e8764c96ef1e4c1b13f828bc5fc72a7a1bdae4bb480a224a222c7f6a59656f4";
const HOSTED_RUNTIME_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "VERCEL_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE"
] as const;

async function loadDiagnosticModule() {
  const loaded = await import("@/lib/ai/gemini-resume-v7-diagnostic").catch(() => null);
  assert.ok(loaded, "the distinct v7 diagnostic module must exist");
  return loaded;
}

async function withLocalRuntime<T>(operation: () => Promise<T>) {
  const previous = new Map(HOSTED_RUNTIME_KEYS.map((key) => [key, process.env[key]]));
  HOSTED_RUNTIME_KEYS.forEach((key) => delete process.env[key]);
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function providerEnvelope(
  value: unknown,
  usage = {
    promptTokenCount: 4_000,
    candidatesTokenCount: 7_500,
    thoughtsTokenCount: 100,
    totalTokenCount: 11_600
  }
) {
  return JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: JSON.stringify(value) }] }
    }],
    usageMetadata: usage
  });
}

test("builds a separately pinned v7 request with exact production request parity", async () => {
  const diagnostic = await loadDiagnosticModule();
  const request = diagnostic.buildPinnedGeminiResumeV7DiagnosticRequest(
    fullSizeSyntheticDocxExtractedText
  );
  const payload = buildResumeProviderSourceInput(fullSizeSyntheticDocxExtractedText);
  const canonicalSchema = buildResumeParseProviderV7JsonSchema(payload);
  const wireSchema = buildResumeParseGeminiProviderV7JsonSchema(payload);
  const expectedBody = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV7,
    payload,
    responseJsonSchema: wireSchema,
    maxOutputTokens: 24_000,
    thinkingLevel: "LOW"
  });

  assert.equal(request.contractVersion, "7");
  assert.equal(request.promptVersion, RESUME_PARSE_PROMPT_VERSION);
  assert.equal(request.cacheVersion, RESUME_PARSE_CACHE_VERSION);
  assert.equal(request.wireSchemaVersion, RESUME_PARSE_GEMINI_WIRE_SCHEMA_VERSION);
  assert.equal(request.promptVersion, "9");
  assert.equal(request.cacheVersion, "10");
  assert.equal(request.wireSchemaVersion, "4");
  assert.equal(request.maximumInputTokens, 12_000);
  assert.equal(request.maximumOutputTokens, 24_000);
  assert.equal(request.maximumCostMicros, 63_600);
  assert.equal(request.responseBodyLimitBytes, 65_536);
  assert.equal(request.timeoutMs, 180_000);
  assert.equal(request.sourceHash.length, 64);
  assert.equal(request.requestHash, EXPECTED_V7_REQUEST_HASH);
  assert.equal(request.schemaHash, EXPECTED_V7_SCHEMA_HASH);
  assert.notEqual(request.requestHash, HISTORICAL_V6_REQUEST_HASH);
  assert.notEqual(request.schemaHash, HISTORICAL_V6_SCHEMA_HASH);
  assert.equal(request.requestBodyBytes, Buffer.byteLength(request.bodyJson));
  assert.equal(request.requestBodyBytes, 18_739);
  assert.equal(request.schemaBytes,
    Buffer.byteLength(JSON.stringify(expectedBody.generationConfig.responseJsonSchema)));
  assert.deepEqual(JSON.parse(request.bodyJson), expectedBody);
  assert.equal(request.schemaBytes, 3_475);
  assert.doesNotMatch(request.bodyJson, /recordSpans|startLineId|endLineId|spanIndex/u);
  assert.match(request.bodyJson, /recordId/u);
  assert.ok(Buffer.byteLength(JSON.stringify(canonicalSchema)) > request.schemaBytes);
});

test("runs exactly one v7 request and validates record authority plus every consumer", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = providerV7FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );
  const approved = diagnostic.buildPinnedGeminiResumeV7DiagnosticRequest(
    fullSizeSyntheticDocxExtractedText
  );
  let calls = 0;
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV7Diagnostic(
    "synthetic-secret",
    {
      resumeText: fullSizeSyntheticDocxExtractedText,
      fetchImpl: async (_input: unknown, init: RequestInit | undefined) => {
        calls += 1;
        assert.equal(init?.body, approved.bodyJson);
        assert.equal(init?.redirect, "error");
        return new Response(providerEnvelope(output), { status: 200 });
      }
    }
  ));

  assert.equal(calls, 1);
  assert.equal(result.outcome, "validated");
  assert.equal(result.validation.contractVersion, "7");
  assert.equal(result.validation.recordAuthority, "server_owned");
  assert.equal(result.validation.structuralRecordCount, 10);
  assert.equal(result.validation.applicationPlan, "passed");
  assert.equal(result.validation.jobMatch, "passed");
  assert.equal(result.validation.tailoring, "passed");
  assert.doesNotMatch(JSON.stringify(result), /Taylor Boundary|taylor\.boundary@example\.test/);
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(output)));
});

test("rejects returned usage beyond the pinned token or cost reservation", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = providerV7FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );
  let calls = 0;
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV7Diagnostic(
    "synthetic-secret",
    {
      resumeText: fullSizeSyntheticDocxExtractedText,
      fetchImpl: async () => {
        calls += 1;
        return new Response(providerEnvelope(output, {
          promptTokenCount: 12_001,
          candidatesTokenCount: 24_000,
          thoughtsTokenCount: 1,
          totalTokenCount: 36_002
        }), { status: 200 });
      }
    }
  ));

  assert.equal(calls, 1);
  assert.equal(result.outcome, "invalid_response");
  assert.equal(result.category, "USAGE_LIMIT_EXCEEDED");
  assert.equal(result.finishReason, "STOP");
  assert.deepEqual(result.usage, {
    inputTokens: 12_001,
    outputTokens: 24_001,
    cachedInputTokens: 0,
    visibleOutputTokens: 24_000,
    thinkingTokens: 1
  });
});

test("proves every canonical consumer path and explicit bounded omission", async () => {
  const diagnostic = await loadDiagnosticModule();
  const validated = assembleAndValidateResumeV7(
    fullSizeSyntheticDocxExtractedText,
    providerV7FromCanonical(
      fullSizeSyntheticDocxExtractedText,
      fullSizeSyntheticProviderOutput()
    )
  );
  const resume = { ...validated, rawText: fullSizeSyntheticDocxExtractedText };
  const job = {
    title: "Synthetic Systems Engineer",
    company: "Synthetic Boundary Labs",
    description: "Build reliable TypeScript systems with structured data and test automation.",
    requirements: ["TypeScript", "structured data", "test automation"],
    preferredQualifications: ["Cloud systems"],
    detectedTechStack: ["TypeScript"]
  };
  const plan = buildApplicationPlanPayload({ job, resume });
  const evidence = new Map(plan.evidenceCatalog.map((entry) => [entry.id, entry.text]));
  const omissions = new Map(plan.projectionOmissions.map((entry) => [entry.sourcePath, entry]));
  const refs = getJobMatchEvidenceReferences({ job, resume });
  const tailoringPayload = buildResumeTailoringPayload(job, resume, null);
  const tailoring = tailoringPayload.resume;

  validated.workHistory.slice(0, 4).forEach((_, index) => {
    assert.ok(evidence.has(`work-${index + 1}`));
    assert.ok(refs.applicant.includes(`resume.workHistory[${index}]`));
  });
  assert.deepEqual(omissions.get("resume.workHistory"), {
    sourcePath: "resume.workHistory",
    omittedIds: ["work-5"],
    omittedCount: 1,
    truncatedIds: []
  });
  assert.ok(validated.projects[0]!.bullets[0]!.startsWith(
    evidence.get("project-1-highlight-1") ?? "missing"
  ));
  assert.ok(omissions.get("resume.projects[0].highlights")?.truncatedIds.includes(
    "project-1-highlight-1"
  ));
  assert.match(evidence.get("education-2") ?? "", /Bachelor of Arts — Business Administration/u);
  assert.match(evidence.get("certification-1-detail-1") ?? "", /SYN-OPS-6403/u);
  assert.deepEqual(tailoring, {
    rawText: resume.rawText,
    summary: validated.summary,
    skills: validated.skills,
    achievements: validated.achievements,
    workHistory: validated.workHistory.map((record) => ({
      sourceText: record.sourceText,
      company: record.company,
      title: record.title,
      location: record.location,
      startDate: record.startDate,
      endDate: record.endDate,
      bullets: record.bullets
    })),
    projects: validated.projects.map((record) => ({
      sourceText: record.sourceText,
      name: record.name,
      description: record.description,
      date: record.date,
      technologies: record.technologies,
      bullets: record.bullets
    })),
    education: validated.education.map((record) => ({
      sourceText: record.sourceText,
      institution: record.institution,
      credential: record.credential,
      fieldOfStudy: record.fieldOfStudy,
      startDate: record.startDate,
      endDate: record.endDate,
      details: record.details
    })),
    certifications: validated.certifications.map((record) => ({
      sourceText: record.sourceText,
      name: record.name,
      issuer: record.issuer,
      date: record.date,
      expirationDate: record.expirationDate,
      details: record.details
    }))
  });
  assert.equal(diagnostic.assertResumeDiagnosticConsumerCoverage(
    fullSizeSyntheticDocxExtractedText,
    validated,
    { plan, refs, tailoring: tailoringPayload }
  ), plan.projectionOmissions.length);
});

test("fails ambiguous source segmentation before transport", async () => {
  const diagnostic = await loadDiagnosticModule();
  let calls = 0;
  const ambiguous = [
    "Jordan Example",
    "",
    "WORK EXPERIENCE",
    "Platform Lead | Example Labs",
    "2022 - Present",
    "• Built reliable systems.",
    "",
    "Unlabelled fragment",
    "Without a record header or complete narrative"
  ].join("\n");

  await assert.rejects(
    withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV7Diagnostic("synthetic-secret", {
      resumeText: ambiguous,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      }
    })),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_STRUCTURE_AMBIGUOUS"
  );
  assert.equal(calls, 0);
});

test("returns privacy-safe v7 record-reference diagnostics without retrying", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = providerV7FromCanonical(
    fullSizeSyntheticDocxExtractedText,
    fullSizeSyntheticProviderOutput()
  );
  output.workHistory[0]!.recordId = "section-4-record-999";
  let calls = 0;
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV7Diagnostic(
    "synthetic-secret",
    {
      resumeText: fullSizeSyntheticDocxExtractedText,
      fetchImpl: async () => {
        calls += 1;
        return new Response(providerEnvelope(output), { status: 200 });
      }
    }
  ));

  assert.equal(calls, 1);
  assert.equal(result.outcome, "invalid_response");
  assert.equal(result.category, "INVALID_STRUCTURED_OUTPUT");
  assert.equal(result.fieldPath, "workHistory[0].recordId");
  assert.equal(result.validationStage, "lossless_source_authority");
  assert.equal(result.internalErrorCode, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  assert.equal(result.section, "workHistory");
  assert.equal(result.mismatchComponent, "recordId");
  assert.doesNotMatch(JSON.stringify(result), /record-999|Taylor Boundary/u);
});

test("keeps the historical v6 command pinned and exposes a distinct v7 owner command", async () => {
  const historical = await import("@/lib/ai/gemini-resume-diagnostic");
  const oldRequest = historical.buildPinnedGeminiResumeDiagnosticRequest(
    fullSizeSyntheticDocxExtractedText
  );
  assert.equal(oldRequest.requestHash, HISTORICAL_V6_REQUEST_HASH);
  assert.equal(oldRequest.schemaHash, HISTORICAL_V6_SCHEMA_HASH);
  assert.equal(oldRequest.wireSchemaVersion, "3");

  const wrapper = await readFile(
    new URL("../scripts/run-gemini-resume-v7-diagnostic.sh", import.meta.url),
    "utf8"
  ).catch(() => null);
  assert.ok(wrapper, "the distinct v7 owner wrapper must exist");
  assert.match(wrapper, /diagnose-gemini-resume-v7\.ts/u);
  assert.doesNotMatch(wrapper, /diagnose-gemini-resume-schema\.ts|GEMINI_API_KEY|--api-key|\.env/u);

  const oldWrapper = await readFile(
    new URL("../scripts/run-gemini-resume-schema-diagnostic.sh", import.meta.url),
    "utf8"
  );
  assert.match(oldWrapper, /diagnose-gemini-resume-schema\.ts/u);
  assert.doesNotMatch(oldWrapper, /diagnose-gemini-resume-v7\.ts/u);
});

test("v7 CLI uses one masked credential handoff and emits only the approved packet", async () => {
  const cliModule = await import("@/scripts/diagnose-gemini-resume-v7").catch(() => null);
  assert.ok(cliModule, "the distinct v7 diagnostic CLI must exist");
  const writes: string[] = [];
  let calls = 0;
  const exitCode = await cliModule.runGeminiResumeV7DiagnosticCli({
    assertRuntime: () => undefined,
    loadResumeText: async () => fullSizeSyntheticDocxExtractedText,
    readSecret: async () => "owner-entered-secret",
    runDiagnostic: async () => {
      calls += 1;
      return {
        outcome: "validated" as const,
        httpStatus: 200,
        finishReason: "STOP" as const,
        usage: {
          inputTokens: 4_000,
          outputTokens: 7_600,
          cachedInputTokens: 0,
          visibleOutputTokens: 7_500,
          thinkingTokens: 100
        },
        responseBodyBytes: 20_000,
        responseBodyTruncated: false,
        validation: {
          contractVersion: "7" as const,
          sourceFacts: "complete" as const,
          recordAuthority: "server_owned" as const,
          sourceSectionCount: 9,
          structuralRecordCount: 10,
          workHistoryCount: 5,
          projectCount: 2,
          educationCount: 2,
          certificationCount: 1,
          achievementCount: 2,
          applicationPlan: "passed" as const,
          jobMatch: "passed" as const,
          tailoring: "passed" as const
        }
      };
    },
    write: (value: string) => writes.push(value)
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /"contractVersion": "7"/u);
  assert.match(writes[0]!, /"promptVersion": "9"/u);
  assert.match(writes[0]!, /"cacheVersion": "10"/u);
  assert.match(writes[0]!, /"wireSchemaVersion": "4"/u);
  assert.doesNotMatch(writes[0]!, /owner-entered-secret|Taylor Boundary|taylor\.boundary@example\.test/u);
});
