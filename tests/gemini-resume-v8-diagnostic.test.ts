import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import { getJobMatchEvidenceReferences } from "@/lib/ai/job-match";
import {
  assembleAndValidateResumeV8,
  buildResumeParseGeminiProviderV8JsonSchema,
  buildResumeParseProviderV8JsonSchema,
  prepareResumeParseV8Request
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInput } from "@/lib/ai/resume-source-catalog";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { resumeParsePromptV8 } from "@/prompts/resumeParsePrompt";
import {
  syntheticDocxExtractedText,
  syntheticDocxProviderOutput
} from "@/tests/fixtures/resume-contract-v5-data";
import { providerV8FromCanonical } from "@/tests/fixtures/resume-v8-provider-data";

const CANDIDATE_COMMIT = "105ba6f29d298d58c9636eb6ab17212adf50132c";
const EXPECTED_SOURCE_HASH = "ef2af3269f33639e869fa202440fe29d654aaa580e67a07a0c54a5b416b33823";
const EXPECTED_REQUEST_HASH = "6727cbe7a1c6a7efaae9243c0e7ddca40a608da458b4d31793c60e31fed956ab";
const EXPECTED_SCHEMA_HASH = "5d6f75cde707327a89f44a453df3cfcb5737f4e574fba1b3b4cb2ffb9a31d983";
const HISTORICAL_V7_REQUEST_HASH = "14e084686614fab6aeeedacc37fa7d42f0d390c076ddd4798acd953bdf890eb3";
const HISTORICAL_V7_SCHEMA_HASH = "a25c70d983f109e05a15529e06637e4c52d21b0ffe1760df1b6b120660c69c57";
const HOSTED_RUNTIME_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "VERCEL_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE"
] as const;

async function loadDiagnosticModule() {
  const loaded = await import("@/lib/ai/gemini-resume-v8-diagnostic").catch(() => null);
  assert.ok(loaded, "the distinct v8 diagnostic module must exist");
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

function providerEnvelope(value: unknown) {
  return JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: JSON.stringify(value) }] }
    }],
    usageMetadata: {
      promptTokenCount: 4_000,
      candidatesTokenCount: 7_500,
      thoughtsTokenCount: 100,
      totalTokenCount: 11_600
    }
  });
}

function partialSkillsProviderOutput() {
  const output = providerV8FromCanonical(
    syntheticDocxExtractedText,
    syntheticDocxProviderOutput()
  );
  output.skills = ["SQL", "stakeholder communication", "TypeScript"];
  return output;
}

test("pins the exact production V8 request, grammar, cost, body, time, and hashes", async () => {
  const diagnostic = await loadDiagnosticModule();
  const request = diagnostic.buildPinnedGeminiResumeV8DiagnosticRequest(
    syntheticDocxExtractedText
  );
  const prepared = prepareResumeParseV8Request(syntheticDocxExtractedText, "gemini");
  const payload = buildResumeProviderSourceInput(syntheticDocxExtractedText);
  const canonicalSchema = buildResumeParseProviderV8JsonSchema(payload);
  const wireSchema = buildResumeParseGeminiProviderV8JsonSchema(payload);
  const expectedBody = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV8,
    payload,
    responseJsonSchema: wireSchema,
    maxOutputTokens: 24_000,
    thinkingLevel: "LOW"
  });

  assert.equal(request.candidateCommit, CANDIDATE_COMMIT);
  assert.equal(request.contractVersion, "8");
  assert.equal(request.promptVersion, "10");
  assert.equal(request.cacheVersion, "11");
  assert.equal(request.wireSchemaVersion, "5");
  assert.equal(request.model, "gemini-3.5-flash-lite");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.thinkingLevel, "LOW");
  assert.equal(request.maximumInputTokens, 12_000);
  assert.equal(request.maximumOutputTokens, 24_000);
  assert.equal(request.maximumCostMicros, 63_600);
  assert.equal(request.maximumCostUsd, "0.063600");
  assert.equal(request.timeoutMs, 180_000);
  assert.equal(request.responseBodyLimitBytes, 65_536);
  assert.equal(request.sourceBytes, Buffer.byteLength(prepared.normalizedText));
  assert.equal(request.sourceHash, EXPECTED_SOURCE_HASH);
  assert.equal(request.requestHash, EXPECTED_REQUEST_HASH);
  assert.equal(request.schemaHash, EXPECTED_SCHEMA_HASH);
  assert.equal(request.requestBodyBytes, 13_467);
  assert.equal(request.schemaBytes, 2_696);
  assert.equal(request.requestBodyBytes, Buffer.byteLength(request.bodyJson));
  assert.deepEqual(JSON.parse(request.bodyJson), expectedBody);
  assert.deepEqual(prepared.payload, payload);
  assert.ok(Buffer.byteLength(JSON.stringify(canonicalSchema)) > request.schemaBytes);

  const schemaText = JSON.stringify(expectedBody.generationConfig.responseJsonSchema);
  assert.match(schemaText, /"recordId"/u);
  assert.doesNotMatch(schemaText, /"summary"|"achievements"|"sectionStatus"|"sourceText"/u);
  assert.doesNotMatch(request.bodyJson, /recordSpans|startLineId|endLineId|spanIndex/u);
});

