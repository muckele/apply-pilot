import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildGeminiJsonRequest } from "@/lib/ai/gemini";
import {
  buildResumeParseGeminiProviderV9JsonSchema,
  prepareResumeParseV9Request
} from "@/lib/ai/resume";
import { buildResumeProviderSourceInputV9 } from "@/lib/ai/resume-source-catalog";
import { resumeParsePromptV9 } from "@/prompts/resumeParsePrompt";
import {
  resumeV9OwnerTopologyTwinCanonical,
  resumeV9OwnerTopologyTwinDocxText
} from "@/tests/fixtures/resume-v9-structural-twin-data";
import { providerV9FromCanonical } from "@/tests/fixtures/resume-v9-provider-data";

const CANDIDATE_COMMIT = "e712ad7829f2706b147f4b76ef49337c0d246e1b";
const EXPECTED_SOURCE_HASH = "579be60d3d8e66dfd013e7cfa92a689746a4f74f811ea3c31934521f24e62799";
const EXPECTED_REQUEST_HASH = "ea70c338a29242014f89eaa2b2d9b354898f262055a7746bee4862413b6237d7";
const EXPECTED_SCHEMA_HASH = "d59e1ba2ba364ddf3706fdc68922e8e1b31e492c6ee6dcbb4f40fa967d4e9db1";
const EXPECTED_TYPED_PROJECTION_HASH = "9b11b23902fd4680778c2e8eb68b141dd29d41e952fd4e89825d2b18267570b9";
const HOSTED_RUNTIME_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "VERCEL_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE"
] as const;

async function loadDiagnosticModule() {
  const loaded = await import("@/lib/ai/gemini-resume-v9-diagnostic").catch(() => null);
  assert.ok(loaded, "the pinned V9 diagnostic module must exist");
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
      promptTokenCount: 4_200,
      candidatesTokenCount: 8_200,
      thoughtsTokenCount: 120,
      totalTokenCount: 12_520
    }
  });
}

test("pins the exact V9 owner-topology request, bounds, and hashes", async () => {
  const diagnostic = await loadDiagnosticModule();
  const request = diagnostic.buildPinnedGeminiResumeV9DiagnosticRequest(
    resumeV9OwnerTopologyTwinDocxText
  );
  const prepared = prepareResumeParseV9Request(resumeV9OwnerTopologyTwinDocxText, "gemini");
  const payload = buildResumeProviderSourceInputV9(resumeV9OwnerTopologyTwinDocxText);
  const wireSchema = buildResumeParseGeminiProviderV9JsonSchema(payload);
  const expectedBody = buildGeminiJsonRequest({
    systemPrompt: resumeParsePromptV9,
    payload,
    responseJsonSchema: wireSchema,
    maxOutputTokens: 24_000,
    thinkingLevel: "LOW"
  });

  assert.equal(request.candidateCommit, CANDIDATE_COMMIT);
  assert.equal(request.contractVersion, "9");
  assert.equal(request.promptVersion, "11");
  assert.equal(request.cacheVersion, "12");
  assert.equal(request.wireSchemaVersion, "6");
  assert.equal(request.model, "gemini-3.5-flash-lite");
  assert.equal(request.maximumInputTokens, 12_000);
  assert.equal(request.maximumOutputTokens, 24_000);
  assert.equal(request.maximumCostMicros, 63_600);
  assert.equal(request.maximumCostUsd, "0.063600");
  assert.equal(request.timeoutMs, 180_000);
  assert.equal(request.responseBodyLimitBytes, 65_536);
  assert.equal(request.sourceBytes, 5_447);
  assert.equal(request.sourceLineCount, 65);
  assert.equal(request.sourceHash, EXPECTED_SOURCE_HASH);
  assert.equal(request.requestBodyBytes, 15_538);
  assert.equal(request.schemaBytes, 2_766);
  assert.equal(request.requestHash, EXPECTED_REQUEST_HASH);
  assert.equal(request.schemaHash, EXPECTED_SCHEMA_HASH);
  assert.deepEqual(JSON.parse(request.bodyJson), expectedBody);
  assert.deepEqual(prepared.payload, payload);
});

