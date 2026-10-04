import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  buildPinnedGeminiResumeV7DiagnosticRequest,
  runPinnedGeminiResumeV7Diagnostic
} from "@/lib/ai/gemini-resume-v7-diagnostic";
import { extractResumeDocxText } from "@/lib/resume-docx-text";

function assertLocalInteractiveRuntime() {
  const hosted = [
    process.env.CI,
    process.env.GITHUB_ACTIONS,
    process.env.VERCEL,
    process.env.VERCEL_ENV,
    process.env.AWS_LAMBDA_FUNCTION_NAME,
    process.env.K_SERVICE
  ].some((value) => Boolean(value));
  if (
    process.env.NODE_ENV === "production"
    || hosted
    || !process.stdin.isTTY
    || !process.stderr.isTTY
  ) {
    throw new Error("This command requires a local interactive terminal.");
  }
}

async function readSecretFromTty() {
  const ttyFd = openSync("/dev/tty", "r+");
  let echoDisabled = false;
  const bytes: number[] = [];
  try {
    writeSync(ttyFd, "Existing Gemini API key (input hidden): ");
    const disabled = spawnSync("/bin/stty", ["-echo"], {
      stdio: [ttyFd, ttyFd, ttyFd]
    });
    if (disabled.status !== 0) throw new Error("Could not mask terminal input.");
    echoDisabled = true;

    const byte = Buffer.alloc(1);
    while (true) {
      const count = readSync(ttyFd, byte, 0, 1, null);
      if (count === 0 || byte[0] === 10 || byte[0] === 13) break;
      if (bytes.length >= 512) {
        throw new Error("The supplied credential exceeded the accepted bound.");
      }
      bytes.push(byte[0]);
      byte.fill(0);
    }
  } finally {
    if (echoDisabled) {
      spawnSync("/bin/stty", ["echo"], { stdio: [ttyFd, ttyFd, ttyFd] });
    }
    writeSync(ttyFd, "\n");
    closeSync(ttyFd);
  }

  const credentialBytes = Buffer.from(bytes);
  const secret = credentialBytes.toString("utf8").trim();
  credentialBytes.fill(0);
  if (!secret) throw new Error("No credential was supplied through the masked prompt.");
  return secret;
}

type CliDependencies = {
  assertRuntime?: () => void;
  loadResumeText?: () => Promise<string>;
  readSecret?: () => Promise<string>;
  runDiagnostic?: typeof runPinnedGeminiResumeV7Diagnostic;
  write?: (value: string) => void;
};

export async function loadPinnedSyntheticResumeText() {
  const fixture = await readFile(
    new URL("../tests/fixtures/synthetic-resume-contract-v5.docx", import.meta.url)
  );
  return extractResumeDocxText(fixture);
}

export async function runGeminiResumeV7DiagnosticCli(dependencies: CliDependencies = {}) {
  const write = dependencies.write ?? ((value: string) => process.stdout.write(`${value}\n`));
  let request: ReturnType<typeof buildPinnedGeminiResumeV7DiagnosticRequest> | null = null;
  let apiKey = "";
  try {
    (dependencies.assertRuntime ?? assertLocalInteractiveRuntime)();
    const resumeText = await (dependencies.loadResumeText ?? loadPinnedSyntheticResumeText)();
    request = buildPinnedGeminiResumeV7DiagnosticRequest(resumeText);
    apiKey = await (dependencies.readSecret ?? readSecretFromTty)();
    const result = await (dependencies.runDiagnostic ?? runPinnedGeminiResumeV7Diagnostic)(apiKey, {
      resumeText
    });
    write(JSON.stringify({
      approvedRequest: {
        cacheVersion: request.cacheVersion,
        contractVersion: request.contractVersion,
        endpoint: request.endpoint,
        maximumCostMicros: request.maximumCostMicros,
        maximumInputTokens: request.maximumInputTokens,
        maximumOutputTokens: request.maximumOutputTokens,
        model: request.model,
        promptVersion: request.promptVersion,
        requestBodyBytes: request.requestBodyBytes,
        requestHash: request.requestHash,
        responseBodyLimitBytes: request.responseBodyLimitBytes,
        schemaBytes: request.schemaBytes,
        schemaHash: request.schemaHash,
        sourceHash: request.sourceHash,
        timeoutMs: request.timeoutMs,
        wireSchemaVersion: request.wireSchemaVersion
      },
      result
    }, null, 2));
    return result.outcome === "validated" ? 0 : 1;
  } catch {
    write(JSON.stringify({
      approvedRequest: request ? {
        cacheVersion: request.cacheVersion,
        contractVersion: request.contractVersion,
        endpoint: request.endpoint,
        maximumCostMicros: request.maximumCostMicros,
        maximumInputTokens: request.maximumInputTokens,
        maximumOutputTokens: request.maximumOutputTokens,
        model: request.model,
        promptVersion: request.promptVersion,
        requestBodyBytes: request.requestBodyBytes,
        requestHash: request.requestHash,
        responseBodyLimitBytes: request.responseBodyLimitBytes,
        schemaBytes: request.schemaBytes,
        schemaHash: request.schemaHash,
        sourceHash: request.sourceHash,
        timeoutMs: request.timeoutMs,
        wireSchemaVersion: request.wireSchemaVersion
      } : null,
      result: {
        outcome: "transport_error",
        category: "TRANSPORT_OR_LOCAL_FAILURE"
      }
    }, null, 2));
    return 1;
  } finally {
    apiKey = "";
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void runGeminiResumeV7DiagnosticCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