test("runs one injected V8 request and proves lossless authority plus every consumer", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = partialSkillsProviderOutput();
  const approved = diagnostic.buildPinnedGeminiResumeV8DiagnosticRequest(
    syntheticDocxExtractedText
  );
  let calls = 0;
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV8Diagnostic(
    "synthetic-secret",
    {
      resumeText: syntheticDocxExtractedText,
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
  assert.equal(result.validation.contractVersion, "8");
  assert.equal(result.validation.candidateCommit, CANDIDATE_COMMIT);
  assert.equal(result.validation.recordAuthority, "server_owned_finite_ids");
  assert.equal(result.validation.sourceAuthority, "server_owned_lossless");
  assert.deepEqual(result.validation.losslessFields, [
    "sourceSections", "summary", "achievements", "sectionStatus"
  ]);
  assert.equal(result.validation.skillsProjection, "source_backed_semantic_subset");
  assert.equal(result.validation.rawSourceFallback, "preserved");
  assert.equal(result.validation.contactProjectionCount, 8);
  assert.equal(result.validation.contactProjectionCompleteness, "passed");
  assert.equal(result.validation.applicationPlan, "passed");
  assert.equal(result.validation.jobMatch, "passed");
  assert.equal(result.validation.tailoring, "passed");
  assert.doesNotMatch(JSON.stringify(result), /Jordan Example|jordan@example\.test|synthetic-secret/u);
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(output)));
});

test("rejects provider attempts to override source-owned V8 fields", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = partialSkillsProviderOutput() as Record<string, unknown>;
  for (const injected of [
    { summary: "Truncated provider summary" },
    { achievements: [] },
    { sectionStatus: { achievements: "absent" } },
    { sourceText: "Provider-owned source" }
  ]) {
    let calls = 0;
    const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV8Diagnostic(
      "synthetic-secret",
      {
        resumeText: syntheticDocxExtractedText,
        fetchImpl: async () => {
          calls += 1;
          return new Response(providerEnvelope({ ...output, ...injected }), { status: 200 });
        }
      }
    ));
    assert.equal(calls, 1);
    assert.equal(result.outcome, "invalid_response");
    assert.equal(result.category, "INVALID_STRUCTURED_OUTPUT");
    assert.equal(result.validationStage, "resume_schema");
  }
});

test("uses finite record IDs and rejects an invented V8 record reference", async () => {
  const diagnostic = await loadDiagnosticModule();
  const output = partialSkillsProviderOutput();
  output.workHistory[0]!.recordId = "section-4-record-999";
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV8Diagnostic(
    "synthetic-secret",
    {
      resumeText: syntheticDocxExtractedText,
      fetchImpl: async () => new Response(providerEnvelope(output), { status: 200 })
    }
  ));

  assert.equal(result.outcome, "invalid_response");
  assert.equal(result.category, "INVALID_STRUCTURED_OUTPUT");
  assert.equal(result.fieldPath, "workHistory[0].recordId");
  assert.equal(result.validationStage, "lossless_source_authority");
  assert.doesNotMatch(JSON.stringify(result), /record-999|Jordan Example/u);
});