test("one injected V9 request proves the exact twin topology and canonical consumers", async () => {
  const diagnostic = await loadDiagnosticModule();
  const provider = providerV9FromCanonical(
    resumeV9OwnerTopologyTwinDocxText,
    resumeV9OwnerTopologyTwinCanonical()
  );
  assert.deepEqual(provider.certifications, []);
  assert.deepEqual(
    resumeV9OwnerTopologyTwinCanonical().sourceSections.map((section) => section.section),
    ["contactInfo", "summary", "skills", "workHistory", "projects", "education"]
  );
  const approved = diagnostic.buildPinnedGeminiResumeV9DiagnosticRequest(
    resumeV9OwnerTopologyTwinDocxText
  );
  let calls = 0;
  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV9Diagnostic(
    "synthetic-secret",
    {
      resumeText: resumeV9OwnerTopologyTwinDocxText,
      fetchImpl: async (_input: unknown, init: RequestInit | undefined) => {
        calls += 1;
        assert.equal(init?.body, approved.bodyJson);
        return new Response(providerEnvelope(provider), { status: 200 });
      }
    }
  ));

  assert.equal(calls, 1);
  assert.equal(result.outcome, "validated");
  assert.equal(result.validation.candidateCommit, CANDIDATE_COMMIT);
  assert.equal(result.validation.contractVersion, "9");
  assert.equal(result.validation.sourceLineCount, 65);
  assert.equal(result.validation.reachableNonblankLineCount, 46);
  assert.equal(result.validation.sourceSectionCount, 6);
  assert.equal(result.validation.workHistoryCount, 5);
  assert.equal(result.validation.workBulletCount, 21);
  assert.deepEqual(result.validation.workBulletCounts, [4, 4, 5, 3, 5]);
  assert.equal(result.validation.projectCount, 2);
  assert.deepEqual(result.validation.projectBulletCounts, [1, 1]);
  assert.deepEqual(result.validation.projectTechnologyCounts, [2, 2]);
  assert.equal(result.validation.educationCount, 2);
  assert.deepEqual(result.validation.educationDetailCounts, [1, 0]);
  assert.deepEqual(result.validation.educationRecordLineCounts, [2, 1]);
  assert.equal(result.validation.certificationCount, 0);
  assert.deepEqual(result.validation.certificationDetailCounts, []);
  assert.equal(result.validation.canonicalProjectionCompleteness, "passed");
  assert.equal(result.validation.typedProjectionHash, EXPECTED_TYPED_PROJECTION_HASH);
  assert.equal(result.validation.achievementCount, 0);
  assert.equal(result.validation.applicationPlan, "passed");
  assert.equal(result.validation.jobMatch, "passed");
  assert.equal(result.validation.tailoring, "passed");
  assert.doesNotMatch(JSON.stringify(result), /Casey Structure|synthetic-secret/u);
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(provider)));
});

test("V9 diagnostic rejects omitted canonical education, project, and work facts", async () => {
  const diagnostic = await loadDiagnosticModule();
  const canonicalProvider = providerV9FromCanonical(
    resumeV9OwnerTopologyTwinDocxText,
    resumeV9OwnerTopologyTwinCanonical()
  );
  const omissions: Array<(provider: typeof canonicalProvider) => void> = [
    (provider) => {
      provider.education[1]!.credential = null;
      provider.education[1]!.fieldOfStudy = null;
    },
    (provider) => { provider.education[0]!.details = []; },
    (provider) => {
      provider.projects.forEach((project) => {
        project.bullets = [];
        project.technologies = [];
      });
    },
    (provider) => { provider.workHistory[2]!.bullets.pop(); }
  ];

  for (const omit of omissions) {
    const provider = structuredClone(canonicalProvider);
    omit(provider);
    const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV9Diagnostic(
      "synthetic-secret",
      {
        resumeText: resumeV9OwnerTopologyTwinDocxText,
        fetchImpl: async () => new Response(providerEnvelope(provider), { status: 200 })
      }
    ));
    assert.equal(result.outcome, "invalid_response");
    assert.equal(result.category, "INVALID_STRUCTURED_OUTPUT");
  }
});