test("keeps V8 rejection status and field paths without retaining provider-controlled text", async () => {
  const diagnostic = await loadDiagnosticModule();
  const providerBody = JSON.stringify({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "generationConfig.responseJsonSchema rejected Jordan Example jordan@example.test synthetic-secret",
      details: [{
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [{
          field: "generationConfig.responseJsonSchema",
          description: "Jordan Example jordan@example.test synthetic-secret"
        }]
      }, {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "Jordan Example",
        domain: "jordan@example.test",
        metadata: { "synthetic-secret": "Jordan Example" }
      }]
    }
  });
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV8Diagnostic(
    "synthetic-secret",
    {
      resumeText: syntheticDocxExtractedText,
      fetchImpl: async () => new Response(providerBody, {
        status: 400,
        headers: { "x-goog-request-id": "Jordan-Example-jordan@example.test" }
      })
    }
  ));

  assert.equal(result.outcome, "rejected");
  assert.equal(result.httpStatus, 400);
  assert.equal(result.providerCode, "INVALID_ARGUMENT");
  assert.equal(result.category, "INVALID_SCHEMA_VALUE");
  assert.deepEqual(result.fieldPaths, ["generationConfig.responseJsonSchema"]);
  assert.equal(result.fieldViolationCount, 1);
  assert.deepEqual(result.detailTypes, ["BadRequest", "ErrorInfo"]);
  assert.equal(result.requestId, null);
  assert.equal(result.errorReason, null);
  assert.equal(result.errorDomain, null);
  assert.deepEqual(result.metadataKeys, []);
  assert.equal(result.providerMessagePreview, null);
  assert.ok(result.responseBodyBytes > 0);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Jordan Example|jordan@example\.test|synthetic-secret/u
  );
});

test("keeps skills intentionally partial while contact and all canonical consumers remain complete", async () => {
  const diagnostic = await loadDiagnosticModule();
  const provider = partialSkillsProviderOutput();
  const validated = assembleAndValidateResumeV8(syntheticDocxExtractedText, provider);
  const canonical = syntheticDocxProviderOutput();
  const resume = { ...validated, rawText: syntheticDocxExtractedText };
  const job = {
    title: "Synthetic Systems Engineer",
    company: "Synthetic Boundary Labs",
    description: "Build reliable TypeScript systems with structured data and test automation.",
    requirements: ["TypeScript", "structured data", "test automation"],
    preferredQualifications: ["Cloud systems"],
    detectedTechStack: ["TypeScript"]
  };
  const plan = buildApplicationPlanPayload({ job, resume });
  const refs = getJobMatchEvidenceReferences({ job, resume });
  const tailoring = buildResumeTailoringPayload(job, resume, null);

  assert.deepEqual(validated.contactInfo, canonical.contactInfo);
  assert.equal(validated.summary, canonical.summary);
  assert.deepEqual(validated.achievements, canonical.achievements);
  assert.deepEqual(validated.sectionStatus, canonical.sectionStatus);
  assert.deepEqual(validated.skills, ["SQL", "stakeholder communication", "TypeScript"]);
  assert.notDeepEqual(validated.skills, canonical.skills);
  assert.deepEqual(
    validated.sourceSections.find((section) => section.section === "skills")?.recordBlocks,
    canonical.sourceSections.find((section) => section.section === "skills")?.recordBlocks
  );
  assert.ok(plan.evidenceCatalog.some((entry) => entry.id === "raw-source-1"));
  assert.ok(refs.applicant.includes("resume.rawText"));
  assert.ok(tailoring.resume);
  assert.equal(tailoring.resume.rawText, syntheticDocxExtractedText);
  assert.equal(diagnostic.assertResumeDiagnosticConsumerCoverage(
    syntheticDocxExtractedText,
    validated,
    { plan, refs, tailoring }
  ), plan.projectionOmissions.length);
});

test("preserves the failed V7 packet and exposes only a distinct V8 owner command", async () => {
  const historical = await import("@/lib/ai/gemini-resume-v7-diagnostic");
  const oldRequest = historical.buildPinnedGeminiResumeV7DiagnosticRequest(
    syntheticDocxExtractedText
  );
  assert.equal(oldRequest.requestHash, HISTORICAL_V7_REQUEST_HASH);
  assert.equal(oldRequest.schemaHash, HISTORICAL_V7_SCHEMA_HASH);
  assert.equal(oldRequest.contractVersion, "7");

  const wrapper = await readFile(
    new URL("../scripts/run-gemini-resume-v8-diagnostic.sh", import.meta.url),
    "utf8"
  ).catch(() => null);
  assert.ok(wrapper, "the distinct V8 owner wrapper must exist");
  assert.match(wrapper, /diagnose-gemini-resume-v8\.ts/u);
  assert.doesNotMatch(wrapper, /diagnose-gemini-resume-v7\.ts|GEMINI_API_KEY|--api-key|\.env/u);

  const oldWrapper = await readFile(
    new URL("../scripts/run-gemini-resume-v7-diagnostic.sh", import.meta.url),
    "utf8"
  );
  assert.match(oldWrapper, /diagnose-gemini-resume-v7\.ts/u);
  assert.doesNotMatch(oldWrapper, /diagnose-gemini-resume-v8\.ts/u);
});

test("V8 CLI uses one masked credential handoff and emits only the approval packet", async () => {
  const cliModule = await import("@/scripts/diagnose-gemini-resume-v8").catch(() => null);
  assert.ok(cliModule, "the distinct V8 diagnostic CLI must exist");
  const writes: string[] = [];
  let calls = 0;
  const exitCode = await cliModule.runGeminiResumeV8DiagnosticCli({
    assertRuntime: () => undefined,
    loadResumeText: async () => syntheticDocxExtractedText,
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
          contractVersion: "8" as const,
          sourceFacts: "complete" as const,
          candidateCommit: CANDIDATE_COMMIT,
          recordAuthority: "server_owned_finite_ids" as const,
          sourceAuthority: "server_owned_lossless" as const,
          losslessFields: ["sourceSections", "summary", "achievements", "sectionStatus"] as const,
          skillsProjection: "source_backed_semantic_subset" as const,
          rawSourceFallback: "preserved" as const,
          contactProjectionCount: 8,
          contactProjectionCompleteness: "passed" as const,
          structuralRecordCount: 7,
          sourceSectionCount: 9,
          workHistoryCount: 2,
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
  assert.match(writes[0]!, new RegExp(CANDIDATE_COMMIT, "u"));
  assert.match(writes[0]!, /"contractVersion": "8"/u);
  assert.match(writes[0]!, /"promptVersion": "10"/u);
  assert.match(writes[0]!, /"cacheVersion": "11"/u);
  assert.match(writes[0]!, /"wireSchemaVersion": "5"/u);
  assert.match(writes[0]!, /"maximumCostUsd": "0\.063600"/u);
  assert.match(writes[0]!, new RegExp(EXPECTED_REQUEST_HASH, "u"));
  assert.doesNotMatch(writes[0]!, /owner-entered-secret|Jordan Example|jordan@example\.test/u);
});

test("V8 owner command loads the exact private-free mixed-contact DOCX", async () => {
  const cliModule = await import("@/scripts/diagnose-gemini-resume-v8");
  const loadPinnedSyntheticResumeText = (
    cliModule as { loadPinnedSyntheticResumeText?: () => Promise<string> }
  ).loadPinnedSyntheticResumeText;
  assert.ok(loadPinnedSyntheticResumeText, "the V8 owner command must expose its pinned fixture loader");

  const extracted = await loadPinnedSyntheticResumeText();
  assert.equal(extracted, syntheticDocxExtractedText);
  assert.match(extracted, /Riverton, CA \| \(555\) 010-1000 \| jordan@example\.test/u);
  assert.match(extracted, /ACHIEVEMENTS[\s\S]*Operational Excellence:[\s\S]*Customer Impact:/u);
});