test("V9 diagnostic rejects count-preserving truncation of canonical typed facts", async () => {
  const diagnostic = await loadDiagnosticModule();
  const provider = providerV9FromCanonical(
    resumeV9OwnerTopologyTwinDocxText,
    resumeV9OwnerTopologyTwinCanonical()
  );
  provider.education[0]!.details = ["Completed a"];
  provider.education[1]!.credential = "Bachelor";
  provider.education[1]!.fieldOfStudy = "Business";
  provider.projects[0]!.bullets = ["Built a"];
  provider.projects[1]!.bullets = ["Created a"];

  const result = await withLocalRuntime(() => diagnostic.runPinnedGeminiResumeV9Diagnostic(
    "synthetic-secret",
    {
      resumeText: resumeV9OwnerTopologyTwinDocxText,
      fetchImpl: async () => new Response(providerEnvelope(provider), { status: 200 })
    }
  ));

  assert.equal(result.outcome, "invalid_response");
  assert.equal(result.category, "INVALID_STRUCTURED_OUTPUT");
});

test("the V9 owner command is distinct, local-only, and emits a bounded approval packet", async () => {
  const wrapper = await readFile(
    new URL("../scripts/run-gemini-resume-v9-diagnostic.sh", import.meta.url),
    "utf8"
  ).catch(() => null);
  assert.ok(wrapper, "the V9 owner wrapper must exist");
  assert.match(wrapper, /diagnose-gemini-resume-v9\.ts/u);
  assert.doesNotMatch(wrapper, /GEMINI_API_KEY|--api-key|\.env/u);

  const cli = await import("@/scripts/diagnose-gemini-resume-v9").catch(() => null);
  assert.ok(cli, "the V9 diagnostic CLI must exist");
  assert.equal(await cli.loadPinnedSyntheticResumeText(), resumeV9OwnerTopologyTwinDocxText);
  const writes: string[] = [];
  let calls = 0;
  const exitCode = await cli.runGeminiResumeV9DiagnosticCli({
    assertRuntime: () => undefined,
    loadResumeText: async () => resumeV9OwnerTopologyTwinDocxText,
    readSecret: async () => "owner-entered-secret",
    runDiagnostic: async () => {
      calls += 1;
      return {
        outcome: "validated" as const,
        httpStatus: 200,
        finishReason: "STOP" as const,
        usage: {
          inputTokens: 4_200,
          outputTokens: 8_320,
          cachedInputTokens: 0,
          visibleOutputTokens: 8_200,
          thinkingTokens: 120
        },
        responseBodyBytes: 22_000,
        responseBodyTruncated: false,
        validation: {
          contractVersion: "9" as const,
          sourceFacts: "complete" as const,
          candidateCommit: CANDIDATE_COMMIT,
          recordAuthority: "server_owned_finite_ids" as const,
          sourceAuthority: "server_owned_lossless" as const,
          rawSourceFallback: "preserved" as const,
          contactProjectionCount: 8,
          sourceLineCount: 65,
          reachableNonblankLineCount: 46,
          workBulletCount: 21,
          workBulletCounts: [4, 4, 5, 3, 5],
          projectBulletCounts: [1, 1],
          projectTechnologyCounts: [2, 2],
          educationDetailCounts: [1, 0],
          educationRecordLineCounts: [2, 1] as const,
          certificationDetailCounts: [],
          canonicalProjectionCompleteness: "passed" as const,
          typedProjectionHash: EXPECTED_TYPED_PROJECTION_HASH,
          structuralRecordCount: 9,
          sourceSectionCount: 6,
          workHistoryCount: 5,
          projectCount: 2,
          educationCount: 2,
          certificationCount: 0,
          achievementCount: 0,
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
  assert.match(writes[0]!, /"candidateCommit": "e712ad7829f2706b147f4b76ef49337c0d246e1b"/u);
  assert.match(writes[0]!, /"maximumCostUsd": "0\.063600"/u);
  assert.doesNotMatch(writes[0]!, /owner-entered-secret|Casey Structure/u);
});
